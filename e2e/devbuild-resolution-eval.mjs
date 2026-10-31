// AI EVAL (real model) of "Closing chats" on a Dev Build the owner signed in to: it makes model calls
// on the owner's AI subscription, so run it only with the owner's agreement. Fake WhatsApp, the owner's
// test data; every conversation uses a new number. Prints a score (0–100) and, with --baseline, the
// difference against an earlier run, so an AI change shows a regression before it ships.
// Usage: node e2e/devbuild-resolution-eval.mjs <port> <login file> [--out result.json] [--baseline old.json]
// The login file has "username:" and "password:" lines (an admin of the test data).
// Owner rule for the "Ask if the question is answered" switch:
//   on:  the answer ends by asking, in the customer's language and in its own words, whether it answered
//        the question; a thanks or yes after it closes the chat with a short closing line in words;
//   off: no check-in line; a plain thanks gets only a 👍 (nothing to answer) and closes the chat;
//   both: a thanks with new facts keeps the chat open.
import { readFileSync, writeFileSync } from 'node:fs';
import { apiClient, changeMark, poll, wait, oneLine } from './devbuild-client.mjs';

const args = process.argv.slice(2);
const [port, loginFile] = args;
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!/^\d+$/.test(port ?? '') || !loginFile)
  throw new Error(
    'Usage: node e2e/devbuild-resolution-eval.mjs <port> <login file> [--out f] [--baseline f]',
  );
const BASE = 'http://127.0.0.1:' + port;
const login = readFileSync(loginFile, 'utf8');
const field = (name) =>
  login
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith(name + ':'))
    ?.slice(name.length + 1)
    .trim();
const api = apiClient(BASE);
if (
  (await api('POST', '/auth/login', { username: field('username'), password: field('password') }))
    .status !== 200
)
  throw new Error('sign-in failed');
const agent = (await api('GET', '/ai')).json.agents[0];
const before = agent.resolutionCheck === true;

/** One conversation: a question the business knowledge answers, then the customer's closing text. */
const CASES = [
  { id: 'en-thanks', question: 'What time do you open?', closing: 'Thank you!', closes: true },
  { id: 'en-ok-thanks', question: 'What time do you open?', closing: 'ok thanks', closes: true },
  {
    id: 'en-yes',
    question: 'What time do you open?',
    closing: 'yes, that answers it, thank you',
    closes: true,
  },
  { id: 'ms-thanks', question: 'Pukul berapa kedai buka?', closing: 'Terima kasih!', closes: true },
  { id: 'zh-thanks', question: '你们几点开门？', closing: '谢谢！', closes: true },
  {
    id: 'en-new-facts',
    question: 'What time do you open?',
    closing: 'thanks, I will ask my boss and come back tomorrow',
    closes: false,
  },
];
// A check-in in any language: the reply's last line ends with a question mark (the opening-hours
// question itself needs no question back, so a closing "?" is the check-in).
const asksBack = (text) => {
  const chars = [...text.trim()];
  while (chars.length && /[\p{Extended_Pictographic}\s️]/u.test(chars.at(-1))) chars.pop();
  return /[?？]/.test(chars.at(-1) ?? '');
};

const messages = async (jid) =>
  (await api('GET', `/chats/${encodeURIComponent(jid)}/messages`)).json?.messages ?? [];
const chat = async (jid) =>
  (await api('GET', `/chats/${encodeURIComponent(jid)}`)).json?.chat ?? {};
const customer = (jid, text) =>
  api('POST', '/dev/fake-incoming', { chatJid: jid, text, senderName: 'Eval customer' });
const aiTexts = async (jid) =>
  (await messages(jid)).filter((m) => m.sentByUserId === agent.userId).map((m) => m.body ?? '');

async function run(jid, c) {
  await customer(jid, c.question);
  await poll(async () => (await aiTexts(jid)).length >= 1, 60_000);
  const [answer = ''] = await aiTexts(jid);
  await customer(jid, c.closing);
  await poll(
    async () => (await chat(jid)).status === 'resolved' || (await aiTexts(jid)).length >= 2,
    45_000,
  );
  await wait(4_000);
  const last = (await messages(jid)).findLast((m) => !m.fromMe);
  return {
    answer,
    after: (await aiTexts(jid)).slice(1),
    thumbs: (last?.reactions ?? []).filter((r) => r.emoji === '👍' && r.senderJid === null).length,
    status: (await chat(jid)).status,
  };
}

/** The scored checks of one conversation: [name, ok, detail]. */
function score(on, c, r) {
  const checks = [];
  checks.push([
    on ? 'answer asks back whether it answered' : 'answer has no check-in',
    on ? asksBack(r.answer) : !asksBack(r.answer),
    oneLine(r.answer).slice(-60),
  ]);
  if (!c.closes) {
    checks.push(
      ['stays open', r.status === 'open', r.status],
      ['no 👍', r.thumbs === 0, r.thumbs],
      // The customer said what happens next: asking the check-in question again ignores it.
      [
        'does not repeat the check-in question',
        !r.after.some((text) => asksBack(text) && r.answer.trim().endsWith(text.trim())),
        JSON.stringify(r.after),
      ],
    );
    return checks;
  }
  checks.push(['closes the chat', r.status === 'resolved', r.status]);
  if (on)
    checks.push([
      'closes with one short closing line in words',
      r.after.length === 1 && !asksBack(r.after[0]),
      JSON.stringify(r.after),
    ]);
  else
    checks.push([
      'closes with only a 👍',
      r.after.length === 0 && r.thumbs === 1,
      `${r.after.length} texts, ${r.thumbs} 👍`,
    ]);
  return checks;
}

const stamp = String(Date.now()).slice(-6);
const rows = [];
/** The raw conversations, kept in --out so a judge (e2e/eval-judge-jev.mjs) can score them later. */
const conversations = [];
try {
  for (const on of [true, false]) {
    if (
      (await api('PUT', `/ai/agents/${agent.id}/resolution-check`, { enabled: on })).status !== 200
    )
      throw new Error('switch did not change');
    const results = await Promise.all(
      CASES.map((c, i) => run(`60197${on ? 1 : 0}${stamp}${i}@s.whatsapp.net`, c)),
    );
    CASES.forEach((c, i) => {
      conversations.push({
        key: `${on ? 'on' : 'off'}/${c.id}`,
        switchOn: on,
        case: c,
        ...results[i],
      });
      for (const [name, ok, detail] of score(on, c, results[i]))
        rows.push({ key: `${on ? 'on' : 'off'}/${c.id}/${name}`, ok, detail: String(detail) });
    });
  }
} finally {
  await api('PUT', `/ai/agents/${agent.id}/resolution-check`, { enabled: before });
}

const passed = rows.filter((r) => r.ok).length;
const total = Math.round((passed / rows.length) * 100);
const baseline = flag('--baseline') ? JSON.parse(readFileSync(flag('--baseline'), 'utf8')) : null;
const was = new Map((baseline?.rows ?? []).map((r) => [r.key, r.ok]));
for (const r of rows)
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.key}  (${oneLine(r.detail)})${changeMark(was, r.key, r.ok)}`,
  );
let vsBaseline = '';
if (baseline) {
  const delta = total - baseline.score;
  vsBaseline = `; baseline ${baseline.score}/100 → ${delta >= 0 ? '+' : ''}${delta}`;
}
console.log(`AI eval score: ${total}/100 (${passed}/${rows.length} checks)${vsBaseline}`);
if (flag('--out'))
  writeFileSync(
    flag('--out'),
    JSON.stringify({ score: total, at: new Date().toISOString(), rows, conversations }, null, 2),
  );

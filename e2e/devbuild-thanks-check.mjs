// Dev Build check: a plain "thanks" after the AI's answer gets a 👍 and closes the chat, with the
// "Ask if the question is answered" switch off and on; a thanks with new facts keeps the chat open.
// Runs against e2e/agents-devbuild.ts (mock model, fake WhatsApp, temp data).
// Usage: node e2e/devbuild-thanks-check.mjs <port>. Prints PASS/FAIL per step.
import { apiClient, checker, poll, wait } from './devbuild-client.mjs';

const PORT = Number(process.argv[2] ?? 7491);
const BASE = 'http://127.0.0.1:' + PORT;
const { check, finish } = checker();
const api = apiClient(BASE);

const health = await fetch(BASE + '/api/health');
if (health.headers.get('x-agents-devbuild') !== 'mock-ai')
  throw new Error('Run this only against e2e/agents-devbuild.ts (mock model)');

const messages = async (jid) =>
  (await api('GET', `/chats/${encodeURIComponent(jid)}/messages`)).json?.messages ?? [];
const chat = async (jid) =>
  (await api('GET', `/chats/${encodeURIComponent(jid)}`)).json?.chat ?? {};
const customer = (jid, text) =>
  api('POST', '/dev/fake-incoming', { chatJid: jid, text, senderName: 'Siti Aminah' });
async function aiMessages(jid, userId, n, ms = 30_000) {
  const mine = async () => (await messages(jid)).filter((m) => m.sentByUserId === userId);
  await poll(async () => (await mine()).length >= n, ms);
  return mine();
}

const admin = { username: 'checker', displayName: 'Checker', password: 'check-pass-123' };
if ((await api('GET', '/setup/status')).json.needsSetup) await api('POST', '/setup/admin', admin);
check(
  (await api('POST', '/auth/login', { username: admin.username, password: admin.password }))
    .status === 200,
  'admin signs in',
);
await api('PUT', '/ai', { displayName: 'Mei', enabled: false, instructions: '', handoffRules: '' });
const agent = (await api('GET', '/ai')).json.agents[0];
await api('POST', `/ai/agents/${agent.id}/documents/text`, {
  name: 'Overview',
  text: 'We sell H100 GPUs from Kuala Lumpur.',
});
const on = await api('PUT', `/ai/agents/${agent.id}`, {
  displayName: 'Mei',
  enabled: true,
  instructions: '',
});
check(on.status === 200 && on.json.agent.enabled, 'the agent turns on');

/** One chat: a question the AI answers, then `thanks`; returns the chat and what was sent. */
async function thanked(jid, thanks) {
  await customer(jid, 'Do you sell H100 GPUs? CHECKIN');
  await aiMessages(jid, agent.userId, 1);
  await customer(jid, thanks);
  await poll(async () => (await chat(jid)).status === 'resolved', 20_000);
  await wait(2_000);
  const list = await messages(jid);
  const last = list.findLast((m) => !m.fromMe);
  return {
    chat: await chat(jid),
    aiSent: list.filter((m) => m.sentByUserId === agent.userId).length,
    thumbs: (last?.reactions ?? []).filter((r) => r.emoji === '👍' && r.senderJid === null).length,
  };
}

for (const switchOn of [false, true]) {
  await api('PUT', `/ai/agents/${agent.id}/resolution-check`, { enabled: switchOn });
  const label = `switch ${switchOn ? 'on' : 'off'}`;
  const r = await thanked(`6012000010${switchOn ? 2 : 1}@s.whatsapp.net`, 'Thank you!');
  check(
    r.chat.status === 'resolved' && r.chat.assignedTo == null,
    `${label}: "Thank you!" after the answer resolves and unassigns the chat`,
    `${r.chat.status}, assignedTo ${r.chat.assignedTo}`,
  );
  check(r.thumbs === 1, `${label}: the thanks gets a 👍 reaction from the linked number`, r.thumbs);
  check(r.aiSent === 1, `${label}: no extra AI message after the thanks`, r.aiSent);
}

await api('PUT', `/ai/agents/${agent.id}/resolution-check`, { enabled: false });
const more = await thanked(
  '60120000103@s.whatsapp.net',
  'thanks, I will ask my boss and come back',
);
check(
  more.chat.status === 'open' && more.thumbs === 0,
  'a thanks with new facts keeps the chat open and gets no 👍',
  `${more.chat.status}, ${more.thumbs} 👍`,
);

const audit = JSON.stringify((await api('GET', '/audit?limit=50')).json ?? '');
check(
  (audit.match(/ai\.resolve\b/g) ?? []).length >= 2 && /previous\W+answer/.test(audit),
  'both closes are audited as ai.resolve after an answer',
);
finish();

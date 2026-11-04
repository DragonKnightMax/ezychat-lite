// Dev Build check for Fix English against e2e/agents-devbuild.ts (mock model, fake WhatsApp, temp
// data). Usage: node e2e/devbuild-fix-english-check.mjs <port>
// Prints PASS/FAIL per step; never calls a model or a real WhatsApp number. Spelling runs in the
// browser (see e2e/fix-english-screens.mjs); this checks the server side: switch, grammar, words.
import { cookieSession } from './devbuild-client.mjs';

const PORT = Number(process.argv[2] ?? 7491);
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ');
const check = (ok, step, detail = '') => {
  if (!ok) failed++;
  const extra = detail ? '  (' + oneLine(detail) + ')' : '';
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + step + extra);
};

const health = await fetch(BASE + '/api/health');
if (health.headers.get('x-agents-devbuild') !== 'mock-ai')
  throw new Error('Run this only against e2e/agents-devbuild.ts (mock model)');

const api = cookieSession(BASE);
const code = (r) => r.json?.error?.code ?? r.json?.error;
const enc = encodeURIComponent;

const admin = { username: 'checker', displayName: 'Checker', password: 'check-pass-123' };
if ((await api('GET', '/setup/status')).json.needsSetup) await api('POST', '/setup/admin', admin);
check(
  (await api('POST', '/auth/login', { username: admin.username, password: admin.password }))
    .status === 200,
  'admin signs in',
);
const jid = '60129990777@s.whatsapp.net';
await api('POST', '/dev/fake-incoming', {
  chatJid: jid,
  text: 'Where is my order?',
  senderName: 'Nurul',
});
await new Promise((r) => setTimeout(r, 800));

const status = await api('GET', '/fix-english');
check(
  status.json?.enabled === true && status.json.spelling === 'on' && status.json.grammar === 'on',
  'new install: Fix English on, spelling and grammar on',
  JSON.stringify(status.json),
);

const draft = 'hi Nurul, your order have been ship. pls check you email for a update, RM12 paid.';
const started = Date.now();
const grammar = await api('POST', `/chats/${enc(jid)}/ai/fix-grammar`, { text: draft });
const pairs = (grammar.json?.issues ?? []).map((i) => `${i.original}>${i.replacement}`);
check(
  grammar.status === 200 &&
    grammar.json.status === 'checked' &&
    (grammar.json.issues ?? []).every((i) => draft.slice(i.start, i.end) === i.original),
  'grammar marks sit on the typed text',
  `${Date.now() - started} ms: ${pairs.join(', ')}`,
);
check(
  ['hi>Hi', 'have>has', 'ship>shipped', 'pls>Pls', 'you>your', 'a>an'].every((p) =>
    pairs.includes(p),
  ) && !pairs.some((p) => p.includes('RM')),
  'mock model fixes reach the marks; the price is never touched',
);
// Owner report 2026-11-04: a fix offered again after it was applied, adding the text twice.
const twice = await api('POST', `/chats/${enc(jid)}/ai/fix-grammar`, { text: 'pls check email' });
const twicePairs = (twice.json?.issues ?? []).map((i) => `${i.original}>${i.replacement}`);
check(
  twicePairs.filter((p) => p.startsWith('email>')).length === 1 &&
    twicePairs.includes('email>your email.'),
  'two changes on one word give one mark',
  twicePairs.join(', '),
);
const fixed = await api('POST', `/chats/${enc(jid)}/ai/fix-grammar`, {
  text: 'Pls check your email.',
});
check(
  fixed.json?.status === 'checked' && fixed.json.issues.length === 0,
  'the applied full stop is not offered again',
  (fixed.json?.issues ?? []).map((i) => `${i.original}>${i.replacement}`).join(', '),
);
const malay = await api('POST', `/chats/${enc(jid)}/ai/fix-grammar`, {
  text: 'Boleh, saya check dulu ya',
});
check(malay.json?.status === 'skipped' && malay.json.reason === 'not_english', 'Malay is skipped');

const added = await api('POST', '/fix-english/words', { word: 'cendol' });
check(
  added.status === 200 &&
    added.json.words.some((w) => w.word === 'cendol' && w.addedBy === 'Checker'),
  'a teammate adds a team word',
);
check(
  (await api('POST', '/fix-english/words', { word: 'RM12' })).status === 400,
  'a word with numbers is refused',
);
const removed = await api('DELETE', '/fix-english/words/cendol');
check(removed.status === 200 && removed.json.words.length === 0, 'an admin removes it');

const off = await api('PUT', '/ai/fix-english', { enabled: false });
check(off.json?.spelling === 'off' && off.json.grammar === 'off', 'switch off: both checks off');
const refused = await api('POST', `/chats/${enc(jid)}/ai/fix-grammar`, { text: draft });
check(refused.status === 409 && code(refused) === 'fix_english_off', 'grammar refused while off');
await api('PUT', '/ai/fix-english', { enabled: true });

const audit = await api('GET', '/audit?limit=20');
const actions = JSON.stringify(audit.json ?? {});
check(
  actions.includes('fix_english.update') && actions.includes('fix_english.word_add'),
  'switch and words are audited',
);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;

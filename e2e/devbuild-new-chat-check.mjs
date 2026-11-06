// Dev Build check for New chat (docs/features/new-chat/design.md) against a running Dev Build started with
//   npx tsx packages/server/src/cli.ts --data <temp> --port 7492 --fake-wa --mode dev --max-inboxes 3 --web-dist apps/web/dist
// on a fresh temp data folder. Usage: node e2e/devbuild-new-chat-check.mjs <port>
// Prints PASS/FAIL per step; never calls a model or a real WhatsApp number (fake WhatsApp only).
import { randomUUID } from 'node:crypto';
import { checker, cookieSession } from './devbuild-client.mjs';

const PORT = Number(process.argv[2] ?? 7492);
const BASE = `http://127.0.0.1:${PORT}`;
const { check, finish } = checker();

const admin = cookieSession(BASE);
const creds = { username: 'checker', displayName: 'Checker', password: 'check-pass-123' };
if ((await admin('GET', '/setup/status')).json.needsSetup)
  await admin('POST', '/setup/admin', creds);
check(
  (await admin('POST', '/auth/login', { username: creds.username, password: creds.password }))
    .status === 200,
  'admin signs in',
);
const start = (api, inboxId, phone, extra = {}) =>
  api('POST', `/inboxes/${inboxId}/new-chat`, { phone, clientRequestId: randomUUID(), ...extra });

// Admin, linked phone (inbox 1).
let status = (await admin('GET', '/new-chat')).json;
check(
  status.allowed && !status.staffEnabled && status.dailyLimit === 20 && status.perUserPerHour === 5,
  'admin may start new chats; team members off and 20 a day by default',
  JSON.stringify(status),
);
const bad = await admin('POST', '/inboxes/1/new-chat/check', { phone: '12345' });
check(bad.status === 400 && bad.json.error.code === 'invalid_number', 'a bad number is refused');
const own = await admin('POST', '/inboxes/1/new-chat/check', { phone: '+60 00000 0000' });
check(
  own.status === 400 && own.json.error.code === 'own_number',
  'the linked number itself is refused',
);
const checkLocal = await admin('POST', '/inboxes/1/new-chat/check', { phone: '012-888 7777' });
check(
  checkLocal.json.next === 'check' && checkLocal.json.phone === '60128887777',
  'a Malaysian local number gets +60 and needs the WhatsApp check',
);
const created = await start(admin, 1, '012-888 7777', { name: 'Farah Ismail' });
const jid = '60128887777@s.whatsapp.net';
check(
  created.status === 201 && created.json.chatJid === jid && created.json.created,
  'Start checks the number and creates the chat',
);
const chat = (await admin('GET', `/chats/${encodeURIComponent(jid)}`)).json.chat;
check(
  chat.name === 'Farah Ismail' && chat.assignedTo != null,
  'the chat has the name and is assigned to the starter',
);
const sent = await admin('POST', `/chats/${encodeURIComponent(jid)}/messages`, {
  text: 'Hello Farah, thanks for your call earlier.',
  clientId: randomUUID(),
});
check(sent.status === 201, 'the first message goes out through the normal composer route');
const again = await admin('POST', '/inboxes/1/new-chat/check', { phone: '+60128887777' });
check(
  again.json.next === 'existing' && again.json.chatJid === jid,
  'the same number again opens the existing chat',
);

// Settings: daily limit and team members.
const limit = await admin('PUT', '/new-chat/settings', { dailyLimit: 1 });
check(limit.json.dailyLimit === 1, 'the admin lowers the daily limit to 1');
const second = await start(admin, 1, '0128887778');
check(
  second.status === 429 && second.json.error.code === 'new_chat_daily_limit',
  'the limit applies at once (1 used today)',
);
await admin('PUT', '/new-chat/settings', { dailyLimit: 0 });
check((await start(admin, 1, '0128887778')).status === 201, '0 = no limit');

// A team member.
await admin('POST', '/users', {
  username: 'daniel',
  displayName: 'Daniel',
  role: 'agent',
  password: 'daniel-pass-123',
});
const users = (await admin('GET', '/users')).json.users ?? (await admin('GET', '/users')).json;
const daniel = users.find((u) => u.username === 'daniel');
await admin('PUT', `/users/${daniel.id}/inboxes`, { inboxIds: [1] });
const agent = cookieSession(BASE);
await agent('POST', '/auth/login', { username: 'daniel', password: 'daniel-pass-123' });
// A new member must change the password the admin gave before using the app.
await agent('POST', '/auth/change-password', {
  currentPassword: 'daniel-pass-123',
  newPassword: 'daniel-pass-456',
});
check(
  !(await agent('GET', '/new-chat')).json.allowed,
  'a team member cannot start chats while the switch is off',
);
check(
  (await agent('POST', '/inboxes/1/new-chat/check', { phone: '0128887779' })).status === 403,
  'the routes refuse them (403)',
);
await admin('PUT', '/new-chat/settings', { staffEnabled: true });
check((await agent('GET', '/new-chat')).json.allowed, 'after the admin switches it on, they may');
check((await start(agent, 1, '0128887779')).status === 201, 'the team member starts a chat');
await admin('PUT', `/users/${daniel.id}/chats`, { scope: 'chosen', chats: [jid] });
check(
  !(await agent('GET', '/new-chat')).json.allowed,
  'an agent limited to chosen chats never may, even with the switch on',
);

// Business API (dev fake-api inbox).
const api = (await admin('POST', '/dev/fake-api-inbox', { name: 'Online orders' })).json;
const apiStatus = (await admin('GET', '/new-chat')).json.inboxes.find((i) => i.inboxId === api.id);
check(apiStatus?.mode === 'template', 'the Business API inbox works template first');
check(
  (await admin('POST', `/inboxes/${api.id}/new-chat/check`, { phone: '012-888 5001' })).json
    .next === 'template',
  'its check asks for a template (no number check)',
);
const noTemplate = await start(admin, api.id, '012-888 5001');
check(noTemplate.json.error?.code === 'template_required', 'Start without a template is refused');
const tpl = await start(admin, api.id, '012-888 5001', {
  name: 'Ravi Kumar',
  template: { name: 'order_update', language: 'en', params: ['Ravi', '#1042'] },
});
const key = `60128885001@s.whatsapp.net#${api.id}`;
check(tpl.status === 201 && tpl.json.chatJid === key, 'the template is sent and the chat created');
const msgs = (await admin('GET', `/chats/${encodeURIComponent(key)}/messages`)).json.messages;
check(
  msgs.length === 1 && /Ravi/.test(msgs[0].body) && msgs[0].status !== 'failed',
  'the chat holds the sent template',
);
const free = await admin('POST', `/chats/${encodeURIComponent(key)}/messages`, {
  text: 'Hi',
  clientId: randomUUID(),
});
check(free.status === 409, 'free text stays locked until the customer replies');

// Audit.
const rows = (await admin('GET', '/audit?limit=100')).json.entries;
const actions = rows.map((r) => r.action);
check(
  actions.filter((a) => a === 'chat.new_number').length === 4 &&
    actions.includes('settings.new_chat_staff') &&
    actions.includes('settings.new_chat_daily_limit'),
  'Audit has the 4 new chats and both settings changes',
);
check(
  !JSON.stringify(rows.filter((r) => r.action === 'chat.new_number')).includes('Farah'),
  'audit rows carry ids only (no name)',
);
finish();

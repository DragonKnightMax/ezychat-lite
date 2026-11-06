// Dev Build check for scheduled tasks of AI agents (docs/features/scheduled-tasks/design.md) against
// e2e/agents-devbuild.ts (mock model, fake WhatsApp, temp data, real timers). Lite runner.
// Usage: node e2e/devbuild-scheduled-check.mjs <port>
// Waits for one real scheduled time (the next 5-minute step at least 2 minutes away, up to ~8 minutes).
// Prints PASS/FAIL per step; never calls a model or a real WhatsApp number.
import { devbuildClient } from './devbuild-client.mjs';

const STAFF = '120363088800001@g.us';
const FARAH = '60177700021@s.whatsapp.net';
const client = await devbuildClient(Number(process.argv[2] ?? 7491));
const { api, check, code, wait, finish } = client;
const enc = encodeURIComponent;

await client.signInAdmin();
await api('PUT', '/ai', {
  displayName: 'Aina',
  enabled: false,
  instructions: '',
  handoffRules: '',
});
await api('POST', '/ai/documents/text', { name: 'Menu', text: 'MARK-KOPI Kopi O RM2.50' });
await api('POST', '/ai/documents/text', {
  name: 'Internal',
  text: 'Supplier code KOPI-SECRET-2026 is for staff only, never share it',
  internal: true,
});
const agent = (await api('GET', '/ai')).json.agents[0];
const on = await api('PUT', `/ai/agents/${agent.id}`, {
  displayName: 'Aina',
  enabled: true,
  instructions: '',
  handoffRules: '',
});
check(on.status === 200, 'the agent turns on', on.status);

await api('POST', '/dev/fake-group', {
  groupJid: STAFF,
  name: 'Kopi Apong Staff',
  generated: 2,
  members: [{ phone: '60177700029', name: 'Hafiz', role: 'admin' }],
});
await api('POST', '/dev/fake-incoming', { chatJid: FARAH, text: 'Hi!', senderName: 'Farah' });
await wait(1500);

const base = `/ai/agents/${agent.id}/scheduled-tasks`;
const list = await api('GET', base);
check(
  list.status === 200 && list.json.paused === null && list.json.max === 10,
  'the list answers, not paused, max 10',
  JSON.stringify({ paused: list.json?.paused, tz: list.json?.timeZone }),
);
const timeZone = list.json.timeZone;

const bad = await api('POST', base, {
  name: 'Nobody',
  time: '08:30',
  dayRule: 'daily',
  chatJid: '60199999999@s.whatsapp.net',
  instruction: 'Hello',
});
check(
  bad.status === 400 && code(bad) === 'chat_not_in_inbox',
  'a chat not in the inbox is refused',
  bad.status,
);

// Preview: nothing sent.
const preview = await api('POST', `${base}/preview`, {
  chatJid: STAFF,
  instruction: "Tell the team today's specials",
});
check(
  preview.status === 200 && preview.json.result === 'sent' && /MARK-KOPI/.test(preview.json.text),
  'preview shows the message, written from the business context',
  preview.json?.text,
);
const skipPreview = await api('POST', `${base}/preview`, {
  chatJid: STAFF,
  instruction: 'SKIP today',
});
check(skipPreview.json?.reason === 'nothing_to_say', 'preview says when it would send nothing');
const leak = await api('POST', `${base}/preview`, { chatJid: STAFF, instruction: 'LEAK it' });
check(
  leak.json?.reason === 'confidential_leak',
  'an Internal item is never sent',
  leak.json?.reason,
);

// The next 5-minute step at least 2 minutes away, in the business time zone.
const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  })
    .formatToParts(new Date())
    .map((p) => [p.type, p.value]),
);
const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
const slotMin = (Math.ceil((nowMin + 2) / 5) * 5) % 1440;
const time = `${String(Math.floor(slotMin / 60)).padStart(2, '0')}:${String(slotMin % 60).padStart(2, '0')}`;
const created = await api('POST', base, {
  name: 'Morning specials',
  time,
  dayRule: 'daily',
  chatJid: STAFF,
  instruction: "Tell the team today's specials",
});
check(
  created.status === 200 && created.json.chat?.type === 'group',
  `task created for ${time}`,
  created.status,
);
const task = created.json;
const skipper = (
  await api('POST', base, {
    name: 'Quiet one',
    time,
    dayRule: 'daily',
    chatJid: FARAH,
    instruction: 'SKIP unless something is due',
  })
).json;

const messages = async (jid) =>
  (await api('GET', `/chats/${enc(jid)}/messages`)).json?.messages ?? [];
const deadline = task.nextRunAt + 120_000;
let sent = [];
while (Date.now() < deadline) {
  sent = (await messages(STAFF)).filter((m) => m.scheduledTask?.id === task.id);
  if (sent.length) break;
  await wait(5000);
}
check(sent.length === 1, 'the task sent one message at its time', sent.length);
check(
  sent[0]?.scheduledTask?.name === 'Morning specials' && sent[0]?.sentByUserId === agent.userId,
  'the message carries the Scheduled mark and comes from the agent',
);
const groupChat = (await api('GET', `/chats/${enc(STAFF)}`)).json?.chat;
check(groupChat?.assignedTo == null, 'the send did not take the group');
await wait(40_000); // two more ticks: still one message
check(
  (await messages(STAFF)).filter((m) => m.scheduledTask?.id === task.id).length === 1,
  'the same time never runs twice',
);
const runs = (await api('GET', `${base}/${task.id}/runs`)).json?.runs ?? [];
check(
  runs[0]?.result === 'sent' && runs[0]?.trigger === 'schedule',
  'History shows the run as sent',
);
const quiet = (await api('GET', `${base}/${skipper.id}/runs`)).json?.runs ?? [];
check(
  quiet[0]?.reason === 'nothing_to_say',
  'a task with nothing to tell sends nothing',
  quiet[0]?.reason,
);
check(
  (await messages(FARAH)).every((m) => !m.scheduledTask),
  'nothing reached the quiet task’s chat',
);

// Run now: 3 an hour, then 429; paused while the agent is off.
const press = () => api('POST', `${base}/${task.id}/run`);
const r1 = await press();
check(r1.status === 200 && r1.json.run.result === 'sent', 'Run now sends', r1.status);
await press();
await press();
const r4 = await press();
check(
  r4.status === 429 && code(r4) === 'rate_limited',
  'the 4th Run now in an hour is refused',
  r4.status,
);
await api('PUT', `/ai/agents/${agent.id}`, {
  displayName: 'Aina',
  enabled: false,
  instructions: '',
  handoffRules: '',
});
check((await api('GET', base)).json.paused === 'agent_off', 'tasks pause while the agent is off');
const paused = await api('POST', `${base}/${skipper.id}/run`);
check(
  paused.status === 409 && code(paused) === 'scheduled_paused',
  'Run now is refused while paused',
);

// Limit and delete.
for (let i = 0; i < 8; i++)
  await api('POST', base, {
    name: `T${i}`,
    time: '09:00',
    dayRule: 'weekdays',
    chatJid: STAFF,
    instruction: 'Hi',
  });
const over = await api('POST', base, {
  name: 'Over',
  time: '09:00',
  dayRule: 'daily',
  chatJid: STAFF,
  instruction: 'Hi',
});
check(
  over.status === 409 && code(over) === 'scheduled_task_limit',
  'the 11th task is refused',
  over.status,
);
const del = await api('DELETE', `${base}/${task.id}`);
check(del.status === 200, 'a task can be deleted');
const kept = (await messages(STAFF)).find((m) => m.id === sent[0]?.id);
check(kept?.scheduledTask?.name === null, 'its messages keep the mark without the name');

finish();

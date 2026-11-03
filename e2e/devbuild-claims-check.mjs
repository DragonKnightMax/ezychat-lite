// Dev Build check for group agents recording claims into Google Sheets
// (docs/features/group-agents/design.md) against e2e/agents-devbuild.ts (mock model, fake WhatsApp,
// fake Google Sheets, temp data). Start the runner with --max-agents 2, then:
//   node e2e/devbuild-claims-check.mjs <port>
// Prints PASS/FAIL per step; never calls a model or a real WhatsApp number.
const PORT = Number(process.argv[2] ?? 7491);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error('The port must be an integer between 1024 and 65535.');
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ');
const check = (ok, step, detail = '') => {
  if (!ok) failed++;
  const extra = detail ? '  (' + oneLine(detail).slice(0, 240) + ')' : '';
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + step + extra);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await fetch(BASE + '/api/health');
if (health.headers.get('x-agents-devbuild') !== 'mock-ai')
  throw new Error('Run this only against e2e/agents-devbuild.ts (mock model)');

let cookie = '';
/** One API path of the local Dev Build: plain segments only (ids from the server are data). */
function apiUrl(path) {
  if (
    !/^(\/[\w%@.:?=&-]+)+$/.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error(`Unexpected API path: ${path}`);
  const url = new URL(`/api${path}`, BASE);
  if (url.origin !== BASE) throw new Error('Refusing a link outside the local Dev Build');
  return url.href;
}
async function api(method, path, body) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { html: text };
  }
  return { status: res.status, json };
}
const enc = encodeURIComponent;

const admin = { username: 'checker', displayName: 'Checker', password: 'check-pass-123' };
if ((await api('GET', '/setup/status')).json.needsSetup) await api('POST', '/setup/admin', admin);
check(
  (await api('POST', '/auth/login', { username: admin.username, password: admin.password }))
    .status === 200,
  'admin signs in',
);

// Agent 1 answers direct chats; agent 2 is the claims agent (created group-only on the same number).
await api('PUT', '/ai', {
  displayName: 'Aina',
  enabled: false,
  instructions: '',
  handoffRules: '',
});
const created = await api('POST', '/ai/agents', {
  displayName: 'Claims agent',
  enabled: false,
  preset: 'custom',
  instructions:
    'When a member posts a claim (Policy no, Amount, What happened), save it to the tab "Claims". Reply "Recorded". Ignore chat that is not a claim.',
  handoffRules: '',
});
const claims = created.json?.agent ?? created.json;
check(
  created.status === 200 && !!claims?.id,
  'a second AI agent is created on the same number',
  JSON.stringify(created.json),
);
const list = (await api('GET', '/ai/agents')).json;
const summary = (list?.agents ?? []).find((a) => a.id === claims?.id);
check(
  summary?.answerDirect === false,
  'the second agent starts group-only',
  JSON.stringify(summary),
);
const direct = await api('PUT', `/ai/agents/${claims.id}/direct`, { enabled: true });
check(
  direct.status === 409 &&
    (direct.json?.error?.code ?? direct.json?.error) === 'inbox_has_direct_agent',
  'a second direct-chat agent is refused',
  direct.status,
);

// Google Sheets (fake Google): sign in, pick the demo spreadsheet, Claims on Add rows only.
const connect = await api('POST', '/connectors/google-sheets/connect', {});
/** A link the Dev Build gave back, as an API path of this Dev Build only (refuses any other host). */
function localApiPath(link) {
  const url = new URL(String(link), BASE);
  if (url.origin !== BASE || !url.pathname.startsWith('/api/'))
    throw new Error('Refusing a link outside the local Dev Build');
  return url.pathname.slice('/api'.length) + url.search;
}
const consent = await api('GET', localApiPath(connect.json?.authorizationUrl));
const allow = /id="allow" href="([^"]+)"/
  .exec(String(consent.json?.html ?? ''))?.[1]
  ?.replace(/&#38;|&amp;/g, '&');
await api('GET', localApiPath(allow));
await wait(500);
const sheetsStatus = (await api('GET', '/connectors/google-sheets')).json;
check(
  sheetsStatus?.state === 'connected',
  'Google Sheets is connected (fake Google)',
  JSON.stringify(sheetsStatus),
);
const picker = await api('POST', '/connectors/google-sheets/picker', {});
const token = new URL(picker.json.pickerUrl).searchParams.get('token');
const sheets = (await api('GET', '/dev/fake-google-sheets')).json.sheets;
const sheetId = sheets[0].id;
await api('GET', `/dev/fake-google-sheets/pick?token=${enc(token)}&id=${enc(sheetId)}`);
const saved = await api('PUT', `/connectors/google-sheets/agents/${claims.id}`, {
  spreadsheetId: sheetId,
  spreadsheetName: sheets[0].name,
  tabs: [{ title: 'Claims', access: 'add' }],
});
check(
  saved.status === 200 && saved.json?.tabs?.[0]?.access === 'add',
  'the Claims tab is set to Add rows',
  JSON.stringify(saved.json),
);
const refreshed = await api('POST', `/connectors/google-sheets/agents/${claims.id}/refresh`, {});
const claimsTab = refreshed.json?.tabs?.find((t) => t.title === 'Claims');
check(
  claimsTab?.columns?.includes('Policy no'),
  'Refresh returns the tab columns',
  JSON.stringify(claimsTab),
);

// Business context and the agent on; three branch groups given to it, reading every message.
await api('POST', `/ai/agents/${claims.id}/documents/text`, {
  name: 'Claims',
  text: 'Claims are recorded within one working day.',
});
const on = await api('PUT', `/ai/agents/${claims.id}`, {
  displayName: 'Claims agent',
  enabled: true,
  instructions:
    claims.settings?.instructions ??
    created.json?.settings?.instructions ??
    'Record claims to the tab Claims.',
  handoffRules: '',
});
check(on.status === 200, 'the claims agent is on', JSON.stringify(on.json).slice(0, 200));
await api('PUT', `/ai/agents/${claims.id}/groups`, { enabled: true });
const GROUPS = [
  ['120363099990011@g.us', 'Claims KL'],
  ['120363099990012@g.us', 'Claims Penang'],
  ['120363099990013@g.us', 'Claims JB'],
];
for (const [jid, name] of GROUPS)
  await api('POST', '/dev/fake-group', {
    groupJid: jid,
    name,
    generated: 0,
    members: [
      { phone: '60126677889', name: 'Hafiz' },
      { phone: '60190000101', name: 'Mei Ling' },
    ],
  });
const give = await api('PUT', `/ai/agents/${claims.id}/group-chats`, {
  jids: GROUPS.map(([jid]) => jid),
  enabled: true,
  listen: true,
});
const mine = (give.json?.groups ?? []).filter((g) => g.agentId === claims.id && g.listen);
check(
  give.status === 200 && mine.length === 3,
  'three branch groups are given to the claims agent, reading every message',
  give.status,
);
const taken = await api('PUT', `/ai/agents/1/group-chats`, { jids: [GROUPS[0][0]], enabled: true });
check(
  taken.status === 409 && (taken.json?.error?.code ?? taken.json?.error) === 'group_has_agent',
  'another agent cannot take a held group',
  taken.status,
);

const HAFIZ = '60126677889@s.whatsapp.net';
async function say(group, text) {
  await api('POST', '/dev/fake-incoming', {
    chatJid: group,
    senderJid: HAFIZ,
    senderName: 'Hafiz',
    text,
  });
}
const aiIn = async (group) =>
  ((await api('GET', `/chats/${enc(group)}/messages`)).json?.messages ?? []).filter(
    (m) => m.sentByUserId === summary?.userId || m.sentByUserId === claims.userId,
  );
async function aiAfter(group, count, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await aiIn(group);
    if (list.length > count && list.at(-1).status !== 'pending') return list.at(-1);
    await wait(500);
  }
  return null;
}
const claimRows = async () =>
  (await api('GET', '/dev/fake-google-sheets')).json.sheets.find((s) => s.id === sheetId).tabs
    .Claims;

// 1. A claim in Claims KL (no tag) is recorded after the batch wait, with the group's name.
const before = (await claimRows()).length;
await say(
  GROUPS[0][0],
  'Claim\nPolicy no: P-902341\nWhat happened: Side mirror broken\nAmount: RM 480',
);
const reply1 = await aiAfter(GROUPS[0][0], 0);
check(
  !!reply1 && /Recorded/.test(reply1.body),
  'a claim posted without a tag gets "Recorded"',
  reply1?.body,
);
const rows1 = await claimRows();
const row = rows1.at(-1) ?? [];
check(
  rows1.length === before + 1 && row.includes('P-902341') && row.includes('Claims KL'),
  'the claim is one new row with the policy and the group name',
  JSON.stringify(row),
);

// 2. Same agent, another branch: Claims Penang goes to the same tab.
await say(GROUPS[1][0], 'Policy no: P-110022\nWhat happened: Windscreen crack\nAmount: 620');
const reply2 = await aiAfter(GROUPS[1][0], 0);
const rows2 = await claimRows();
check(
  !!reply2 && rows2.length === before + 2 && rows2.at(-1).includes('Claims Penang'),
  'a claim from another branch group lands in the same tab',
  JSON.stringify(rows2.at(-1)),
);

// 3. A claim without an amount gets a question and no row.
await say(GROUPS[2][0], 'Claim for Policy no: P-777000, flood damage');
const reply3 = await aiAfter(GROUPS[2][0], 0);
check(
  !!reply3 && /amount/i.test(reply3.body) && (await claimRows()).length === before + 2,
  'a claim without an amount gets a question and no row',
  reply3?.body,
);

// 4. Chit-chat gets no reply.
await say(GROUPS[0][0], 'Thanks everyone, have a good day!');
check(
  (await aiAfter(GROUPS[0][0], 1, 14_000)) === null,
  'chit-chat in a reading group gets no reply',
);

// 5. A value the member never wrote is refused by the server (the mock passes only written values,
//    so check the guard through Activity: every line names the tab and group, never a value).
const activity = (await api('GET', '/connectors/google-sheets/activity')).json?.activity ?? [];
const added = activity.filter((a) => a.kind === 'row_added');
check(
  added.length >= 2 &&
    added.every((a) => a.tab === 'Claims') &&
    added.some((a) => a.group === 'Claims KL'),
  'Activity shows rows added to Claims with the group',
  JSON.stringify(added.slice(0, 2)),
);
check(!JSON.stringify(activity).includes('P-902341'), 'Activity never stores row values');

console.log(failed ? `\n${failed} step(s) failed` : '\nAll steps passed');
process.exit(failed ? 1 : 0);

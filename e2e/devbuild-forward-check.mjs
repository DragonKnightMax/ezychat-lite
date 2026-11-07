// Dev Build check for Forward (docs/features/forward-message/design.md) against a running Dev Build started with
//   npx tsx packages/server/src/cli.ts --data <temp> --port 7494 --fake-wa --mode dev --max-inboxes 3 --web-dist apps/web/dist
// on a fresh temp data folder. Usage: node e2e/devbuild-forward-check.mjs <port>
// It builds its own MP4 (a file-type box the server recognises, then padding) up to 70 MB.
// Prints PASS/FAIL per step; never calls a model or a real WhatsApp number (fake WhatsApp only).
import { randomUUID } from 'node:crypto';
import { checker, poll, wait } from './devbuild-client.mjs';

const PORT = Number(process.argv[2] ?? 7494);
// Only a local Dev Build: a numeric port on the loopback address, never another host.
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error('Usage: node e2e/devbuild-forward-check.mjs <port 1024-65535>');
const BASE = `http://127.0.0.1:${PORT}`;
const API_PATH = /^\/[\w%@.:?=&#/-]*$/;
const { check, finish } = checker();
const MB = 1024 * 1024;
/** An MP4 of `size` bytes: an `ftyp` box (what the server's type check reads), then zeros. */
const mp4 = (size) => {
  const head = Buffer.from([
    0,
    0,
    0,
    0x18,
    ...Buffer.from('ftypisom'),
    0,
    0,
    2,
    0,
    ...Buffer.from('isomiso2'),
  ]);
  return Buffer.concat([head, Buffer.alloc(size - head.length)]);
};

/** A signed-in session: JSON calls and one multipart upload, keeping the cookie. */
function session() {
  let cookie = '';
  const call = async (method, path, body, form) => {
    if (!API_PATH.test(path) || path.split('/').some((p) => p === '..' || p === '.'))
      throw new Error(`Unexpected API path: ${path}`);
    const url = new URL(`/api${path}`, BASE);
    if (url.origin !== BASE) throw new Error('Refusing a request outside the local Dev Build');
    const res = await fetch(url, {
      method,
      headers: {
        origin: BASE,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  };
  return call;
}
const enc = encodeURIComponent;
const code = (r) => r.json?.error?.code;

const admin = session();
const creds = { username: 'checker', displayName: 'Checker', password: 'check-pass-123' };
if ((await admin('GET', '/setup/status')).json.needsSetup)
  await admin('POST', '/setup/admin', creds);
check(
  (await admin('POST', '/auth/login', { username: creds.username, password: creds.password }))
    .status === 200,
  'admin signs in',
);

// Inbox 1 (linked phone), inbox 2 (a second linked phone), and a Business API inbox (fake-api).
const second = await admin('POST', '/inboxes', { name: 'Catering', memberIds: [] });
await admin('POST', '/dev/fake-link', { inboxId: second.json.id ?? second.json.inbox?.id ?? 2 });
const secondId = second.json.id ?? second.json.inbox?.id ?? 2;
const apiInbox = (await admin('POST', '/dev/fake-api-inbox', { name: 'Online orders' })).json;
const inboxes = (await admin('GET', '/inboxes')).json.inboxes;
const caps = (id) => inboxes.find((i) => i.id === id)?.capabilities ?? {};
check(
  caps(1).mediaLimits?.video === 64 * MB && caps(1).mediaLimits?.document === 2048 * MB,
  'a linked phone reports its limits (video 64 MB, documents 2 GB)',
  JSON.stringify(caps(1).mediaLimits),
);
check(
  caps(apiInbox.id).mediaLimits?.video === 16 * MB &&
    caps(apiInbox.id).mediaLimits?.document === 100 * MB &&
    !caps(apiInbox.id).forwardedMark,
  'the Business API inbox reports 16 MB video / 100 MB document and no Forwarded mark',
  JSON.stringify(caps(apiInbox.id)),
);

const incoming = async (inboxId, chatJid, senderName, text, extra = {}) =>
  (await admin('POST', '/dev/fake-incoming', { inboxId, chatJid, senderName, text, ...extra }))
    .json;
const farah = '60123110021@s.whatsapp.net';
const priya = '60128814455@s.whatsapp.net';
const jason = '60129001234@s.whatsapp.net';
const src = await incoming(1, farah, 'Farah Aziz', 'Our menu for the 30 pax event, please check');
const priyaKey = (await incoming(secondId, priya, 'Priya Nair', 'Hi, is my order ready?')).chatJid;
const jasonKey = (await incoming(apiInbox.id, jason, 'Jason Lim', 'Do you deliver today?')).chatJid;
check(
  priyaKey.endsWith(`#${secondId}`) && jasonKey.endsWith(`#${apiInbox.id}`),
  'three chats on three numbers',
  `${priyaKey} ${jasonKey}`,
);

// Text forward across numbers: one request, two chats on two other numbers.
const fwd = (api, id, to, extra = {}) =>
  api('POST', `/messages/${enc(id)}/forward`, { to, clientRequestId: randomUUID(), ...extra });
const r1 = await fwd(admin, src.id, [priyaKey, jasonKey]);
check(
  r1.status === 200 && r1.json.messages.length === 2,
  'a text forwards to chats on two other numbers',
  `${r1.status} ${JSON.stringify(r1.json).slice(0, 200)}`,
);
await wait(2500);
const last = async (key) =>
  (await admin('GET', `/chats/${enc(key)}/messages`)).json.messages.at(-1);
const copyPriya = await last(priyaKey);
const copyJason = await last(jasonKey);
check(
  copyPriya.body === 'Our menu for the 30 pax event, please check' &&
    copyPriya.forwarded?.manyTimes === false,
  'the copy on the second number is marked Forwarded',
  JSON.stringify({
    body: copyPriya.body,
    forwarded: copyPriya.forwarded,
    status: copyPriya.status,
  }),
);
check(
  copyJason.forwarded?.manyTimes === false && copyJason.status !== 'failed',
  'the Business API copy is sent and shown as Forwarded in the app',
  JSON.stringify({ forwarded: copyJason.forwarded, status: copyJason.status }),
);
const priyaChat = (await admin('GET', `/chats/${enc(priyaKey)}`)).json.chat;
check(priyaChat.assignedTo != null, 'the forward claimed the unassigned chat like a reply');

// Refusals: every chat checked before anything is sent.
await admin('POST', '/dev/fake-window', { chatJid: jasonKey, hoursAgo: 30 });
const before = (await admin('GET', `/chats/${enc(priyaKey)}/messages`)).json.messages.length;
const closed = await fwd(admin, src.id, [priyaKey, jasonKey]);
check(
  closed.status === 409 && code(closed) === 'window_closed',
  'a closed 24-hour window refuses the whole forward',
);
await wait(1500);
check(
  (await admin('GET', `/chats/${enc(priyaKey)}/messages`)).json.messages.length === before,
  'nothing was sent to the other chat',
);
const six = await admin('POST', `/messages/${enc(src.id)}/forward`, {
  to: [farah, priyaKey, jasonKey, 'a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net'],
  clientRequestId: randomUUID(),
});
check(six.status === 400, 'six chats are refused');
const stranger = await fwd(admin, src.id, ['60199999999@s.whatsapp.net']);
check(stranger.status === 404, 'a number without a chat is refused (404, never a new chat)');

// Large file: a 70 MB video (uploads now go up to 100 MB). As a video it is over the linked phone's
// 64 MB video limit, so the composer sends it as a file; then it is forwarded across numbers.
const video = mp4(70 * MB);
const videoForm = (fields) => {
  const f = new FormData();
  f.set('clientId', randomUUID());
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  f.set('file', new Blob([video], { type: 'video/mp4' }), 'Event hall walkthrough.mp4');
  return f;
};
const asVideoUp = await admin('POST', `/chats/${enc(farah)}/media`, undefined, videoForm({}));
check(
  asVideoUp.status === 413 && code(asVideoUp) === 'too_large_as_video',
  'a 70 MB video is over the linked phone’s 64 MB video limit',
  `${asVideoUp.status} ${code(asVideoUp)}`,
);
const up = await admin(
  'POST',
  `/chats/${enc(farah)}/media`,
  undefined,
  videoForm({ asFile: '1', caption: 'Walkthrough of the event hall for Saturday' }),
);
check(
  up.status === 201 && up.json.type === 'document' && up.json.mediaSize >= 69 * MB,
  'the composer sends the 70 MB video as a file (limit now 100 MB)',
  `${up.status} ${up.json?.type} ${up.json?.mediaSize}`,
);
const big = await poll(async () => {
  const m = await last(farah);
  return m.id && !m.id.startsWith('local-') ? m : null;
}, 20_000);
check(big?.status !== 'failed', 'WhatsApp took the 70 MB file', JSON.stringify(big?.status));
await admin('POST', '/dev/fake-window', { chatJid: jasonKey, hoursAgo: 1 });
const asFile = await fwd(admin, big.id, [priyaKey, jasonKey]);
check(
  asFile.status === 200 && asFile.json.messages.every((m) => m.type === 'document'),
  'the file forwards to the second number and the Business API chat (100 MB document limit)',
  `${asFile.status} ${code(asFile)} ${JSON.stringify(asFile.json?.messages?.map((m) => m.type))}`,
);
const sent = await poll(async () => {
  const m = await last(priyaKey);
  return m.status === 'sent' || m.status === 'delivered' ? m : null;
}, 20_000);
check(
  sent?.mediaSize >= 69 * MB && sent?.forwarded,
  'the large copy is sent with its size and Forwarded mark',
  JSON.stringify({ status: sent?.status, size: sent?.mediaSize }),
);
// A real video message (from WhatsApp) above a chat's video limit: refused as a video, fine as a file.
const clip = await incoming(1, farah, 'Farah Aziz', 'Short clip', {
  type: 'video',
  media: { mime: 'video/mp4', base64: mp4(4096).toString('base64') },
});
const clipFwd = await fwd(admin, clip.id, [jasonKey]);
check(clipFwd.status === 200, 'a small video forwards as a video to the Business API chat');
const tooBig = await admin(
  'POST',
  `/chats/${enc(jasonKey)}/media`,
  undefined,
  (() => {
    const f = new FormData();
    f.set('clientId', randomUUID());
    f.set('file', new Blob([video], { type: 'video/mp4' }), 'Event hall walkthrough.mp4');
    return f;
  })(),
);
check(
  tooBig.status === 413 && code(tooBig) === 'too_large_as_video',
  'uploading the 70 MB video to the Business API chat is refused as a video (16 MB)',
  `${tooBig.status} ${code(tooBig)}`,
);

// Audit: ids only.
const rows = (await admin('GET', '/audit?limit=100')).json.entries;
const fw = rows.filter((r) => r.action === 'message.forwarded');
check(fw.length === 3, 'Audit has the three forwards', String(fw.length));
check(
  !JSON.stringify(fw).includes('Our menu') && !JSON.stringify(fw).includes('walkthrough'),
  'audit rows carry ids only (no text, caption or file name)',
);
finish();

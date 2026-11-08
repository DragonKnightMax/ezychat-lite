// POST /mcp/uploads and the send tools' uploadId (design docs/features/mcp-file-upload/design.md):
// the real route (tokens, reach, raw and multipart bodies), the upload store's limits, and sends by
// uploadId, link and base64 through the real message service and fake WhatsApp.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LINKED_PHONE_CAPABILITIES, FakeWaAdapter } from '@ezychat/wa';
import { MCP_UPLOAD_TTL_MS } from '@ezychat/shared';
import { setMcpEnabled } from '../src/mcp/settings.js';
import { createInboxSendPort, guardedVideoFetcher } from '../src/mcp/send.js';
import {
  cleanUploadName,
  createUploadStore,
  UPLOAD_LIMITS,
  type UploadStore,
  type UploadLimits,
} from '../src/uploads/store.js';
import { MediaStore } from '../src/messages/media-store.js';
import { pdfFixture } from './ai-fixtures.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { data, mcpClient, sendTokens, waitFor } from './mcp-helpers.js';
import {
  bytesOf,
  httpsFixture,
  lastSendAudit,
  principalOf,
  sentRow,
  testUploadStore,
} from './mcp-send-media-helpers.js';

const LID = '9301@lid';
const PN = '60123459301@s.whatsapp.net';
const PDF = pdfFixture('Price list 2026');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** The start of an MP4 file (ftyp box) followed by padding: enough for the type check. */
const mp4 = (size: number) => {
  const head = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypmp42'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('mp42isom'),
  ]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
};
const VIDEO_LIMIT = 4096;
/** The test number's largest file (its document limit): a file above it never leaves this computer. */
const DOCUMENT_LIMIT = 200_000;

let t: TestApp;
let sender: string;
let senderId: number;
let readOnly: string;
let otherSender: string;
let uploadDir: string;
let clock = Date.now();

const mcp = mcpClient(() => t);
let n = 0;
const requestId = () => `upload-test-${++n}-abcdef`;

/** POST /mcp/uploads as a raw body. */
const uploadRaw = (
  body: Buffer,
  opts: { token?: string; name?: string; type?: string; remote?: string; headers?: object } = {},
) =>
  t.app.inject({
    method: 'POST',
    url: '/mcp/uploads',
    remoteAddress: opts.remote ?? '127.0.0.1',
    headers: {
      host: 'localhost',
      'content-type': opts.type ?? 'application/octet-stream',
      ...(opts.token === '' ? {} : { authorization: `Bearer ${opts.token ?? sender}` }),
      ...(opts.name ? { 'x-file-name': opts.name } : {}),
      ...opts.headers,
    },
    payload: body,
  });

/** POST /mcp/uploads as multipart/form-data with one part. */
const uploadMultipart = (file: Buffer, fileName: string, field = 'file', token = sender) => {
  const boundary = '----ezychat-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return t.app.inject({
    method: 'POST',
    url: '/mcp/uploads',
    remoteAddress: '127.0.0.1',
    headers: {
      host: 'localhost',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${token}`,
    },
    payload,
  });
};

/** The send queue keeps a second between sends in a chat: several sends need longer than waitFor. */
async function waitLong(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 20_000) throw new Error('waitLong timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const call = (name: string, args: Record<string, unknown>, token = sender) =>
  mcp.call(name, args, token);
const uploadFiles = () => readdirSync(uploadDir);

beforeAll(async () => {
  const wa = new FakeWaAdapter({
    capabilities: {
      ...LINKED_PHONE_CAPABILITIES,
      mediaLimits: { video: VIDEO_LIMIT, image: DOCUMENT_LIMIT, document: DOCUMENT_LIMIT },
    },
  });
  t = await makeTestApp({
    listen: true,
    wa,
    beforeBuild: (ctx) => {
      uploadDir = join(ctx.config.dataDir, 'uploads');
      ctx.services.uploads = createUploadStore(uploadDir, {
        log: pino({ level: 'silent' }),
        now: () => clock,
        freeBytes: () => 1e12,
      });
    },
  });
  let admin;
  ({ sender, senderId, readOnly, admin } = sendTokens(t));
  otherSender = t.ctx.services.apiTokens!.create(
    admin.id,
    { name: 'other', expiresInDays: 90, canSend: true },
    'ip',
  ).secret;
  t.wa.simulateIncoming({
    chatJid: LID,
    chatJidAlt: PN,
    body: 'Send the file',
    senderName: 'Aina',
  });
  await waitFor(() => mcp.count('SELECT COUNT(*) AS n FROM chats WHERE wa_jid = ?', LID) === 1);
});
afterAll(() => t.close());

describe('POST /mcp/uploads: reach and token', () => {
  it('answers 404 while AI assistant access is off, 403 to a LAN peer, 401 without a token', async () => {
    setMcpEnabled(t.ctx, false);
    expect((await uploadRaw(PDF)).statusCode).toBe(404);
    setMcpEnabled(t.ctx, true);
    expect((await uploadRaw(PDF, { remote: '192.168.1.20' })).statusCode).toBe(403);
    expect((await uploadRaw(PDF, { token: '' })).statusCode).toBe(401);
    expect((await uploadRaw(PDF, { token: 'ezc_pat_wrong' })).statusCode).toBe(401);
    expect(uploadFiles()).toEqual([]);
  });

  it("refuses a token that cannot send, and a declared body above the number's limit, before reading it", async () => {
    const r = await uploadRaw(PDF, { token: readOnly });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toMatch(/cannot send/);
    const big = await uploadRaw(PDF, {
      headers: { 'content-length': String(DOCUMENT_LIMIT + 1) },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('too_large_for_whatsapp');
    // the rest of a refused body is not drained: the connection closes
    expect(big.headers.connection).toBe('close');
    expect(uploadFiles()).toEqual([]);
  });
});

describe('POST /mcp/uploads: bodies', () => {
  it('takes a raw PDF with X-File-Name, typed from the bytes, into a private file', async () => {
    const r = await uploadRaw(PDF, {
      name: encodeURIComponent('../Senarai harga é.pdf'),
      type: 'image/png',
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = r.json();
    expect(body).toMatchObject({
      name: 'Senarai harga é.pdf',
      type: 'application/pdf',
      size: PDF.length,
      expiresAt: clock + MCP_UPLOAD_TTL_MS,
    });
    expect(body.uploadId).toMatch(/^upl_[a-f0-9]{32}$/);
    const files = uploadFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(join(uploadDir, files[0]!))).toEqual(PDF);
    if (process.platform !== 'win32') {
      expect(statSync(join(uploadDir, files[0]!)).mode & 0o777).toBe(0o600);
      expect(statSync(uploadDir).mode & 0o777).toBe(0o700);
    }
    const store = t.ctx.services.uploads!;
    store.discard(store.take(senderId, body.uploadId)!.path);
    expect(uploadFiles()).toEqual([]);
  });

  it('takes multipart form data with one part named file', async () => {
    const r = await uploadMultipart(PNG, 'photo.png');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'photo.png', type: 'image/png', size: PNG.length });
    const store = t.ctx.services.uploads!;
    store.discard(store.take(senderId, r.json().uploadId)!.path);
    const wrong = await uploadMultipart(PNG, 'photo.png', 'image');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toMatch(/named "file"/);
    expect(uploadFiles()).toEqual([]);
  });

  it('refuses a type it cannot send (415), an empty body and a JSON body, keeping nothing', async () => {
    const zip = await uploadRaw(Buffer.from('PK\x03\x04 not a document'), { name: 'a.zip' });
    expect(zip.statusCode).toBe(415);
    expect(zip.json().error.code).toBe('upload_type');
    expect((await uploadRaw(Buffer.alloc(0))).statusCode).toBe(400);
    const json = await uploadRaw(Buffer.from('{"a":1}'), { type: 'application/json' });
    expect(json.statusCode).toBe(415);
    expect(uploadFiles()).toEqual([]);
  });
});

describe('send tools with uploadId', () => {
  const upload = async (file: Buffer, name: string, token = sender) => {
    const r = await uploadRaw(file, { name, token });
    expect(r.statusCode).toBe(201);
    return r.json().uploadId as string;
  };

  it('send_file sends an upload by path once, under its own name; the audit has type and size', async () => {
    const uploadId = await upload(PDF, 'Price list.pdf');
    const id = requestId();
    const r = await call('send_file', { jid: LID, uploadId, caption: 'Our prices', requestId: id });
    expect(r.isError).toBeFalsy();
    expect(data(r)).toMatchObject({ duplicate: false });
    expect(sentRow(t, senderId, id)).toMatchObject({
      type: 'document',
      media_mime: 'application/pdf',
      media_name: 'Price list.pdf',
      body: 'Our prices',
      sent_via_token_id: senderId,
    });
    // moved into the media store: nothing is left in the upload folder
    expect(uploadFiles()).toEqual([]);
    await waitFor(() => t.wa.sent.some((s) => s.file?.fileName === 'Price list.pdf'));
    const sent = t.wa.sent.find((s) => s.file?.fileName === 'Price list.pdf')!;
    expect(sent.file!.path).toBeTruthy();
    expect(sent.file!.buffer).toEqual(PDF);
    const audit = lastSendAudit(t);
    expect(audit.meta).toMatchObject({ type: 'document', size: PDF.length, tokenId: senderId });
    expect(audit.raw).not.toMatch(/Price list|Our prices/);

    // a retry returns that message; the upload is used up for anything new
    const again = await call('send_file', {
      jid: LID,
      uploadId,
      caption: 'Our prices',
      requestId: id,
    });
    expect(data(again)).toMatchObject({ duplicate: true });
    const reuse = await call('send_file', { jid: LID, uploadId, requestId: requestId() });
    expect(reuse.isError).toBe(true);
    expect(reuse.content[0]!.text).toMatch(/No upload .* already sent, it expired/);
  });

  it("never sends another token's upload, a wrong kind, or an expired one", async () => {
    const theirs = await upload(PDF, 'theirs.pdf', otherSender);
    const r = await call('send_file', { jid: LID, uploadId: theirs, requestId: requestId() });
    expect(r.content[0]!.text).toMatch(/No upload/);

    const pdf = await upload(PDF, 'not-a-photo.pdf');
    const img = await call('send_image', { jid: LID, uploadId: pdf, requestId: requestId() });
    expect(img.content[0]!.text).toMatch(/Only JPEG, PNG or WebP/);
    // a refused send keeps the upload for another try
    const file = await call('send_file', { jid: LID, uploadId: pdf, requestId: requestId() });
    expect(file.isError).toBeFalsy();

    const old = await upload(PNG, 'old.png');
    clock += MCP_UPLOAD_TTL_MS + 1;
    const expired = await call('send_image', { jid: LID, uploadId: old, requestId: requestId() });
    expect(expired.content[0]!.text).toMatch(/No upload/);
    // the other token's upload expired too: the sweep removes it
    t.ctx.services.uploads!.sweep();
    expect(uploadFiles()).toEqual([]);
    expect(t.ctx.services.uploads!.get(principalOf(t, otherSender).tokenId, theirs)).toBeNull();
  });

  it('lends an upload to one send at a time, and gives a refused one back', async () => {
    const store = t.ctx.services.uploads!;
    const uploadId = await upload(PDF, 'one.pdf');
    const taken = store.take(senderId, uploadId)!;
    // while one send has it, another send and the sweep cannot use or delete it
    const second = await call('send_file', { jid: LID, uploadId, requestId: requestId() });
    expect(second.content[0]!.text).toMatch(/No upload/);
    clock += MCP_UPLOAD_TTL_MS + 1;
    store.sweep();
    expect(existsSync(taken.path)).toBe(true);
    // given back after it expired: deleted
    store.restore(taken);
    expect(existsSync(taken.path)).toBe(false);
    expect(store.get(senderId, uploadId)).toBeNull();
  });

  it('needs exactly one source and a name for a base64 or link file', async () => {
    const uploadId = await upload(PNG, 'a.png');
    const both = await call('send_image', {
      jid: LID,
      uploadId,
      imageBase64: PNG.toString('base64'),
      requestId: requestId(),
    });
    expect(both.content[0]!.text).toMatch(/exactly one/);
    const bad = await call('send_image', { jid: LID, uploadId: 'upl_123', requestId: requestId() });
    expect(bad.isError).toBe(true);
    const ok = await call('send_image', { jid: LID, uploadId, requestId: requestId() });
    expect(ok.isError).toBeFalsy();
  });

  it('send_video sends a video, or a file above the number limit or when asked', async () => {
    const small = await upload(mp4(1000), 'clip.mp4');
    const r1 = await call('send_video', { jid: LID, uploadId: small, requestId: requestId() });
    expect(data(r1)).toMatchObject({ sentAs: 'video' });

    const big = await upload(mp4(VIDEO_LIMIT + 1), 'long.mp4');
    const id = requestId();
    const r2 = await call('send_video', { jid: LID, uploadId: big, requestId: id });
    expect(data(r2)).toMatchObject({ sentAs: 'file' });
    expect(sentRow(t, senderId, id)).toMatchObject({ type: 'document', media_name: 'long.mp4' });
    await waitLong(() => t.wa.sent.some((s) => s.file?.fileName === 'long.mp4'));
    expect(t.wa.sent.find((s) => s.file?.fileName === 'long.mp4')!.file!.asDocument).toBe(true);
    // the retry of a video that went as a file is the same message
    const again = await call('send_video', { jid: LID, uploadId: big, requestId: id });
    expect(data(again)).toMatchObject({ duplicate: true });

    const forced = await upload(mp4(VIDEO_LIMIT + 1), 'forced.mp4');
    const r3 = await call('send_video', {
      jid: LID,
      uploadId: forced,
      sendAs: 'video',
      requestId: requestId(),
    });
    expect(r3.content[0]!.text).toMatch(/too_large_as_video/);
    const r4 = await call('send_video', {
      jid: LID,
      uploadId: forced,
      sendAs: 'file',
      requestId: requestId(),
    });
    expect(data(r4)).toMatchObject({ sentAs: 'file' });

    const notVideo = await upload(PNG, 'x.png');
    const r5 = await call('send_video', { jid: LID, uploadId: notVideo, requestId: requestId() });
    expect(r5.content[0]!.text).toMatch(/Only MP4/);
    const b64 = await call('send_video', {
      jid: LID,
      videoBase64: mp4(800).toString('base64'),
      requestId: requestId(),
    });
    expect(data(b64)).toMatchObject({ sentAs: 'video' });
  });
});

describe('POST /mcp/uploads: a client that goes away', () => {
  it('answers 400 upload_incomplete and keeps nothing', async () => {
    const { store, dir } = testUploadStore();
    const broken = new Readable({
      read() {
        this.push(PDF.subarray(0, 10));
        this.destroy(new Error('aborted'));
      },
    });
    await expect(store.receive(1, broken, { name: 'a.pdf' })).rejects.toMatchObject({
      status: 400,
      code: 'upload_incomplete',
    });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('send port: link downloads stream to a temporary file', () => {
  it('moves the download into the message, and removes it when the send is refused', async () => {
    const { store, dir } = testUploadStore();
    const write = (bytes: Buffer) => {
      const path = join(dir, `dl-${++n}.bin`);
      writeFileSync(path, bytes);
      return { path, size: bytes.length };
    };
    const port = createInboxSendPort(t.ctx, {
      uploads: store,
      fetchVideo: async (_url, tokenId) => (tokens.push(tokenId), write(mp4(900))),
      fetchFile: async () => write(Buffer.from('not a pdf at all')),
    });
    const principal = principalOf(t, sender);
    const tokens: number[] = [];
    const sent = await port.sendVideo(principal, {
      jid: LID,
      videoUrl: 'https://example.com/v.mp4',
      requestId: requestId(),
    });
    expect(sent.sentAs).toBe('video');
    expect(tokens).toEqual([senderId]);
    expect(readdirSync(dir)).toEqual([]);
    await expect(
      port.sendFile(principal, {
        jid: LID,
        fileUrl: 'https://example.com/a.pdf',
        fileName: 'a.pdf',
        requestId: requestId(),
      }),
    ).rejects.toThrow(/Only PDF or Word/);
    expect(readdirSync(dir)).toEqual([]);
    await expect(
      port.sendFile(principal, {
        jid: LID,
        fileUrl: 'https://example.com/a.pdf',
        requestId: requestId(),
      }),
    ).rejects.toThrow(/fileName is required/);
  });

  it('guardedVideoFetcher writes the download to disk, within its limit', async () => {
    const video = mp4(2048);
    const site = await httpsFixture({ '/v.mp4': video }, 8192);
    try {
      const { store, dir } = testUploadStore();
      const get = guardedVideoFetcher(store, { allowLoopback: true, ca: site.ca });
      const got = await get(`${site.origin}/v.mp4`, 1, 4096);
      expect(Buffer.isBuffer(got)).toBe(false);
      expect(bytesOf(got)).toEqual(video);
      // above the chat's number's limit (declared by the server, so nothing is read)
      await expect(get(`${site.origin}/big`, 1, 4096)).rejects.toThrow(
        /too_large_for_whatsapp: .*up to 1 MB/,
      );
      // no limit known: only the disk bounds it
      await expect(get(`${site.origin}/big`, 1)).resolves.toBeTruthy();
      await expect(get(`${site.origin}/missing`, 1, 4096)).rejects.toThrow(/answered 404/);
      expect(readdirSync(dir)).toHaveLength(2);
      const full = createUploadStore(testUploadStore().dir + '-full', {
        log: pino({ level: 'silent' }),
        freeBytes: () => 0,
      });
      const none = guardedVideoFetcher(full, { allowLoopback: true, ca: site.ca });
      await expect(none(`${site.origin}/v.mp4`, 7, 4096)).rejects.toThrow(/free disk space/);
    } finally {
      await site.close();
    }
  });
});

describe('upload store limits', () => {
  const body = (bytes: Buffer) => Readable.from([bytes]);
  const time = 1_000_000;
  const make = (limits: Partial<UploadLimits> = {}, free = 1e12) => testStore(limits, free);
  function testStore(limits: Partial<UploadLimits>, free: number) {
    const dir = testUploadStore().dir + '-limits';
    return {
      dir,
      store: createUploadStore(dir, {
        log: pino({ level: 'silent' }),
        now: () => time,
        freeBytes: () => free,
        limits,
      }) as UploadStore,
    };
  }

  it('counts uploads an hour per token and refuses above the limit', async () => {
    const { store } = make({ perHour: { windowMs: 60_000, max: 2 } });
    await store.receive(1, body(PDF), { name: 'a.pdf' });
    await store.receive(1, body(PDF), { name: 'b.pdf' });
    await expect(store.receive(1, body(PDF), { name: 'c.pdf' })).rejects.toMatchObject({
      status: 429,
    });
    await expect(store.receive(2, body(PDF), { name: 'c.pdf' })).resolves.toBeTruthy();
  });

  it("refuses a file above the WhatsApp number's limit while it streams, and deletes it", async () => {
    const { store, dir } = make();
    await expect(
      store.receive(1, body(Buffer.alloc(101)), { name: 'big', maxBytes: 100 }),
    ).rejects.toMatchObject({ status: 413, code: 'too_large_for_whatsapp' });
    await expect(
      store.receive(1, body(PDF), { name: 'big', declaredLength: 500, maxBytes: 100 }),
    ).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(dir)).toEqual([]);
    // no limit of our own: a file without a WhatsApp limit is bounded by the disk only
    const big = Buffer.concat([PDF, Buffer.alloc(300_000)]);
    await expect(store.receive(1, body(big), { name: 'big.pdf' })).resolves.toMatchObject({
      size: big.length,
    });
  });

  it('stops a file when the disk would get too full, while it streams', async () => {
    const { store, dir } = make({}, UPLOAD_LIMITS.minFreeBytes + 50);
    await expect(store.receive(1, body(Buffer.alloc(51)), { name: 'x' })).rejects.toMatchObject({
      status: 507,
      code: 'upload_storage_full',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('limits waiting uploads per token, and keeps free disk space', async () => {
    const pending = make({ pendingPerToken: 1 });
    await pending.store.receive(1, body(PDF), { name: 'a.pdf' });
    await expect(pending.store.receive(1, body(PDF), { name: 'b.pdf' })).rejects.toMatchObject({
      code: 'upload_pending_limit',
    });
    const full = make({}, UPLOAD_LIMITS.minFreeBytes + 10);
    await expect(
      full.store.receive(1, body(PDF), { name: 'a.pdf', declaredLength: PDF.length }),
    ).rejects.toMatchObject({ status: 507, code: 'upload_storage_full' });
    await expect(
      full.store.writeTemp('user:1', body(PDF), { maxBytes: 1000 }),
    ).rejects.toMatchObject({ status: 507 });
  });

  it('receives at most two uploads of a token at the same time', async () => {
    const { store } = make();
    const slow = () => new Readable({ read() {} });
    const a = slow();
    const b = slow();
    const first = store.receive(1, a, { name: 'a' });
    const second = store.receive(1, b, { name: 'b' });
    await expect(store.receive(1, body(PDF), { name: 'c.pdf' })).rejects.toMatchObject({
      status: 429,
    });
    a.push(PDF);
    a.push(null);
    b.push(PDF);
    b.push(null);
    await Promise.all([first, second]);
    await expect(store.receive(1, body(PDF), { name: 'c.pdf' })).resolves.toBeTruthy();
  });

  it('stops a sender that stalls (408) and deletes what arrived', async () => {
    const dir = testUploadStore().dir + '-slow';
    const store = createUploadStore(dir, {
      log: pino({ level: 'silent' }),
      freeBytes: () => 1e12,
      timeouts: { idleMs: 30 },
    });
    const stalled = new Readable({ read() {} });
    stalled.push(PDF.subarray(0, 10));
    await expect(store.receive(1, stalled, { name: 'a.pdf' })).rejects.toMatchObject({
      status: 408,
      code: 'upload_timeout',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('starts empty: files left from before a restart are deleted', () => {
    const { store, dir } = make();
    writeFileSync(join(dir, 'left.bin'), 'x');
    store.shutdown();
    createUploadStore(dir, { log: pino({ level: 'silent' }) }).shutdown();
    expect(existsSync(join(dir, 'left.bin'))).toBe(false);
  });
});

describe('cleanUploadName', () => {
  it('keeps the last path segment without control characters, at most 120 characters', () => {
    expect(cleanUploadName('C:\\Users\\me\\quote.pdf')).toBe('quote.pdf');
    expect(cleanUploadName('a\u0000b\u202e.pdf')).toBe('ab.pdf');
    expect(cleanUploadName('%E2%9C%93 ok.pdf')).toBe('✓ ok.pdf');
    expect(cleanUploadName('100%.pdf')).toBe('100%.pdf');
    expect(cleanUploadName(undefined)).toBe('file');
    expect(cleanUploadName('..')).toBe('file');
    expect(cleanUploadName('x'.repeat(200))).toHaveLength(120);
  });
});

describe('MediaStore.adopt', () => {
  it('moves a file in, and copies it when a move is not possible', () => {
    const { dir } = testUploadStore();
    const media = new MediaStore(join(dir, 'media'));
    const src = join(dir, 'in.bin');
    writeFileSync(src, PDF);
    const rel = media.adopt('60111@s.whatsapp.net', 'local-x', src, 'pdf');
    expect(readFileSync(media.abs(rel))).toEqual(PDF);
    expect(existsSync(src)).toBe(false);
    // a source that cannot be renamed (a missing one) fails like the copy would
    expect(() => media.adopt('60111@s.whatsapp.net', 'local-y', src, 'pdf')).toThrow();
  });
});

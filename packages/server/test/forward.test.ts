import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForwardMessageResponse, type Message } from '@ezychat/shared';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { mediaLimitKind, mediaLimitRefusal } from '../src/messages/forward.js';
import { conversationLine } from '../src/ai/conversation.js';

const enc = encodeURIComponent;
const A = '60111000001@s.whatsapp.net';
const B = '60111000002@s.whatsapp.net';
const D = '60111000003@s.whatsapp.net';
const B2 = `${B}#2`;
const D3 = `${D}#3`;

let t: TestApp;
let admin: { cookie: string; id: number };

async function waitFor(fn: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Row {
  id: string;
  chat_jid: string;
  type: string;
  body: string | null;
  status: string;
  client_id: string | null;
  sent_by_user_id: number | null;
  forwarding_score: number | null;
  media_path: string | null;
  media_size: number | null;
  media_name: string | null;
}
const rowsOf = (chatJid: string) =>
  t.ctx.db
    .prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY created_at, rowid')
    .all(chatJid) as Row[];
const rowById = (id: string) =>
  t.ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
/** A copy's row by its client id (the row is renamed to the WhatsApp id once sent). */
const rowOf = (m: { clientId: string | null }) =>
  t.ctx.db.prepare('SELECT * FROM messages WHERE client_id = ?').get(m.clientId) as Row;
const mediaAbs = (rel: string) => join(t.ctx.config.dataDir, 'media', rel);
const forwardAudits = () =>
  (
    t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'message.forwarded' ORDER BY id")
      .all() as Array<{ meta: string }>
  ).map((r) => JSON.parse(r.meta) as Record<string, unknown>);

let reqSeq = 0;
async function forward(
  cookie: string,
  id: string,
  to: string[],
  extra: { clientRequestId?: string; sendAs?: 'original' | 'file' } = {},
) {
  return t.app.inject({
    method: 'POST',
    url: `/api/messages/${enc(id)}/forward`,
    headers: authHeaders(cookie),
    payload: { to, clientRequestId: extra.clientRequestId ?? `req-${++reqSeq}`, ...extra },
  });
}
const code = (r: { statusCode: number; json(): { error: { code: string } } }) => [
  r.statusCode,
  r.json().error.code,
];

/** A live inbound message through an inbox's fake phone; returns the stored message. */
async function incoming(
  inbox: number,
  chatJid: string,
  body: string,
  extra: Partial<Parameters<TestApp['wa']['simulateIncoming']>[0]> = {},
): Promise<Message> {
  const wa = t.inboxWa(inbox);
  const got = new Promise<Message>((resolve) => {
    const on = (m: Message) => {
      if (m.body === body && !m.fromMe) {
        t.ctx.bus.off('message:new', on);
        resolve(m);
      }
    };
    t.ctx.bus.on('message:new', on);
  });
  wa.simulateIncoming({ chatJid, body, senderName: 'Customer', ...extra });
  return got;
}

function mediaOf(mime: string, bytes: Buffer, fileName: string | null = null) {
  return { mime, fileName, download: async () => bytes };
}

let fakeApiInbox: number;
beforeEach(async () => {
  t = await makeTestApp({ maxInboxes: 3, inboxes: 2 });
  const a = await createUserAndLogin(t, { role: 'admin' });
  admin = { cookie: a.cookie, id: a.user.id };
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/dev/fake-api-inbox',
    headers: authHeaders(admin.cookie),
    payload: { name: 'Online orders', memberIds: [] },
  });
  expect(r.statusCode).toBe(201);
  fakeApiInbox = r.json().id;
  expect(fakeApiInbox).toBe(3);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

describe('POST /api/messages/:id/forward', () => {
  it('forwards a text to chats of two numbers, as WhatsApp "Forwarded", claims them and audits ids only', async () => {
    const src = await incoming(1, A, 'Promo: 20% off today');
    await incoming(1, D, 'hello from D');
    await incoming(2, B, 'hello from B on two');

    const r = await forward(admin.cookie, src.id, [D, B2, D], { clientRequestId: 'fw-1' });
    expect(r.statusCode).toBe(200);
    const res = ForwardMessageResponse.parse(r.json());
    // de-duplicated, in the order given
    expect(res.messages.map((m) => m.chatJid)).toEqual([D, B2]);
    for (const m of res.messages) {
      expect(m).toMatchObject({
        body: 'Promo: 20% off today',
        fromMe: true,
        sentByUserId: admin.id,
        forwarded: { manyTimes: false },
        type: 'text',
      });
    }
    // each copy goes from its own chat's number, with the Forwarded mark (score 1)
    await waitFor(() => t.inboxWa(1).sent.length === 1 && t.inboxWa(2).sent.length === 1);
    expect(t.inboxWa(1).sent[0]).toMatchObject({
      chatJid: D,
      text: 'Promo: 20% off today',
      forwarded: { score: 1 },
    });
    expect(t.inboxWa(2).sent[0]).toMatchObject({ chatJid: B, forwarded: { score: 1 } });
    expect(t.inboxWa(1).sent[0]!.mentions).toBeUndefined();

    const rows = [...rowsOf(D), ...rowsOf(B2)].filter((x) => x.client_id?.startsWith('fw-1:'));
    expect(rows.map((x) => [x.client_id, x.forwarding_score, x.sent_by_user_id])).toEqual([
      ['fw-1:0', 1, admin.id],
      ['fw-1:1', 1, admin.id],
    ]);
    // forwarding claims the chat like a reply
    const assigned = (jid: string) =>
      (
        t.ctx.db.prepare('SELECT assigned_to FROM chats WHERE jid = ?').get(jid) as {
          assigned_to: number | null;
        }
      ).assigned_to;
    expect(assigned(D)).toBe(admin.id);
    expect(assigned(B2)).toBe(admin.id);

    const audits = forwardAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      messageId: src.id,
      chatJids: [D, B2],
      messageIds: res.messages.map((m) => m.id),
    });
    expect(JSON.stringify(audits[0])).not.toContain('Promo');

    // the same request again answers the same copies and sends nothing new
    await waitFor(() => rowsOf(D).every((x) => x.status !== 'pending'));
    const again = await forward(admin.cookie, src.id, [D, B2], { clientRequestId: 'fw-1' });
    expect(again.statusCode).toBe(200);
    expect(ForwardMessageResponse.parse(again.json()).messages.map((m) => m.clientId)).toEqual([
      'fw-1:0',
      'fw-1:1',
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.inboxWa(1).sent).toHaveLength(1);
    expect(forwardAudits()).toHaveLength(1);

    // another person cannot re-use the request id
    const agent = await createUserAndLogin(t, { role: 'agent' });
    t.ctx.inboxes.repo.setMembers(1, [agent.user.id]);
    expect(code(await forward(agent.cookie, src.id, [D], { clientRequestId: 'fw-1' }))).toEqual([
      409,
      'duplicate_request',
    ]);
  });

  it('stores and shows a customer’s forwarded message, adds one to the score, and many times goes to one chat', async () => {
    const once = await incoming(1, A, 'forwarded once', { forwardingScore: 2 });
    expect(once.forwarded).toEqual({ manyTimes: false });
    expect(rowById(once.id)!.forwarding_score).toBe(2);
    const plain = await incoming(1, A, 'my own words');
    expect(plain.forwarded).toBeUndefined();
    const many = await incoming(1, A, 'rumour', { forwardingScore: 5 });
    expect(many.forwarded).toEqual({ manyTimes: true });
    await incoming(1, D, 'd');
    await incoming(2, B, 'b');

    const r = await forward(admin.cookie, once.id, [D]);
    expect(r.statusCode).toBe(200);
    expect(rowOf(r.json().messages[0]).forwarding_score).toBe(3);
    await waitFor(() => t.inboxWa(1).sent.length === 1);
    expect(t.inboxWa(1).sent[0]!.forwarded).toEqual({ score: 3 });

    expect(code(await forward(admin.cookie, many.id, [D, B2]))).toEqual([
      400,
      'forward_many_times',
    ]);
    const one = await forward(admin.cookie, many.id, [B2]);
    expect(one.statusCode).toBe(200);
    expect(one.json().messages[0].forwarded).toEqual({ manyTimes: true });

    // history imports carry the mark too
    const hist = await getMessages(t.ctx).ingest(
      {
        id: 'HIST-FWD-1',
        chatJid: A,
        chatJidAlt: null,
        senderJid: A,
        senderJidAlt: null,
        senderName: 'Customer',
        fromMe: false,
        type: 'text',
        body: 'old forward',
        quotedId: null,
        forwardingScore: 7,
        timestamp: Date.now() - 60_000,
        media: null,
      },
      'history',
    );
    expect(hist!.forwarded).toEqual({ manyTimes: true });
    expect(rowById('HIST-FWD-1')!.forwarding_score).toBe(7);
  });

  it('re-sends a stored file: one file per copy, streamed by path, size kept, captions kept', async () => {
    const bytes = Buffer.from('JPEG-ish bytes of a photo');
    const src = await incoming(1, A, 'menu photo', {
      type: 'image',
      media: mediaOf('image/jpeg', bytes),
    });
    expect(src.mediaSize).toBe(bytes.length);
    await incoming(1, D, 'd');
    await incoming(2, B, 'b');

    const r = await forward(admin.cookie, src.id, [D, B2]);
    expect(r.statusCode).toBe(200);
    const copies = ForwardMessageResponse.parse(r.json()).messages;
    expect(copies.map((m) => [m.type, m.body, m.mediaSize, m.mediaMime])).toEqual([
      ['image', 'menu photo', bytes.length, 'image/jpeg'],
      ['image', 'menu photo', bytes.length, 'image/jpeg'],
    ]);
    const paths = copies.map((m) => rowOf(m).media_path!);
    const sourcePath = rowById(src.id)!.media_path!;
    expect(new Set([sourcePath, ...paths]).size).toBe(3);
    for (const p of paths) expect(readFileSync(mediaAbs(p))).toEqual(bytes);

    await waitFor(() => t.inboxWa(1).sent.length === 1 && t.inboxWa(2).sent.length === 1);
    const sent = t.inboxWa(1).sent[0]!;
    expect(sent.file).toMatchObject({ mime: 'image/jpeg', caption: 'menu photo' });
    expect(sent.file!.path).toBe(mediaAbs(paths[0]!));
    expect(sent.file!.buffer).toEqual(bytes);
    expect(sent.forwarded).toEqual({ score: 1 });

    // deleting one copy's file never removes another's
    unlinkSync(mediaAbs(sourcePath));
    for (const p of paths) expect(existsSync(mediaAbs(p))).toBe(true);
  });

  it('sends a video as a file on request, and keeps a voice note a voice note', async () => {
    const video = await incoming(1, A, 'event hall', {
      type: 'video',
      media: mediaOf('video/mp4', Buffer.from('fake mp4 bytes')),
    });
    await incoming(1, D, 'd');
    const r = await forward(admin.cookie, video.id, [D], { sendAs: 'file' });
    expect(r.statusCode).toBe(200);
    const copy = r.json().messages[0] as Message;
    expect(copy).toMatchObject({
      type: 'document',
      mediaMime: 'video/mp4',
      mediaName: 'video.mp4',
    });
    await waitFor(() => t.inboxWa(1).sent.length === 1);
    expect(t.inboxWa(1).sent[0]!.file).toMatchObject({ asDocument: true, mime: 'video/mp4' });

    // a voice note: the source row says so; the copy keeps it
    const voice = await incoming(1, A, '', {
      type: 'audio',
      media: mediaOf('audio/ogg; codecs=opus', Buffer.from('not really ogg')),
    });
    t.ctx.db.prepare('UPDATE messages SET voice_note = 1 WHERE id = ?').run(voice.id);
    const v = await forward(admin.cookie, voice.id, [D]);
    expect(v.statusCode).toBe(200);
    expect(v.json().messages[0]).toMatchObject({ type: 'audio', voiceNote: true, body: null });
  });

  it('a failed copy fails alone, and Retry re-sends it with its Forwarded mark', async () => {
    const src = await incoming(1, A, 'retry me');
    await incoming(1, D, 'd');
    t.inboxWa(1).failNextSend(new Error('Upload to WhatsApp failed'));
    const r = await forward(admin.cookie, src.id, [D]);
    const copy = r.json().messages[0] as Message;
    await waitFor(() => rowOf(copy)?.status === 'failed');
    const id = rowOf(copy).id;
    const retry = await t.app.inject({
      method: 'POST',
      url: `/api/messages/${enc(id)}/retry`,
      headers: authHeaders(admin.cookie),
    });
    expect(retry.statusCode).toBe(200);
    await waitFor(() => t.inboxWa(1).sent.length === 1);
    expect(t.inboxWa(1).sent[0]).toMatchObject({ text: 'retry me', forwarded: { score: 1 } });
  });

  it('refuses sources that cannot be forwarded', async () => {
    const src = await incoming(1, A, 'source');
    await incoming(1, D, 'd');
    const body = (id: string) => forward(admin.cookie, id, [D]);
    expect((await body('nope')).statusCode).toBe(404);

    t.ctx.db.prepare('UPDATE messages SET deleted_at = 1 WHERE id = ?').run(src.id);
    expect(code(await body(src.id))).toEqual([409, 'message_deleted']);
    t.ctx.db
      .prepare('UPDATE messages SET deleted_at = NULL, hidden_at = 1 WHERE id = ?')
      .run(src.id);
    expect(code(await body(src.id))).toEqual([409, 'message_deleted']);
    t.ctx.db
      .prepare('UPDATE messages SET hidden_at = NULL, type = ? WHERE id = ?')
      .run('system', src.id);
    expect(code(await body(src.id))).toEqual([409, 'message_not_forwardable']);
    t.ctx.db.prepare("UPDATE messages SET type = 'text' WHERE id = ?").run(src.id);

    // not sent yet: a pending local copy, and a failed send under its WhatsApp id
    t.inboxWa(1).simulateStatus({ state: 'disconnected' });
    const pending = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(D)}/messages`,
      headers: authHeaders(admin.cookie),
      payload: { text: 'waiting', clientId: 'p-1' },
    });
    expect(code(await body(pending.json().id))).toEqual([409, 'message_not_sent']);
    t.inboxWa(1).simulateStatus({ state: 'open' });
    t.ctx.db.prepare("UPDATE messages SET status = 'failed' WHERE id = ?").run(src.id);
    t.ctx.db.prepare('UPDATE messages SET from_me = 1 WHERE id = ?').run(src.id);
    expect(code(await body(src.id))).toEqual([409, 'message_not_sent']);
    expect(t.inboxWa(1).sent.filter((s) => s.forwarded)).toHaveLength(0);
  });

  it('never forwards what WhatsApp Safety locked or is still checking (admins too)', async () => {
    const src = await incoming(1, A, 'payment slip');
    await incoming(1, D, 'd');
    const safety = t.ctx.services.safety!;
    const level = vi.spyOn(safety, 'levelOf').mockReturnValue('high');
    expect(code(await forward(admin.cookie, src.id, [D]))).toEqual([409, 'safety_locked']);
    level.mockReturnValue('none');
    vi.spyOn(safety, 'cacheable').mockReturnValue(false);
    expect(code(await forward(admin.cookie, src.id, [D]))).toEqual([409, 'safety_locked']);
  });

  it('checks every chosen chat before anything is sent', async () => {
    const src = await incoming(1, A, 'to many');
    await incoming(1, D, 'd');
    await incoming(2, B, 'b');
    await incoming(fakeApiInbox, D, 'order please');
    const sentNothing = () =>
      expect([1, 2, 3].map((i) => t.inboxWa(i).sent.length)).toEqual([0, 0, 0]);

    // more than five chats, no chat
    expect((await forward(admin.cookie, src.id, [A, B, D, B2, D3, 'x'])).statusCode).toBe(400);
    expect((await forward(admin.cookie, src.id, [])).statusCode).toBe(400);
    // a chat that does not exist (never a new number)
    expect(code(await forward(admin.cookie, src.id, [D, '60199999999@s.whatsapp.net']))).toEqual([
      404,
      'not_found',
    ]);
    // the Business API chat's reply window closed
    t.ctx.db
      .prepare('UPDATE chats SET last_inbound_at = ? WHERE jid = ?')
      .run(Date.now() - 25 * 3_600_000, D3);
    expect(code(await forward(admin.cookie, src.id, [D, D3]))).toEqual([409, 'window_closed']);
    // the number of one chat is offline: refused, not queued
    t.inboxWa(2).simulateStatus({ state: 'disconnected' });
    expect(code(await forward(admin.cookie, src.id, [D, B2]))).toEqual([503, 'wa_disconnected']);
    t.inboxWa(2).simulateStatus({ state: 'open' });
    // a removed inbox keeps its chats read only
    t.ctx.db.prepare('UPDATE inboxes SET removed_at = ? WHERE id = 2').run(Date.now());
    expect(code(await forward(admin.cookie, src.id, [D, B2]))).toEqual([409, 'inbox_removed']);
    t.ctx.db.prepare('UPDATE inboxes SET removed_at = NULL WHERE id = 2').run();
    // the chat's number now belongs to someone else
    const aliases = t.ctx.services.aliases!;
    const moved = vi.spyOn(aliases, 'movedAway').mockImplementation((jid) => jid === B);
    expect(code(await forward(admin.cookie, src.id, [D, B2]))).toEqual([409, 'chat_number_moved']);
    moved.mockRestore();
    await new Promise((r) => setTimeout(r, 30));
    sentNothing();
    expect(forwardAudits()).toHaveLength(0);
  });

  it('keeps agents to their inboxes and limited agents to their chosen chats (404), never the AI', async () => {
    const src1 = await incoming(1, A, 'in one');
    const src2 = await incoming(2, B, 'in two');
    await incoming(1, D, 'd');
    const agent = await createUserAndLogin(t, { role: 'agent' });
    t.ctx.inboxes.repo.setMembers(1, [agent.user.id]);
    expect(code(await forward(agent.cookie, src1.id, [B2]))).toEqual([404, 'not_found']);
    expect(code(await forward(agent.cookie, src2.id, [D]))).toEqual([404, 'not_found']);
    expect((await forward(agent.cookie, src1.id, [D])).statusCode).toBe(200);

    const limited = await createUserAndLogin(t, { role: 'agent' });
    t.ctx.db.prepare("UPDATE users SET chat_scope = 'chosen' WHERE id = ?").run(limited.user.id);
    const choose = t.ctx.db.prepare(
      'INSERT INTO member_chats (user_id, chat_jid, added_by, added_at) VALUES (?, ?, NULL, ?)',
    );
    choose.run(limited.user.id, A, Date.now());
    choose.run(limited.user.id, B2, Date.now());
    expect(code(await forward(limited.cookie, src1.id, [D]))).toEqual([404, 'not_found']);
    expect(code(await forward(limited.cookie, src2.id, [D]))).toEqual([404, 'not_found']);
    // between two chosen chats, across numbers
    const ok = await forward(limited.cookie, src1.id, [B2]);
    expect(ok.statusCode).toBe(200);
    await waitFor(() => t.inboxWa(2).sent.length === 1);

    const ai = t.ctx.db.prepare("SELECT id FROM users WHERE kind = 'ai' LIMIT 1").get() as
      { id: number } | undefined;
    await expect(
      getMessages(t.ctx).forward(
        src1.id,
        { to: [D], clientRequestId: 'ai-1', sendAs: 'original' },
        { id: ai?.id ?? 999, role: 'agent', kind: 'ai' },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('checks a file against each chosen number’s WhatsApp limits', async () => {
    const video = await incoming(1, A, 'big video', {
      type: 'video',
      media: mediaOf('video/mp4', Buffer.alloc(50, 1)),
    });
    await incoming(1, D, 'd');
    await incoming(fakeApiInbox, D, 'order please');
    const api = t.inboxWa(fakeApiInbox);
    // stand-in limits in bytes (Business API: 16 MB videos, 100 MB files)
    Object.assign(api.capabilities!, { mediaLimits: { video: 10, document: 100 } });
    expect(code(await forward(admin.cookie, video.id, [D, D3]))).toEqual([
      413,
      'too_large_as_video',
    ]);
    const asFile = await forward(admin.cookie, video.id, [D, D3], { sendAs: 'file' });
    expect(asFile.statusCode).toBe(200);
    await waitFor(() => api.sent.length === 1 && t.inboxWa(1).sent.length === 1);
    // the Business API has no Forwarded mark; our app still shows it
    expect(api.sent[0]!.forwarded).toBeUndefined();
    expect(api.sent[0]!.file).toMatchObject({ asDocument: true });
    expect(asFile.json().messages[1].forwarded).toEqual({ manyTimes: false });

    Object.assign(api.capabilities!, { mediaLimits: { video: 10, document: 20 } });
    expect(code(await forward(admin.cookie, video.id, [D3], { sendAs: 'file' }))).toEqual([
      413,
      'too_large_for_whatsapp',
    ]);
  });

  it('downloads pending history media first, and answers 502 when WhatsApp no longer has it', async () => {
    await incoming(1, D, 'd');
    const ingest = (id: string) =>
      getMessages(t.ctx).ingest(
        {
          id,
          chatJid: A,
          chatJidAlt: null,
          senderJid: A,
          senderJidAlt: null,
          senderName: 'Customer',
          fromMe: false,
          type: 'document',
          body: null,
          quotedId: null,
          timestamp: Date.now() - 60_000,
          media: {
            mime: 'application/pdf',
            fileName: 'menu.pdf',
            download: async () => Buffer.from(''),
          },
        },
        'history',
      );
    await ingest('HIST-DOC-1');
    t.wa.setMedia('HIST-DOC-1', Buffer.from('%PDF-1.4 menu'));
    const ok = await forward(admin.cookie, 'HIST-DOC-1', [D]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().messages[0]).toMatchObject({ mediaName: 'menu.pdf', mediaSize: 13 });

    await ingest('HIST-DOC-2');
    expect(code(await forward(admin.cookie, 'HIST-DOC-2', [D]))).toEqual([
      502,
      'media_unavailable',
    ]);
  });

  it('allows 30 forwards a minute per person, each chat counting one', async () => {
    const src = await incoming(1, A, 'limit');
    const chats = ['1', '2', '3', '4', '5'].map((n) => `6011100090${n}@s.whatsapp.net`);
    for (const c of chats) await incoming(1, c, `hi ${c}`);
    for (let i = 0; i < 6; i++)
      expect((await forward(admin.cookie, src.id, chats)).statusCode).toBe(200);
    const limited = await forward(admin.cookie, src.id, [chats[0]!]);
    expect(code(limited)).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('media limits', () => {
  it('maps types to limits and refuses only above them', () => {
    expect(mediaLimitKind('video')).toBe('video');
    expect(mediaLimitKind('video', true)).toBe('document');
    expect(mediaLimitKind('sticker')).toBe('image');
    expect(mediaLimitKind('image')).toBe('image');
    expect(mediaLimitKind('audio')).toBe('audio');
    expect(mediaLimitKind('document')).toBe('document');
    expect(mediaLimitRefusal(undefined, 10 ** 12, 'video')).toBeNull();
    expect(mediaLimitRefusal({ image: 5 }, 6, 'image')).toMatchObject({
      status: 413,
      code: 'too_large_for_whatsapp',
    });
    expect(mediaLimitRefusal({ image: 5 }, 5, 'image')).toBeNull();
    expect(mediaLimitRefusal({ video: 5 }, 6, 'document')).toBeNull();
  });
});

describe('composer upload limit per number', () => {
  function multipart(fields: Record<string, string>, name: string, mime: string, data: Buffer) {
    const boundary = '----fw' + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields))
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
      );
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return {
      payload: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }
  const upload = (
    jid: string,
    clientId: string,
    data: Buffer,
    name = 'clip.mp4',
    fields: Record<string, string> = {},
  ) => {
    const mp = multipart({ clientId, ...fields }, name, 'video/mp4', data);
    return t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(jid)}/media`,
      headers: { ...authHeaders(admin.cookie), 'content-type': mp.contentType },
      payload: mp.payload,
    });
  };

  it('refuses a video above the number’s video limit and a file above its document limit (413)', async () => {
    await incoming(fakeApiInbox, D, 'order please');
    Object.assign(t.inboxWa(fakeApiInbox).capabilities!, {
      mediaLimits: { video: 10, document: 40 },
    });
    expect(code(await upload(D3, 'u-1', Buffer.alloc(20, 7)))).toEqual([413, 'too_large_as_video']);
    expect(code(await upload(D3, 'u-2', Buffer.alloc(50, 7), 'notes.bin'))).toEqual([
      413,
      'too_large_for_whatsapp',
    ]);
    const ok = await upload(D3, 'u-3', Buffer.alloc(8, 7));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mediaSize).toBe(8);
    // Above the video limit it can still go as a file (a document), up to the document limit.
    const asFile = await upload(D3, 'u-4', Buffer.alloc(20, 7), 'clip.mp4', { asFile: '1' });
    expect(asFile.statusCode).toBe(201);
    expect(asFile.json()).toMatchObject({ type: 'document', mediaName: 'clip.mp4' });
    expect(rowById(asFile.json().id)!.type).toBe('document');
    expect(code(await upload(D3, 'u-5', Buffer.alloc(50, 7), 'clip.mp4', { asFile: '1' }))).toEqual(
      [413, 'too_large_for_whatsapp'],
    );
    expect(
      (await upload(D3, 'u-6', Buffer.alloc(8, 7), 'clip.mp4', { asFile: '1', voiceNote: '1' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('stored size and the AI conversation', () => {
  it('fills a missing media size from the file once, when presented', async () => {
    const photo = await incoming(1, A, 'old photo', {
      type: 'image',
      media: mediaOf('image/jpeg', Buffer.from('twelve bytes')),
    });
    t.ctx.db.prepare('UPDATE messages SET media_size = NULL WHERE id = ?').run(photo.id);
    const page = getMessages(t.ctx).list(A, { limit: 50 });
    expect(page.messages.find((m) => m.id === photo.id)!.mediaSize).toBe(12);
    expect(rowById(photo.id)!.media_size).toBe(12);
    const abs = mediaAbs(rowById(photo.id)!.media_path!);
    expect(statSync(abs).size).toBe(12);
  });

  it('the dev fake-incoming route can deliver a forwarded message', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      headers: authHeaders(admin.cookie),
      payload: { chatJid: A, text: 'chain letter', forwardingScore: 6 },
    });
    expect(r.statusCode).toBe(200);
    expect(rowById(r.json().id)!.forwarding_score).toBe(6);
    const page = getMessages(t.ctx).list(A, { limit: 50 });
    expect(page.messages.find((m) => m.id === r.json().id)!.forwarded).toEqual({ manyTimes: true });
  });

  it('writes a customer’s forwarded message as [forwarded] …', async () => {
    const fwd = await incoming(1, A, 'Free gift, click here', { forwardingScore: 1 });
    expect(conversationLine(fwd)).toBe('[forwarded] Free gift, click here');
    const own = await incoming(1, A, 'my question');
    expect(conversationLine(own)).toBe('my question');
    // our own forwarded copies are the team's words
    expect(conversationLine({ ...fwd, fromMe: true })).toBe('Free gift, click here');
  });
});

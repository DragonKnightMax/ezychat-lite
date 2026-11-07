import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageListResponse, MessageLocateResponse, MessageSchema } from '@ezychat/shared';
import { FAKE_RUN } from '@ezychat/wa';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { createMessageService, GROUP_DELIVERY_ERROR } from '../src/messages/service.js';
import { MessageRepo, rowToMessage } from '../src/messages/repo.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const enc = encodeURIComponent;
const JID = '60177777777@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
async function waitFor(fn: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function seed(n = 1) {
  for (let i = 0; i < n; i++) {
    await getMessages(t.ctx).ingest(
      {
        id: `IN-${i}`,
        chatJid: JID,
        senderJid: JID,
        senderName: 'Gus',
        fromMe: false,
        type: 'text',
        body: `m${i}`,
        quotedId: null,
        timestamp: 1_700_000_000_000 + i * 1000,
        media: null,
      },
      'live',
    );
  }
}

function multipart(
  fields: Record<string, string>,
  file: { name: string; mime: string; data: Buffer },
) {
  const boundary = '----watiboundary' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
    ),
  );
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('messages routes', () => {
  it('lists messages ascending with before-cursor paging', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed(5);
    let r = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(JID)}/messages?limit=3`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const p1 = MessageListResponse.parse(r.json());
    expect(p1.messages.map((m) => m.body)).toEqual(['m2', 'm3', 'm4']);
    expect(p1.nextBefore).not.toBeNull();
    r = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(JID)}/messages?limit=3&before=${enc(p1.nextBefore!)}`,
      headers: { cookie },
    });
    const p2 = MessageListResponse.parse(r.json());
    expect(p2.messages.map((m) => m.body)).toEqual(['m0', 'm1']);
    expect(p2.nextBefore).toBeNull();
  });

  it('locates a quoted message in its chat: how many newer messages, never another chat or a hidden one', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed(5);
    const other = '60188888888@s.whatsapp.net';
    await getMessages(t.ctx).ingest(
      {
        id: 'OTHER-1',
        chatJid: other,
        senderJid: other,
        senderName: 'Other',
        fromMe: false,
        type: 'text',
        body: 'elsewhere',
        quotedId: null,
        timestamp: 1_700_000_100_000,
        media: null,
      },
      'live',
    );
    const locate = async (jid: string, id: string) => {
      const r = await t.app.inject({
        method: 'GET',
        url: `/api/chats/${enc(jid)}/messages/${enc(id)}/locate`,
        headers: { cookie },
      });
      return r;
    };
    let r = await locate(JID, 'IN-1');
    expect(r.statusCode).toBe(200);
    expect(MessageLocateResponse.parse(r.json())).toEqual({ found: true, newer: 3 });
    expect((await locate(JID, 'IN-4')).json()).toEqual({ found: true, newer: 0 });
    // never stored, or stored in another chat: not available here
    expect((await locate(JID, 'NOPE')).json()).toEqual({ found: false, newer: 0 });
    expect((await locate(JID, 'OTHER-1')).json()).toEqual({ found: false, newer: 0 });
    // hidden for the team ("delete for me"): not available, and not counted for the others
    t.ctx.db.prepare("UPDATE messages SET hidden_at = 1 WHERE id = 'IN-3'").run();
    expect((await locate(JID, 'IN-3')).json()).toEqual({ found: false, newer: 0 });
    expect((await locate(JID, 'IN-1')).json()).toEqual({ found: true, newer: 2 });
    // an unknown chat answers 404, like every per-chat route
    r = await locate('60100000000@s.whatsapp.net', 'IN-1');
    expect(r.statusCode).toBe(404);
    r = await t.app.inject({ method: 'GET', url: `/api/chats/${enc(JID)}/messages/IN-1/locate` });
    expect(r.statusCode).toBe(401);
  });

  it('send text via FakeWaAdapter ends with status sent and the WA id', async () => {
    const { user, cookie } = await createUserAndLogin(t);
    await seed();
    const statuses: Array<{ id: string; clientId: string | null; status: string; newId?: string }> =
      [];
    t.ctx.bus.on('message:status', (s) => statuses.push(s));
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'Hello there', clientId: 'c-1' },
    });
    expect(r.statusCode).toBe(201);
    const m = MessageSchema.parse(r.json());
    expect(m.id).toBe('local-c-1');
    expect(m.status).toBe('pending');
    expect(m.sentByUserId).toBe(user.id);
    expect(m.fromMe).toBe(true);

    await waitFor(() => statuses.some((s) => s.clientId === 'c-1' && s.status === 'sent'));
    const sentEv = statuses.find((s) => s.status === 'sent')!;
    expect(sentEv.newId).toMatch(/^FAKE-OUT-[0-9a-z]+-1$/);
    expect(sentEv.id).toBe(sentEv.newId);
    expect(t.wa.sent[0]).toMatchObject({ chatJid: JID, text: 'Hello there' });
    await settle();
    const row = t.ctx.db
      .prepare('SELECT id, status, client_id FROM messages WHERE client_id = ?')
      .get('c-1') as {
      id: string;
      status: string;
    };
    expect(row.id).toBe(sentEv.newId);
    expect(['sent', 'delivered']).toContain(row.status);
    expect(t.wa.presences.some((p) => p.chatJid === JID && p.presence === 'composing')).toBe(true);
  });

  it('a reply sends the quoted id plus a saved copy, so old quotes survive the adapter cache', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed(2);
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'Yes we can', clientId: 'reply-1', quotedId: 'IN-1' },
    });
    expect(r.statusCode).toBe(201);
    expect(MessageSchema.parse(r.json()).quotedId).toBe('IN-1');
    await waitFor(() => t.wa.sent.length === 1);
    expect(t.wa.sent[0]).toMatchObject({
      chatJid: JID,
      text: 'Yes we can',
      reply: {
        quotedId: 'IN-1',
        quoted: { id: 'IN-1', fromMe: false, senderJid: JID, type: 'text', text: 'm1' },
      },
    });
  });

  it('a media reply carries the quote too', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed(1);
    const mp = multipart(
      { clientId: 'reply-media', caption: 'menu', quotedId: 'IN-0' },
      { name: 'p.png', mime: 'image/png', data: PNG },
    );
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/media`,
      headers: { ...authHeaders(cookie), 'content-type': mp.contentType },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(201);
    await waitFor(() => t.wa.sent.length === 1);
    expect(t.wa.sent[0]!.reply).toMatchObject({ quotedId: 'IN-0', quoted: { text: 'm0' } });
  });

  it('refuses to quote a message of another chat or one WhatsApp does not know yet', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed(1);
    const other = '60188888888@s.whatsapp.net';
    await getMessages(t.ctx).ingest(
      {
        id: 'OTHER-1',
        chatJid: other,
        senderJid: other,
        senderName: 'Other',
        fromMe: false,
        type: 'text',
        body: 'secret',
        quotedId: null,
        timestamp: 1_700_000_100_000,
        media: null,
      },
      'live',
    );
    t.wa.simulateStatus({ state: 'disconnected' });
    const pending = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'still pending', clientId: 'p-1' },
    });
    expect(pending.statusCode).toBe(201);
    for (const quotedId of ['OTHER-1', 'local-p-1', 'NOPE']) {
      const r = await t.app.inject({
        method: 'POST',
        url: `/api/chats/${enc(JID)}/messages`,
        headers: authHeaders(cookie),
        payload: { text: 'x', clientId: `bad-${quotedId}`, quotedId },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toMatch(/not in this chat/);
    }
    expect(
      t.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id LIKE 'bad-%'").get(),
    ).toEqual({ n: 0 });
  });

  it('re-posting the same clientId does not create a duplicate', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed();
    t.wa.setConnected(false);
    for (let i = 0; i < 2; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: `/api/chats/${enc(JID)}/messages`,
        headers: authHeaders(cookie),
        payload: { text: 'once', clientId: 'dup' },
      });
      expect(r.statusCode).toBe(201);
    }
    const n = (
      t.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id='dup'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });

  it('send while WA disconnected stays pending, then sends on reconnect', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed();
    t.wa.setConnected(false);
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'later', clientId: 'c-2' },
    });
    expect(r.statusCode).toBe(201);
    await settle();
    const row = () =>
      t.ctx.db.prepare('SELECT id, status FROM messages WHERE client_id = ?').get('c-2') as {
        id: string;
        status: string;
      };
    expect(row().status).toBe('pending');
    expect(t.wa.sent).toHaveLength(0);
    t.wa.setConnected(true);
    await waitFor(() => row().status !== 'pending');
    expect(row().id).toMatch(/^FAKE-OUT-/);
  });

  it('send failure → failed; retry re-sends', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed();
    t.wa.failNextSend(new Error('nope'));
    await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'try', clientId: 'c-3' },
    });
    const row = () =>
      t.ctx.db.prepare('SELECT id, status, error FROM messages WHERE client_id = ?').get('c-3') as {
        id: string;
        status: string;
        error: string | null;
      };
    await waitFor(() => row().status === 'failed');
    expect(row().error).toBe('nope');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/messages/local-c-3/retry`,
      headers: authHeaders(cookie),
    });
    expect(r.statusCode).toBe(200);
    expect(MessageSchema.parse(r.json()).status).toBe('pending');
    await waitFor(() => row().id.startsWith('FAKE-OUT-'));
  });

  it('an ERROR ack that arrives before the id rename leaves the message failed', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed();
    t.wa.skipNextDelivery();
    // the fake adapter's next outgoing id is FAKE-OUT-<run>-1; its failure ack races ahead of the send result
    getMessages(t.ctx).applyStatus({
      id: `FAKE-OUT-${FAKE_RUN}-1`,
      chatJid: JID,
      status: 'failed',
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'doomed', clientId: 'c-early' },
    });
    const row = () =>
      t.ctx.db
        .prepare('SELECT id, status, error FROM messages WHERE client_id = ?')
        .get('c-early') as {
        id: string;
        status: string;
        error: string | null;
      };
    await waitFor(() => row().id === `FAKE-OUT-${FAKE_RUN}-1`);
    await settle();
    expect(row().status).toBe('failed');
    expect(row().error).toBe('Delivery failed');
  });

  it('a retry of a message WhatsApp already took re-sends it under the same id (no second copy)', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed();
    await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'retry me', clientId: 'c-wa' },
    });
    const row = () =>
      t.ctx.db.prepare('SELECT id, status FROM messages WHERE client_id = ?').get('c-wa') as {
        id: string;
        status: string;
      };
    await waitFor(() => row().id.startsWith('FAKE-OUT-'));
    const waId = row().id;
    await settle();
    // simulate WhatsApp's ERROR ack on the WA-id row
    t.ctx.db
      .prepare("UPDATE messages SET status = 'failed', error = 'Delivery failed' WHERE id = ?")
      .run(waId);
    const statuses: Array<{ id: string; newId?: string; status: string }> = [];
    t.ctx.bus.on('message:status', (s) => statuses.push(s));
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/messages/${enc(waId)}/retry`,
      headers: authHeaders(cookie),
    });
    expect(r.statusCode).toBe(200);
    const m = MessageSchema.parse(r.json());
    expect(m).toMatchObject({ id: waId, status: 'pending' });
    expect(statuses[0]).toMatchObject({ id: waId, status: 'pending' });
    expect(statuses[0]?.newId).toBeUndefined();
    await waitFor(() => row().status === 'delivered');
    const copies = t.wa.sent.filter((x) => x.text === 'retry me');
    expect(copies.map((x) => x.id)).toEqual([waId, waId]);
    expect(row().id).toBe(waId);
    expect(
      (
        t.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id = 'c-wa'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('a retry kept under its WhatsApp id is restored after a restart', () => {
    t.ctx.db
      .prepare(
        `INSERT INTO messages(id, chat_jid, from_me, type, body, timestamp, status, client_id, created_at)
         VALUES ('WA-R-1', ?, 1, 'text', 'again', 1700000005000, 'pending', 'c-r', 1700000005000),
                ('WA-IN-1', ?, 0, 'text', 'hi', 1700000005000, 'pending', NULL, 1700000005000)`,
      )
      .run(JID, JID);
    const ids = new MessageRepo(t.ctx.db).pendingLocal().map((r) => r.id);
    expect(ids).toContain('WA-R-1');
    expect(ids).not.toContain('WA-IN-1');
  });

  describe('a WhatsApp error ack', () => {
    const insertSent = (id: string, chatJid: string, status = 'sent') =>
      t.ctx.db
        .prepare(
          `INSERT INTO messages(id, chat_jid, from_me, type, body, timestamp, status, created_at)
           VALUES (?, ?, 1, 'text', 'hello', 1700000005000, ?, 1700000005000)`,
        )
        .run(id, chatJid, status);
    const rowOf = (id: string) =>
      t.ctx.db.prepare('SELECT status, error FROM messages WHERE id = ?').get(id) as {
        status: string;
        error: string | null;
      };

    const seedGroup = () =>
      getMessages(t.ctx).ingest(
        {
          id: 'G-IN-0',
          chatJid: GROUP,
          senderJid: JID,
          senderName: 'Gus',
          fromMe: false,
          type: 'text',
          body: 'hi all',
          quotedId: null,
          timestamp: 1_700_000_000_000,
          media: null,
        },
        'live',
      );

    it('in a group says some members may not have it, not that it failed outright', async () => {
      await seedGroup();
      insertSent('G-1', GROUP);
      getMessages(t.ctx).applyStatus({ id: 'G-1', chatJid: GROUP, status: 'failed', error: '479' });
      expect(rowOf('G-1')).toEqual({ status: 'failed', error: GROUP_DELIVERY_ERROR });
    });

    it('is cleared by a later delivered or read receipt (someone has it)', async () => {
      await seedGroup();
      insertSent('G-2', GROUP);
      const svc = getMessages(t.ctx);
      svc.applyStatus({ id: 'G-2', chatJid: GROUP, status: 'failed' });
      svc.applyStatus({ id: 'G-2', chatJid: GROUP, status: 'sent' });
      expect(rowOf('G-2').status).toBe('failed');
      svc.applyStatus({ id: 'G-2', chatJid: GROUP, status: 'read' });
      expect(rowOf('G-2')).toEqual({ status: 'read', error: null });
    });

    it('in a direct chat stays "Delivery failed" and never downgrades a delivered message', async () => {
      await seed();
      insertSent('D-1', JID);
      insertSent('D-2', JID, 'delivered');
      const svc = getMessages(t.ctx);
      svc.applyStatus({ id: 'D-1', chatJid: JID, status: 'failed' });
      svc.applyStatus({ id: 'D-2', chatJid: JID, status: 'failed' });
      expect(rowOf('D-1')).toEqual({ status: 'failed', error: 'Delivery failed' });
      expect(rowOf('D-2').status).toBe('delivered');
    });

    it('that raced ahead of the send is cleared when a receipt follows before the rename', async () => {
      const { cookie } = await createUserAndLogin(t);
      await seed();
      const id = `FAKE-OUT-${FAKE_RUN}-1`;
      const svc = getMessages(t.ctx);
      svc.applyStatus({ id, chatJid: JID, status: 'failed' });
      svc.applyStatus({ id, chatJid: JID, status: 'sent' });
      svc.applyStatus({ id, chatJid: JID, status: 'delivered' });
      await t.app.inject({
        method: 'POST',
        url: `/api/chats/${enc(JID)}/messages`,
        headers: authHeaders(cookie),
        payload: { text: 'made it', clientId: 'c-race' },
      });
      await waitFor(() => rowOf(id) !== undefined);
      await settle();
      expect(rowOf(id)).toEqual({ status: 'delivered', error: null });
    });

    it('is ignored for a message someone else sent', async () => {
      await seed();
      getMessages(t.ctx).applyStatus({ id: 'IN-0', chatJid: JID, status: 'failed' });
      expect(rowOf('IN-0').status).not.toBe('failed');
    });
  });

  describe('an AI reply', () => {
    const aiUser = () =>
      Number(
        t.ctx.db
          .prepare(
            "INSERT INTO users(username, display_name, password_hash, role, kind, created_at) VALUES ('ai-x', 'Sales Agent', '', 'agent', 'ai', 0)",
          )
          .run().lastInsertRowid,
      );
    const row = (clientId: string) =>
      t.ctx.db
        .prepare('SELECT id, status, error FROM messages WHERE client_id = ?')
        .get(clientId) as { id: string; status: string; error: string | null };

    it('is not sent automatically once the AI no longer owns the answer', async () => {
      await seed();
      const ai = aiUser();
      getMessages(t.ctx).sendText(
        JID,
        { text: 'late answer', clientId: 'c-ai-late', quotedId: 'IN-0' },
        ai,
      );
      await waitFor(() => row('c-ai-late').status === 'failed');
      expect(row('c-ai-late').error).toMatch(/^AI reply cancelled/);
      expect(t.wa.sent.some((x) => x.text === 'late answer')).toBe(false);
    });

    it('rejected by WhatsApp is sent again when a person clicks Retry', async () => {
      const { cookie } = await createUserAndLogin(t);
      await seed();
      const ai = aiUser();
      // WhatsApp took the reply (the AI counted the question as answered), then rejected it.
      t.ctx.db
        .prepare(
          `INSERT INTO messages(id, chat_jid, from_me, type, body, quoted_id, timestamp, status, error, client_id, sent_by_user_id, created_at)
           VALUES ('WA-AI-1', ?, 1, 'text', 'price list', 'IN-0', 1700000005000, 'failed', 'Delivery failed', 'c-ai', ?, 1700000005000)`,
        )
        .run(JID, ai);
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/messages/WA-AI-1/retry',
        headers: authHeaders(cookie),
      });
      expect(r.statusCode).toBe(200);
      await waitFor(() => row('c-ai').status !== 'pending');
      expect(row('c-ai')).toMatchObject({ status: 'sent', error: null });
      expect(t.wa.sent.filter((x) => x.text === 'price list').length).toBe(1);
    });
  });

  it('media upload of a PNG stores and serves it with correct content-type and Range 206', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed();
    const mp = multipart(
      { clientId: 'c-img', caption: 'look' },
      { name: 'dot.png', mime: 'application/octet-stream', data: PNG },
    );
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/media`,
      headers: { ...authHeaders(cookie), 'content-type': mp.contentType },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(201);
    const m = MessageSchema.parse(r.json());
    expect(m.type).toBe('image');
    expect(m.mediaMime).toBe('image/png');
    expect(m.body).toBe('look');
    expect(m.mediaUrl).toBe(`/api/media/${m.id}`);

    await waitFor(() => t.wa.sent.length === 1);
    expect(t.wa.sent[0]!.file!.mime).toBe('image/png');
    await settle();
    const row = t.ctx.db.prepare('SELECT id FROM messages WHERE client_id = ?').get('c-img') as {
      id: string;
    };

    let res = await t.app.inject({
      method: 'GET',
      url: `/api/media/${enc(row.id)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline/);
    // a message's file never changes: the phone may keep it for 30 days
    expect(res.headers['cache-control']).toBe('private, max-age=2592000, immutable');
    expect(res.rawPayload.equals(PNG)).toBe(true);

    res = await t.app.inject({
      method: 'GET',
      url: `/api/media/${enc(row.id)}`,
      headers: { cookie, range: 'bytes=0-9' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-9/${PNG.length}`);
    expect(res.rawPayload.equals(PNG.subarray(0, 10))).toBe(true);

    res = await t.app.inject({
      method: 'GET',
      url: `/api/media/${enc(row.id)}`,
      headers: { cookie, range: 'bytes=9999-' },
    });
    expect(res.statusCode).toBe(416);
  });

  it('non-image media is served as attachment', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seed();
    const mp = multipart(
      { clientId: 'c-doc' },
      { name: 'notes.txt', mime: 'text/plain', data: Buffer.from('hello world') },
    );
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/media`,
      headers: { ...authHeaders(cookie), 'content-type': mp.contentType },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(201);
    const m = MessageSchema.parse(r.json());
    expect(m.type).toBe('document');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/media/${enc(m.id)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="notes.txt"/);
  });

  const ingestHistoryImage = (id: string) =>
    getMessages(t.ctx).ingest(
      {
        id,
        chatJid: JID,
        senderJid: JID,
        senderName: 'Gus',
        fromMe: false,
        type: 'image',
        body: null,
        quotedId: null,
        timestamp: 1_700_000_000_000,
        media: { mime: 'image/png', fileName: null, download: async () => PNG },
      },
      'history',
    );

  it('GET /api/media/:id on pending history media downloads on demand, then serves it', async () => {
    const { cookie } = await createUserAndLogin(t);
    const m = await ingestHistoryImage('HIST-IMG-1');
    expect(m!.mediaStatus).toBe('pending');
    t.wa.setMedia('HIST-IMG-1', PNG);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/media/HIST-IMG-1`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(PNG)).toBe(true);
    const row = t.ctx.db
      .prepare('SELECT media_status FROM messages WHERE id = ?')
      .get('HIST-IMG-1') as { media_status: string };
    expect(row.media_status).toBe('ok');
  });

  it('GET /api/media/:id on pending media that cannot be downloaded → 404 media_pending', async () => {
    const { cookie } = await createUserAndLogin(t);
    await ingestHistoryImage('HIST-IMG-2');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/media/HIST-IMG-2`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('media_pending');
  });

  describe('WhatsApp thumbnail', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const ingestWithThumb = (id: string) =>
      getMessages(t.ctx).ingest(
        {
          id,
          chatJid: JID,
          senderJid: JID,
          senderName: 'Gus',
          fromMe: false,
          type: 'image',
          body: null,
          quotedId: null,
          timestamp: 1_700_000_000_000,
          media: {
            mime: 'image/png',
            fileName: null,
            download: async () => PNG,
            thumbnail: JPEG,
          },
        },
        'history',
      );
    const getThumb = (id: string, cookie?: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/media/${id}/thumb`,
        headers: cookie ? { cookie } : {},
      });

    it('serves the preview as a JPEG, and the message links to it', async () => {
      const { cookie } = await createUserAndLogin(t);
      const m = await ingestWithThumb('TH-1');
      expect(m!.mediaThumbUrl).toBe('/api/media/TH-1/thumb');
      const res = await getThumb('TH-1', cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toContain('private');
      expect(res.rawPayload.equals(JPEG)).toBe(true);
    });

    it('never downloads the real file', async () => {
      const { cookie } = await createUserAndLogin(t);
      await ingestWithThumb('TH-2');
      const download = vi.spyOn(t.wa, 'downloadMedia');
      expect((await getThumb('TH-2', cookie)).statusCode).toBe(200);
      expect(download).not.toHaveBeenCalled();
    });

    it('needs a session', async () => {
      await ingestWithThumb('TH-3');
      expect((await getThumb('TH-3')).statusCode).toBe(401);
    });

    it('answers 404 without a preview', async () => {
      const { cookie } = await createUserAndLogin(t);
      const m = await ingestHistoryImage('TH-4');
      expect(m).not.toHaveProperty('mediaThumbUrl');
      expect((await getThumb('TH-4', cookie)).statusCode).toBe(404);
    });

    it('stays away from a deleted or hidden message', async () => {
      const { cookie } = await createUserAndLogin(t);
      await ingestWithThumb('TH-5');
      await ingestWithThumb('TH-6');
      await ingestWithThumb('TH-7');
      const repo = new MessageRepo(t.ctx.db);
      repo.update('TH-5', { deleted_at: 1, deleted_by: 'sender' });
      repo.update('TH-6', { hidden_at: 1 });
      repo.delete('TH-7');
      expect((await getThumb('TH-5', cookie)).statusCode).toBe(404);
      expect((await getThumb('TH-6', cookie)).statusCode).toBe(404);
      expect(repo.mediaThumb('TH-5')).toBeNull();
      expect(repo.mediaThumb('TH-7')).toBeNull();
      expect(rowToMessage(repo.get('TH-5')!)).not.toHaveProperty('mediaThumbUrl');
    });

    it('shows no preview of an image WhatsApp Safety flagged', async () => {
      const { cookie } = await createUserAndLogin(t);
      await ingestWithThumb('TH-8');
      const level = vi.spyOn(t.ctx.services.safety!, 'levelOf').mockReturnValue('high');
      expect((await getThumb('TH-8', cookie)).statusCode).toBe(404);
      level.mockRestore();
    });

    it('stops a phone keeping a preview while the safety check is open', async () => {
      const { cookie } = await createUserAndLogin(t);
      await ingestWithThumb('TH-9');
      vi.spyOn(t.ctx.services.safety!, 'cacheable').mockReturnValue(false);
      const res = await getThumb('TH-9', cookie);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('download data kept across a restart', () => {
    const REF = '{"opaque":"ref"}';
    const refOf = (id: string) =>
      t.ctx.db.prepare('SELECT ref FROM media_refs WHERE message_id = ?').get(id) as
        { ref: string } | undefined;
    const ingestWithRef = (id: string, source: 'history' | 'live' = 'history', fail = false) =>
      getMessages(t.ctx).ingest(
        {
          id,
          chatJid: JID,
          senderJid: JID,
          senderName: 'Gus',
          fromMe: false,
          type: 'image',
          body: null,
          quotedId: null,
          timestamp: 1_700_000_000_000,
          media: {
            mime: 'image/png',
            fileName: null,
            download: async () => {
              if (fail) throw new Error('no network');
              return PNG;
            },
            ref: REF,
            width: 1600,
            height: 900,
          },
        },
        source,
      );

    it('gives the adapter the stored ref, then forgets it once the file is stored', async () => {
      const { cookie } = await createUserAndLogin(t);
      await ingestWithRef('REF-1');
      expect(refOf('REF-1')?.ref).toBe(REF);
      const download = vi.spyOn(t.wa, 'downloadMedia').mockResolvedValue(PNG);
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/media/REF-1',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(download).toHaveBeenCalledWith('REF-1', REF);
      expect(refOf('REF-1')).toBeUndefined();
    });

    it('keeps the ref after a failed download, so Retry can work', async () => {
      const { cookie } = await createUserAndLogin(t);
      await ingestWithRef('REF-2');
      const download = vi.spyOn(t.wa, 'downloadMedia').mockResolvedValueOnce(null);
      const url = '/api/media/REF-2/redownload';
      const headers = authHeaders(cookie);
      const failed = await t.app.inject({ method: 'POST', url, headers });
      expect(failed.statusCode).toBe(409);
      expect(refOf('REF-2')?.ref).toBe(REF);

      download.mockResolvedValueOnce(PNG);
      const retried = await t.app.inject({ method: 'POST', url, headers });
      expect(retried.statusCode).toBe(200);
      expect(retried.json().mediaStatus).toBe('ok');
    });

    it('a live file that stored at once keeps no ref; one that failed keeps it for Retry', async () => {
      await ingestWithRef('REF-LIVE-OK', 'live');
      expect(refOf('REF-LIVE-OK')).toBeUndefined();
      await ingestWithRef('REF-LIVE-BAD', 'live', true);
      expect(refOf('REF-LIVE-BAD')?.ref).toBe(REF);
    });

    it('forgets the ref when the message is deleted or removed', async () => {
      await ingestWithRef('REF-3');
      await ingestWithRef('REF-4');
      const repo = new MessageRepo(t.ctx.db);
      repo.update('REF-3', { deleted_at: 1 });
      repo.delete('REF-4');
      expect(refOf('REF-3')).toBeUndefined();
      expect(refOf('REF-4')).toBeUndefined();
    });

    it('sends the image size to clients, never the ref', async () => {
      const m = await ingestWithRef('REF-5');
      expect(m).toMatchObject({ mediaWidth: 1600, mediaHeight: 900 });
      expect(JSON.stringify(m)).not.toContain('opaque');
      const repo = new MessageRepo(t.ctx.db);
      repo.update('REF-5', { deleted_at: 1, deleted_by: 'sender' });
      expect(rowToMessage(repo.get('REF-5')!)).not.toHaveProperty('mediaWidth');
    });

    it('a message without a size has none', async () => {
      const m = await ingestHistoryImage('REF-6');
      expect(m).not.toHaveProperty('mediaWidth');
      expect(new MessageRepo(t.ctx.db).mediaRef('REF-6')).toBeNull();
    });
  });

  it('media requires auth and unknown id → 404', async () => {
    const { cookie } = await createUserAndLogin(t);
    let res = await t.app.inject({ method: 'GET', url: `/api/media/nope` });
    expect(res.statusCode).toBe(401);
    res = await t.app.inject({ method: 'GET', url: `/api/media/nope`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('ownership on reply', () => {
  it('the first EzyChat reply to an unassigned chat assigns it to the sender', async () => {
    const { user, cookie } = await createUserAndLogin(t, { role: 'agent' });
    await seed();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(cookie),
      payload: { text: 'Hello Gus', clientId: 'own-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(getChats(t.ctx).get(JID)?.assignedTo).toBe(user.id);
    const events = getChats(t.ctx).events(JID);
    expect(events.map((e) => e.type)).toEqual(['assigned']);
    expect(events[0]).toMatchObject({
      actorId: user.id,
      payload: { assignedTo: user.id, previous: null, reason: 'reply' },
    });
  });

  it('a media reply assigns too, and a repeated clientId does not add a second event', async () => {
    const { user } = await createUserAndLogin(t, { role: 'agent' });
    await seed();
    await getMessages(t.ctx).sendMedia(
      JID,
      { buffer: PNG, fileName: 'a.png' },
      user.id,
      'own-media',
    );
    await getMessages(t.ctx).sendMedia(
      JID,
      { buffer: PNG, fileName: 'a.png' },
      user.id,
      'own-media',
    );
    expect(getChats(t.ctx).get(JID)?.assignedTo).toBe(user.id);
    expect(
      getChats(t.ctx)
        .events(JID)
        .map((e) => e.type),
    ).toEqual(['assigned']);
  });

  it('replying never takes over a chat another teammate owns', async () => {
    const owner = await createUserAndLogin(t, { role: 'agent' });
    const other = await createUserAndLogin(t, { role: 'agent' });
    await seed();
    getChats(t.ctx).patch(JID, { assignedTo: owner.user.id }, owner.user.id);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/messages`,
      headers: authHeaders(other.cookie),
      payload: { text: 'Covering for you', clientId: 'own-2' },
    });
    expect(res.statusCode).toBe(201);
    expect(getChats(t.ctx).get(JID)?.assignedTo).toBe(owner.user.id);
    expect(
      getChats(t.ctx)
        .events(JID)
        .map((e) => e.type),
    ).toEqual(['assigned']);
  });

  it('a reply sent from the WhatsApp phone app assigns nobody', async () => {
    await seed();
    await getMessages(t.ctx).ingest(
      {
        id: 'FROM-PHONE',
        chatJid: JID,
        senderJid: null,
        senderName: null,
        fromMe: true,
        type: 'text',
        body: 'typed on the phone',
        quotedId: null,
        timestamp: 1_700_000_100_000,
        media: null,
      },
      'live',
    );
    expect(getChats(t.ctx).get(JID)?.assignedTo).toBeNull();
    expect(getChats(t.ctx).events(JID)).toEqual([]);
  });
});

describe('replies and receipts for one person with two addresses', () => {
  const PN = '60111111111@s.whatsapp.net';
  const LID = '123456789@lid';
  const inbound = (id: string, chatJid: string, ts: number, chatJidAlt: string | null = null) =>
    getMessages(t.ctx).ingest(
      {
        id,
        chatJid,
        chatJidAlt,
        senderJid: chatJid,
        senderName: 'Aisyah',
        fromMe: false,
        type: 'text',
        body: id,
        quotedId: null,
        timestamp: ts,
        media: null,
      },
      'live',
    );

  it('replies go to the address of the last inbound message and composing uses it too', async () => {
    const { user } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('L-1', LID, 1000, PN);
    await inbound('P-2', PN, 2000);
    getMessages(t.ctx).sendText(LID, { clientId: 'reply-1', text: 'hello' }, user.id);
    await waitFor(() => t.wa.sent.length === 1);
    expect(t.wa.sent[0]!.chatJid).toBe(PN);
    expect(t.wa.presences.some((p) => p.chatJid === PN && p.presence === 'composing')).toBe(true);
    expect(
      t.ctx.db
        .prepare("SELECT chat_jid, wa_remote_jid FROM messages WHERE client_id = 'reply-1'")
        .get(),
    ).toEqual({ chat_jid: LID, wa_remote_jid: PN });
  });

  it('never replies to a phone number that has since moved to another WhatsApp ID', async () => {
    const { user } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('L-1', LID, 1000, PN);
    await inbound('P-2', PN, 2000);
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: '987654321@lid' }]); // number recycled
    getMessages(t.ctx).sendText(LID, { clientId: 'moved-1', text: 'hello' }, user.id);
    await waitFor(() => t.wa.sent.length === 1);
    expect(t.wa.sent[0]!.chatJid).toBe(LID);
  });

  it('read receipts are sent per WhatsApp address', async () => {
    const { cookie } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('L-1', LID, 1000, PN);
    await inbound('P-2', PN, 2000);
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(LID)}/read`,
      headers: authHeaders(cookie),
    });
    expect(r.statusCode).toBe(200);
    expect(t.wa.reads).toEqual([
      { chatJid: LID, messageIds: ['L-1'] },
      { chatJid: PN, messageIds: ['P-2'] },
    ]);
  });

  it('the echo of our own send to the PN is stored once, in the LID chat', async () => {
    const { user } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('L-1', LID, 1000, PN);
    await inbound('P-2', PN, 2000);
    getMessages(t.ctx).sendText(LID, { clientId: 'echo-1', text: 'echo me' }, user.id);
    await waitFor(() => t.wa.sent.length === 1);
    const waId = t.wa.sent[0]!.id;
    t.wa.simulateIncoming({ id: waId, chatJid: PN, fromMe: true, body: 'echo me' });
    await settle();
    expect(t.ctx.db.prepare('SELECT chat_jid FROM messages WHERE id = ?').all(waId)).toEqual([
      { chat_jid: LID },
    ]);
  });

  it('a retry never goes to a phone number that has since moved to another WhatsApp ID', async () => {
    const { user, cookie } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('L-1', LID, 1000, PN);
    await inbound('P-2', PN, 2000);
    t.wa.failNextSend(new Error('nope'));
    getMessages(t.ctx).sendText(LID, { clientId: 'retry-moved', text: 'hello' }, user.id);
    const row = () =>
      t.ctx.db
        .prepare('SELECT id, status, wa_remote_jid FROM messages WHERE client_id = ?')
        .get('retry-moved') as { id: string; status: string; wa_remote_jid: string };
    await waitFor(() => row().status === 'failed');
    expect(row().wa_remote_jid).toBe(PN);
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: '987654321@lid' }]); // number recycled
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/messages/local-retry-moved/retry`,
      headers: authHeaders(cookie),
    });
    expect(r.statusCode).toBe(200);
    await waitFor(() => t.wa.sent.length === 1);
    expect(t.wa.sent[0]!.chatJid).toBe(LID);
    expect(row().wa_remote_jid).toBe(LID);
  });

  it('refuses to send from a phone-number chat whose number now belongs to someone else', async () => {
    const { user } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('P-1', PN, 1000);
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: '555555555@lid' }]);
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: '987654321@lid' }]);
    expect(() =>
      getMessages(t.ctx).sendText(PN, { clientId: 'stale-1', text: 'hello' }, user.id),
    ).toThrow(/now belongs to a different WhatsApp account/);
    await settle();
    expect(t.wa.sent).toHaveLength(0);
  });

  it('a retry from such a chat is marked failed and nothing is sent', async () => {
    const { user, cookie } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('P-1', PN, 1000);
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: '555555555@lid' }]);
    t.wa.failNextSend(new Error('nope'));
    getMessages(t.ctx).sendText(PN, { clientId: 'stale-2', text: 'hello' }, user.id);
    const row = () =>
      t.ctx.db.prepare('SELECT status, error FROM messages WHERE client_id = ?').get('stale-2') as {
        status: string;
        error: string;
      };
    await waitFor(() => row().status === 'failed');
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: '987654321@lid' }]);
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/messages/local-stale-2/retry',
      headers: authHeaders(cookie),
    });
    expect(r.statusCode).toBe(200);
    await settle();
    expect(row()).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/different WhatsApp account/),
    });
    expect(t.wa.sent).toHaveLength(0);
  });

  it('restored pending sends after a restart still go to their stored target', async () => {
    const { user } = await createUserAndLogin(t, { role: 'agent' });
    await inbound('L-1', LID, 1000, PN);
    await inbound('P-2', PN, 2000);
    t.wa.setConnected(false);
    getMessages(t.ctx).sendText(LID, { clientId: 'restart-1', text: 'after restart' }, user.id);
    getMessages(t.ctx).shutdown();
    const restarted = createMessageService(t.ctx);
    t.wa.setConnected(true);
    restarted.queue.onConnected();
    await waitFor(() => t.wa.sent.length === 1);
    expect(t.wa.sent[0]!.chatJid).toBe(PN);
    restarted.shutdown();
  });
});

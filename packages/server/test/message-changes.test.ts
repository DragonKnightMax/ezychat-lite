import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageEditsResponse,
  MessageListResponse,
  MessageSchema,
  type Message,
} from '@ezychat/shared';
import { FakeWaAdapter, LINKED_PHONE_CAPABILITIES } from '@ezychat/wa';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { MessageRepo, type MessageRow } from '../src/messages/repo.js';
import { ChatRepo } from '../src/chats/repo.js';
import {
  CHANGES_PER_MINUTE,
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  changeAuthor,
} from '../src/messages/changes.js';

const enc = encodeURIComponent;
const DM = '60177777777@s.whatsapp.net';
const OTHER = '60188888888@s.whatsapp.net';
const GROUP = '120363000000001@g.us';
const ALI = '60111111111@s.whatsapp.net';
const BEN = '60122222222@s.whatsapp.net';

let t: TestApp;
let admin: { cookie: string; id: number };
let agent: { cookie: string; id: number };
let updated: Message[];

async function start(wa?: FakeWaAdapter) {
  t = await makeTestApp(wa ? { wa } : undefined);
  const a = await createUserAndLogin(t, { role: 'admin' });
  admin = { cookie: a.cookie, id: a.user.id };
  const g = await createUserAndLogin(t, { role: 'agent', username: 'daniel' });
  agent = { cookie: g.cookie, id: g.user.id };
  updated = [];
  t.ctx.bus.on('message:updated', (m) => updated.push(m));
}

beforeEach(async () => {
  await start();
});
afterEach(async () => {
  await t.close();
});

async function incoming(chatJid: string, id: string, extra: Record<string, unknown> = {}) {
  return getMessages(t.ctx).ingest(
    {
      id,
      chatJid,
      senderJid: chatJid.endsWith('@g.us') ? ALI : chatJid,
      senderName: 'Gus',
      fromMe: false,
      type: 'text',
      body: `body ${id}`,
      quotedId: null,
      timestamp: Date.now(),
      media: null,
      ...extra,
    },
    'live',
  );
}

/** A message the team sent and WhatsApp accepted (stored as the queue leaves it). */
function teamMessage(id: string, userId: number | null, extra: Partial<MessageRow> = {}) {
  const at = Date.now();
  new ChatRepo(t.ctx.db).ensure(1, DM, { name: 'Gus' }, at);
  new MessageRepo(t.ctx.db).insert({
    id,
    chat_jid: DM,
    sender_jid: null,
    sender_name: null,
    from_me: 1,
    sent_by_user_id: userId,
    type: 'text',
    body: `team ${id}`,
    media_path: null,
    media_mime: null,
    media_name: null,
    media_status: 'none',
    quoted_id: null,
    status: 'sent',
    error: null,
    timestamp: at,
    created_at: at,
    client_id: null,
    wa_remote_jid: DM,
    ...extra,
  });
}

const edit = (id: string, text: string, cookie = admin.cookie) =>
  t.app.inject({
    method: 'PATCH',
    url: `/api/messages/${enc(id)}`,
    headers: authHeaders(cookie),
    payload: { text },
  });
const del = (id: string, scope: 'everyone' | 'me', cookie = admin.cookie) =>
  t.app.inject({
    method: 'DELETE',
    url: `/api/messages/${enc(id)}?scope=${scope}`,
    headers: authHeaders(cookie),
  });
const edits = async (id: string, cookie = admin.cookie) => {
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/messages/${enc(id)}/edits`,
    headers: authHeaders(cookie),
  });
  expect(res.statusCode).toBe(200);
  return MessageEditsResponse.parse(res.json());
};
async function list(chatJid = DM, cookie = admin.cookie): Promise<Message[]> {
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/chats/${enc(chatJid)}/messages`,
    headers: authHeaders(cookie),
  });
  expect(res.statusCode).toBe(200);
  return MessageListResponse.parse(res.json()).messages;
}
const byId = async (id: string, chatJid = DM) => (await list(chatJid)).find((m) => m.id === id);
const audits = () =>
  (
    t.ctx.db
      .prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'message.%'")
      .all() as Array<{
      action: string;
      meta: string;
    }>
  ).map((r) => ({ action: r.action, meta: JSON.parse(r.meta) as Record<string, unknown> }));
const preview = (jid = DM) => getChats(t.ctx).get(jid)!.lastMessagePreview;
const age = (id: string, ms: number) =>
  t.ctx.db.prepare('UPDATE messages SET timestamp = timestamp - ? WHERE id = ?').run(ms, id);

describe('PATCH /api/messages/:id (edit)', () => {
  it('the teammate who sent it edits it: WhatsApp, the row, the earlier version, event, audit', async () => {
    await incoming(DM, 'IN1');
    teamMessage('OUT1', agent.id);
    const res = await edit('OUT1', '  A large Kopi Peng is RM5.50.  ', agent.cookie);
    expect(res.statusCode).toBe(200);
    const m = MessageSchema.parse(res.json());
    expect(m).toMatchObject({ id: 'OUT1', body: 'A large Kopi Peng is RM5.50.', editCount: 1 });
    expect(m.editedAt).toEqual(expect.any(Number));
    expect(t.wa.changes).toEqual([
      {
        kind: 'edit',
        chatJid: DM,
        target: { id: 'OUT1', fromMe: true, participant: null },
        text: 'A large Kopi Peng is RM5.50.',
      },
    ]);
    expect(updated.map((u) => [u.id, u.body])).toEqual([['OUT1', 'A large Kopi Peng is RM5.50.']]);
    expect(preview()).toBe('A large Kopi Peng is RM5.50.');
    expect(await edits('OUT1', agent.cookie)).toEqual({
      messageId: 'OUT1',
      edits: [{ previousBody: 'team OUT1', at: m.editedAt, by: 'team', userId: agent.id }],
      original: null,
    });
    expect(audits()).toEqual([
      { action: 'message.edit', meta: { messageId: 'OUT1', chatJid: DM } },
    ]);
    // The same text again changes nothing and sends nothing.
    expect((await edit('OUT1', 'A large Kopi Peng is RM5.50.')).statusCode).toBe(200);
    expect(t.wa.changes).toHaveLength(1);
    expect((await byId('OUT1'))!.editCount).toBe(1);
  });

  it('an admin edits a phone or AI message; an agent only their own', async () => {
    teamMessage('PHONE', null);
    teamMessage('MINE', admin.id);
    expect((await edit('PHONE', 'x', agent.cookie)).statusCode).toBe(403);
    expect((await edit('MINE', 'x', agent.cookie)).statusCode).toBe(403);
    expect((await edit('PHONE', 'from the inbox')).statusCode).toBe(200);
    expect(t.wa.changes).toHaveLength(1);
  });

  it('refuses customer, system, template, media and still-sending messages, and after 15 minutes', async () => {
    await incoming(DM, 'IN1');
    teamMessage('SYS', null, { type: 'system' });
    teamMessage('TPL', admin.id, { template_name: 'hello', template_language: 'en' });
    teamMessage('PIC', admin.id, { type: 'image', body: null, media_mime: 'image/png' });
    teamMessage('CAP', admin.id, { type: 'image', body: 'old caption', media_mime: 'image/png' });
    teamMessage('local-c1', admin.id, { status: 'pending' });
    teamMessage('OLD', admin.id);
    age('OLD', EDIT_WINDOW_MS + 1000);
    expect((await edit('NOPE', 'x')).statusCode).toBe(404);
    expect((await edit('IN1', 'x')).statusCode).toBe(400);
    expect((await edit('SYS', 'x')).statusCode).toBe(400);
    expect((await edit('TPL', 'x')).statusCode).toBe(400);
    expect((await edit('PIC', 'x')).statusCode).toBe(400);
    expect((await edit('local-c1', 'x')).statusCode).toBe(409);
    const old = await edit('OLD', 'x');
    expect([old.statusCode, old.json().error.code]).toEqual([409, 'edit_window_closed']);
    expect((await edit('OUT', '   ')).statusCode).toBe(400);
    // A caption can be edited.
    expect((await edit('CAP', 'new caption')).statusCode).toBe(200);
    expect(t.wa.changes.map((c) => c.kind)).toEqual(['edit']);
  });

  it('WhatsApp offline answers 503 and changes nothing', async () => {
    teamMessage('OUT1', admin.id);
    t.wa.simulateStatus({ state: 'connecting' });
    expect((await edit('OUT1', 'x')).statusCode).toBe(503);
    expect((await byId('OUT1'))!.body).toBe('team OUT1');
  });

  it('a deleted message cannot be edited', async () => {
    teamMessage('OUT1', admin.id);
    expect((await del('OUT1', 'everyone')).statusCode).toBe(200);
    expect((await edit('OUT1', 'x')).statusCode).toBe(409);
  });
});

describe('DELETE /api/messages/:id?scope=everyone', () => {
  it('deletes on WhatsApp; the message goes out without body, media or reactions', async () => {
    await incoming(DM, 'IN1');
    teamMessage('OUT1', agent.id);
    t.ctx.db
      .prepare(
        "INSERT INTO message_reactions (message_id, reactor, chat_wa_jid, emoji, from_me, reacted_at) VALUES ('OUT1', ?, ?, '👍', 0, 1)",
      )
      .run(DM, DM);
    expect((await byId('OUT1'))!.reactions).toHaveLength(1);
    const res = await del('OUT1', 'everyone', agent.cookie);
    expect(res.statusCode).toBe(200);
    const m = MessageSchema.parse(res.json());
    expect(m).toMatchObject({
      body: null,
      mediaUrl: null,
      deletedBy: 'team',
      deletedByUserId: agent.id,
      reactions: [],
    });
    expect(m.deletedAt).toEqual(expect.any(Number));
    expect(t.wa.changes).toEqual([
      {
        kind: 'deleteForEveryone',
        chatJid: DM,
        target: { id: 'OUT1', fromMe: true, participant: null },
      },
    ]);
    expect(preview()).toBe('This message was deleted');
    expect(updated.at(-1)).toMatchObject({ id: 'OUT1', body: null, deletedBy: 'team' });
    // Admins can read the original; agents cannot, not even through the earlier versions.
    expect((await edits('OUT1')).original).toBe('team OUT1');
    expect(await edits('OUT1', agent.cookie)).toEqual({
      messageId: 'OUT1',
      edits: [],
      original: null,
    });
    expect(audits()).toEqual([
      { action: 'message.delete', meta: { messageId: 'OUT1', chatJid: DM, scope: 'everyone' } },
    ]);
    expect((await del('OUT1', 'everyone')).statusCode).toBe(409);
  });

  it('refuses after 2 days, customer messages and other teammates; a pending send is cancelled', async () => {
    await incoming(DM, 'IN1');
    teamMessage('OLD', admin.id);
    age('OLD', DELETE_WINDOW_MS + 1000);
    teamMessage('PHONE', null);
    teamMessage('local-c2', agent.id, { status: 'pending' });
    const old = await del('OLD', 'everyone');
    expect([old.statusCode, old.json().error.code]).toEqual([409, 'delete_window_closed']);
    expect((await del('IN1', 'everyone')).statusCode).toBe(400);
    expect((await del('PHONE', 'everyone', agent.cookie)).statusCode).toBe(403);
    expect((await del('MISSING', 'everyone')).statusCode).toBe(404);
    const pending = await del('local-c2', 'everyone', agent.cookie);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ status: 'failed', deletedBy: 'team' });
    expect(t.wa.changes).toEqual([]);
  });

  it('a send that finishes after its delete is deleted on WhatsApp too', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sendText = t.wa.sendText.bind(t.wa);
    vi.spyOn(t.wa, 'sendText').mockImplementation(async (...args) => {
      await gate;
      return sendText(...args);
    });
    await incoming(DM, 'IN1');
    const sent = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(DM)}/messages`,
      headers: authHeaders(agent.cookie),
      payload: { text: 'Oops', clientId: 'late-1' },
    });
    expect(sent.statusCode).toBe(201);
    await vi.waitFor(() => expect(t.wa.sendText).toHaveBeenCalled());
    expect((await del('local-late-1', 'everyone', agent.cookie)).statusCode).toBe(200);
    release();
    await vi.waitFor(() => expect(t.wa.changes.map((c) => c.kind)).toEqual(['deleteForEveryone']));
    const row = (await list()).find((m) => m.clientId === 'late-1')!;
    expect(row).toMatchObject({ deletedBy: 'team', body: null });
  });
});

describe('DELETE /api/messages/:id?scope=me', () => {
  it('an admin hides a message for the team and on the linked phone', async () => {
    await incoming(DM, 'IN1');
    await incoming(DM, 'IN2');
    const res = await del('IN2', 'me');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'IN2', hidden: true });
    const row = t.ctx.db.prepare('SELECT timestamp FROM messages WHERE id = ?').get('IN2') as {
      timestamp: number;
    };
    expect(t.wa.changes).toEqual([
      {
        kind: 'deleteForMe',
        chatJid: DM,
        target: { id: 'IN2', fromMe: false, participant: null },
        timestamp: row.timestamp,
      },
    ]);
    expect((await list()).map((m) => m.id)).toEqual(['IN1']);
    expect(preview()).toBe('body IN1');
    expect(updated.at(-1)).toMatchObject({ id: 'IN2', hidden: true });
    expect(audits()).toEqual([
      { action: 'message.delete', meta: { messageId: 'IN2', chatJid: DM, scope: 'me' } },
    ]);
    // Again: nothing more is sent.
    expect((await del('IN2', 'me')).statusCode).toBe(200);
    expect(t.wa.changes).toHaveLength(1);
  });

  it('agents may not; a group member message names its author; a pending send is cancelled', async () => {
    await incoming(GROUP, 'G1');
    expect((await del('G1', 'me', agent.cookie)).statusCode).toBe(403);
    expect((await del('G1', 'me')).statusCode).toBe(200);
    expect(t.wa.changes).toEqual([
      expect.objectContaining({
        kind: 'deleteForMe',
        chatJid: GROUP,
        target: { id: 'G1', fromMe: false, participant: ALI },
      }),
    ]);
    teamMessage('local-c3', admin.id, { status: 'pending' });
    const pending = await del('local-c3', 'me');
    expect(pending.json()).toMatchObject({ hidden: true, status: 'failed' });
    expect(t.wa.changes).toHaveLength(1);
    teamMessage('SYS', null, { type: 'system' });
    expect((await del('SYS', 'me')).statusCode).toBe(400);
    expect((await list(GROUP)).map((m) => m.id)).toEqual([]);
    expect(preview(GROUP)).toBeNull();
  });

  it('a hidden or deleted message never serves its file', async () => {
    await incoming(DM, 'IN1');
    t.ctx.db
      .prepare("UPDATE messages SET media_path = 'x.png', media_status = 'ok' WHERE id = 'IN1'")
      .run();
    t.ctx.db
      .prepare("UPDATE messages SET deleted_at = 1, deleted_by = 'sender' WHERE id = 'IN1'")
      .run();
    expect(getMessages(t.ctx).mediaPath('IN1')).toBeNull();
    await expect(getMessages(t.ctx).redownload('IN1')).rejects.toMatchObject({ status: 404 });
  });

  it('the scope is required and limits count edits and deletes together', async () => {
    teamMessage('OUT1', admin.id);
    const bad = await t.app.inject({
      method: 'DELETE',
      url: '/api/messages/OUT1',
      headers: authHeaders(admin.cookie),
    });
    expect(bad.statusCode).toBe(400);
    for (let i = 0; i < CHANGES_PER_MINUTE; i++)
      expect((await edit('OUT1', `v${i}`)).statusCode).toBe(200);
    expect((await del('OUT1', 'everyone')).statusCode).toBe(429);
  });
});

describe('edits and deletes WhatsApp reports', () => {
  it('a customer edits their message: new text, earlier version, event, preview; no notification', async () => {
    let notified = 0;
    t.ctx.bus.on('inbound:notify', () => notified++);
    await incoming(DM, 'IN1');
    notified = 0;
    t.wa.simulateEdit({
      chatJid: DM,
      targetId: 'IN1',
      body: 'Make it 4',
      timestamp: Date.now() + 10,
    });
    const m = (await byId('IN1'))!;
    expect(m).toMatchObject({ body: 'Make it 4', editCount: 1 });
    expect((await edits('IN1')).edits).toEqual([
      { previousBody: 'body IN1', at: expect.any(Number), by: 'sender', userId: null },
    ]);
    expect(updated.map((u) => u.id)).toEqual(['IN1']);
    expect(preview()).toBe('Make it 4');
    expect(notified).toBe(0);
    // An older edit arriving late, a repeat, and an edit from another chat change nothing.
    t.wa.simulateEdit({ chatJid: DM, targetId: 'IN1', body: 'older', timestamp: 1 });
    t.wa.simulateEdit({
      chatJid: DM,
      targetId: 'IN1',
      body: 'Make it 4',
      timestamp: Date.now() + 20,
    });
    t.wa.simulateEdit({ chatJid: OTHER, targetId: 'IN1', body: 'spoof' });
    expect((await byId('IN1'))!.body).toBe('Make it 4');
    expect(updated).toHaveLength(1);
  });

  it('only the author changes a message: a customer cannot edit ours, the phone can', async () => {
    teamMessage('OUT1', admin.id);
    t.wa.simulateEdit({ chatJid: DM, targetId: 'OUT1', body: 'customer spoof' });
    expect((await byId('OUT1'))!.body).toBe('team OUT1');
    t.wa.simulateEdit({ chatJid: DM, targetId: 'OUT1', body: 'from the phone', fromMe: true });
    expect((await edits('OUT1')).edits.map((e) => e.by)).toEqual(['phone']);
    t.wa.simulateRevoke({ chatJid: DM, targetId: 'OUT1' });
    expect((await byId('OUT1'))!.deletedAt).toBeFalsy();
    t.wa.simulateRevoke({ chatJid: DM, targetId: 'OUT1', fromMe: true });
    expect((await byId('OUT1'))!).toMatchObject({ deletedBy: 'phone', body: null });
  });

  it('a customer deletes their message: placeholder for everyone, original for admins', async () => {
    await incoming(DM, 'IN1');
    t.wa.simulateRevoke({ chatJid: DM, targetId: 'IN1' });
    expect((await list(DM, agent.cookie)).find((m) => m.id === 'IN1')).toMatchObject({
      body: null,
      deletedBy: 'sender',
    });
    expect(preview()).toBe('This message was deleted');
    expect((await edits('IN1')).original).toBe('body IN1');
    expect((await edits('IN1', agent.cookie)).original).toBeNull();
    // A later edit of a deleted message changes nothing.
    t.wa.simulateEdit({ chatJid: DM, targetId: 'IN1', body: 'back' });
    expect((await byId('IN1'))!.body).toBeNull();
  });

  it('groups: the author edits; a group admin or our phone deletes another member’s message', async () => {
    await incoming(GROUP, 'G1');
    await incoming(GROUP, 'G2');
    t.wa.simulateEdit({ chatJid: GROUP, targetId: 'G1', senderJid: BEN, body: 'not Ben’s' });
    expect((await byId('G1', GROUP))!.body).toBe('body G1');
    t.wa.simulateEdit({ chatJid: GROUP, targetId: 'G1', senderJid: ALI, body: 'Ali edits' });
    expect((await byId('G1', GROUP))!.body).toBe('Ali edits');
    t.wa.simulateRevoke({ chatJid: GROUP, targetId: 'G1', senderJid: BEN });
    expect((await byId('G1', GROUP))!.deletedBy).toBe('group_admin');
    t.wa.simulateRevoke({ chatJid: GROUP, targetId: 'G2', fromMe: true });
    expect((await byId('G2', GROUP))!.deletedBy).toBe('phone');
  });

  it('a change that arrives before its message is applied when the message is stored', async () => {
    t.wa.simulateRevoke({ chatJid: DM, targetId: 'LATER' }, 'history');
    t.wa.simulateEdit({
      chatJid: DM,
      targetId: 'EDITED',
      body: 'edited first',
      timestamp: Date.now() + 5,
    });
    // Only in the same chat: a change from another chat never applies.
    t.wa.simulateRevoke({ chatJid: OTHER, targetId: 'ELSEWHERE' });
    await incoming(DM, 'LATER');
    await incoming(DM, 'EDITED');
    await incoming(DM, 'ELSEWHERE');
    const msgs = await list();
    expect(msgs.find((m) => m.id === 'LATER')).toMatchObject({ deletedBy: 'sender', body: null });
    expect(msgs.find((m) => m.id === 'EDITED')).toMatchObject({
      body: 'edited first',
      editCount: 1,
    });
    expect(msgs.find((m) => m.id === 'ELSEWHERE')).toMatchObject({ body: 'body ELSEWHERE' });
    expect(
      (t.ctx.db.prepare('SELECT COUNT(*) AS n FROM message_changes_pending').get() as { n: number })
        .n,
    ).toBe(0);
  });

  it('a message with a mention that is deleted keeps no text in the list or preview', async () => {
    await incoming(GROUP, 'M1', { body: '@60122222222 see you', mentionedJids: [BEN] });
    t.wa.simulateRevoke({ chatJid: GROUP, targetId: 'M1', senderJid: ALI });
    expect((await byId('M1', GROUP))!.body).toBeNull();
    expect(preview(GROUP)).toBe('This message was deleted');
  });

  it('the fake phone dev routes deliver edits and deletes', async () => {
    await incoming(DM, 'IN1');
    await incoming(GROUP, 'G1');
    const post = (path: string, payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url: `/api/dev/${path}`,
        headers: authHeaders(admin.cookie),
        payload,
      });
    expect((await post('fake-edit', { messageId: 'IN1' })).statusCode).toBe(400);
    expect((await post('fake-edit', { messageId: 'NOPE', body: 'x' })).statusCode).toBe(404);
    const res = await post('fake-edit', { messageId: 'IN1', body: 'via dev' });
    expect(res.json()).toMatchObject({
      messageId: 'IN1',
      chatJid: DM,
      timestamp: expect.any(Number),
    });
    expect((await byId('IN1'))!.body).toBe('via dev');
    // A group change comes from the message's author unless another member is named.
    expect((await post('fake-revoke', { messageId: 'G1' })).statusCode).toBe(200);
    expect((await byId('G1', GROUP))!.deletedBy).toBe('sender');
    teamMessage('OUT1', admin.id);
    expect((await post('fake-revoke', { messageId: 'OUT1', fromMe: true })).statusCode).toBe(200);
    await incoming(DM, 'IN2');
    expect((await post('fake-revoke', { messageId: 'IN2', senderJid: DM })).statusCode).toBe(200);
    expect((await byId('OUT1'))!.deletedBy).toBe('phone');
    expect((await byId('IN2'))!.deletedBy).toBe('sender');
  });
});

describe('a connection that cannot edit or delete', () => {
  it('answers 409 not_supported; the inbox lists its capabilities', async () => {
    await t.close();
    await start(
      new FakeWaAdapter({
        capabilities: {
          ...LINKED_PHONE_CAPABILITIES,
          editMessage: false,
          deleteForEveryone: false,
          deleteForMe: false,
        },
      }),
    );
    teamMessage('OUT1', admin.id);
    for (const res of [
      await edit('OUT1', 'x'),
      await del('OUT1', 'everyone'),
      await del('OUT1', 'me'),
    ])
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'not_supported']);
    expect(t.wa.changes).toEqual([]);
  });
});

describe('changeAuthor', () => {
  const aliases = { resolve: (jid: string) => (jid === '900111@lid' ? ALI : jid) };
  it('direct chats: each side changes only its own messages', () => {
    const ours = { from_me: 1, sender_jid: null, chat_jid: DM };
    const theirs = { from_me: 0, sender_jid: DM, chat_jid: DM };
    expect(changeAuthor(ours, { fromMe: true, senderJid: null }, 'edit', false, aliases)).toBe(
      'phone',
    );
    expect(
      changeAuthor(ours, { fromMe: false, senderJid: DM }, 'delete', false, aliases),
    ).toBeNull();
    expect(changeAuthor(theirs, { fromMe: false, senderJid: DM }, 'delete', false, aliases)).toBe(
      'sender',
    );
  });
  it('groups: the same member under another address, an admin delete, never an admin edit', () => {
    const ali = { from_me: 0, sender_jid: ALI, chat_jid: GROUP };
    expect(
      changeAuthor(ali, { fromMe: false, senderJid: '900111@lid' }, 'edit', true, aliases),
    ).toBe('sender');
    expect(changeAuthor(ali, { fromMe: false, senderJid: BEN }, 'edit', true, aliases)).toBeNull();
    expect(changeAuthor(ali, { fromMe: false, senderJid: BEN }, 'delete', true, aliases)).toBe(
      'group_admin',
    );
    expect(changeAuthor(ali, { fromMe: true, senderJid: null }, 'delete', true, aliases)).toBe(
      'phone',
    );
    expect(changeAuthor(ali, { fromMe: false, senderJid: null }, 'delete', true, aliases)).toBe(
      'group_admin',
    );
  });
});

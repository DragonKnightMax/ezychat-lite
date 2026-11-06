// Limited chat access (docs/features/partner-role/design.md): an agent whose "Chats this member can
// see" is Only chosen chats opens only those chats, works there like any agent, and hears nothing
// about any other chat. Lite (one inbox, the single-inbox shortcut) unless a test says otherwise.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import {
  ChatListResponse,
  GroupInfoResponse,
  MemberChatsResponse,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type User,
} from '@ezychat/shared';
import type { WaGroupInfo } from '@ezychat/wa';
import {
  canOpenChat,
  chosenChats,
  scopeFor,
  usersWhoCanOpen,
  usersWhoCanOpenChat,
  visibleInboxIds,
} from '../src/inboxes/access.js';
import { mergeChat } from '../src/chats/merge.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const A = '60123000111@s.whatsapp.net'; // chosen for the limited agent
const B = '60123000222@s.whatsapp.net'; // not chosen
const G = '120363000000000001@g.us'; // chosen group
const MEMBER = '60175550001@s.whatsapp.net';
const enc = encodeURIComponent;

const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

let t: TestApp;
let admin: { user: User; cookie: string };
let limited: { user: User; cookie: string };
let normal: { user: User; cookie: string };

async function seed(app: TestApp, inboxId = 1) {
  const wa = app.inboxWa(inboxId);
  wa.simulateIncoming({ chatJid: A, body: 'hello A', senderName: 'Ann' });
  wa.simulateIncoming({ chatJid: B, body: 'hello B', senderName: 'Bob' });
  wa.simulateIncoming({ chatJid: G, body: 'group hi', senderJid: MEMBER, senderName: 'Ben' });
  await settle();
}

function put(userId: number, body: unknown, cookie = admin.cookie) {
  return t.app.inject({
    method: 'PUT',
    url: `/api/users/${userId}/chats`,
    headers: authHeaders(cookie),
    payload: body as Record<string, unknown>,
  });
}

async function limit(userId: number, chats: string[]) {
  const res = await put(userId, { scope: 'chosen', chats });
  expect(res.statusCode).toBe(200);
  return MemberChatsResponse.parse(res.json());
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
) {
  return t.app.inject({
    method,
    url,
    headers: authHeaders(cookie),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function list(cookie: string, query = '') {
  const res = await inject('GET', `/api/chats${query}`, cookie);
  expect(res.statusCode).toBe(200);
  return ChatListResponse.parse(res.json()).chats.map((c) => c.jid);
}

beforeEach(async () => {
  t = await makeTestApp();
  admin = await createUserAndLogin(t, { role: 'admin' });
  limited = await createUserAndLogin(t);
  normal = await createUserAndLogin(t);
  await seed(t);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

describe('GET/PUT /api/users/:id/chats', () => {
  it('defaults to All chats and keeps the choice with names, in the order chosen', async () => {
    const before = await inject('GET', `/api/users/${limited.user.id}/chats`, admin.cookie);
    expect(MemberChatsResponse.parse(before.json())).toEqual({ scope: 'all', chats: [] });
    const saved = await limit(limited.user.id, [G, A, A]);
    expect(saved.scope).toBe('chosen');
    expect(saved.chats.map((c) => [c.jid, c.type])).toEqual([
      [G, 'group'],
      [A, 'dm'],
    ]);
    expect(saved.chats[1]!.name).toBe('Ann');
    const again = await inject('GET', `/api/users/${limited.user.id}/chats`, admin.cookie);
    expect(MemberChatsResponse.parse(again.json())).toEqual(saved);
  });

  it('is admin-only, refuses admins, AI members, unknown users and unknown chats', async () => {
    expect(
      (await put(limited.user.id, { scope: 'chosen', chats: [A] }, normal.cookie)).statusCode,
    ).toBe(403);
    expect(
      (await inject('GET', `/api/users/${limited.user.id}/chats`, normal.cookie)).statusCode,
    ).toBe(403);
    const asAdmin = await put(admin.user.id, { scope: 'chosen', chats: [A] });
    expect(asAdmin.statusCode).toBe(400);
    expect(asAdmin.json().error.code).toBe('not_an_agent');
    const ai = t.ctx.db.prepare("SELECT id FROM users WHERE kind = 'ai' LIMIT 1").get() as
      { id: number } | undefined;
    if (ai)
      expect((await put(ai.id, { scope: 'chosen', chats: [A] })).json().error.code).toBe(
        'not_an_agent',
      );
    expect((await put(9999, { scope: 'all', chats: [] })).statusCode).toBe(404);
    expect((await inject('GET', '/api/users/9999/chats', admin.cookie)).statusCode).toBe(404);
    const unknown = await put(limited.user.id, {
      scope: 'chosen',
      chats: ['60199999999@s.whatsapp.net'],
    });
    expect(unknown.json().error.code).toBe('unknown_chat');
    const malformed = await put(limited.user.id, { scope: 'chosen', chats: [`${A}#x`] });
    expect(malformed.json().error.code).toBe('unknown_chat');
    expect((await put(limited.user.id, { scope: 'some' })).statusCode).toBe(400);
    // nothing was saved by a refused call
    expect(chosenChats(t.ctx, limited.user)).toBeNull();
  });

  it('"All chats" drops every chosen chat; the audit row carries ids only', async () => {
    await limit(limited.user.id, [A, G]);
    const back = await put(limited.user.id, { scope: 'all', chats: [A] });
    expect(MemberChatsResponse.parse(back.json())).toEqual({ scope: 'all', chats: [] });
    const rows = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'user.chat_scope' ORDER BY id")
      .all() as Array<{ meta: string }>;
    expect(rows.map((r) => JSON.parse(r.meta))).toEqual([
      { targetId: limited.user.id, before: 'all', after: 'chosen', added: [A, G], removed: [] },
      { targetId: limited.user.id, before: 'chosen', after: 'all', added: [], removed: [A, G] },
    ]);
    expect(rows.map((r) => r.meta).join()).not.toContain('Ann');
  });

  it('users, me and the directory carry the scope; the directory shows only chats the viewer opens', async () => {
    await limit(limited.user.id, [A]);
    const users = (await inject('GET', '/api/users', admin.cookie)).json().users as User[];
    expect(users.find((u) => u.id === limited.user.id)).toMatchObject({
      chatScope: 'chosen',
      chatJids: [A],
    });
    expect(users.find((u) => u.id === normal.user.id)?.chatScope).toBeUndefined();
    const me = (await inject('GET', '/api/me', limited.cookie)).json();
    expect(JSON.stringify(me)).toContain('"chatScope":"chosen"');
    const dir = (await inject('GET', '/api/users/directory', normal.cookie)).json().users as Array<{
      id: number;
      chatJids?: string[];
    }>;
    expect(dir.find((u) => u.id === limited.user.id)?.chatJids).toEqual([A]);
    expect(dir.find((u) => u.id === normal.user.id)?.chatJids).toBeUndefined();
  });

  it('a promotion to admin clears the choice (no hidden leftovers)', async () => {
    await limit(limited.user.id, [A]);
    const res = await inject('PATCH', `/api/users/${limited.user.id}`, admin.cookie, {
      role: 'admin',
    });
    expect(res.statusCode).toBe(200);
    expect(
      t.ctx.db.prepare('SELECT chat_scope FROM users WHERE id = ?').get(limited.user.id),
    ).toEqual({
      chat_scope: 'all',
    });
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM member_chats').get()).toEqual({ n: 0 });
  });
});

describe('the one scope check', () => {
  it('Lite: a limited agent lists, searches and tag-filters only the chosen chats', async () => {
    expect(new Set(await list(limited.cookie))).toEqual(new Set([A, B, G]));
    await limit(limited.user.id, [A, G]);
    expect(new Set(await list(limited.cookie))).toEqual(new Set([A, G]));
    expect(await list(limited.cookie, '?q=Bob')).toEqual([]);
    expect(await list(limited.cookie, '?q=Ann')).toEqual([A]);
    // the other agent and the admin are unchanged
    expect(new Set(await list(normal.cookie))).toEqual(new Set([A, B, G]));
    expect(new Set(await list(admin.cookie))).toEqual(new Set([A, B, G]));
    // tags: only those of the chosen chats
    const tag = (jid: string, tags: string[]) =>
      inject('PUT', `/api/chats/${enc(jid)}/profile`, admin.cookie, {
        name: '',
        company: '',
        email: '',
        otherPhone: '',
        address: '',
        tags,
      });
    await tag(A, ['VIP']);
    await tag(B, ['Secret']);
    expect((await inject('GET', '/api/customer-tags', limited.cookie)).json().tags).toEqual([
      'VIP',
    ]);
    expect(await list(limited.cookie, '?tag=Secret')).toEqual([]);
    expect(await list(limited.cookie, '?tag=VIP')).toEqual([A]);
    // nothing chosen: no chats, no tags (never "all")
    await limit(limited.user.id, []);
    expect(await list(limited.cookie)).toEqual([]);
    expect((await inject('GET', '/api/customer-tags', limited.cookie)).json().tags).toEqual([]);
  });

  it('answers 404 outside the chosen chats on per-chat and message-id routes; works inside', async () => {
    await limit(limited.user.id, [A]);
    for (const [method, url, payload] of [
      ['GET', `/api/chats/${enc(B)}`],
      ['GET', `/api/chats/${enc(B)}/messages`],
      ['GET', `/api/chats/${enc(B)}/notes`],
      ['POST', `/api/chats/${enc(B)}/messages`, { text: 'hi', clientId: 'x-1' }],
      ['PATCH', `/api/chats/${enc(B)}`, { status: 'resolved' }],
      ['GET', `/api/chats/${enc(G)}/members`],
    ] as const) {
      const res = await inject(method, url, limited.cookie, payload);
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('Bob');
    }
    const idB = (
      t.ctx.db.prepare('SELECT id FROM messages WHERE chat_jid = ?').get(B) as { id: string }
    ).id;
    expect((await inject('GET', `/api/media/${enc(idB)}`, limited.cookie)).statusCode).toBe(404);
    // inside: a normal agent (chat, messages, notes, send)
    expect((await inject('GET', `/api/chats/${enc(A)}`, limited.cookie)).statusCode).toBe(200);
    expect(
      (await inject('POST', `/api/chats/${enc(A)}/notes`, limited.cookie, { body: 'n' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await inject('GET', `/api/chats/${enc(A)}/notes`, limited.cookie)).json().notes,
    ).toHaveLength(1);
    const sent = await inject('POST', `/api/chats/${enc(A)}/messages`, limited.cookie, {
      text: 'hi',
      clientId: 'x-2',
    });
    expect(sent.statusCode).toBe(201);
  });

  it('the single-inbox shortcut never applies to a limited agent', async () => {
    await limit(limited.user.id, [A]);
    expect(scopeFor(t.ctx, normal.user)).toBe('all');
    expect(scopeFor(t.ctx, limited.user)).toEqual(new Set());
    expect(usersWhoCanOpen(t.ctx, 1)).not.toContain(limited.user.id);
    expect(usersWhoCanOpen(t.ctx, 1)).toContain(normal.user.id);
    expect(usersWhoCanOpenChat(t.ctx, A)).toContain(limited.user.id);
    expect(usersWhoCanOpenChat(t.ctx, B)).not.toContain(limited.user.id);
    expect(usersWhoCanOpenChat(t.ctx, 'not a key#x')).toEqual([]);
    // disabled: nobody hears about anything
    t.ctx.db.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').run(limited.user.id);
    expect(usersWhoCanOpenChat(t.ctx, A)).not.toContain(limited.user.id);
  });

  it('group members: names and numbers as for any agent, no member chat to open or start', async () => {
    await limit(limited.user.id, [G]);
    const info: WaGroupInfo = {
      jid: G,
      name: 'Regulars',
      description: null,
      createdAt: 1,
      ownerJid: MEMBER,
      size: 2,
      participants: [
        { jid: MEMBER, phoneJid: MEMBER, lidJid: null, username: null, role: 'member' },
        { jid: A, phoneJid: A, lidJid: null, username: null, role: 'member' },
      ],
    };
    t.wa.setGroupInfo(info);
    getChats(t.ctx).upsertFromWa({ jid: MEMBER, type: 'dm', name: 'Ben' });
    const res = await inject('GET', `/api/chats/${enc(G)}/members`, limited.cookie);
    expect(res.statusCode).toBe(200);
    const members = GroupInfoResponse.parse(res.json()).members;
    const ben = members.find((m) => m.jid === MEMBER)!;
    expect(ben.phone).toBe('60175550001'); // numbers as for any agent
    expect(ben.chatJid).toBeNull(); // Ben's chat is not one of the chosen chats
    const other = await inject('GET', `/api/chats/${enc(G)}/members`, normal.cookie);
    expect(
      GroupInfoResponse.parse(other.json()).members.find((m) => m.jid === MEMBER)?.chatJid,
    ).toBe(MEMBER);
    // a chosen chat stays linked
    await limit(limited.user.id, [G, A]);
    const linked = GroupInfoResponse.parse(
      (await inject('GET', `/api/chats/${enc(G)}/members`, limited.cookie)).json(),
    ).members.find((m) => m.jid === A);
    expect(linked?.chatJid).toBe(A);
    const start = await inject(
      'POST',
      `/api/chats/${enc(G)}/members/${enc(MEMBER)}/chat`,
      limited.cookie,
    );
    expect(start.statusCode).toBe(403);
    expect(start.json().error.code).toBe('chat_scope_limited');
  });

  it('Ask Ezy refuses a limited agent before any model call', async () => {
    await limit(limited.user.id, [A]);
    const res = await inject('POST', '/api/ask-ezy', limited.cookie, {
      question: 'How many chats?',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('chat_scope_limited');
  });

  it('several inboxes: chosen chats come from any inbox and replace inbox access', async () => {
    await t.close();
    t = await makeTestApp({ maxInboxes: 3, inboxes: 2 });
    admin = await createUserAndLogin(t, { role: 'admin' });
    limited = await createUserAndLogin(t);
    t.ctx.inboxes.repo.setUserInboxes(limited.user.id, [1]);
    await seed(t, 1);
    await seed(t, 2);
    await limit(limited.user.id, [`${A}#2`]);
    expect(await list(limited.cookie)).toEqual([`${A}#2`]);
    // inbox 2 is visible (name, status) but nothing else of it
    expect(visibleInboxIds(t.ctx, limited.user)).toEqual(new Set([2]));
    const inboxes = (await inject('GET', '/api/inboxes', limited.cookie)).json().inboxes as Array<{
      id: number;
    }>;
    expect(inboxes.map((i) => i.id)).toEqual([2]);
    expect((await inject('GET', `/api/chats/${enc(A)}`, limited.cookie)).statusCode).toBe(404);
    expect((await inject('GET', '/api/wa/status', limited.cookie)).json().me).toBeNull();
    // removing the inbox ends the access
    const removed = await inject('DELETE', `/api/inboxes/2`, admin.cookie);
    expect(removed.statusCode).toBe(204);
    const row = getChats(t.ctx).get(`${A}#2`)!;
    expect(canOpenChat(t.ctx, limited.user, { jid: row.jid, inbox_id: 2 })).toBe(false);
    expect(await list(limited.cookie)).toEqual([]);
    expect(usersWhoCanOpenChat(t.ctx, `${A}#2`)).not.toContain(limited.user.id);
    expect(
      (await put(limited.user.id, { scope: 'chosen', chats: [`${A}#2`] })).json().error.code,
    ).toBe('unknown_chat');
  });

  it('inbox 1 status and templates follow the chosen chats', async () => {
    await limit(limited.user.id, [A]);
    const status = (await inject('GET', '/api/wa/status', limited.cookie)).json();
    expect(status.state).toBe(t.wa.status.state);
    await limit(limited.user.id, []);
    expect(visibleInboxIds(t.ctx, limited.user)).toEqual(new Set());
  });

  it('a chat merge keeps the chosen chat under its new key', () => {
    t.ctx.db.prepare("UPDATE users SET chat_scope = 'chosen' WHERE id = ?").run(limited.user.id);
    t.ctx.db
      .prepare(
        'INSERT INTO member_chats (user_id, chat_jid, added_by, added_at) VALUES (?, ?, ?, 1)',
      )
      .run(limited.user.id, A, admin.user.id);
    const LID = '311222333444555@lid';
    mergeChat(t.ctx.db, A, LID, { now: Date.now() });
    expect(chosenChats(t.ctx, limited.user)).toEqual(new Set([LID]));
  });
});

describe('assignment', () => {
  it('a limited agent can be assigned only their chosen chats; removing a chat unassigns them', async () => {
    await limit(limited.user.id, [A]);
    const out = await inject('PATCH', `/api/chats/${enc(B)}`, admin.cookie, {
      assignedTo: limited.user.id,
    });
    expect(out.statusCode).toBe(400);
    expect(out.json().error.code).toBe('assignee_no_access');
    const ok = await inject('PATCH', `/api/chats/${enc(A)}`, admin.cookie, {
      assignedTo: limited.user.id,
    });
    expect(ok.statusCode).toBe(200);
    await limit(limited.user.id, [G]);
    expect(getChats(t.ctx).get(A)!.assignedTo).toBeNull();
    const event = t.ctx.db
      .prepare(
        "SELECT payload FROM chat_events WHERE chat_jid = ? AND type = 'unassigned' ORDER BY id DESC",
      )
      .get(A) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      previous: limited.user.id,
      reason: 'chat_access',
    });
  });
});

describe('AI hand-off picks only a teammate who may open the chat', () => {
  it('skips a free limited agent for a chat they did not choose', async () => {
    const pick = (jid: string) =>
      t.ctx.db
        .prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id')
        .all(JSON.stringify(usersWhoCanOpenChat(t.ctx, jid))) as Array<{ id: number }>;
    await limit(limited.user.id, [A]);
    expect(pick(B).map((r) => r.id)).not.toContain(limited.user.id);
    expect(pick(A).map((r) => r.id)).toContain(limited.user.id);
  });
});

// ---------------------------------------------------------------------------------------------
// Notifications: the owner's rule, one test per path. Nothing about an unchosen chat reaches a
// limited agent; a chosen chat reaches them like any agent.
// ---------------------------------------------------------------------------------------------

describe('notifications (push, notification:new, hand-offs)', () => {
  const chatOf = (jid: string, assignedTo: number | null) => ({
    ...getChats(t.ctx).get(jid)!,
    assignedTo,
  });
  const message = { id: 'm1', chatJid: B, body: 'hi' } as never;

  async function capture() {
    const { createPushService } = await import('../src/push/service.js');
    t.ctx.services.push!.shutdown();
    const sent: string[] = [];
    const push = createPushService(t.ctx, {
      sender: async (sub) => {
        sent.push(sub.endpoint);
      },
    });
    t.ctx.services.push = push;
    const live: string[][] = [];
    t.ctx.services.realtime = {
      io: {
        to: (rooms: string[]) => {
          live.push(rooms);
          return { emit: () => undefined };
        },
      },
      close: () => undefined,
      isOnline: () => false,
    } as never;
    for (const u of [admin, limited, normal])
      push.subscribe(u.user.id, {
        endpoint: `https://push.example/${u.user.id}`,
        keys: { p256dh: 'p', auth: 'a' },
      });
    return { push, sent, live, mine: `https://push.example/${limited.user.id}` };
  }

  beforeEach(async () => {
    await limit(limited.user.id, [A, G]);
  });

  it('new inbound message of an unassigned chat: web push and notification:new skip the limited agent', async () => {
    const { push, sent, live, mine } = await capture();
    await push.notifyInbound(chatOf(B, null), message);
    expect(sent).not.toContain(mine);
    expect(sent).toContain(`https://push.example/${normal.user.id}`);
    expect(live.flat()).not.toContain(`user:${limited.user.id}`);
    sent.length = 0;
    live.length = 0;
    await push.notifyInbound(chatOf(A, null), message);
    expect(sent).toContain(mine);
    expect(live.flat()).toContain(`user:${limited.user.id}`);
  });

  it('an unchosen chat still assigned to them (before the change) never notifies them', async () => {
    const { push, sent, live, mine } = await capture();
    await push.notifyInbound(chatOf(B, limited.user.id), message);
    expect(sent).toEqual([]);
    expect(live).toEqual([]);
    await push.notifyInbound(chatOf(A, limited.user.id), message);
    expect(sent).toEqual([mine]);
  });

  it('AI hand-off ("needs a team member"): only people who may open the chat', async () => {
    const { push, sent, live, mine } = await capture();
    await push.notifyHandoff(chatOf(B, null));
    expect(sent).not.toContain(mine);
    expect(live.flat()).not.toContain(`user:${limited.user.id}`);
    sent.length = 0;
    await push.notifyHandoff(chatOf(A, null));
    expect(sent).toContain(mine);
  });

  it('group hand-off: a limited agent hears only about a chosen group', async () => {
    const { push, sent, mine } = await capture();
    const G2 = '120363000000000002@g.us';
    t.wa.simulateIncoming({ chatJid: G2, body: 'other group', senderJid: MEMBER });
    await settle();
    await push.notifyGroupHandoff({
      chat: chatOf(G2, null),
      agentName: 'Aina',
      member: 'Ben',
      question: 'q',
    } as never);
    expect(sent).not.toContain(mine);
    sent.length = 0;
    await push.notifyGroupHandoff({
      chat: chatOf(G, null),
      agentName: 'Aina',
      member: 'Ben',
      question: 'q',
    } as never);
    expect(sent).toContain(mine);
  });

  it('the bus path (inbound:notify) follows the same rule', async () => {
    const { sent, mine } = await capture();
    t.ctx.bus.emit('inbound:notify', { chat: chatOf(B, null), message });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(mine);
  });
});

// ---------------------------------------------------------------------------------------------
// Sockets: limited agents join chat:<jid> rooms only; changes re-sync without a reconnect.
// ---------------------------------------------------------------------------------------------

describe('socket events', () => {
  type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
  const sockets: ClientSocket[] = [];
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  async function listening() {
    await t.close();
    t = await makeTestApp({ listen: true });
    admin = await createUserAndLogin(t, { role: 'admin' });
    limited = await createUserAndLogin(t);
    normal = await createUserAndLogin(t);
    await seed(t);
  }

  async function connect(cookie: string) {
    const s: ClientSocket = ioClient(t.url!, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { cookie },
      forceNew: true,
    });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    const seen: Array<{ ev: string; arg: unknown }> = [];
    s.onAny((ev: string, arg: unknown) => seen.push({ ev, arg }));
    return { s, seen };
  }

  const about = (seen: Array<{ ev: string; arg: unknown }>, jid: string) =>
    seen
      .filter((e) => {
        const a = e.arg as { chatJid?: string; jid?: string } | undefined;
        return a?.chatJid === jid || a?.jid === jid;
      })
      .map((e) => e.ev);

  it('message:new, chat:updated, message:reactions and typing reach a limited agent only for chosen chats', async () => {
    await listening();
    await limit(limited.user.id, [A]);
    const me = await connect(limited.cookie);
    const other = await connect(normal.cookie);
    t.wa.simulateIncoming({ chatJid: B, body: 'secret B', id: 'b-2' });
    t.wa.simulateIncoming({ chatJid: A, body: 'for A', id: 'a-2' });
    await delay(150);
    t.wa.simulateReaction({ chatJid: B, targetId: 'b-2', emoji: '👍' });
    t.wa.simulateReaction({ chatJid: A, targetId: 'a-2', emoji: '👍' });
    other.s.emit('typing', { chatJid: B });
    other.s.emit('typing', { chatJid: A });
    await delay(250);
    expect(about(me.seen, B)).toEqual([]);
    expect(about(me.seen, A)).toEqual(
      expect.arrayContaining(['message:new', 'chat:updated', 'message:reactions', 'typing']),
    );
    expect(about(other.seen, B)).toEqual(expect.arrayContaining(['message:new', 'chat:updated']));
    // a limited agent's own typing in an unchosen chat goes nowhere
    me.s.emit('typing', { chatJid: B });
    await delay(100);
    expect(about(other.seen, B)).not.toContain('typing');
  });

  it('a change re-syncs the rooms live and tells the client (chats:access), no reconnect', async () => {
    await listening();
    await limit(limited.user.id, [A]);
    const me = await connect(limited.cookie);
    await limit(limited.user.id, [B]);
    await delay(100);
    expect(me.seen.map((e) => e.ev)).toContain('chats:access');
    t.wa.simulateIncoming({ chatJid: A, body: 'A now hidden', id: 'a-3' });
    t.wa.simulateIncoming({ chatJid: B, body: 'B now visible', id: 'b-3' });
    await delay(200);
    expect(about(me.seen, A)).toEqual([]);
    expect(about(me.seen, B)).toContain('message:new');
    // never an inbox room: a brand-new chat of the inbox reaches them not at all
    t.wa.simulateIncoming({
      chatJid: '60123000333@s.whatsapp.net',
      body: 'new customer',
      id: 'c-1',
    });
    await delay(150);
    expect(about(me.seen, '60123000333@s.whatsapp.net')).toEqual([]);
    const tags = me.seen
      .filter((e) => e.ev === 'notification:new')
      .map((e) => (e.arg as { tag: string }).tag);
    expect(tags).not.toContain(A);
    expect(tags).not.toContain('60123000333@s.whatsapp.net');
  });

  it('getMessages ingest stays unaffected for the team (sanity)', async () => {
    await listening();
    await limit(limited.user.id, []);
    const other = await connect(normal.cookie);
    await getMessages(t.ctx).ingest(
      {
        id: 'x-9',
        chatJid: B,
        body: 'still here',
        type: 'text',
        fromMe: false,
        senderJid: B,
        senderName: 'Bob',
        timestamp: Date.now(),
        quotedId: null,
        media: null,
      },
      'live',
    );
    await delay(150);
    expect(about(other.seen, B)).toContain('message:new');
  });
});

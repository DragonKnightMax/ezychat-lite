import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatListResponse,
  CustomerProfileBody,
  GroupInfoResponse,
  type Message,
} from '@ezychat/shared';
import type { WaGroupInfo } from '@ezychat/wa';
import { computeInboxActivity } from '../src/chats/activity.js';
import { getAliases } from '../src/chats/aliases.js';
import { computeInboxStats } from '../src/chats/stats.js';
import { runIdentityMigration } from '../src/chats/identity-migration.js';
import { mergeChat } from '../src/chats/merge.js';
import { ChatRepo } from '../src/chats/repo.js';
import { createGroupService } from '../src/groups/service.js';
import { createProfileImages } from '../src/http/profile-images.js';
import { getChats } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const PN = '60123456789@s.whatsapp.net';
const LID = '987654321012345@lid';
const GROUP = '120363000000000009@g.us';
const MEMBER_PN = '60175550001@s.whatsapp.net';
const MEMBER_LID = '111222333444555@lid';
const enc = encodeURIComponent;

const open: TestApp[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

async function twoInboxes(): Promise<TestApp> {
  const t = await makeTestApp({ maxInboxes: 3, inboxes: 2 });
  open.push(t);
  return t;
}

function group(over: Partial<WaGroupInfo> = {}): WaGroupInfo {
  return {
    jid: GROUP,
    name: 'Partners',
    description: null,
    createdAt: 1_710_000_000_000,
    ownerJid: null,
    size: 2,
    participants: [
      {
        jid: MEMBER_LID,
        phoneJid: MEMBER_PN,
        lidJid: MEMBER_LID,
        username: null,
        role: 'member',
      },
      {
        jid: '60000000002@s.whatsapp.net',
        phoneJid: '60000000002@s.whatsapp.net',
        lidJid: null,
        username: null,
        role: 'admin',
      },
    ],
    ...over,
  };
}

describe('chats of several inboxes', () => {
  it('keys a chat by inbox: the same WhatsApp JID in two inboxes is two chats', async () => {
    const t = await twoInboxes();
    const chats = getChats(t.ctx);
    const one = chats.upsertFromWa({ jid: PN, type: 'dm', name: 'Alice' }, 1);
    const two = chats.upsertFromWa({ jid: PN, type: 'dm', name: 'Alice' }, 2);
    expect(one).toMatchObject({ jid: PN, inboxId: 1, waJid: PN, phone: '60123456789' });
    expect(two).toMatchObject({ jid: `${PN}#2`, inboxId: 2, waJid: PN, phone: '60123456789' });
    const repo = new ChatRepo(t.ctx.db);
    expect(repo.byWa(2, PN)?.jid).toBe(`${PN}#2`);
    expect(repo.byWa(1, PN)?.jid).toBe(PN);
    expect(repo.byWa(3, PN)).toBeNull();
    // the stored row carries the inbox and the WhatsApp JID (never left NULL)
    const raw = t.ctx.db
      .prepare('SELECT inbox_id, wa_jid FROM chats WHERE jid = ?')
      .get(`${PN}#2`) as { inbox_id: number; wa_jid: string };
    expect(raw).toEqual({ inbox_id: 2, wa_jid: PN });
    // a key passed alone still works (inbox 1 = the plain JID)
    expect(repo.ensure(`${GROUP}#2`, { name: 'G' }, 1).inbox_id).toBe(2);
    expect(repo.get(`${GROUP}#2`)).toMatchObject({ type: 'group', wa_jid: GROUP });
  });

  it('a LID alias learned in inbox 2 never routes into inbox 1', async () => {
    const t = await twoInboxes();
    const chats = getChats(t.ctx);
    const aliases = getAliases(t.ctx);
    chats.upsertFromWa({ jid: PN, type: 'dm', name: 'Alice' }, 1);
    expect(aliases.learn({ jid: PN, alias: LID }, 'message').kind).toBe('added');

    // inbox 1 keeps its phone-number chat; inbox 2 has none, so new chats are LID-keyed there
    expect(aliases.route(1, LID)).toBe(PN);
    expect(aliases.route(LID)).toBe(PN); // a plain JID is an inbox 1 key
    expect(aliases.route(2, LID)).toBe(`${LID}#2`);
    expect(aliases.route(2, PN)).toBe(`${LID}#2`);
    expect(aliases.route(2, GROUP)).toBe(`${GROUP}#2`);
    expect(aliases.route(`${PN}#2`)).toBe(`${LID}#2`);

    const two = chats.upsertFromWa({ jid: LID, type: 'dm', name: null }, 2);
    expect(two).toMatchObject({ jid: `${LID}#2`, inboxId: 2, waJid: LID });
    // the learned number shows on the LID chat of inbox 2 as well
    expect(two.phone).toBe('60123456789');
    expect(chats.resolveJid(`${PN}#2`)).toBe(`${LID}#2`);
    expect(chats.get(`${PN}#2`)?.jid).toBe(`${LID}#2`);
    expect(chats.resolveJid(PN)).toBe(PN);
    expect(chats.get(PN)).toMatchObject({ inboxId: 1, waJid: PN, name: 'Alice' });
    expect(new ChatRepo(t.ctx.db).byWa(1, LID)).toBeNull();
  });

  it('ignores the own number of every inbox when learning aliases', async () => {
    const t = await twoInboxes();
    const aliases = getAliases(t.ctx);
    const own1 = t.inboxWa(1).status.me!.jid;
    const own2 = t.inboxWa(2).status.me!.jid;
    expect(own1).not.toBe(own2);
    expect(aliases.learn({ jid: own1, alias: '100000000000001@lid' }, 'message').kind).toBe(
      'ignored',
    );
    expect(aliases.learn({ jid: own2, alias: '100000000000002@lid' }, 'message').kind).toBe(
      'ignored',
    );
    // an own number kept on the inbox row (phone unlinked now) is still never a customer
    t.ctx.inboxes.repo.setOwnJid(2, '60188888888@s.whatsapp.net');
    expect(
      aliases.learn({ jid: '60188888888@s.whatsapp.net', alias: '100000000000003@lid' }, 'message')
        .kind,
    ).toBe('ignored');
    // ...and an own LID neither
    t.inboxWa(2).simulateStatus({
      me: { jid: own2, name: 'Two', lid: '100000000000009@lid' },
    });
    expect(aliases.learn({ jid: PN, alias: '100000000000009@lid' }, 'message').kind).toBe(
      'ignored',
    );
    expect(aliases.learn({ jid: PN, alias: LID }, 'message').kind).toBe('added');
  });

  it('startup merge stays inside one inbox', async () => {
    const t = await twoInboxes();
    const { user } = await createUserAndLogin(t);
    const repo = new ChatRepo(t.ctx.db);
    // inbox 2 has the same person twice (phone number and WhatsApp ID): a merge
    repo.ensure(2, PN, { name: 'Alice' }, 10);
    repo.ensure(2, LID, { name: 'Alice' }, 10);
    repo.insertNote(`${PN}#2`, user.id, 'note in the inbox 2 phone chat', 11);
    // inbox 1 has only the phone-number chat: re-keyed to the WhatsApp ID inside inbox 1
    repo.ensure(1, PN, { name: 'Alice' }, 10);
    repo.insertNote(PN, user.id, 'note in inbox 1', 11);
    const aliases = getAliases(t.ctx);
    aliases.learn({ jid: PN, alias: LID }, 'message');
    expect(aliases.pendingMerges()).toEqual([
      { inboxId: 1, from: PN, to: LID },
      { inboxId: 2, from: `${PN}#2`, to: `${LID}#2` },
    ]);

    const summary = runIdentityMigration(t.ctx, {
      readPairs: () => [],
      backup: () => 'backup.db',
    });
    expect(summary).toMatchObject({ merged: 2, rekeyed: 1, failed: 0 });
    expect(repo.get(PN)).toBeNull();
    expect(repo.get(`${PN}#2`)).toBeNull();
    expect(repo.get(LID)).toMatchObject({ inbox_id: 1, wa_jid: LID, phone: '60123456789' });
    expect(repo.get(`${LID}#2`)).toMatchObject({ inbox_id: 2, wa_jid: LID });
    expect(repo.notes(LID).map((n) => n.body)).toEqual(['note in inbox 1']);
    expect(repo.notes(`${LID}#2`).map((n) => n.body)).toEqual(['note in the inbox 2 phone chat']);
    // a merge never joins two inboxes
    repo.ensure(1, PN, { name: 'Alice' }, 20);
    expect(() => mergeChat(t.ctx.db, PN, `${LID}#2`, { now: 30 })).toThrow(/two inboxes/);
    expect(repo.get(PN)).not.toBeNull();
  });

  it('reads the stored WhatsApp ID pairs of every active inbox', async () => {
    const t = await twoInboxes();
    const read: string[] = [];
    runIdentityMigration(t.ctx, {
      readPairs: (dir) => {
        read.push(dir.replace(/\\/g, '/').split('/').slice(-2).join('/'));
        return dir.includes('wa-auth-inboxes') ? [{ jid: PN, alias: LID }] : [];
      },
      backup: () => 'backup.db',
    });
    expect(read).toEqual([expect.stringMatching(/\/wa-auth$/), 'wa-auth-inboxes/2']);
    expect(getAliases(t.ctx).resolve(PN)).toBe(LID);
    // an unreadable folder of one inbox does not stop the others
    const pairs = runIdentityMigration(t.ctx, {
      readPairs: (dir) => {
        if (dir.includes('wa-auth-inboxes')) throw new Error('corrupt');
        return [{ jid: '60111@s.whatsapp.net', alias: '222@lid' }];
      },
      backup: () => 'backup.db',
    });
    expect(pairs.storedPairs).toBe(1);
  });

  it('lists only the asked inboxes', async () => {
    const t = await twoInboxes();
    const repo = new ChatRepo(t.ctx.db);
    repo.ensure(1, PN, { name: 'A' }, 1);
    repo.ensure(2, PN, { name: 'B' }, 2);
    repo.ensure(2, '60111111111@s.whatsapp.net', { name: 'C' }, 3);
    const base = { assigned: 'any' as const, userId: 1, limit: 10 };
    const keys = (f: Partial<Parameters<ChatRepo['list']>[0]>) =>
      repo
        .list({ ...base, ...f })
        .map((r) => r.jid)
        .sort();
    expect(keys({ inboxIds: [2] })).toEqual([`60111111111@s.whatsapp.net#2`, `${PN}#2`]);
    expect(keys({ inboxIds: [] })).toEqual([]);
    expect(keys({ inboxIds: [1, 2], inbox: 1 })).toEqual([PN]);
    expect(keys({ inboxIds: [1], inbox: 2 })).toEqual([]);
    expect(keys({})).toHaveLength(3);
    // search matches the WhatsApp JID, never the inbox suffix
    expect(keys({ q: '#2' })).toEqual([]);

    const chats = getChats(t.ctx);
    const q = { assigned: 'any' as const, limit: 50 };
    expect(chats.list(q, 1, { inboxIds: [2] }).chats.map((c) => c.inboxId)).toEqual([2, 2]);
    expect(chats.list(q, 1, { inboxIds: [1, 2], inbox: 2 }).chats).toHaveLength(2);
    expect(chats.list(q, 1).chats).toHaveLength(3);
  });

  it('marks a chat read through its own inbox', async () => {
    const t = await twoInboxes();
    const chats = getChats(t.ctx);
    chats.upsertFromWa({ jid: PN, type: 'dm', name: 'Alice' }, 2);
    t.ctx.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender_jid, from_me, type, body, media_status, status,
           timestamp, created_at, wa_remote_jid)
         VALUES (?, ?, ?, 0, 'text', 'hi', 'none', 'delivered', ?, ?, ?)`,
      )
      .run('M1#2', `${PN}#2`, PN, 5, 5, PN);
    t.ctx.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender_jid, from_me, type, body, media_status, status,
           timestamp, created_at, wa_remote_jid)
         VALUES (?, ?, ?, 0, 'text', 'hi', 'none', 'delivered', ?, ?, NULL)`,
      )
      .run('M2#2', `${PN}#2`, PN, 6, 6);
    await t.inboxWa(2).connect();
    await chats.markRead(`${PN}#2`, 1);
    expect(t.inboxWa(2).reads).toEqual([{ chatJid: PN, messageIds: ['M1', 'M2'] }]);
    expect(t.inboxWa(1).reads).toEqual([]);
  });

  it('asks the inbox of the chat key for a profile photo', async () => {
    const t = await twoInboxes();
    const two = vi
      .spyOn(t.inboxWa(2), 'getProfilePicture')
      .mockResolvedValue('https://pps.whatsapp.net/two.jpg');
    const one = vi.spyOn(t.inboxWa(1), 'getProfilePicture').mockResolvedValue(null);
    const photo = createProfileImages(t.ctx, t.ctx.log);
    expect(await photo(`${PN}#2`)).toBe('https://pps.whatsapp.net/two.jpg');
    expect(two).toHaveBeenCalledWith(PN);
    expect(await photo(PN)).toBeNull();
    expect(one).toHaveBeenCalledWith(PN);
  });
});

describe('customer profiles of several inboxes', () => {
  it('a group sender’s profile comes from their direct chat in the group’s inbox', async () => {
    const t = await twoInboxes();
    const { user } = await createUserAndLogin(t, { role: 'admin' });
    const chats = getChats(t.ctx);
    const customers = t.ctx.services.customers!;
    chats.upsertFromWa({ jid: PN, type: 'dm', name: 'Alice' }, 1);
    chats.upsertFromWa({ jid: PN, type: 'dm', name: 'Alice' }, 2);
    const body = CustomerProfileBody.parse({ name: 'Alice of one' });
    customers.save(PN, body, { userId: user.id, ip: null, isAdmin: true });
    const message = (chatJid: string): Message =>
      ({
        id: `m-${chatJid}`,
        chatJid,
        senderJid: PN,
        senderName: 'Alice',
        fromMe: false,
        sentByUserId: null,
        type: 'text',
        body: 'hi',
        media: null,
        quotedId: null,
        status: 'delivered',
        error: null,
        timestamp: 1,
      }) as unknown as Message;
    const [one, two, dm] = customers.withSenderProfiles([
      message(GROUP),
      message(`${GROUP}#2`),
      message(`${PN}#2`),
    ]);
    expect(one!.senderProfile).toEqual({ chatJid: PN, name: 'Alice of one' });
    // inbox 2 has its own chat with Alice, and it carries the same (synced) profile
    expect(two!.senderProfile).toEqual({ chatJid: `${PN}#2`, name: 'Alice of one' });
    expect(dm).not.toHaveProperty('senderProfile');
    customers.save(`${PN}#2`, CustomerProfileBody.parse({ name: 'Alice of two' }), {
      userId: user.id,
      ip: null,
    });
    expect(customers.senderProfiles([PN], 2).get(PN)).toEqual({
      chatJid: `${PN}#2`,
      name: 'Alice of two',
    });
    expect(customers.senderProfiles([PN], 1).get(PN)).toEqual({
      chatJid: PN,
      name: 'Alice of two',
    });
    // the WhatsApp facts read contacts by WhatsApp JID, not by the chat key
    getChats(t.ctx).upsertContacts([{ jid: PN, pushName: 'Ali', savedName: null }]);
    expect(customers.profile(`${PN}#2`).whatsapp?.pushName).toBe('Ali');
    expect(chats.get(`${PN}#2`)?.name).toBe('Alice of two');
  });

  it('a contact name reaches the person’s chat in every inbox', async () => {
    const t = await twoInboxes();
    const chats = getChats(t.ctx);
    chats.upsertFromWa({ jid: PN, type: 'dm', name: null }, 1);
    chats.upsertFromWa({ jid: PN, type: 'dm', name: null }, 2);
    chats.upsertContacts([{ jid: PN, pushName: null, savedName: 'Alice Saved' }]);
    expect(chats.get(PN)?.name).toBe('Alice Saved');
    expect(chats.get(`${PN}#2`)?.name).toBe('Alice Saved');
    // a new inbox chat of a known contact takes the saved name, and keeps it on upsert
    expect(chats.upsertFromWa({ jid: PN, type: 'dm', name: '60123456789' }, 2).name).toBe(
      'Alice Saved',
    );
  });
});

describe('stats and activity of several inboxes', () => {
  it('count only the chats of the given inboxes', async () => {
    const t = await twoInboxes();
    const repo = new ChatRepo(t.ctx.db);
    repo.ensure(1, PN, { name: 'A' }, 1);
    repo.ensure(2, PN, { name: 'B' }, 1);
    repo.ensure(2, '60111111111@s.whatsapp.net', { name: 'C' }, 1);
    const now = Date.parse('2026-10-07T12:00:00+08:00');
    const insert = t.ctx.db.prepare(
      `INSERT INTO messages (id, chat_jid, from_me, type, body, media_status, status, timestamp, created_at)
       VALUES (?, ?, 0, 'text', 'x', 'none', 'delivered', ?, ?)`,
    );
    insert.run('a1', PN, now - 60_000, now);
    insert.run('b1#2', `${PN}#2`, now - 60_000, now);
    insert.run('c1#2', `60111111111@s.whatsapp.net#2`, now - 30_000, now);
    const stats = (inboxIds?: number[]) =>
      computeInboxStats(t.ctx.db, { days: 1, timeZone: 'Asia/Kuala_Lumpur', now, inboxIds });
    expect(stats().chats.open).toBe(3);
    expect(stats([2])).toMatchObject({
      chats: { open: 2 },
      openByAssignee: [{ userId: null, count: 2 }],
      waitingForReply: { count: 2 },
      daily: [{ activeChats: 2, inbound: 2 }],
    });
    expect(stats([1]).daily[0]).toMatchObject({ activeChats: 1, inbound: 1 });
    expect(stats([])).toMatchObject({ chats: { open: 0 }, daily: [{ activeChats: 0 }] });
    expect(() => stats([0])).toThrow(/invalid inbox id/);

    const activity = (inboxIds?: number[]) =>
      computeInboxActivity(t.ctx.db, { days: 1, timeZone: 'Asia/Kuala_Lumpur', now, inboxIds });
    const customerMessages = (inboxIds?: number[]) =>
      activity(inboxIds).byHour.reduce((n, h) => n + h.customerMessages, 0);
    expect(customerMessages()).toBe(3);
    expect(customerMessages([2])).toBe(2);
    expect(customerMessages([])).toBe(0);
  });
});

describe('a removed or unknown inbox', () => {
  it('answers a malformed or removed inbox key without asking any phone', async () => {
    const t = await twoInboxes();
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Partners' }, 2);
    getChats(t.ctx).upsertFromWa({ jid: PN, type: 'dm', name: 'Alice' }, 2);
    const groups = createGroupService(t.ctx);
    const photo = createProfileImages(t.ctx, t.ctx.log);
    await expect(groups.info(`${GROUP}#0`)).rejects.toThrow(/Group not found/);
    await expect(photo(`${PN}#0`)).rejects.toThrow(/invalid/);
    await t.ctx.inboxes.connections.remove(2);
    t.ctx.inboxes.repo.markRemoved(2, Date.now());
    await expect(groups.info(`${GROUP}#2`)).rejects.toThrow(/not connected/);
    await expect(photo(`${PN}#2`)).rejects.toThrow(/no WhatsApp connection/);
    // a read receipt of a removed inbox's chat is skipped, the unread count still clears
    new ChatRepo(t.ctx.db).update(`${PN}#2`, { unread_count: 3 });
    await getChats(t.ctx).markRead(`${PN}#2`, 1);
    expect(getChats(t.ctx).get(`${PN}#2`)?.unreadCount).toBe(0);
    groups.shutdown();
  });
});

describe('groups of several inboxes', () => {
  it('opens a group member chat in the group’s inbox', async () => {
    const t = await twoInboxes();
    const { cookie } = await createUserAndLogin(t, { role: 'admin' });
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Partners' }, 2);
    t.inboxWa(2).setGroupInfo(group());
    // inbox 1 knows the member already: that chat is not inbox 2's
    getChats(t.ctx).upsertFromWa({ jid: MEMBER_LID, type: 'dm', name: 'Known in one' }, 1);

    const info = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(`${GROUP}#2`)}/members`,
      headers: { cookie },
    });
    expect(info.statusCode).toBe(200);
    const members = GroupInfoResponse.parse(info.json()).members;
    expect(t.inboxWa(2).groupInfoCalls).toEqual([GROUP]);
    expect(t.inboxWa(1).groupInfoCalls).toEqual([]);
    // inbox 2's own number is "me"; the inbox 1 chat is not offered as the member's chat
    expect(members.find((m) => m.isMe)?.jid).toBe('60000000002@s.whatsapp.net');
    expect(members.find((m) => m.lid === MEMBER_LID)?.chatJid).toBeNull();

    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(`${GROUP}#2`)}/members/${enc(MEMBER_LID)}/chat`,
      headers: authHeaders(cookie),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ chatJid: `${MEMBER_LID}#2` });
    expect(getChats(t.ctx).get(`${MEMBER_LID}#2`)).toMatchObject({ inboxId: 2, waJid: MEMBER_LID });
    expect(getChats(t.ctx).get(MEMBER_LID)?.name).toBe('Known in one');

    // a second time: the existing inbox 2 chat
    const again = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(`${GROUP}#2`)}/members/${enc(MEMBER_PN)}/chat`,
      headers: authHeaders(cookie),
    });
    expect(again.json()).toEqual({ chatJid: `${MEMBER_LID}#2` });
    const list = ChatListResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } })).json(),
    );
    expect(
      list.chats
        .filter((c) => c.waJid === MEMBER_LID)
        .map((c) => c.inboxId)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('refuses a chat with the own number of the group’s inbox', async () => {
    const t = await twoInboxes();
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Partners' }, 2);
    t.inboxWa(2).setGroupInfo(group());
    const groups = createGroupService(t.ctx);
    await expect(
      groups.startChat(`${GROUP}#2`, '60000000002@s.whatsapp.net', { userId: 1, ip: null }),
    ).rejects.toThrow(/own number/);
    groups.shutdown();
  });

  it('caches member lists per inbox and drops only the changed inbox’s list', async () => {
    const t = await twoInboxes();
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'One' }, 1);
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Two' }, 2);
    t.inboxWa(1).setGroupInfo(group({ name: 'One' }));
    t.inboxWa(2).setGroupInfo(group({ name: 'Two' }));
    const groups = createGroupService(t.ctx);
    expect((await groups.info(GROUP)).group.name).toBe('One');
    expect((await groups.info(`${GROUP}#2`)).group.name).toBe('Two');
    await groups.info(GROUP);
    await groups.info(`${GROUP}#2`);
    expect(t.inboxWa(1).groupInfoCalls).toHaveLength(1);
    expect(t.inboxWa(2).groupInfoCalls).toHaveLength(1);
    t.inboxWa(2).simulateGroupChanged(GROUP);
    await groups.info(GROUP);
    await groups.info(`${GROUP}#2`);
    expect(t.inboxWa(1).groupInfoCalls).toHaveLength(1);
    expect(t.inboxWa(2).groupInfoCalls).toHaveLength(2);
    // the member's About and photo come from the group's inbox
    t.inboxWa(2).setAbout(MEMBER_PN, 'Hello from two');
    expect(await groups.about(`${GROUP}#2`, MEMBER_LID)).toBe('Hello from two');
    expect(t.inboxWa(2).aboutCalls).toEqual([MEMBER_PN]);
    expect(t.inboxWa(1).aboutCalls).toEqual([]);
    expect(await groups.photoTarget(`${GROUP}#2`, MEMBER_LID)).toEqual({
      jid: `${MEMBER_PN}#2`,
      key: `2|${MEMBER_LID}|${MEMBER_PN}`,
    });
    // an inbox added later is listened to as well
    const id = await t.addInbox('Three');
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Three' }, id);
    t.inboxWa(id).setGroupInfo(group({ name: 'Three' }));
    await groups.info(`${GROUP}#${id}`);
    t.inboxWa(id).simulateGroupChanged(GROUP);
    await groups.info(`${GROUP}#${id}`);
    expect(t.inboxWa(id).groupInfoCalls).toHaveLength(2);
    groups.shutdown();
  });
});

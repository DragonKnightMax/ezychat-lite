import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatListResponse, GroupInfoResponse } from '@ezychat/shared';
import type { WaGroupInfo } from '@ezychat/wa';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { getAliases } from '../src/chats/aliases.js';

let t: TestApp;
let cookie: string;
const enc = encodeURIComponent;
const GROUP = '120363000000000001@g.us';
const ME = '60000000000@s.whatsapp.net'; // the fake adapter's own number
const AISYAH = '60137782210@s.whatsapp.net';
const AISYAH_LID = '311222333444555@lid';
const DAVID = '6591234567@s.whatsapp.net';
const HIDDEN = '184392017734251@lid';
const STRANGER = '60170000001@s.whatsapp.net';

const group = (over: Partial<WaGroupInfo> = {}): WaGroupInfo => ({
  jid: GROUP,
  name: 'SME Founders',
  description: 'Weekly meetup',
  createdAt: 1_710_200_000_000,
  ownerJid: DAVID,
  size: 965,
  participants: [
    { jid: HIDDEN, phoneJid: null, lidJid: HIDDEN, username: null, role: 'member' },
    {
      jid: AISYAH_LID,
      phoneJid: AISYAH,
      lidJid: AISYAH_LID,
      username: 'nurul.aisyah',
      role: 'member',
    },
    { jid: DAVID, phoneJid: DAVID, lidJid: null, username: null, role: 'admin' },
    { jid: ME, phoneJid: ME, lidJid: null, username: null, role: 'superadmin' },
    { jid: STRANGER, phoneJid: STRANGER, lidJid: null, username: null, role: 'member' },
  ],
  ...over,
});

async function get(url: string) {
  return t.app.inject({ method: 'GET', url, headers: { cookie } });
}
async function post(url: string) {
  return t.app.inject({ method: 'POST', url, headers: authHeaders(cookie) });
}
async function members() {
  const r = await get(`/api/chats/${enc(GROUP)}/members`);
  expect(r.statusCode).toBe(200);
  return GroupInfoResponse.parse(r.json());
}

beforeEach(async () => {
  t = await makeTestApp();
  ({ cookie } = await createUserAndLogin(t));
  getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'SME Founders' });
  t.wa.setGroupInfo(group());
});
afterEach(async () => t.close());

describe('group members', () => {
  it('lists members with known names, existing chats and WhatsApp’s member count', async () => {
    getChats(t.ctx).upsertContacts([{ jid: DAVID, pushName: 'David Tay', savedName: null }]);
    // Aisyah already has a direct chat under her phone number, linked to her WhatsApp ID.
    await getMessages(t.ctx).ingest(
      {
        id: 'gm-1',
        chatJid: AISYAH,
        senderJid: AISYAH,
        senderName: 'Nurul Aisyah',
        fromMe: false,
        type: 'text',
        body: 'hi',
        quotedId: null,
        timestamp: Date.now(),
        media: null,
      },
      'live',
    );
    getChats(t.ctx).upsertContactAliases([{ jid: AISYAH, alias: AISYAH_LID }]);

    const r = await members();
    expect(r.group).toMatchObject({
      jid: GROUP,
      name: 'SME Founders',
      size: 965,
      adminCount: 2,
      createdBy: { jid: DAVID, name: 'David Tay', phone: '6591234567' },
    });
    // Me first, then admins, then named members, then the rest.
    expect(r.members.map((m) => m.jid)).toEqual([ME, DAVID, AISYAH_LID, HIDDEN, STRANGER]);
    expect(r.members[0]).toMatchObject({ isMe: true, role: 'superadmin', phone: '60000000000' });
    expect(r.members[1]).toMatchObject({
      jid: DAVID,
      name: 'David Tay',
      role: 'admin',
      chatJid: null,
    });
    expect(r.members[2]).toMatchObject({
      jid: AISYAH_LID,
      name: 'Nurul Aisyah',
      phone: '60137782210',
      lid: AISYAH_LID,
      username: 'nurul.aisyah',
    });
    expect(r.members[2]?.chatJid).toBeTruthy();
    const hidden = r.members.find((m) => m.jid === HIDDEN);
    expect(hidden).toMatchObject({ name: null, phone: null, lid: HIDDEN, chatJid: null });
  });

  it('reads WhatsApp once, then reuses the list until the group changes', async () => {
    await members();
    await members();
    expect(t.wa.groupInfoCalls).toEqual([GROUP]);
    t.wa.simulateGroupChanged(GROUP);
    await members();
    expect(t.wa.groupInfoCalls).toEqual([GROUP, GROUP]);
  });

  it('refuses direct chats, unknown chats and signed-out requests', async () => {
    await getMessages(t.ctx).ingest(
      {
        id: 'gm-2',
        chatJid: DAVID,
        senderJid: DAVID,
        senderName: 'David',
        fromMe: false,
        type: 'text',
        body: 'hi',
        quotedId: null,
        timestamp: Date.now(),
        media: null,
      },
      'live',
    );
    expect((await get(`/api/chats/${enc(DAVID)}/members`)).statusCode).toBe(404);
    expect((await get(`/api/chats/${enc('999@g.us')}/members`)).statusCode).toBe(404);
    const anon = await t.app.inject({ method: 'GET', url: `/api/chats/${enc(GROUP)}/members` });
    expect(anon.statusCode).toBe(401);
  });

  it('answers 503 while WhatsApp is not connected', async () => {
    await t.wa.disconnect();
    const r = await get(`/api/chats/${enc(GROUP)}/members`);
    expect(r.statusCode).toBe(503);
  });

  it('fetches a member’s About on demand, only for members of the group', async () => {
    t.wa.setAbout(DAVID, 'Hello. I’m using WhatsApp Business.');
    const ok = await get(`/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/about`);
    expect(ok.json()).toEqual({ about: 'Hello. I’m using WhatsApp Business.' });
    await get(`/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/about`);
    expect(t.wa.aboutCalls).toEqual([DAVID]);
    const outsider = await get(
      `/api/chats/${enc(GROUP)}/members/${enc('60199999999@s.whatsapp.net')}/about`,
    );
    expect(outsider.statusCode).toBe(404);
  });

  it('does not reuse a recycled number’s cached About for its new owner', async () => {
    const OLD_LID = '999888777666555@lid';
    const pair = (lid: string) => ({
      jid: lid,
      phoneJid: AISYAH,
      lidJid: lid,
      username: null,
      role: 'member' as const,
    });
    t.wa.setGroupInfo(group({ participants: [pair(OLD_LID)] }));
    t.wa.setAbout(AISYAH, 'old owner');
    await get(`/api/chats/${enc(GROUP)}/members/${enc(AISYAH)}/about`);
    t.wa.setGroupInfo(group({ participants: [pair(AISYAH_LID)] }));
    t.wa.simulateGroupChanged(GROUP);
    t.wa.setAbout(AISYAH, 'new owner');
    const r = await get(`/api/chats/${enc(GROUP)}/members/${enc(AISYAH)}/about`);
    expect(r.json()).toEqual({ about: 'new owner' });
  });

  it('ignores a group read that was invalidated while in flight', async () => {
    const OLD_LID = '999888777666555@lid';
    const pair = (lid: string) => ({
      jid: lid,
      phoneJid: AISYAH,
      lidJid: lid,
      username: null,
      role: 'member' as const,
    });
    const groups = t.ctx.services.groups!;
    t.wa.setGroupInfo(group({ participants: [pair(OLD_LID)] }));
    const stale = groups.info(GROUP); // reads the old list
    t.wa.simulateGroupChanged(GROUP);
    t.wa.setGroupInfo(group({ participants: [pair(AISYAH_LID)] }));
    const fresh = await groups.info(GROUP);
    expect((await stale).members.map((m) => m.jid)).toEqual([AISYAH_LID]);
    expect(fresh.members.map((m) => m.jid)).toEqual([AISYAH_LID]);
    expect(getAliases(t.ctx).resolve(AISYAH)).toBe(AISYAH_LID);
  });

  it('answers from the newer read when an invalidated read fails late', async () => {
    const groups = t.ctx.services.groups!;
    const real = t.wa.getGroupInfo.bind(t.wa);
    let calls = 0;
    t.wa.getGroupInfo = async (jid: string) => {
      if (calls++ === 0) {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('timed out');
      }
      return real(jid);
    };
    const stale = groups.info(GROUP);
    t.wa.simulateGroupChanged(GROUP);
    const fresh = await groups.info(GROUP);
    expect((await stale).members).toHaveLength(fresh.members.length);
  });

  it('never caches an About read while WhatsApp is offline', async () => {
    t.wa.setAbout(DAVID, 'Hello');
    await members();
    await t.wa.disconnect();
    expect((await get(`/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/about`)).statusCode).toBe(
      503,
    );
    await t.wa.connect();
    const r = await get(`/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/about`);
    expect(r.json()).toEqual({ about: 'Hello' });
  });

  it('never caches a failed About lookup as empty', async () => {
    t.wa.setAbout(DAVID, 'Hello');
    t.wa.aboutFails = true;
    expect((await get(`/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/about`)).statusCode).toBe(
      503,
    );
    t.wa.aboutFails = false;
    const r = await get(`/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/about`);
    expect(r.json()).toEqual({ about: 'Hello' });
  });

  it('serves member photos only for members (204 when WhatsApp has none)', async () => {
    expect((await get(`/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/avatar`)).statusCode).toBe(
      204,
    );
    expect(
      (await get(`/api/chats/${enc(GROUP)}/members/${enc('60199999999@s.whatsapp.net')}/avatar`))
        .statusCode,
    ).toBe(404);
  });

  it('serves a member photo from the store: bytes, ETag, 304, day cache, failure no-store', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 2]);
    const url = `/api/chats/${enc(GROUP)}/members/${enc(DAVID)}/avatar`;
    const lookup = vi
      .spyOn(t.wa, 'getProfilePicture')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('https://pps.whatsapp.net/v/david.jpg');
    const download = vi.fn(async () => new Response(new Uint8Array(bytes)));
    vi.stubGlobal('fetch', download);
    try {
      const failed = await get(url);
      expect(failed.statusCode).toBe(204);
      expect(failed.headers['cache-control']).toBe('no-store');
      const r = await get(url);
      expect(r.statusCode).toBe(200);
      expect(r.headers.location).toBeUndefined();
      expect(r.rawPayload).toEqual(bytes);
      expect(r.headers['content-type']).toBe('image/jpeg');
      expect(r.headers['cache-control']).toBe('private, max-age=86400');
      const etag = r.headers.etag as string;
      expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
      const again = await t.app.inject({
        method: 'GET',
        url,
        headers: { cookie, 'if-none-match': etag },
      });
      expect(again.statusCode).toBe(304);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe('starting a direct chat with a member', () => {
  it('creates an empty direct chat for a member and audits it', async () => {
    const r = await post(`/api/chats/${enc(GROUP)}/members/${enc(STRANGER)}/chat`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ chatJid: STRANGER });
    const list = await get('/api/chats');
    const chats = ChatListResponse.parse(list.json()).chats;
    expect(chats.find((c) => c.jid === STRANGER)).toMatchObject({ type: 'dm' });
    expect(t.wa.sent).toHaveLength(0);
    const row = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'chat.start_from_group'")
      .get() as { meta: string };
    expect(JSON.parse(row.meta)).toEqual({ groupJid: GROUP, chatJid: STRANGER });
  });

  it('returns the existing chat instead of creating another', async () => {
    const first = (await post(`/api/chats/${enc(GROUP)}/members/${enc(STRANGER)}/chat`)).json();
    const again = (await post(`/api/chats/${enc(GROUP)}/members/${enc(STRANGER)}/chat`)).json();
    expect(again).toEqual(first);
  });

  it('keys a new chat by the WhatsApp ID and routes the member’s number into it', async () => {
    const r = await post(`/api/chats/${enc(GROUP)}/members/${enc(AISYAH_LID)}/chat`);
    expect(r.json()).toEqual({ chatJid: AISYAH_LID });
    await getMessages(t.ctx).ingest(
      {
        id: 'gm-3',
        chatJid: AISYAH,
        senderJid: AISYAH,
        senderName: 'Nurul Aisyah',
        fromMe: false,
        type: 'text',
        body: 'hi',
        quotedId: null,
        timestamp: Date.now(),
        media: null,
      },
      'live',
    );
    const chats = ChatListResponse.parse((await get('/api/chats')).json()).chats;
    expect(chats.filter((c) => c.type === 'dm').map((c) => c.jid)).toEqual([AISYAH_LID]);
  });

  it('never offers a recycled number’s old chat for the member who has it now', async () => {
    const OLD_LID = '999888777666555@lid';
    getChats(t.ctx).upsertContactAliases([{ jid: AISYAH, alias: OLD_LID, source: 'contacts' }]);
    getChats(t.ctx).upsertContacts([{ jid: AISYAH, pushName: 'Previous owner', savedName: null }]);
    getChats(t.ctx).upsertFromWa({ jid: OLD_LID, type: 'dm', name: 'Previous owner' });
    const aisyah = (await members()).members.find((m) => m.jid === AISYAH_LID);
    // Neither the old chat nor the old owner's name carries over to the number's new owner.
    expect(aisyah).toMatchObject({ chatJid: null, name: null });
    const copied = t.ctx.db
      .prepare('SELECT push_name FROM contacts WHERE jid = ?')
      .get(AISYAH_LID) as { push_name: string | null } | undefined;
    expect(copied?.push_name ?? null).toBeNull();
    const r = await post(`/api/chats/${enc(GROUP)}/members/${enc(AISYAH)}/chat`);
    expect(r.json()).toEqual({ chatJid: AISYAH_LID });
    // Nor may a later contacts sync (for either address), or a later read of the same group.
    getChats(t.ctx).upsertContacts([{ jid: AISYAH_LID, pushName: null, savedName: null }]);
    getChats(t.ctx).upsertContacts([{ jid: AISYAH, pushName: null, savedName: 'Previous owner' }]);
    t.wa.simulateGroupChanged(GROUP);
    const again = (await members()).members.find((m) => m.jid === AISYAH_LID);
    expect(again?.name).toBeNull();
    const row = t.ctx.db.prepare('SELECT push_name FROM contacts WHERE jid = ?').get(AISYAH_LID) as
      { push_name: string | null } | undefined;
    expect(row?.push_name ?? null).toBeNull();
  });

  it('never writes the new owner’s name onto a recycled number’s old contact or chat', async () => {
    const OLD_LID = '999888777666555@lid';
    getChats(t.ctx).upsertContactAliases([{ jid: AISYAH, alias: OLD_LID, source: 'contacts' }]);
    getChats(t.ctx).upsertContacts([{ jid: AISYAH, pushName: 'Previous owner', savedName: null }]);
    getChats(t.ctx).upsertFromWa({ jid: AISYAH, type: 'dm', name: 'Previous owner' });
    await members(); // the group moves the number to AISYAH_LID
    getChats(t.ctx).upsertContacts([{ jid: AISYAH_LID, pushName: null, savedName: 'New owner' }]);
    const pnRow = t.ctx.db
      .prepare('SELECT push_name, saved_name FROM contacts WHERE jid = ?')
      .get(AISYAH) as { push_name: string | null; saved_name: string | null };
    expect(pnRow).toEqual({ push_name: 'Previous owner', saved_name: null });
    expect(getChats(t.ctx).get(OLD_LID)?.name).toBe('Previous owner');
  });

  it('never shows another person’s chat when a newer read moved the number away', async () => {
    const OTHER_GROUP = '120363000000000002@g.us';
    const NEW_LID = '777666555444333@lid';
    const pair = (lid: string) => ({
      jid: lid,
      phoneJid: AISYAH,
      lidJid: lid,
      username: null,
      role: 'member' as const,
    });
    t.wa.setGroupInfo(group({ participants: [pair(AISYAH_LID)] }));
    await members(); // group A cached: the number is Aisyah's
    getChats(t.ctx).upsertFromWa({ jid: OTHER_GROUP, type: 'group', name: 'Other' });
    t.wa.setGroupInfo(group({ jid: OTHER_GROUP, participants: [pair(NEW_LID)] }));
    await get(`/api/chats/${enc(OTHER_GROUP)}/members`); // the number now belongs to NEW_LID
    getChats(t.ctx).upsertFromWa({ jid: NEW_LID, type: 'dm', name: 'Someone else' });
    const aisyah = (await members()).members.find((m) => m.jid === AISYAH_LID);
    // Neither their chat nor their number is shown as Aisyah's.
    expect(aisyah).toMatchObject({ chatJid: null, phone: null });
    const r = await post(`/api/chats/${enc(GROUP)}/members/${enc(AISYAH_LID)}/chat`);
    expect(r.json()).toEqual({ chatJid: AISYAH_LID });
    // Nor the other person's About: details are read by Aisyah's WhatsApp ID now.
    t.wa.setAbout(AISYAH, 'someone else');
    t.wa.setAbout(AISYAH_LID, 'Aisyah');
    const about = await get(`/api/chats/${enc(GROUP)}/members/${enc(AISYAH_LID)}/about`);
    expect(about.json()).toEqual({ about: 'Aisyah' });
  });

  it('never shows a member’s number as their name once their chat exists', async () => {
    await post(`/api/chats/${enc(GROUP)}/members/${enc(AISYAH_LID)}/chat`);
    const aisyah = (await members()).members.find((m) => m.jid === AISYAH_LID);
    expect(aisyah).toMatchObject({ name: null, chatJid: AISYAH_LID, phone: '60137782210' });
  });

  it('shows a hidden member’s number the team already knows, never as their name', async () => {
    // As seen in a real hidden-number group: the team's own chat already knows this person's number.
    getChats(t.ctx).upsertContactAliases([{ jid: '60112760440@s.whatsapp.net', alias: HIDDEN }]);
    getChats(t.ctx).upsertFromWa({ jid: HIDDEN, type: 'dm', name: null });
    const hidden = (await members()).members.find((m) => m.jid === HIDDEN);
    expect(hidden).toMatchObject({ name: null, phone: '60112760440', chatJid: HIDDEN });
  });

  it('starts a hidden-number member’s chat on their WhatsApp ID', async () => {
    const r = await post(`/api/chats/${enc(GROUP)}/members/${enc(HIDDEN)}/chat`);
    expect(r.json()).toEqual({ chatJid: HIDDEN });
  });

  it('refuses the linked number itself and people outside the group', async () => {
    expect((await post(`/api/chats/${enc(GROUP)}/members/${enc(ME)}/chat`)).statusCode).toBe(400);
    expect(
      (await post(`/api/chats/${enc(GROUP)}/members/${enc('60199999999@s.whatsapp.net')}/chat`))
        .statusCode,
    ).toBe(404);
  });
});

describe('dev: fake group', () => {
  it('creates a group with generated members, some named and some with hidden numbers', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-group',
      headers: authHeaders(cookie),
      payload: { groupJid: '120363000000000099@g.us', name: 'Demo group', generated: 28 },
    });
    expect(r.json()).toEqual({ groupJid: '120363000000000099@g.us', members: 29 });
    const list = GroupInfoResponse.parse(
      (await get(`/api/chats/${enc('120363000000000099@g.us')}/members`)).json(),
    );
    expect(list.members[0]?.isMe).toBe(true);
    expect(list.members.filter((m) => m.name).length).toBe(7);
    expect(list.members.filter((m) => !m.phone).length).toBe(4);
    expect(list.group.adminCount).toBe(3);
  });
});

describe('the linked account in a group where WhatsApp hides its number', () => {
  it('is "me" by the session LID when the member has no phone number', async () => {
    const ME_LID = '81071886581878@lid';
    t.wa.simulateStatus({ me: { jid: ME, name: 'Kopi Apong', lid: ME_LID } });
    t.wa.setGroupInfo(
      group({
        participants: [
          { jid: ME_LID, phoneJid: null, lidJid: ME_LID, username: null, role: 'admin' },
          { jid: HIDDEN, phoneJid: null, lidJid: HIDDEN, username: null, role: 'member' },
        ],
      }),
    );
    const r = await members();
    expect(r.members[0]).toMatchObject({ jid: ME_LID, isMe: true });
    expect(r.members[1]).toMatchObject({ jid: HIDDEN, isMe: false });
  });
});

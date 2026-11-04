import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ChatDetailResponse, ChatListResponse, ChatSchema, NoteSchema } from '@ezychat/shared';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { ChatRepo, rowToChat, type ChatRow } from '../src/chats/repo.js';
import { runIdentityMigration } from '../src/chats/identity-migration.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

describe('chat profile images', () => {
  const jid = '60177777777@s.whatsapp.net';
  const photo = 'https://pps.whatsapp.net/v/t61.24694-24/profile.jpg?token=test';
  const avatar = (chatJid = jid) => `/api/chats/${enc(chatJid)}/avatar`;

  it('requires authentication without querying WhatsApp', async () => {
    await seedChat(jid, 'Profile test', Date.now());
    const lookup = vi.spyOn(t.wa, 'getProfilePicture').mockResolvedValue(photo);
    const r = await t.app.inject({ method: 'GET', url: avatar() });
    expect(r.statusCode).toBe(401);
    expect(r.headers.location).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('gives list and detail responses an encoded same-origin avatar endpoint', async () => {
    const { cookie } = await createUserAndLogin(t);
    const groupJid = '120363012345@g.us';
    await seedChat(jid, 'Profile test', Date.now());
    await seedChat(groupJid, 'Group profile test', Date.now());
    const lookup = vi.spyOn(t.wa, 'getProfilePicture');
    const list = await t.app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const chats = ChatListResponse.parse(list.json()).chats;
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      expect(chat.avatarUrl).toBe(avatar(chat.jid));
      const detail = await t.app.inject({
        method: 'GET',
        url: `/api/chats/${enc(chat.jid)}`,
        headers: { cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(ChatDetailResponse.parse(detail.json()).chat.avatarUrl).toBe(avatar(chat.jid));
    }
    // Rendering a directory does not fetch every contact's photo from WhatsApp.
    expect(lookup).not.toHaveBeenCalled();
  });

  const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const NEW_PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
  const hashOf = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);
  const cdn = (body: Buffer = PHOTO) =>
    vi.fn(async () => new Response(new Uint8Array(body), { status: 200 }));
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves the photo bytes itself with an ETag, never a redirect to WhatsApp', async () => {
    const { cookie } = await createUserAndLogin(t, { role: 'agent' });
    await seedChat(jid, 'Profile test', Date.now());
    const lookup = vi.spyOn(t.wa, 'getProfilePicture').mockResolvedValue(photo);
    const download = cdn();
    vi.stubGlobal('fetch', download);
    const r = await t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers.location).toBeUndefined();
    expect(r.rawPayload).toEqual(PHOTO);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers.etag).toBe(`"${hashOf(PHOTO)}"`);
    expect(r.headers['cache-control']).toBe('private, max-age=86400');
    expect(lookup).toHaveBeenCalledExactlyOnceWith(jid);
    expect(download).toHaveBeenCalledExactlyOnceWith(
      photo,
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('caches for a year by content hash, answers 304 to a matching ETag, and lists ?v=', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seedChat(jid, 'Profile test', Date.now());
    await seedChat('60188888888@s.whatsapp.net', 'No photo yet', Date.now() - 1000);
    vi.spyOn(t.wa, 'getProfilePicture').mockResolvedValue(photo);
    vi.stubGlobal('fetch', cdn());
    const hash = hashOf(PHOTO);
    await t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });

    const list = await t.app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } });
    const chats = ChatListResponse.parse(list.json()).chats;
    expect(chats.map((c) => c.avatarUrl)).toEqual([
      `${avatar()}?v=${hash}`,
      avatar('60188888888@s.whatsapp.net'),
    ]);
    const detail = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(jid)}`,
      headers: { cookie },
    });
    expect(ChatDetailResponse.parse(detail.json()).chat.avatarUrl).toBe(`${avatar()}?v=${hash}`);

    const versioned = await t.app.inject({
      method: 'GET',
      url: `${avatar()}?v=${hash}`,
      headers: { cookie },
    });
    expect(versioned.statusCode).toBe(200);
    // Re-asked after a week, so a changed photo reaches the chat list (the server refreshes after 24 h).
    expect(versioned.headers['cache-control']).toBe('private, max-age=604800');
    const old = await t.app.inject({
      method: 'GET',
      url: `${avatar()}?v=0123456789abcdef`,
      headers: { cookie },
    });
    expect(old.headers['cache-control']).toBe('private, max-age=86400');

    const again = await t.app.inject({
      method: 'GET',
      url: avatar(),
      headers: { cookie, 'if-none-match': `"${hash}"` },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(`"${hash}"`);
    const changed = await t.app.inject({
      method: 'GET',
      url: avatar(),
      headers: { cookie, 'if-none-match': '"0123456789abcdef"' },
    });
    expect(changed.statusCode).toBe(200);
  });

  it('returns no image for missing or private photos and lets the browser keep that a day', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seedChat(jid, 'Profile test', Date.now());
    const lookup = vi.spyOn(t.wa, 'getProfilePicture').mockResolvedValue(null);
    for (let i = 0; i < 2; i++) {
      const r = await t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });
      expect(r.statusCode).toBe(204);
      expect(r.body).toBe('');
      expect(r.headers['cache-control']).toBe('private, max-age=86400');
    }
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('answers no image and no-store when the WhatsApp lookup or the download fails', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seedChat(jid, 'Profile test', Date.now());
    const lookup = vi
      .spyOn(t.wa, 'getProfilePicture')
      .mockRejectedValueOnce(new Error('Photo is private'))
      .mockResolvedValue(photo);
    const failedLookup = await t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });
    expect(failedLookup.statusCode).toBe(204);
    expect(failedLookup.headers['cache-control']).toBe('no-store');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    );
    const failedDownload = await t.app.inject({
      method: 'GET',
      url: avatar(),
      headers: { cookie },
    });
    expect(failedDownload.statusCode).toBe(204);
    expect(failedDownload.headers['cache-control']).toBe('no-store');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('never downloads from unsafe, credential-bearing or non-WhatsApp destinations', async () => {
    const { cookie } = await createUserAndLogin(t);
    const unsafe = [
      'http://pps.whatsapp.net/profile.jpg',
      'https://example.com/profile.jpg',
      'https://whatsapp.net.evil.example/profile.jpg',
      'https://pps.whatsapp.net@evil.example/profile.jpg',
      'https://user:secret@pps.whatsapp.net/profile.jpg',
      'https://pps.whatsapp.net:8443/profile.jpg',
      'https://127.0.0.1/profile.jpg',
      'data:image/png;base64,AAAA',
      'not a URL',
    ];
    const lookup = vi.spyOn(t.wa, 'getProfilePicture');
    const download = cdn();
    vi.stubGlobal('fetch', download);
    for (const [i, url] of unsafe.entries()) {
      const chatJid = `601888880${i}@s.whatsapp.net`;
      await seedChat(chatJid, 'Unsafe image test', Date.now());
      lookup.mockResolvedValueOnce(url);
      const r = await t.app.inject({ method: 'GET', url: avatar(chatJid), headers: { cookie } });
      expect(r.statusCode, url).toBe(204);
      expect(r.headers.location, url).toBeUndefined();
    }
    expect(lookup).toHaveBeenCalledTimes(unsafe.length);
    expect(download).not.toHaveBeenCalled();
  });

  it('coalesces concurrent lookups and reuses the stored photo', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seedChat(jid, 'Profile test', Date.now());
    let finishLookup!: (url: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      finishLookup = resolve;
    });
    const lookup = vi.spyOn(t.wa, 'getProfilePicture').mockReturnValue(pending);
    const download = cdn();
    vi.stubGlobal('fetch', download);
    const first = t.app
      .inject({ method: 'GET', url: avatar(), headers: { cookie } })
      .then((r) => r);
    const second = t.app
      .inject({ method: 'GET', url: avatar(), headers: { cookie } })
      .then((r) => r);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    finishLookup(photo);
    for (const r of await Promise.all([first, second])) {
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload).toEqual(PHOTO);
    }
    const cached = await t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });
    expect(cached.statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('asks WhatsApp again after 24 hours and serves a changed photo under a new hash', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seedChat(jid, 'Profile test', Date.now());
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const lookup = vi.spyOn(t.wa, 'getProfilePicture').mockResolvedValue(photo);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(new Uint8Array(PHOTO)))
        .mockResolvedValueOnce(new Response(new Uint8Array(NEW_PHOTO))),
    );
    const request = () => t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });
    expect((await request()).headers.etag).toBe(`"${hashOf(PHOTO)}"`);
    clock.mockReturnValue(now + 24 * 3_600_000 - 1);
    expect((await request()).headers.etag).toBe(`"${hashOf(PHOTO)}"`);
    expect(lookup).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 24 * 3_600_000);
    const refreshed = await request();
    expect(refreshed.headers.etag).toBe(`"${hashOf(NEW_PHOTO)}"`);
    expect(refreshed.rawPayload).toEqual(NEW_PHOTO);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('returns 404 for an unknown chat without querying WhatsApp', async () => {
    const { cookie } = await createUserAndLogin(t);
    const lookup = vi.spyOn(t.wa, 'getProfilePicture').mockResolvedValue(photo);
    const r = await t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });
    expect(r.statusCode).toBe(404);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not query WhatsApp while disconnected, then loads a photo after reconnecting', async () => {
    const { cookie } = await createUserAndLogin(t);
    await seedChat(jid, 'Profile test', Date.now());
    const lookup = vi.spyOn(t.wa, 'getProfilePicture').mockResolvedValue(photo);
    vi.stubGlobal('fetch', cdn());
    await t.wa.disconnect();
    const request = () => t.app.inject({ method: 'GET', url: avatar(), headers: { cookie } });
    const disconnected = await request();
    expect(disconnected.statusCode).toBe(204);
    expect(disconnected.headers['cache-control']).toBe('no-store');
    expect(lookup).not.toHaveBeenCalled();
    await t.wa.connect();
    const connected = await request();
    expect(connected.statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    // offline again: the kept photo is still served, without asking WhatsApp
    await t.wa.disconnect();
    const kept = await request();
    expect(kept.statusCode).toBe(200);
    expect(kept.rawPayload).toEqual(PHOTO);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('rowToChat encodes the JID and does not expose a stored image path', () => {
    const row: ChatRow = {
      jid: '60123:7@s.whatsapp.net',
      type: 'dm',
      name: 'Profile test',
      avatar_path: 'C:\\private\\media\\profile.jpg',
      unread_count: 0,
      last_message_at: null,
      last_message_preview: null,
      status: 'open',
      assigned_to: null,
      updated_at: Date.now(),
      phone: null,
      inbox_id: 1,
      wa_jid: '60123:7@s.whatsapp.net',
      profile_name: null,
      profile_tags: [],
    };
    expect(rowToChat(row).avatarUrl).toBe('/api/chats/60123%3A7%40s.whatsapp.net/avatar');
  });

  it('rowToChat never shows WhatsApp ID digits as a name and exposes the phone number', () => {
    const base = {
      type: 'dm',
      avatar_path: null,
      unread_count: 0,
      last_message_at: null,
      last_message_preview: null,
      status: 'open',
      assigned_to: null,
      updated_at: 1,
      profile_name: null,
      profile_tags: [] as string[],
      inbox_id: 1,
      wa_jid: null,
    } as const;
    expect(rowToChat({ ...base, jid: '123456789@lid', name: '', phone: null })).toMatchObject({
      name: '',
      phone: null,
    });
    expect(
      rowToChat({ ...base, jid: '123456789@lid', name: '123456789', phone: '60111' }),
    ).toMatchObject({ name: '60111', phone: '60111' });
    expect(
      rowToChat({ ...base, jid: '60111@s.whatsapp.net', name: '', phone: '60111' }),
    ).toMatchObject({ name: '60111', phone: '60111' });
    expect(
      rowToChat({ ...base, type: 'group', jid: '1-2@g.us', name: 'Team', phone: null }),
    ).toMatchObject({ name: 'Team', phone: null });
    // another inbox's key: the JID shape is read from the WhatsApp JID, never from the key
    expect(
      rowToChat({ ...base, inbox_id: 2, jid: '123456789@lid#2', name: '123456789', phone: null }),
    ).toMatchObject({ jid: '123456789@lid#2', inboxId: 2, waJid: '123456789@lid', name: '' });
    expect(
      rowToChat({
        ...base,
        inbox_id: 2,
        jid: '60111@s.whatsapp.net#2',
        wa_jid: '60111@s.whatsapp.net',
        name: '',
        phone: null,
      }),
    ).toMatchObject({ name: '60111', avatarUrl: '/api/chats/60111%40s.whatsapp.net%232/avatar' });
  });

  it('search matches the chat phone number and new phone-number chats store it', () => {
    const repo = new ChatRepo(t.ctx.db);
    repo.ensure('555@lid', { name: 'Hidden Person' }, 1);
    repo.update('555@lid', { phone: '60199999999' });
    expect(repo.ensure('60188888888@s.whatsapp.net', {}, 1).phone).toBe('60188888888');
    const res = getChats(t.ctx).list({ assigned: 'any', limit: 10, q: '60199999999' }, 1);
    expect(res.chats.map((c) => c.jid)).toEqual(['555@lid']);
  });
});

const enc = encodeURIComponent;

async function seedChat(jid: string, name: string, ts: number) {
  await getMessages(t.ctx).ingest(
    {
      id: `seed-${jid}`,
      chatJid: jid,
      senderJid: jid,
      senderName: name,
      fromMe: false,
      type: 'text',
      body: `hi from ${name}`,
      quotedId: null,
      timestamp: ts,
      media: null,
    },
    'live',
  );
}

describe('chats routes', () => {
  it('requires auth', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/chats' });
    expect(r.statusCode).toBe(401);
  });

  it('lists with filters mine/none/any, status, search and cursor paging', async () => {
    const { user, cookie } = await createUserAndLogin(t, { role: 'agent' });
    const base = 1_700_000_000_000;
    for (let i = 0; i < 5; i++)
      await seedChat(`6011100000${i}@s.whatsapp.net`, `Person${i}`, base + i * 1000);
    await seedChat('1203630@g.us', 'Group Chat', base + 10_000);
    getChats(t.ctx).patch('60111000001@s.whatsapp.net', { assignedTo: user.id }, user.id);
    getChats(t.ctx).patch('60111000002@s.whatsapp.net', { status: 'resolved' }, user.id);

    const list = async (qs: string) => {
      const r = await t.app.inject({ method: 'GET', url: `/api/chats?${qs}`, headers: { cookie } });
      expect(r.statusCode).toBe(200);
      return ChatListResponse.parse(r.json());
    };

    const all = await list('');
    expect(all.chats.length).toBe(6);
    expect(all.chats[0]!.jid).toBe('1203630@g.us'); // newest first
    expect((await list('assigned=me')).chats.map((c) => c.jid)).toEqual([
      '60111000001@s.whatsapp.net',
    ]);
    expect((await list('assigned=none')).chats.length).toBe(5);
    expect((await list('status=resolved')).chats.map((c) => c.jid)).toEqual([
      '60111000002@s.whatsapp.net',
    ]);
    expect((await list('status=open')).chats.length).toBe(5);
    expect((await list('q=person3')).chats.map((c) => c.jid)).toEqual([
      '60111000003@s.whatsapp.net',
    ]);
    expect((await list('q=1203630')).chats.length).toBe(1);

    const p1 = await list('limit=4');
    expect(p1.chats.length).toBe(4);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await list(`limit=4&cursor=${p1.nextCursor}`);
    expect(p2.chats.length).toBe(2);
    expect(p2.nextCursor).toBeNull();
    const seen = new Set([...p1.chats, ...p2.chats].map((c) => c.jid));
    expect(seen.size).toBe(6);
  });

  it('GET detail, PATCH assign writes an event, unassign + resolve too', async () => {
    const { user, cookie } = await createUserAndLogin(t, { role: 'agent' });
    const jid = '60122222222@s.whatsapp.net';
    await seedChat(jid, 'Bob', Date.now());

    let r = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(jid)}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(ChatDetailResponse.parse(r.json()).events).toEqual([]);

    r = await t.app.inject({
      method: 'PATCH',
      url: `/api/chats/${enc(jid)}`,
      headers: authHeaders(cookie),
      payload: { assignedTo: user.id },
    });
    expect(r.statusCode).toBe(200);
    expect(ChatSchema.parse(r.json()).assignedTo).toBe(user.id);

    r = await t.app.inject({
      method: 'PATCH',
      url: `/api/chats/${enc(jid)}`,
      headers: authHeaders(cookie),
      payload: { assignedTo: null, status: 'resolved' },
    });
    expect(r.statusCode).toBe(200);

    r = await t.app.inject({ method: 'GET', url: `/api/chats/${enc(jid)}`, headers: { cookie } });
    const detail = ChatDetailResponse.parse(r.json());
    expect(detail.events.map((e) => e.type)).toEqual(['assigned', 'unassigned', 'resolved']);
    expect(detail.events[0]!.actorId).toBe(user.id);
    expect(detail.chat.status).toBe('resolved');
  });

  it('resolving releases the owner and a returning customer reopens the chat unassigned', async () => {
    const { user, cookie } = await createUserAndLogin(t, { role: 'agent' });
    const jid = '60124444444@s.whatsapp.net';
    await seedChat(jid, 'Dina', Date.now());
    getChats(t.ctx).patch(jid, { assignedTo: user.id }, user.id);

    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/chats/${enc(jid)}`,
      headers: authHeaders(cookie),
      payload: { status: 'resolved' },
    });
    expect(r.statusCode).toBe(200);
    expect(ChatSchema.parse(r.json())).toMatchObject({ status: 'resolved', assignedTo: null });
    const events = getChats(t.ctx).events(jid);
    expect(events.map((e) => e.type)).toEqual(['assigned', 'resolved', 'unassigned']);
    expect(events[2]).toMatchObject({
      actorId: user.id,
      payload: { previous: user.id, reason: 'resolved' },
    });

    await getMessages(t.ctx).ingest(
      {
        id: 'dina-back',
        chatJid: jid,
        senderJid: jid,
        senderName: 'Dina',
        fromMe: false,
        type: 'text',
        body: 'one more question',
        quotedId: null,
        timestamp: Date.now(),
        media: null,
      },
      'live',
    );
    expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'open', assignedTo: null });
  });

  it('resolving keeps an owner set explicitly in the same request', async () => {
    const { user } = await createUserAndLogin(t, { role: 'agent' });
    const jid = '60125555555@s.whatsapp.net';
    await seedChat(jid, 'Eli', Date.now());
    const chat = getChats(t.ctx).patch(jid, { assignedTo: user.id, status: 'resolved' }, user.id);
    expect(chat).toMatchObject({ status: 'resolved', assignedTo: user.id });
    expect(
      getChats(t.ctx)
        .events(jid)
        .map((e) => e.type),
    ).toEqual(['assigned', 'resolved']);
  });

  it('PATCH with unknown assignee → 400; unknown chat → 404', async () => {
    const { cookie } = await createUserAndLogin(t, { role: 'agent' });
    const jid = '60133333333@s.whatsapp.net';
    await seedChat(jid, 'Cara', Date.now());
    let r = await t.app.inject({
      method: 'PATCH',
      url: `/api/chats/${enc(jid)}`,
      headers: authHeaders(cookie),
      payload: { assignedTo: 9999 },
    });
    expect(r.statusCode).toBe(400);
    r = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc('nope@s.whatsapp.net')}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(404);
  });

  it('POST read zeroes unread and marks read on WA', async () => {
    const { cookie } = await createUserAndLogin(t, { role: 'agent' });
    const jid = '60144444444@s.whatsapp.net';
    await seedChat(jid, 'Dan', Date.now());
    expect(getChats(t.ctx).get(jid)!.unreadCount).toBe(1);
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(jid)}/read`,
      headers: authHeaders(cookie),
    });
    expect(r.statusCode).toBe(200);
    expect(getChats(t.ctx).get(jid)!.unreadCount).toBe(0);
    expect(t.wa.reads.some((x) => x.chatJid === jid && x.messageIds.includes(`seed-${jid}`))).toBe(
      true,
    );
  });

  it('since= returns chats updated after a timestamp', async () => {
    const { cookie } = await createUserAndLogin(t, { role: 'agent' });
    await seedChat('60155555555@s.whatsapp.net', 'Eve', Date.now());
    const later = Date.now() + 60_000;
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/chats?since=${later}`,
      headers: { cookie },
    });
    expect(ChatListResponse.parse(r.json()).chats).toEqual([]);
  });

  it('notes: add + list, emits note:new', async () => {
    const { user, cookie } = await createUserAndLogin(t, { role: 'agent' });
    const jid = '60166666666@s.whatsapp.net';
    await seedChat(jid, 'Fay', Date.now());
    const emitted: number[] = [];
    t.ctx.bus.on('note:new', (n) => emitted.push(n.id));
    let r = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(jid)}/notes`,
      headers: authHeaders(cookie),
      payload: { body: 'VIP customer' },
    });
    expect(r.statusCode).toBe(201);
    const note = NoteSchema.parse(r.json());
    expect(note.userId).toBe(user.id);
    expect(emitted).toEqual([note.id]);
    r = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(jid)}/notes`,
      headers: { cookie },
    });
    expect(r.json().notes.map((n: { body: string }) => n.body)).toEqual(['VIP customer']);
  });

  it('old phone-number URLs (links, push notifications) open the WhatsApp ID chat after the startup re-key', async () => {
    const { cookie } = await createUserAndLogin(t, { role: 'agent' });
    const h = authHeaders(cookie);
    const PN = '60155555555@s.whatsapp.net';
    const LID = '555555555@lid';
    await seedChat(PN, 'Eve', 1000);
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: LID }]);
    expect(runIdentityMigration(t.ctx)).toMatchObject({ merged: 1, rekeyed: 1 });

    const detail = await t.app.inject({ method: 'GET', url: `/api/chats/${enc(PN)}`, headers: h });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().chat.jid).toBe(LID);
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(PN)}/messages`,
      headers: h,
    });
    expect(list.json().messages.map((m: { id: string }) => m.id)).toEqual([`seed-${PN}`]);
    const note = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(PN)}/notes`,
      headers: h,
      payload: { body: 'merged note' },
    });
    expect(note.statusCode).toBe(201);
    expect(note.json().chatJid).toBe(LID);
    const notes = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${enc(PN)}/notes`,
      headers: h,
    });
    expect(notes.json().notes.map((n: { body: string }) => n.body)).toEqual(['merged note']);
    const sent = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(PN)}/messages`,
      headers: h,
      payload: { clientId: 'route-merge', text: 'hello' },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().chatJid).toBe(LID);
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/chats/${enc(PN)}`,
      headers: h,
      payload: { status: 'resolved' },
    });
    expect(patch.json().jid).toBe(LID);
    const read = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(PN)}/read`,
      headers: h,
    });
    expect(read.statusCode).toBe(200);
  });

  it('a phone-number chat that stays separate until the next start is still reachable under its own URL', async () => {
    const { cookie } = await createUserAndLogin(t, { role: 'agent' });
    const PN = '60166666666@s.whatsapp.net';
    const LID = '666666666@lid';
    await seedChat(PN, 'Fay', 1000);
    await seedChat(LID, 'Fay', 2000);
    getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: LID }]);
    const get = (jid: string) =>
      t.app.inject({ method: 'GET', url: `/api/chats/${enc(jid)}`, headers: authHeaders(cookie) });
    expect((await get(PN)).json().chat.jid).toBe(PN);
    expect((await get(LID)).json().chat.jid).toBe(LID);
  });
});

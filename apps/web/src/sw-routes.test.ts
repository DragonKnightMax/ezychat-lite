import { describe, expect, it } from 'vitest';
import {
  AVATAR_CACHE,
  AVATAR_LIMITS,
  CLEAR_USER_CACHES,
  MEDIA_CACHE,
  MEDIA_LIMITS,
  deleteUserCaches,
  isAvatarRequest,
  isClearUserCachesMessage,
  isMediaRequest,
  MEDIA_MAX_BYTES,
  mediaSizePlugin,
  noStorePlugin,
} from './sw-routes';

const ORIGIN = 'https://inbox.example.com';

function req(
  path: string,
  init: { method?: string; cache?: RequestCache; headers?: Record<string, string> } = {},
) {
  return {
    url: new URL(path, ORIGIN),
    request: {
      method: init.method ?? 'GET',
      cache: init.cache ?? 'default',
      headers: new Headers(init.headers),
    },
  };
}

const avatar = (path: string, init?: Parameters<typeof req>[1]) => {
  const { url, request } = req(path, init);
  return isAvatarRequest(url, request, ORIGIN);
};
const media = (path: string, init?: Parameters<typeof req>[1]) => {
  const { url, request } = req(path, init);
  return isMediaRequest(url, request, ORIGIN);
};

describe('avatar route', () => {
  it('matches chat and group member photos, with or without a version', () => {
    expect(avatar('/api/chats/60123%40s.whatsapp.net/avatar')).toBe(true);
    expect(avatar('/api/chats/60123%40s.whatsapp.net/avatar?v=ab12cd')).toBe(true);
    expect(avatar('/api/chats/120363%40g.us/members/60123%40s.whatsapp.net/avatar')).toBe(true);
  });

  it('never matches API JSON, other origins, writes or no-store requests', () => {
    expect(avatar('/api/chats')).toBe(false);
    expect(avatar('/api/chats/60123%40s.whatsapp.net')).toBe(false);
    expect(avatar('/api/chats/60123%40s.whatsapp.net/members')).toBe(false);
    expect(avatar('/api/chats/a/avatar/extra')).toBe(false);
    expect(avatar('/api/me')).toBe(false);
    const { url, request } = req('/api/chats/x/avatar');
    expect(isAvatarRequest(url, request, 'https://other.example.com')).toBe(false);
    expect(avatar('/api/chats/x/avatar', { method: 'POST' })).toBe(false);
    expect(avatar('/api/chats/x/avatar', { cache: 'no-store' })).toBe(false);
    expect(avatar('/api/chats/x/avatar', { cache: 'reload' })).toBe(false);
  });
});

describe('media route', () => {
  it('matches a message file', () => {
    expect(media('/api/media/3EB0ABCDEF')).toBe(true);
  });

  it('leaves byte ranges, re-downloads, no-store requests and JSON to the network', () => {
    // Audio and video players ask for ranges; a cached whole file cannot answer them.
    expect(media('/api/media/3EB0', { headers: { range: 'bytes=0-' } })).toBe(false);
    expect(media('/api/media/3EB0/redownload', { method: 'POST' })).toBe(false);
    expect(media('/api/media/3EB0/redownload')).toBe(false);
    // WhatsApp Safety downloads ask the server every time (lock check, download record).
    expect(media('/api/media/3EB0', { cache: 'no-store' })).toBe(false);
    expect(media('/api/messages/3EB0')).toBe(false);
  });
});

describe('cache settings', () => {
  it('keeps the agreed names and limits', () => {
    expect(AVATAR_CACHE).toBe('ezy-avatars-v1');
    expect(MEDIA_CACHE).toBe('ezy-media-v1');
    expect(AVATAR_LIMITS).toEqual({ maxEntries: 1000, maxAgeSeconds: 7 * 24 * 60 * 60 });
    expect(MEDIA_LIMITS).toEqual({ maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60 });
  });
});

describe('noStorePlugin', () => {
  const store = (cacheControl: string | null) => {
    const headers = new Headers();
    if (cacheControl !== null) headers.set('cache-control', cacheControl);
    const response = new Response('x', { status: 200, headers });
    return noStorePlugin.cacheWillUpdate({ response });
  };

  it('never stores a response the server marked no-store', async () => {
    expect(await store('no-store')).toBeNull();
    expect(await store('private, No-Store')).toBeNull();
  });

  it('stores other responses unchanged', async () => {
    const headers = new Headers({ 'cache-control': 'private, max-age=31536000, immutable' });
    const response = new Response('x', { status: 200, headers });
    expect(await noStorePlugin.cacheWillUpdate({ response })).toBe(response);
    expect(await store(null)).not.toBeNull();
  });
});

describe('mediaSizePlugin', () => {
  const store = (length: string | null) => {
    const headers = new Headers(length === null ? {} : { 'content-length': length });
    return mediaSizePlugin.cacheWillUpdate({
      response: new Response('x', { status: 200, headers }),
    });
  };

  it('never keeps a file over 20 MB on the phone', async () => {
    expect(MEDIA_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(await store(String(MEDIA_MAX_BYTES + 1))).toBeNull();
    expect(await store(String(200 * 1024 * 1024))).toBeNull();
  });

  it('keeps a file up to 20 MB, and one whose size is not told (the expiration limits still apply)', async () => {
    expect(await store(String(MEDIA_MAX_BYTES))).not.toBeNull();
    expect(await store('2048')).not.toBeNull();
    expect(await store(null)).not.toBeNull();
  });
});

describe('clearing on sign-out', () => {
  it('recognises only the clear message', () => {
    expect(isClearUserCachesMessage({ type: CLEAR_USER_CACHES })).toBe(true);
    expect(isClearUserCachesMessage({ type: 'navigate' })).toBe(false);
    expect(isClearUserCachesMessage(null)).toBe(false);
    expect(isClearUserCachesMessage('clear-user-caches')).toBe(false);
  });

  it('deletes photo and file caches and keeps the app precache', async () => {
    const names = new Set([
      'ezy-avatars-v1',
      'ezy-avatars-v0',
      'ezy-media-v1',
      'workbox-precache-v2-https://inbox.example.com/',
    ]);
    const storage = {
      keys: () => Promise.resolve([...names]),
      delete: (name: string) => Promise.resolve(names.delete(name)),
    };
    await deleteUserCaches(storage);
    expect([...names]).toEqual(['workbox-precache-v2-https://inbox.example.com/']);
  });
});

// Runtime caching rules of the service worker (sw.ts). Pure: no workbox import and no service
// worker globals, so the rules can be unit-tested and the page can share the cache names.
// Only contact photos and message files are kept; API JSON never goes through these caches.

/** Contact and group member photos. */
export const AVATAR_CACHE = 'ezy-avatars-v1';
/** Message files (`/api/media/:id`). */
export const MEDIA_CACHE = 'ezy-media-v1';
/** Every version of the per-user caches: removed on sign-out and when another user signs in. */
export const USER_CACHE_PREFIXES = ['ezy-avatars-', 'ezy-media-'] as const;
/** Message the page posts to the service worker to remove the per-user caches. */
export const CLEAR_USER_CACHES = 'clear-user-caches';

const DAY_SECONDS = 24 * 60 * 60;
export const AVATAR_LIMITS = { maxEntries: 1000, maxAgeSeconds: 7 * DAY_SECONDS };
export const MEDIA_LIMITS = { maxEntries: 300, maxAgeSeconds: 30 * DAY_SECONDS };

/** `/api/chats/:jid/avatar` and `/api/chats/:groupJid/members/:member/avatar`. */
const AVATAR_PATH = /^\/api\/chats\/[^/]+\/(?:members\/[^/]+\/)?avatar$/;
/** `/api/media/:id` only (not `…/redownload`). */
const MEDIA_PATH = /^\/api\/media\/[^/]+$/;

type RouteRequest = Pick<Request, 'method' | 'cache' | 'headers'>;

/** A same-origin GET that does not ask to skip caches (`fetch(…, { cache: 'no-store' })`). */
function cacheableGet(url: URL, request: RouteRequest, origin: string): boolean {
  return (
    url.origin === origin &&
    request.method === 'GET' &&
    request.cache !== 'no-store' &&
    request.cache !== 'reload'
  );
}

export function isAvatarRequest(url: URL, request: RouteRequest, origin: string): boolean {
  return cacheableGet(url, request, origin) && AVATAR_PATH.test(url.pathname);
}

/**
 * Byte-range requests (audio and video players) stay on the network: a cached whole file cannot
 * answer them, and a partial (206) answer is never stored.
 */
export function isMediaRequest(url: URL, request: RouteRequest, origin: string): boolean {
  return (
    cacheableGet(url, request, origin) &&
    MEDIA_PATH.test(url.pathname) &&
    !request.headers.has('range')
  );
}

/** Workbox plugin: never store a response the server marked `no-store` (e.g. a flagged file). */
export const noStorePlugin = {
  cacheWillUpdate: ({ response }: { response: Response }): Promise<Response | null> =>
    Promise.resolve(
      /(^|[\s,])no-store($|[\s,;])/i.test(response.headers.get('cache-control') ?? '')
        ? null
        : response,
    ),
};

/** Largest message file the phone keeps: one long video must not fill the phone's storage. */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** Workbox plugin for message files: never store one larger than MEDIA_MAX_BYTES. */
export const mediaSizePlugin = {
  cacheWillUpdate: ({ response }: { response: Response }): Promise<Response | null> =>
    Promise.resolve(
      Number(response.headers.get('content-length') ?? 0) > MEDIA_MAX_BYTES ? null : response,
    ),
};

export function isClearUserCachesMessage(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === CLEAR_USER_CACHES
  );
}

export function isUserCacheName(name: string): boolean {
  return USER_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Removes the photo and file caches; the app's own precache stays. */
export async function deleteUserCaches(
  storage: Pick<CacheStorage, 'keys' | 'delete'>,
): Promise<void> {
  const names = await storage.keys();
  await Promise.all(names.filter(isUserCacheName).map((name) => storage.delete(name)));
}

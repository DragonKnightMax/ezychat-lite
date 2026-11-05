// Keeps a small part of the query cache on the device, per user, so the inbox shows the last known
// chat list, inboxes and user at once on the next open (over the tunnel each load costs ~1 s), then
// loads fresh copies right away. Never message history, chat details or files.
import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type { User } from '@ezychat/shared';
import type { ChatsData } from './queries';

/** Same key as `qk.me`: no runtime import of queries.ts, which imports this module's users. */
const ME_KEY = ['me'] as const;

export type KeyValueStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

/** A saved copy older than this is not shown. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Saves are grouped: at most one write per this delay. */
export const SAVE_DELAY_MS = 1_000;
/** The id of the last user seen on this device (to notice a different user signing in). */
export const LAST_USER_KEY = 'ezy.last-user';
const SAVED_PREFIX = 'ezy.queries.';
const FORMAT = 1;
/** The chat lists kept (one per filter the user opened), newest first. */
const MAX_CHAT_LISTS = 4;
/** Single-key queries kept as they are. */
const KEPT = new Set(['me', 'setup-status', 'inboxes', 'settings']);
/** Not user data: kept in memory when another user signs in. */
const KEPT_ON_SWITCH = new Set(['me', 'setup-status']);

interface SavedQueries {
  format: number;
  buster: string;
  savedAt: number;
  userId: number;
  state: DehydratedState;
}

interface QueryLike {
  queryKey: QueryKey;
  state: { status: string; data: unknown };
}

/** `localStorage`, or null where the browser refuses it. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function read(storage: KeyValueStorage | null, key: string): string | null {
  return storage ? attempt(() => storage.getItem(key), null) : null;
}

function write(storage: KeyValueStorage | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Full or refused: never leave an older copy behind.
    attempt(() => storage.removeItem(key), undefined);
  }
}

function remove(storage: KeyValueStorage | null, key: string): void {
  if (storage) attempt(() => storage.removeItem(key), undefined);
}

function readLastUser(storage: KeyValueStorage | null): number | null {
  const id = Number(read(storage, LAST_USER_KEY));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isChatList(queryKey: QueryKey): boolean {
  const [head, filters] = queryKey;
  return (
    head === 'chats' &&
    queryKey.length === 2 &&
    typeof filters === 'object' &&
    filters !== null &&
    !(filters as { q?: unknown }).q
  );
}

/** The first screen only: user, setup status, inboxes, settings and chat lists without a search. */
export function shouldPersistQuery(query: QueryLike): boolean {
  if (query.state.status !== 'success' || query.state.data == null) return false;
  const head = query.queryKey[0];
  if (typeof head === 'string' && KEPT.has(head)) return query.queryKey.length === 1;
  return isChatList(query.queryKey);
}

function firstPage(data: unknown): unknown {
  const list = data as ChatsData | undefined;
  if (!list || !Array.isArray(list.pages) || !Array.isArray(list.pageParams)) return data;
  return { pages: list.pages.slice(0, 1), pageParams: list.pageParams.slice(0, 1) };
}

function serialize(qc: QueryClient, userId: number, buster: string, now: number): string {
  const { queries } = dehydrate(qc, {
    shouldDehydrateQuery: shouldPersistQuery,
    shouldDehydrateMutation: () => false,
  });
  const lists = queries
    .filter((q) => isChatList(q.queryKey))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, MAX_CHAT_LISTS);
  const kept = queries
    .filter((q) => !isChatList(q.queryKey) || lists.includes(q))
    // Dehydrated states are the live objects: copy before cutting a list to its first page.
    .map((q) =>
      isChatList(q.queryKey) ? { ...q, state: { ...q.state, data: firstPage(q.state.data) } } : q,
    );
  const saved: SavedQueries = {
    format: FORMAT,
    buster,
    savedAt: now,
    userId,
    state: { mutations: [], queries: kept },
  };
  return JSON.stringify(saved);
}

function parseSaved(raw: string | null): SavedQueries | null {
  if (!raw) return null;
  const saved = attempt(() => JSON.parse(raw) as Partial<SavedQueries> | null, null);
  if (
    !saved ||
    typeof saved !== 'object' ||
    typeof saved.savedAt !== 'number' ||
    typeof saved.userId !== 'number' ||
    !Array.isArray(saved.state?.queries)
  )
    return null;
  return saved as SavedQueries;
}

/**
 * Before the first render: puts the last user's saved copy into the cache, marked stale so every
 * kept query loads again as soon as it is used. A copy that is too old, from another build or not
 * this user's is removed instead.
 */
export function restorePersistedQueries(
  qc: QueryClient,
  {
    storage,
    buster,
    now = Date.now(),
  }: { storage: KeyValueStorage | null; buster: string; now?: number },
): void {
  const userId = readLastUser(storage);
  if (userId === null) return;
  const key = SAVED_PREFIX + userId;
  const saved = parseSaved(read(storage, key));
  const me = saved?.state.queries.find((q) => q.queryKey[0] === 'me' && q.queryKey.length === 1);
  const valid =
    saved !== null &&
    saved.format === FORMAT &&
    saved.buster === buster &&
    saved.userId === userId &&
    now - saved.savedAt <= PERSIST_MAX_AGE_MS &&
    (me?.state.data as User | null | undefined)?.id === userId &&
    // A user who still had to change the password is never shown from a copy: the guard would send
    // a reload straight to /change-password before the server says it is done (`savable`).
    !(me?.state.data as User).mustChangePassword;
  if (!valid) {
    remove(storage, key);
    return;
  }
  hydrate(qc, saved.state);
  void qc.invalidateQueries({ predicate: shouldPersistQuery, refetchType: 'none' });
}

/**
 * Saves the kept queries of the signed-in user while the app runs. When the session ends (sign-out,
 * a 401 for a disabled user or a revoked session) the saved copy is removed and `clearCaches` runs
 * (it removes the photo and file caches); when a different user signs in, the earlier user's data
 * also leaves memory. `clearCaches` runs once per user who leaves.
 */
export function startQueryPersistence(
  qc: QueryClient,
  {
    storage,
    buster,
    clearCaches,
  }: { storage: KeyValueStorage | null; buster: string; clearCaches: () => void },
): () => void {
  let lastUser = readLastUser(storage);
  // True once the caches were cleared after lastUser left, until the next user arrives.
  let cleared = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const save = () => {
    timer = undefined;
    const me = qc.getQueryData<User | null>(ME_KEY);
    if (me?.id !== lastUser || lastUser === null) return;
    if (savable(me)) write(storage, SAVED_PREFIX + me.id, serialize(qc, me.id, buster, Date.now()));
    else remove(storage, SAVED_PREFIX + me.id);
  };
  const onUser = (user: User | null) => {
    if (!user) {
      cancel();
      if (lastUser !== null && !cleared) {
        remove(storage, SAVED_PREFIX + lastUser);
        attempt(clearCaches, undefined);
        cleared = true;
      }
      return;
    }
    // Never keep a copy that still says "change your password": saves wait up to SAVE_DELAY_MS, so
    // a reload right after the change would restore it and send the user back to that page.
    if (!savable(user)) remove(storage, SAVED_PREFIX + user.id);
    if (user.id === lastUser) {
      cleared = false;
      return;
    }
    if (!cleared) attempt(clearCaches, undefined);
    cleared = false;
    if (lastUser !== null) {
      remove(storage, SAVED_PREFIX + lastUser);
      qc.removeQueries({
        predicate: (q) => !KEPT_ON_SWITCH.has(String(q.queryKey[0])),
      });
    }
    lastUser = user.id;
    write(storage, LAST_USER_KEY, String(user.id));
  };
  const unsubscribe = qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const { query } = event;
    if (query.queryKey[0] === 'me' && query.queryKey.length === 1)
      onUser((query.state.data as User | null | undefined) ?? null);
    if (shouldPersistQuery(query) && timer === undefined) timer = setTimeout(save, SAVE_DELAY_MS);
  });
  return () => {
    cancel();
    unsubscribe();
  };
}

/** A user who must still change the password is never saved (see `restorePersistedQueries`). */
function savable(user: User): boolean {
  return !user.mustChangePassword;
}

/** Removes every user's saved copy (sign-out). */
export function dropPersistedQueries(storage: KeyValueStorage | null): void {
  if (!storage) return;
  const keys = attempt(() => {
    const found: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(SAVED_PREFIX)) found.push(key);
    }
    return found;
  }, []);
  for (const key of keys) remove(storage, key);
}

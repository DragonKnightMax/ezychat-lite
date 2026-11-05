import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  LAST_USER_KEY,
  PERSIST_MAX_AGE_MS,
  SAVE_DELAY_MS,
  dropPersistedQueries,
  restorePersistedQueries,
  shouldPersistQuery,
  startQueryPersistence,
  type KeyValueStorage,
} from './query-persist';
import { qk, type ChatsData } from './queries';

const BUSTER = '0.1.75';
const filters = { assigned: 'any', status: 'open' } as const;

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

function page(name: string, next: string | null) {
  return { chats: [{ jid: `${name}@s.whatsapp.net`, name }], nextCursor: next };
}

function chatList(): ChatsData {
  return {
    pages: [page('first', 'c1'), page('second', null)],
    pageParams: [null, 'c1'],
  } as unknown as ChatsData;
}

function signedIn(qc: QueryClient, id: number) {
  qc.setQueryData(qk.me, { id, displayName: `User ${id}` });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldPersistQuery', () => {
  const q = (queryKey: unknown[], data: unknown = { x: 1 }, status = 'success') =>
    shouldPersistQuery({ queryKey, state: { status, data } });

  it('keeps the first screen: user, setup status, inboxes, settings and chat lists', () => {
    expect(q(['me'])).toBe(true);
    expect(q(['setup-status'])).toBe(true);
    expect(q(['inboxes'])).toBe(true);
    expect(q(['settings'])).toBe(true);
    expect(q(['chats', filters])).toBe(true);
  });

  it('never keeps messages, files, chat details, searches, failures or a signed-out user', () => {
    expect(q(['messages', 'x@s.whatsapp.net'])).toBe(false);
    expect(q(['chat', 'x@s.whatsapp.net'])).toBe(false);
    expect(q(['notes', 'x@s.whatsapp.net'])).toBe(false);
    expect(q(['chats', { ...filters, q: 'alex' }])).toBe(false);
    expect(q(['chats'])).toBe(false);
    expect(q(['users', 'directory'])).toBe(false);
    expect(q(['inboxes'], undefined, 'error')).toBe(false);
    expect(q(['me'], null)).toBe(false);
  });
});

describe('save and restore', () => {
  it('keeps the first page of each list per user and shows it at once on the next open', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const qc = new QueryClient();
    const stop = startQueryPersistence(qc, { storage, buster: BUSTER, clearCaches: () => {} });
    signedIn(qc, 7);
    qc.setQueryData(qk.chats(filters), chatList());
    qc.setQueryData(qk.inboxes, { inboxes: [{ id: 1 }] });
    qc.setQueryData(qk.messages('x@s.whatsapp.net'), { pages: [], pageParams: [] });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    stop();
    expect(storage.getItem(LAST_USER_KEY)).toBe('7');
    const saved = storage.getItem('ezy.queries.7');
    expect(saved).toBeTruthy();
    expect(saved).not.toContain('"messages"');

    const next = new QueryClient();
    restorePersistedQueries(next, { storage, buster: BUSTER });
    expect(next.getQueryData<{ id: number }>(qk.me)?.id).toBe(7);
    expect(next.getQueryData(qk.inboxes)).toEqual({ inboxes: [{ id: 1 }] });
    const list = next.getQueryData<ChatsData>(qk.chats(filters))!;
    expect(list.pages).toHaveLength(1);
    expect(list.pageParams).toEqual([null]);
    // The live list keeps both pages; only the saved copy is cut.
    expect(qc.getQueryData<ChatsData>(qk.chats(filters))!.pages).toHaveLength(2);
    // Shown at once, then loaded again from the server right away.
    const state = next.getQueryCache().find({ queryKey: qk.chats(filters), exact: true })!.state;
    expect(state.isInvalidated).toBe(true);
  });

  it('ignores and removes a saved copy that is too old, from another build or broken', () => {
    const storage = memoryStorage();
    const save = (savedAt: number, buster = BUSTER) => {
      const qc = new QueryClient();
      vi.useFakeTimers({ now: savedAt });
      const stop = startQueryPersistence(qc, { storage, buster, clearCaches: () => {} });
      signedIn(qc, 7);
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      stop();
      vi.useRealTimers();
    };
    const restore = (now: number) => {
      const qc = new QueryClient();
      restorePersistedQueries(qc, { storage, buster: BUSTER, now });
      return qc.getQueryData(qk.me);
    };

    save(1_000_000);
    expect(restore(1_000_000 + PERSIST_MAX_AGE_MS + SAVE_DELAY_MS + 1)).toBeUndefined();
    expect(storage.getItem('ezy.queries.7')).toBeNull();

    save(1_000_000, 'older-build');
    expect(restore(1_000_000 + SAVE_DELAY_MS)).toBeUndefined();

    storage.setItem(LAST_USER_KEY, '7');
    storage.setItem('ezy.queries.7', '{not json');
    expect(restore(Date.now())).toBeUndefined();
    expect(storage.getItem('ezy.queries.7')).toBeNull();
  });

  it('restores only the copy of the last user, and only when its user matches', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const qc = new QueryClient();
    const stop = startQueryPersistence(qc, { storage, buster: BUSTER, clearCaches: () => {} });
    signedIn(qc, 7);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    stop();
    // Another user's copy under user 7's name is never shown.
    const saved = JSON.parse(storage.getItem('ezy.queries.7')!) as { userId: number };
    storage.setItem('ezy.queries.7', JSON.stringify({ ...saved, userId: 8 }));
    const next = new QueryClient();
    restorePersistedQueries(next, { storage, buster: BUSTER });
    expect(next.getQueryData(qk.me)).toBeUndefined();
  });
});

describe('a user who must change the password', () => {
  const user = (mustChangePassword: boolean) => ({
    id: 7,
    displayName: 'User 7',
    mustChangePassword,
  });

  it('is never saved, so a reload right after the change cannot bring the old state back', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const qc = new QueryClient();
    const stop = startQueryPersistence(qc, { storage, buster: BUSTER, clearCaches: () => {} });
    qc.setQueryData(qk.me, user(true));
    qc.setQueryData(qk.inboxes, { inboxes: [{ id: 1 }] });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(storage.getItem('ezy.queries.7')).toBeNull();

    // The password is changed and the page reloads before the next save: nothing is restored, so
    // the app asks the server instead of sending the user back to /change-password.
    qc.setQueryData(qk.me, user(false));
    const reloaded = new QueryClient();
    restorePersistedQueries(reloaded, { storage, buster: BUSTER });
    expect(reloaded.getQueryData(qk.me)).toBeUndefined();

    // Once saved, the next open shows the user at once again.
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    stop();
    const next = new QueryClient();
    restorePersistedQueries(next, { storage, buster: BUSTER });
    expect(next.getQueryData(qk.me)).toEqual(user(false));
  });

  it('removes an earlier copy at once, and ignores a saved copy that still says so', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const qc = new QueryClient();
    const stop = startQueryPersistence(qc, { storage, buster: BUSTER, clearCaches: () => {} });
    qc.setQueryData(qk.me, user(false));
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    const earlier = storage.getItem('ezy.queries.7')!;
    expect(earlier).toBeTruthy();
    qc.setQueryData(qk.me, user(true));
    expect(storage.getItem('ezy.queries.7')).toBeNull();
    stop();

    // A copy written by an older build, before this rule.
    storage.setItem(
      'ezy.queries.7',
      earlier.replace('"mustChangePassword":false', '"mustChangePassword":true'),
    );
    const next = new QueryClient();
    restorePersistedQueries(next, { storage, buster: BUSTER });
    expect(next.getQueryData(qk.me)).toBeUndefined();
    expect(storage.getItem('ezy.queries.7')).toBeNull();
  });
});

describe('sign-out and user switch', () => {
  it('removes the saved copy when the user signs out, and a pending save does not bring it back', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const qc = new QueryClient();
    startQueryPersistence(qc, { storage, buster: BUSTER, clearCaches: () => {} });
    signedIn(qc, 7);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(storage.getItem('ezy.queries.7')).toBeTruthy();

    qc.setQueryData(qk.inboxes, { inboxes: [] }); // schedules a save
    qc.clear();
    qc.setQueryData(qk.me, null); // logout, or the session ended (401)
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(storage.getItem('ezy.queries.7')).toBeNull();
  });

  it('clears the photo and file caches once when the session ends (e.g. a disabled user, 401)', () => {
    const storage = memoryStorage();
    storage.setItem(LAST_USER_KEY, '7'); // user 7 used this device before
    const clearCaches = vi.fn();
    const qc = new QueryClient();
    startQueryPersistence(qc, { storage, buster: BUSTER, clearCaches });
    qc.setQueryData(qk.me, null); // /api/me answered 401
    expect(clearCaches).toHaveBeenCalledTimes(1);
    qc.setQueryData(qk.me, null); // the login page asks again: nothing more to clear
    expect(clearCaches).toHaveBeenCalledTimes(1);
    signedIn(qc, 8); // already cleared since user 7 left
    expect(clearCaches).toHaveBeenCalledTimes(1);
    expect(storage.getItem(LAST_USER_KEY)).toBe('8');
  });

  it('never clears on a device where nobody was signed in before', () => {
    const clearCaches = vi.fn();
    const qc = new QueryClient();
    startQueryPersistence(qc, { storage: memoryStorage(), buster: BUSTER, clearCaches });
    qc.setQueryData(qk.me, null);
    expect(clearCaches).not.toHaveBeenCalled();
  });

  it('clears the photo caches and the other user’s data when a different user signs in', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const clearCaches = vi.fn();
    const qc = new QueryClient();
    startQueryPersistence(qc, { storage, buster: BUSTER, clearCaches });
    signedIn(qc, 7);
    expect(clearCaches).toHaveBeenCalledTimes(1); // no earlier user known on this device
    qc.setQueryData(qk.chats(filters), chatList());
    vi.advanceTimersByTime(SAVE_DELAY_MS);

    signedIn(qc, 7); // the same user again (a profile change): nothing is cleared
    expect(clearCaches).toHaveBeenCalledTimes(1);

    qc.setQueryData(qk.me, null); // session ended without signing out
    signedIn(qc, 8);
    expect(clearCaches).toHaveBeenCalledTimes(2);
    expect(qc.getQueryData(qk.chats(filters))).toBeUndefined();
    expect(storage.getItem('ezy.queries.7')).toBeNull();
    expect(storage.getItem(LAST_USER_KEY)).toBe('8');
  });

  it('dropPersistedQueries removes every saved copy and keeps other app settings', () => {
    const storage = memoryStorage();
    storage.setItem('ezy.queries.7', '{}');
    storage.setItem('ezy.queries.8', '{}');
    storage.setItem('wati.theme', 'dark');
    dropPersistedQueries(storage);
    expect([...storage.data.keys()]).toEqual(['wati.theme']);
  });

  it('works without storage (blocked or private window)', () => {
    vi.useFakeTimers();
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
      key: () => {
        throw new Error('denied');
      },
      get length(): number {
        throw new Error('denied');
      },
    };
    const qc = new QueryClient();
    expect(() => restorePersistedQueries(qc, { storage: broken, buster: BUSTER })).not.toThrow();
    startQueryPersistence(qc, { storage: broken, buster: BUSTER, clearCaches: () => {} });
    expect(() => {
      signedIn(qc, 7);
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      dropPersistedQueries(broken);
    }).not.toThrow();
    expect(() => restorePersistedQueries(qc, { storage: null, buster: BUSTER })).not.toThrow();
  });
});

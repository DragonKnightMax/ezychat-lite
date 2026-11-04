import { afterEach, expect, it, vi } from 'vitest';
import { clearUserCaches } from './user-caches';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  localStorage.clear();
});

function fakeCaches(names: string[]) {
  const kept = new Set(names);
  vi.stubGlobal('caches', {
    keys: () => Promise.resolve([...kept]),
    delete: (name: string) => Promise.resolve(kept.delete(name)),
  });
  return kept;
}

it('asks the service worker to remove photos and files, removes them itself and drops saved lists', async () => {
  const postMessage = vi.fn();
  const activePost = vi.fn();
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: { postMessage },
      ready: Promise.resolve({ active: { postMessage: activePost } }),
    },
  });
  const kept = fakeCaches(['ezy-avatars-v1', 'ezy-media-v1', 'workbox-precache-v2-x']);
  localStorage.setItem('ezy.queries.7', '{}');
  localStorage.setItem('ezy.last-user', '7');

  await clearUserCaches();

  expect(postMessage).toHaveBeenCalledWith({ type: 'clear-user-caches' });
  expect(activePost).toHaveBeenCalledWith({ type: 'clear-user-caches' });
  expect([...kept]).toEqual(['workbox-precache-v2-x']);
  expect(localStorage.getItem('ezy.queries.7')).toBeNull();
  // Kept, so the next sign-in can tell whether it is the same person.
  expect(localStorage.getItem('ezy.last-user')).toBe('7');
});

it('never fails or hangs sign-out: no service worker, no Cache API, or a refusing one', async () => {
  await expect(clearUserCaches()).resolves.toBeUndefined();
  // No worker registered: `ready` never settles, and sign-out must not wait for it.
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: null, ready: new Promise(() => {}) },
  });
  await expect(clearUserCaches()).resolves.toBeUndefined();
  vi.stubGlobal('caches', {
    keys: () => Promise.reject(new Error('SecurityError')),
    delete: () => Promise.resolve(false),
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: {
        postMessage: () => {
          throw new Error('gone');
        },
      },
      ready: Promise.reject(new Error('no registration')),
    },
  });
  await expect(clearUserCaches()).resolves.toBeUndefined();
});

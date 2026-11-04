// What one user leaves on the device: contact photos and message files in the service worker's
// caches, and the saved first screen (chat list, inboxes). Removed on sign-out, and when a different
// user signs in, so the next person never sees chats they may no longer open.
import { browserStorage, dropPersistedQueries } from '../api/query-persist';
import { CLEAR_USER_CACHES, deleteUserCaches } from '../sw-routes';

const MESSAGE = { type: CLEAR_USER_CACHES } as const;

function tellServiceWorker(): void {
  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (!sw) return;
  try {
    sw.controller?.postMessage(MESSAGE);
  } catch {
    // The worker is being replaced; the ready one below still gets the message.
  }
  // Before the first reload the page has no controller yet: the active worker still keeps caches.
  // Not awaited: `ready` never settles where no worker is registered.
  void Promise.resolve(sw.ready)
    .then((registration) => registration?.active?.postMessage(MESSAGE))
    .catch(() => undefined);
}

/** Never throws or hangs: sign-out must finish even where the browser refuses storage or caches. */
export async function clearUserCaches(): Promise<void> {
  dropPersistedQueries(browserStorage());
  tellServiceWorker();
  // The page reaches the same caches directly: this works even when no worker runs.
  if (typeof caches !== 'undefined') await deleteUserCaches(caches).catch(() => undefined);
}

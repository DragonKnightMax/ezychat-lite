/// <reference lib="webworker" />
// Service worker (built by vite-plugin-pwa, strategies: 'injectManifest').
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

/** Payload sent by the server's PushService (packages/server/src/push). */
interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// registerType 'autoUpdate': activate new versions immediately.
self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data: PushPayload;
  try {
    data = (event.data?.json() as PushPayload | undefined) ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  const title = data.title || 'EzyChat Lite';
  const options: NotificationOptions = {
    body: data.body ?? '',
    tag: data.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url ?? '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data as { url?: string } | null)?.url ?? '/';
  const target = new URL(raw, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const sameOrigin = windows.filter((c) => new URL(c.url).origin === self.location.origin);
      const existing = sameOrigin.find((c) => c.focused) ?? sameOrigin[0];
      if (existing) {
        await existing.focus();
        if (existing.url !== target) {
          try {
            await existing.navigate(target);
          } catch {
            // navigate() fails for uncontrolled clients; ask the page to route instead.
            existing.postMessage({ type: 'navigate', url: raw });
          }
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/// <reference types="vite-plugin-pwa/vanillajs" />
// Loaded by main.tsx (via import.meta.glob). Registers the service worker built from src/sw.ts.
import { registerSW as register } from 'virtual:pwa-register';

let registered = false;

export function registerSW(): void {
  if (registered || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  registered = true;

  register({
    immediate: true,
    onRegisterError(error: unknown) {
      console.warn('Service worker registration failed', error);
    },
  });

  // sw.ts asks the page to route when it cannot navigate the client itself.
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'navigate' && typeof data.url === 'string' && data.url.startsWith('/')) {
      window.location.assign(data.url);
    }
  });
}

export default registerSW;

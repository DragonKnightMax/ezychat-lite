// Web Push helpers (browser side). Server routes: GET /api/push/vapid-key,
// POST /api/push/subscribe (PushSubscribeBody), DELETE /api/push/subscribe ({ endpoint }).
import type { PushSubscribeBody } from '@ezychat/shared';
import { api } from '../api/client';
import { reportClientError } from '@/lib/error-reporter';
import { i18n } from '@/i18n';
import { isDesktopNotifications, setDesktopNotifications } from './desktop-notifications';

export function isPushSupported(): boolean {
  return (
    isDesktopNotifications() ||
    (typeof window !== 'undefined' &&
      'Notification' in window &&
      'PushManager' in window &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator)
  );
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as Mac; detect via touch support.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) &&
      typeof navigator.maxTouchPoints === 'number' &&
      navigator.maxTouchPoints > 1)
  );
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

/** iOS only delivers web push to Home Screen web apps. */
export function needsInstallForPush(): boolean {
  return isIOS() && !isStandalone();
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function fetchVapidKey(): Promise<string> {
  const data = await api<unknown>('/push/vapid-key');
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const k = d.publicKey ?? d.key ?? d.vapidPublicKey;
    if (typeof k === 'string') return k;
  }
  throw new Error(i18n.t('inbox:push.errors.noKey'));
}

/** Current service worker registration (waits for it to become ready, max `timeoutMs`). */
export async function getSWRegistration(
  timeoutMs = 10_000,
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (isDesktopNotifications()) return null;
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function toBody(sub: PushSubscription): PushSubscribeBody {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
}

/** Ask permission, subscribe with the server's VAPID key and register the subscription. */
export async function subscribePush(): Promise<PushSubscription | null> {
  if (isDesktopNotifications()) {
    await setDesktopNotifications(true);
    return null;
  }
  let stage = 'permission';
  try {
    if (!isPushSupported()) throw new Error(i18n.t('inbox:push.errors.browserUnsupported'));
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(i18n.t('inbox:push.errors.permissionDenied'));
    stage = 'service-worker';
    const reg = await getSWRegistration();
    if (!reg) throw new Error(i18n.t('inbox:push.errors.serviceWorker'));
    stage = 'vapid-key';
    const vapid = await fetchVapidKey();
    stage = 'subscription';
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
    }
    stage = 'server-registration';
    await api('/push/subscribe', { method: 'POST', body: toBody(sub) });
    return sub;
  } catch (error) {
    reportClientError({
      kind: 'error',
      message: `Notification registration failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

export async function unsubscribePush(): Promise<void> {
  if (isDesktopNotifications()) {
    await setDesktopNotifications(false);
    return;
  }
  const sub = await getCurrentSubscription();
  if (!sub) return;
  try {
    await api('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  } finally {
    await sub.unsubscribe();
  }
}

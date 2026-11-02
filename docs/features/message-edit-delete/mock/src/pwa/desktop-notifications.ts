import { NotificationPayload } from '@ezychat/shared';
import { reportClientError } from '@/lib/error-reporter';
import { i18n } from '@/i18n';

interface DesktopNotifications {
  isSupported(): Promise<boolean>;
  show(notification: NotificationPayload): Promise<boolean>;
  clear(): Promise<void>;
}

declare global {
  interface Window {
    watiNotifications?: DesktopNotifications;
  }
}

const PREFERENCE = 'wati.desktopNotifications';
let enabled = false;

export function isDesktopNotifications(): boolean {
  return typeof window !== 'undefined' && !!window.watiNotifications;
}

export function desktopNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(PREFERENCE) === 'on';
  } catch {
    return enabled;
  }
}

export async function setDesktopNotifications(enabledNext: boolean): Promise<void> {
  const bridge = window.watiNotifications;
  if (!bridge) return;
  if (enabledNext && !(await bridge.isSupported())) {
    throw new Error(i18n.t('inbox:push.errors.desktopUnavailable'));
  }
  // Persist before showing "on" so reopening the menu reflects the same state.
  try {
    localStorage.setItem(PREFERENCE, enabledNext ? 'on' : 'off');
  } catch {
    /* in-memory fallback */
  }
  enabled = enabledNext;
  if (!enabledNext) await bridge.clear();
}

/** Only called for authenticated, targeted live events; history messages never enter this path. */
export async function showDesktopNotification(value: NotificationPayload): Promise<void> {
  if (!isDesktopNotifications() || !desktopNotificationsEnabled()) return;
  try {
    const notification = NotificationPayload.parse(value);
    await window.watiNotifications!.show(notification);
  } catch (error) {
    reportClientError({
      kind: 'error',
      message: 'Desktop notification delivery failed',
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

export function clearDesktopNotifications(): void {
  void window.watiNotifications?.clear().catch(() => {});
}

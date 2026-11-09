import type { ClientErrorBody } from '@ezychat/shared';

/**
 * Sends browser-side errors to POST /api/client-errors so they land in the server log as structured
 * `mod: "web"` entries (render crashes are otherwise invisible to the server). Fire-and-forget; never throws.
 * Duplicates (same kind + message + route) are suppressed for a minute to avoid flooding.
 */
const recent = new Map<string, number>();
const DEDUPE_MS = 60_000;

export function reportClientError(e: Omit<ClientErrorBody, 'route' | 'appVersion'> & { route?: string }): void {
  try {
    const route = e.route ?? window.location.pathname + window.location.search;
    const key = `${e.kind}|${e.message}|${route}`;
    const now = Date.now();
    if ((recent.get(key) ?? 0) > now - DEDUPE_MS) return;
    recent.set(key, now);
    const body: ClientErrorBody = {
      kind: e.kind,
      message: String(e.message).slice(0, 2000),
      stack: e.stack?.slice(0, 8000),
      componentStack: e.componentStack?.slice(0, 8000),
      route: route.slice(0, 500),
      appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
    };
    void fetch('/api/client-errors', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* reporting must never break the app */
  }
}

/** Global handlers for uncaught errors and unhandled promise rejections. Call once at startup. */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (ev) => {
    const err = ev.error as Error | undefined;
    reportClientError({ kind: 'error', message: err?.message ?? ev.message ?? 'Unknown error', stack: err?.stack });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as unknown;
    const err = r instanceof Error ? r : null;
    reportClientError({ kind: 'unhandledrejection', message: err?.message ?? String(r), stack: err?.stack });
  });
}

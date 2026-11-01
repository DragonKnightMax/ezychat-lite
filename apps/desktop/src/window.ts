// BrowserWindow factories: the main inbox window (remote http://127.0.0.1:<port>) and the
// local status/control window (file:// + preload IPC).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  shell,
  type NativeImage,
  type Session,
} from 'electron';
import type { Locale } from '@ezychat/shared';
import { t } from './i18n.js';
import { registerInboxNotifications } from './notifications.js';
import { externalLinkToOpen, inboxPermissionAllowed, isInboxUrl } from './window-security.js';
import { activeProduct } from './product.js';
import { registerContextMenu } from './context-menu.js';

const SAFE_PREFS = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
  webviewTag: false,
} as const;

function openExternalSafe(url: string): void {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
}

/**
 * Simple self-contained HTML page (data URL) used while the server starts or on errors.
 * `title`/`body` are already translated; `lang` is the desktop locale.
 */
export function messagePage(
  title: string,
  body: string,
  lang: Locale = 'en',
  opts: { spinner?: boolean } = {},
): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
    );
  const html = `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(activeProduct().productName)}</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}
@media (prefers-color-scheme:dark){body{background:#0b1120;color:#e2e8f0}}
.c{max-width:28rem;padding:24px;text-align:center}.s{width:36px;height:36px;margin:0 auto 16px;border:4px solid #05966933;border-top-color:#059669;border-radius:50%;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}h1{font-size:1.15rem;margin:0 0 8px}p{margin:0;opacity:.75;white-space:pre-wrap}
</style></head><body><div class="c">${opts.spinner === false ? '' : '<div class="s"></div>'}<h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Keeps `title` as the window title: the loaded page (web app / message page) sets its own. */
function pinTitle(win: BrowserWindow, title: string): void {
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.setTitle(title);
  });
}

/**
 * The web UI is a PWA: its service worker can keep serving JS from an older build after the app updates,
 * which then breaks against the new server. Clear the service worker + Cache Storage whenever the app
 * version changes (marker file in userData). Returns true when it cleared.
 */
export async function clearWebCacheOnVersionChange(
  ses: Session,
  version: string,
): Promise<boolean> {
  const marker = join(app.getPath('userData'), 'web-cache-version');
  let last = '';
  try {
    last = readFileSync(marker, 'utf8').trim();
  } catch {
    /* first run */
  }
  if (last === version) return false;
  await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  await ses.clearCache();
  try {
    writeFileSync(marker, version);
  } catch {
    /* non-fatal: we'll just clear again next start */
  }
  return true;
}

/** F12 / Ctrl+Shift+I: DevTools · Ctrl+R / F5: reload · Ctrl+Shift+R: reload bypassing the cache. */
function addDevShortcuts(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    } else if ((mod && input.shift && key === 'r') || (input.shift && input.key === 'F5')) {
      win.webContents.reloadIgnoringCache();
      e.preventDefault();
    } else if ((mod && key === 'r') || input.key === 'F5') {
      win.webContents.reload();
      e.preventDefault();
    }
  });
}

export function createMainWindow(o: {
  icon: NativeImage;
  baseUrl: () => string | null;
  title: string;
  preload: string;
  locale: Locale;
  /** Flags the inbox preload reads from process.argv (which privileged bridges to expose). */
  preloadArgs?: string[];
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    title: o.title,
    icon: o.icon,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1120',
    webPreferences: {
      ...SAFE_PREFS,
      preload: o.preload,
      backgroundThrottling: false,
      ...(o.preloadArgs?.length ? { additionalArguments: o.preloadArgs } : {}),
    },
  });
  registerInboxNotifications(win, o.baseUrl, o.icon);
  pinTitle(win, o.title);
  addDevShortcuts(win);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  registerContextMenu(win.webContents, {
    isInboxUrl: (url) => isInboxUrl(url, o.baseUrl()),
    locale: o.locale,
    writeText: (text) => clipboard.writeText(text),
    popup: (template) => Menu.buildFromTemplate(template).popup({ window: win }),
  });
  win.webContents.on('will-navigate', (e, url) => {
    const base = o.baseUrl();
    if (isInboxUrl(url, base)) return;
    e.preventDefault();
    openExternalSafe(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isInboxUrl(url, o.baseUrl())) event.preventDefault();
  });
  win.webContents.on('will-frame-navigate', (event) => {
    const base = o.baseUrl();
    if (isInboxUrl(event.url, base)) return;
    event.preventDefault();
    // Blocking here cancels will-navigate, so an external link clicked in the main frame (e.g. a
    // mailto: "Email to activate" button) is opened from here.
    const external = externalLinkToOpen(event.url, event.isMainFrame, base);
    if (external) void shell.openExternal(external);
  });
  // No inbox feature needs a webview, camera, location or screen capture; voice notes need the
  // microphone (audio only, see inboxPermissionAllowed).
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const session = win.webContents.session;
  session.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(
      !win.isDestroyed() &&
        wc === win.webContents &&
        inboxPermissionAllowed(
          permission,
          wc.getURL(),
          details.requestingUrl,
          details.isMainFrame,
          o.baseUrl(),
          'mediaTypes' in details ? (details.mediaTypes ?? []) : [],
        ),
    );
  });
  session.setPermissionCheckHandler(
    (wc, permission, requestingOrigin, details) =>
      !win.isDestroyed() &&
      wc === win.webContents &&
      inboxPermissionAllowed(
        permission,
        wc.getURL(),
        requestingOrigin,
        details.isMainFrame,
        o.baseUrl(),
        details.mediaType ? [details.mediaType] : [],
      ),
  );
  return win;
}

export function createStatusWindow(o: {
  icon: NativeImage;
  preload: string;
  html: string;
  title: string;
  locale: Locale;
}): BrowserWindow {
  const title = t(o.locale, 'window.statusTitle', { title: o.title });
  const win = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 360,
    minHeight: 420,
    title,
    icon: o.icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { ...SAFE_PREFS, preload: o.preload },
  });
  pinTitle(win, title);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(o.html);
  return win;
}

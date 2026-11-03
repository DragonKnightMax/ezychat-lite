// "Screenshot of this window" for Send feedback (`window.watiCapture`, inbox-preload.cts): a PNG of
// the inbox window that asks, nothing else. Same guards as the other inbox IPC (current registered
// window, its exact main frame, loopback inbox origin); no renderer arguments.
import type { BrowserWindow } from 'electron';
import { registerInboxIpc, type InboxWindow } from './inbox-ipc.js';

export const CAPTURE_CHANNEL = 'wati:capture-window';
/** Same as one feedback attachment: a larger picture is not returned. */
export const CAPTURE_MAX_BYTES = 10 * 1024 * 1024;

/** A PNG of the window's page, or null when it is gone, hidden or too large. */
export async function captureWindowPng(win: BrowserWindow | null): Promise<Uint8Array | null> {
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  const image = await win.webContents.capturePage();
  if (image.isEmpty()) return null;
  const png = image.toPNG();
  return png.length > CAPTURE_MAX_BYTES ? null : new Uint8Array(png);
}

export function registerCaptureIpc(windows: InboxWindow): { dispose(): void } {
  return registerInboxIpc(
    windows,
    { [CAPTURE_CHANNEL]: { arity: 0, run: () => captureWindowPng(windows.main()) } },
    'wati:capture-changed',
  );
}

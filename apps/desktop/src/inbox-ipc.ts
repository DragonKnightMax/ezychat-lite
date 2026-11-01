// Privileged IPC of the inbox window (Lite import, Enterprise installer): the same guards as the update
// IPC (update-ipc.ts). A request is served only from the current registered inbox window, its exact main
// frame, on the loopback inbox origin; the window getter keeps a destroyed or recreated window without
// authority. Admin-only is enforced by the web UI and the server routes.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

export interface InboxWindow {
  main(): BrowserWindow | null;
  baseUrl(): string;
}

/** True for an http://127.0.0.1:<port> page of the inbox origin (no credentials in the URL). */
export function sameInboxOrigin(value: string, base: string): boolean {
  try {
    const target = new URL(value);
    const origin = new URL(base);
    return (
      origin.protocol === 'http:' &&
      origin.hostname === '127.0.0.1' &&
      target.origin === origin.origin &&
      !target.username &&
      !target.password
    );
  } catch {
    return false;
  }
}

function trustedWindow(win: BrowserWindow | null, frameUrl: string, base: string): boolean {
  return !!win && !win.isDestroyed() && sameInboxOrigin(frameUrl, base);
}

export function trustedInboxEvent(event: IpcMainInvokeEvent, windows: InboxWindow): boolean {
  const win = windows.main();
  return (
    trustedWindow(win, event.senderFrame?.url ?? '', windows.baseUrl()) &&
    event.sender === win!.webContents &&
    event.senderFrame === win!.webContents.mainFrame
  );
}

/**
 * Registers invoke handlers behind the inbox guards. Each handler gets the renderer's arguments and
 * validates them itself (`arity` = how many it accepts; more is refused before it runs).
 */
export function registerInboxIpc(
  windows: InboxWindow,
  handlers: Record<string, { arity: number; run: (...args: unknown[]) => unknown }>,
  pushChannel: string,
): { broadcast(payload: unknown): void; dispose(): void } {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trustedInboxEvent(event, windows)) throw new Error('Forbidden request');
      if (args.length > handler.arity) throw new Error('Invalid request');
      return handler.run(...args);
    });
  }
  return {
    broadcast(payload) {
      const win = windows.main();
      if (trustedWindow(win, win?.webContents.mainFrame.url ?? '', windows.baseUrl()))
        win!.webContents.send(pushChannel, payload);
    },
    dispose() {
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    },
  };
}

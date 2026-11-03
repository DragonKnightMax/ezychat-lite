import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => mock.handlers.set(channel, handler),
    removeHandler: (channel: string) => mock.handlers.delete(channel),
  },
}));
import {
  CAPTURE_CHANNEL,
  CAPTURE_MAX_BYTES,
  captureWindowPng,
  registerCaptureIpc,
} from './capture-ipc.js';

function windowFixture(url: string, png = Buffer.from([0x89, 0x50, 0x4e, 0x47]), empty = false) {
  const mainFrame = { url };
  const capturePage = vi.fn(async () => ({ isEmpty: () => empty, toPNG: () => png }));
  const webContents = { mainFrame, send: vi.fn(), capturePage };
  const win = { webContents, isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true) };
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  return { win, event, capturePage };
}

beforeEach(() => mock.handlers.clear());

describe('window screenshot IPC', () => {
  it('returns a PNG of the inbox window that asks', async () => {
    const main = windowFixture('http://127.0.0.1:7420/admin/reports');
    const ipc = registerCaptureIpc({
      main: () => main.win as unknown as BrowserWindow,
      baseUrl: () => 'http://127.0.0.1:7420',
    });
    const out = (await mock.handlers.get(CAPTURE_CHANNEL)!(main.event)) as Uint8Array;
    expect([...out]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // another page, frame or argument gets nothing
    const other = windowFixture('https://evil.example/');
    expect(() => mock.handlers.get(CAPTURE_CHANNEL)!(other.event)).toThrow(/Forbidden/);
    expect(() => mock.handlers.get(CAPTURE_CHANNEL)!(main.event, 'x')).toThrow(/Invalid/);
    ipc.dispose();
    expect(mock.handlers.has(CAPTURE_CHANNEL)).toBe(false);
  });

  it('answers null for a missing, hidden, empty or too large picture', async () => {
    expect(await captureWindowPng(null)).toBeNull();
    const hidden = windowFixture('http://127.0.0.1:1/');
    hidden.win.isVisible.mockReturnValue(false);
    expect(await captureWindowPng(hidden.win as unknown as BrowserWindow)).toBeNull();
    const empty = windowFixture('http://127.0.0.1:1/', Buffer.alloc(1), true);
    expect(await captureWindowPng(empty.win as unknown as BrowserWindow)).toBeNull();
    const big = windowFixture('http://127.0.0.1:1/', Buffer.alloc(CAPTURE_MAX_BYTES + 1));
    expect(await captureWindowPng(big.win as unknown as BrowserWindow)).toBeNull();
  });
});

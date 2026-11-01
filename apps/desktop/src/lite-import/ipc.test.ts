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
import { sameInboxOrigin } from '../inbox-ipc.js';
import { LITE_IMPORT_CHANNELS, registerLiteImportIpc } from './ipc.js';
import { registerUpgradeIpc, UPGRADE_CHANNELS } from '../upgrade/ipc.js';

function windowFixture(url: string) {
  const mainFrame = { url };
  const webContents = { mainFrame, send: vi.fn() };
  const win = { webContents, isDestroyed: vi.fn(() => false) };
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  return { win, event, mainFrame };
}

const state = { phase: 'idle' } as never;

function fixture() {
  const main = windowFixture('http://127.0.0.1:7440/setup');
  let current: ReturnType<typeof windowFixture>['win'] | null = main.win;
  const controller = {
    getState: vi.fn(() => state),
    scan: vi.fn(async () => state),
    start: vi.fn(async () => state),
    reset: vi.fn(async () => state),
    saveSupportFile: vi.fn(async () => true),
  };
  const windows = {
    main: () => current as unknown as BrowserWindow,
    baseUrl: () => 'http://127.0.0.1:7440',
  };
  const ipc = registerLiteImportIpc(controller, windows);
  const invoke = (channel: string, event = main.event, ...args: unknown[]) =>
    mock.handlers.get(channel)!(event, ...args);
  return {
    main,
    controller,
    ipc,
    invoke,
    windows,
    setMain: (w: typeof current) => (current = w),
  };
}

beforeEach(() => mock.handlers.clear());

describe('Lite import IPC', () => {
  it('serves the current inbox window’s main frame', async () => {
    const f = fixture();
    expect(f.invoke(LITE_IMPORT_CHANNELS.state)).toBe(state);
    await f.invoke(LITE_IMPORT_CHANNELS.scan);
    await f.invoke(LITE_IMPORT_CHANNELS.reset);
    expect(await f.invoke(LITE_IMPORT_CHANNELS.support)).toBe(true);
    expect(f.controller.scan).toHaveBeenCalledOnce();
    expect(f.controller.reset).toHaveBeenCalledOnce();
  });

  it('validates the plan and passes only the clean copy', async () => {
    const f = fixture();
    const choice = { liteUserId: 1, action: 'add', matchUserId: null, role: 'agent' };
    await f.invoke(LITE_IMPORT_CHANNELS.start, f.main.event, { team: [{ ...choice, x: 1 }] });
    expect(f.controller.start).toHaveBeenCalledWith({ team: [choice] });
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.start, f.main.event, { team: 'all' })).toThrow(
      /Invalid import plan/,
    );
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.start, f.main.event, {}, 'extra')).toThrow(
      /Invalid request/,
    );
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.scan, f.main.event, '/path')).toThrow(
      /Invalid request/,
    );
  });

  it('refuses other frames, other origins, replaced and destroyed windows', () => {
    const f = fixture();
    const sub = { ...f.main.event, senderFrame: { url: f.main.mainFrame.url } } as never;
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.scan, sub)).toThrow(/Forbidden/);
    const remote = windowFixture('https://inbox.example.com/setup');
    f.setMain(remote.win);
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.scan, remote.event)).toThrow(/Forbidden/);
    f.setMain(windowFixture(f.main.mainFrame.url).win);
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.scan)).toThrow(/Forbidden/);
    f.setMain(f.main.win);
    f.main.win.isDestroyed.mockReturnValue(true);
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.scan)).toThrow(/Forbidden/);
    f.setMain(null);
    expect(() => f.invoke(LITE_IMPORT_CHANNELS.scan)).toThrow(/Forbidden/);
    expect(f.controller.scan).not.toHaveBeenCalled();
  });

  it('pushes state only to a trusted inbox window and disposes its handlers', () => {
    const f = fixture();
    f.ipc.broadcast(state);
    expect(f.main.win.webContents.send).toHaveBeenCalledWith(LITE_IMPORT_CHANNELS.changed, state);
    f.main.mainFrame.url = 'data:text/html,starting';
    f.ipc.broadcast(state);
    expect(f.main.win.webContents.send).toHaveBeenCalledOnce();
    f.ipc.dispose();
    expect(mock.handlers.size).toBe(0);
  });
});

describe('upgrade IPC', () => {
  it('takes no renderer arguments at all', async () => {
    const main = windowFixture('http://127.0.0.1:7420/');
    const upgrade = {
      getState: vi.fn(() => state),
      install: vi.fn(async () => state),
      cancel: vi.fn(() => state),
    };
    const ipc = registerUpgradeIpc(upgrade, {
      main: () => main.win as unknown as BrowserWindow,
      baseUrl: () => 'http://127.0.0.1:7420',
    });
    const invoke = (channel: string, ...args: unknown[]) =>
      mock.handlers.get(channel)!(main.event, ...args);
    expect(invoke(UPGRADE_CHANNELS.state)).toBe(state);
    await invoke(UPGRADE_CHANNELS.install);
    invoke(UPGRADE_CHANNELS.cancel);
    expect(upgrade.install).toHaveBeenCalledOnce();
    expect(upgrade.cancel).toHaveBeenCalledOnce();
    expect(() => invoke(UPGRADE_CHANNELS.install, 'https://evil.example/x.exe')).toThrow(
      /Invalid request/,
    );
    ipc.broadcast(state);
    expect(main.win.webContents.send).toHaveBeenCalledWith(UPGRADE_CHANNELS.changed, state);
    ipc.dispose();
  });
});

describe('sameInboxOrigin', () => {
  it('accepts only the loopback http inbox origin without credentials', () => {
    const base = 'http://127.0.0.1:7440';
    expect(sameInboxOrigin('http://127.0.0.1:7440/admin', base)).toBe(true);
    expect(sameInboxOrigin('http://127.0.0.1:7441/admin', base)).toBe(false);
    expect(sameInboxOrigin('http://u:p@127.0.0.1:7440/', base)).toBe(false);
    expect(sameInboxOrigin('http://localhost:7440/', 'http://localhost:7440')).toBe(false);
    expect(sameInboxOrigin('not a url', base)).toBe(false);
  });
});

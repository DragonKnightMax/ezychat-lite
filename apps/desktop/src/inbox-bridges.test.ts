import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  exposed: new Map<string, Record<string, (...args: unknown[]) => unknown>>(),
  invoke: vi.fn(async (..._args: unknown[]) => 'ok'),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, (...args: unknown[]) => unknown>) =>
      mock.exposed.set(name, api),
  },
  ipcRenderer: { invoke: mock.invoke, on: mock.on, removeListener: mock.removeListener },
}));

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  mock.exposed.clear();
  mock.invoke.mockClear();
  vi.resetModules();
});

async function loadPreload(flags: string[]) {
  process.argv = [...argv, ...flags];
  await import('./inbox-preload.cjs');
  return mock.exposed;
}

describe('inbox preload bridges', () => {
  it('exposes neither the Lite import nor the upgrade bridge without their flags', async () => {
    const exposed = await loadPreload([]);
    expect([...exposed.keys()].sort()).toEqual(['watiCapture', 'watiNotifications', 'watiUpdates']);
    await exposed.get('watiCapture')!.captureWindow!();
    expect(mock.invoke.mock.calls).toEqual([['wati:capture-window']]);
  });

  it('exposes watiLiteImport with --wati-lite-import, on fixed channels', async () => {
    const api = (await loadPreload(['--wati-lite-import'])).get('watiLiteImport')!;
    expect(mock.exposed.has('watiUpgrade')).toBe(false);
    await api.getState!();
    await api.scan!();
    await api.unlock!();
    await api.start!({ team: [] });
    await api.reset!();
    await api.saveSupportFile!();
    expect(mock.invoke.mock.calls).toEqual([
      ['wati:lite-import-state'],
      ['wati:lite-import-scan'],
      ['wati:lite-import-unlock'],
      ['wati:lite-import-start', { team: [] }],
      ['wati:lite-import-reset'],
      ['wati:lite-import-support'],
    ]);
    const callback = vi.fn();
    const off = api.onChanged!(callback) as () => void;
    const listener = mock.on.mock.calls.at(-1)![1] as (e: unknown, s: unknown) => void;
    expect(mock.on.mock.calls.at(-1)![0]).toBe('wati:lite-import-changed');
    listener(null, { phase: 'done' });
    expect(callback).toHaveBeenCalledWith({ phase: 'done' });
    off();
    expect(mock.removeListener).toHaveBeenCalledWith('wati:lite-import-changed', listener);
  });

  it('exposes watiUpgrade with --wati-upgrade, with no arguments to the main process', async () => {
    const api = (await loadPreload(['--wati-upgrade'])).get('watiUpgrade')!;
    await api.getState!();
    await api.install!();
    await api.cancel!();
    expect(mock.invoke.mock.calls).toEqual([
      ['wati:upgrade-state'],
      ['wati:upgrade-install'],
      ['wati:upgrade-cancel'],
    ]);
    const callback = vi.fn();
    const off = api.onChanged!(callback) as () => void;
    const listener = mock.on.mock.calls.at(-1)![1] as (e: unknown, s: unknown) => void;
    listener(null, { status: 'started' });
    expect(callback).toHaveBeenCalledWith({ status: 'started' });
    off();
    expect(mock.removeListener).toHaveBeenCalledWith('wati:upgrade-changed', listener);
  });

  it('uses the same channel names as the main process', async () => {
    const { LITE_IMPORT_CHANNELS, LITE_IMPORT_PRELOAD_ARG } = await import('./lite-import/ipc.js');
    const { UPGRADE_CHANNELS, UPGRADE_PRELOAD_ARG } = await import('./upgrade/ipc.js');
    expect(LITE_IMPORT_PRELOAD_ARG).toBe('--wati-lite-import');
    expect(UPGRADE_PRELOAD_ARG).toBe('--wati-upgrade');
    expect(Object.values(LITE_IMPORT_CHANNELS)).toEqual([
      'wati:lite-import-state',
      'wati:lite-import-scan',
      'wati:lite-import-unlock',
      'wati:lite-import-start',
      'wati:lite-import-reset',
      'wati:lite-import-support',
      'wati:lite-import-changed',
    ]);
    expect(Object.values(UPGRADE_CHANNELS)).toEqual([
      'wati:upgrade-state',
      'wati:upgrade-install',
      'wati:upgrade-cancel',
      'wati:upgrade-changed',
    ]);
  });
});

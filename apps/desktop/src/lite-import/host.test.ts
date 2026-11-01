import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LITE_PRODUCT } from '../product.js';
import type { ServerCli } from './cli.js';
import { ElevationCancelledError } from '../service/index.js';
import {
  liteImportDeps,
  liteServiceFolders,
  saveSupportFile,
  type LiteImportHostOptions,
} from './host.js';

const cli: ServerCli = { run: vi.fn(async () => ({ code: 0, lines: [] })) };

function options(over: Partial<LiteImportHostOptions> = {}) {
  const files: Record<string, string> = {};
  const o: LiteImportHostOptions = {
    adoptFrom: LITE_PRODUCT,
    platform: 'darwin',
    env: {},
    appData: '/Users/a/Library/Application Support',
    dataDir: '/ent/data',
    cli,
    liteService: {
      status: vi.fn(async () => 'not-installed' as const),
      uninstall: vi.fn(async () => {}),
    },
    probe: vi.fn(async (port: number) => port === 7431),
    serverUrl: () => 'http://127.0.0.1:7440',
    fetch: vi.fn(async () => Response.json({ needsSetup: false })),
    fs: {
      mtimeMs: (p) =>
        p === '/Users/a/Library/Application Support/WA Team Inbox/data/app.db' ? 1 : null,
      readText: (p) =>
        p === '/Users/a/Library/Application Support/WA Team Inbox/desktop.json'
          ? '{"port":7431}'
          : null,
      exists: (p) => p === join('/ent/data', 'app.db'),
      freeBytes: vi.fn(async () => 5),
      makeTempDir: vi.fn(async () => '/work/x'),
      writePrivate: vi.fn(async (file: string, text: string) => {
        files[file] = text;
      }),
      removeDir: vi.fn(async () => {}),
    },
    ownServer: {
      stop: vi.fn(async () => {}),
      restart: vi.fn(async () => true),
      takeOverPort: vi.fn(),
    },
    ...over,
  };
  return { o, files };
}

describe('liteImportDeps', () => {
  it('finds Lite’s folder and port from the adopted product', async () => {
    const { o } = options();
    const deps = liteImportDeps(o);
    expect(deps.enabled).toBe(true);
    expect(await deps.findLite()).toEqual({
      dataDir: '/Users/a/Library/Application Support/WA Team Inbox/data',
      kind: 'user',
      profile: '/Users/a/Library/Application Support/WA Team Inbox',
      readable: true,
    });
    expect(deps.litePorts()).toEqual([7431, 7420]);
    expect(await deps.liteAnswers(7431)).toBe(true);
    expect(o.probe).toHaveBeenCalledWith(7431, LITE_PRODUCT);
    expect(await deps.liteServiceState()).toBe('not-installed');
    expect(await deps.freeBytes('/ent/data')).toBe(5);
  });

  it('is off without adoptFrom, and without a service manager the service is not installed', async () => {
    const deps = liteImportDeps(options({ adoptFrom: null, liteService: null }).o);
    expect(deps.enabled).toBe(false);
    expect(await deps.findLite()).toBeNull();
    expect(deps.litePorts()).toEqual([]);
    expect(await deps.liteAnswers(7420)).toBe(false);
    expect(await deps.liteServiceState()).toBe('not-installed');
  });

  it('prefers the machine folder while Lite’s service is installed', async () => {
    const { o } = options({
      liteService: { status: async () => 'stopped' },
    });
    o.fs.mtimeMs = () => 1;
    expect((await liteImportDeps(o).findLite())?.kind).toBe('machine');
    o.liteService = {
      status: async () => {
        throw new Error('sc failed');
      },
    };
    expect((await liteImportDeps(o).findLite())?.kind).toBe('user');
  });

  it('has data only with an app.db and a finished setup', async () => {
    expect(await liteImportDeps(options().o).ownHasData()).toBe(true);
    const fresh = options({ fetch: vi.fn(async () => Response.json({ needsSetup: true })) }).o;
    expect(await liteImportDeps(fresh).ownHasData()).toBe(false);
    expect(fresh.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7440/api/setup/status',
      expect.any(Object),
    );
    const down = options({ fetch: vi.fn(async () => Promise.reject(new Error('down'))) }).o;
    expect(await liteImportDeps(down).ownHasData()).toBe(true);
    const empty = options().o;
    empty.fs.exists = () => false;
    expect(await liteImportDeps(empty).ownHasData()).toBe(false);
  });

  it('writes the plan privately and removes it', async () => {
    const { o, files } = options();
    const written = await liteImportDeps(o).writePlan({ team: [] });
    expect(written.file).toBe(join('/work/x', 'plan.json'));
    expect(files[join('/work/x', 'plan.json')]).toBe('{"team":[]}');
    await written.dispose();
    expect(o.fs.removeDir).toHaveBeenCalledWith('/work/x');
  });

  it('restarts only a server it stopped, and passes the port takeover through', async () => {
    const { o } = options();
    const deps = liteImportDeps(o);
    expect(await deps.startOwnServer()).toBe(true);
    expect(o.ownServer.restart).not.toHaveBeenCalled();
    await deps.stopOwnServer();
    expect(await deps.startOwnServer()).toBe(true);
    expect(o.ownServer.restart).toHaveBeenCalledOnce();
    await deps.startOwnServer();
    expect(o.ownServer.restart).toHaveBeenCalledOnce();
    deps.takeOverPort(7431);
    expect(o.ownServer.takeOverPort).toHaveBeenCalledWith(7431);

    const refusing = options({
      ownServer: {
        stop: async () => {
          throw new Error('service mode');
        },
        restart: vi.fn(async () => true),
        takeOverPort: vi.fn(),
      },
    }).o;
    const d2 = liteImportDeps(refusing);
    await expect(d2.stopOwnServer()).rejects.toThrow('service mode');
    await d2.startOwnServer();
    expect(refusing.ownServer.restart).not.toHaveBeenCalled();
  });
});

describe('unlockLite and the Lite service folders', () => {
  const win = {
    adoptFrom: LITE_PRODUCT,
    platform: 'win32' as const,
    env: { ProgramData: 'C:\\ProgramData' },
    appData: 'C:\\Users\\a\\AppData\\Roaming',
    dataDir: 'C:\\Users\\a\\AppData\\Roaming\\EzyChat Enterprise\\data',
  };
  const liteUserDb = 'C:\\Users\\a\\AppData\\Roaming\\WA Team Inbox\\data\\app.db';

  it('moves between Lite’s own folders, never into ours', () => {
    const folders = liteServiceFolders(LITE_PRODUCT, win);
    expect(folders).toEqual({
      userDataDir: 'C:\\Users\\a\\AppData\\Roaming\\WA Team Inbox\\data',
      machineDataDir: 'C:\\ProgramData\\wa-team-inbox',
    });
    expect(folders.userDataDir).not.toBe(win.dataDir);
  });

  it('runs Lite’s own Remove service: done, or cancelled when the prompt is refused', async () => {
    const { o } = options(win);
    o.fs.exists = () => false;
    expect(await liteImportDeps(o).unlockLite()).toBe('done');
    expect(o.liteService?.uninstall).toHaveBeenCalledTimes(1);

    o.liteService = {
      status: async () => 'running',
      uninstall: vi.fn(async () => {
        throw new ElevationCancelledError();
      }),
    };
    expect(await liteImportDeps(o).unlockLite()).toBe('cancelled');
  });

  it('asks nothing when Lite’s user folder already holds an app.db, and passes other errors on', async () => {
    const { o } = options(win);
    o.fs.exists = (p) => p === liteUserDb;
    expect(await liteImportDeps(o).unlockLite()).toBe('target_has_data');
    expect(o.liteService?.uninstall).not.toHaveBeenCalled();

    o.fs.exists = () => false;
    o.liteService = {
      status: async () => 'running',
      uninstall: async () => {
        throw new Error('service uninstall failed');
      },
    };
    await expect(liteImportDeps(o).unlockLite()).rejects.toThrow('service uninstall failed');
    await expect(
      liteImportDeps(options({ ...win, liteService: null }).o).unlockLite(),
    ).rejects.toThrow('No EzyChat Lite service');
  });
});

describe('saveSupportFile', () => {
  it('writes the report into the folder and reveals it', () => {
    const write = vi.fn();
    const reveal = vi.fn();
    const ok = saveSupportFile(
      { supportReport: (meta) => `report ${meta.version}` },
      {
        dir: '/dl',
        now: new Date('2026-11-01T10:20:30.400Z'),
        meta: { version: '1' },
        write,
        reveal,
      },
    );
    expect(ok).toBe(true);
    const file = join('/dl', 'ezychat-import-support-2026-11-01T10-20-30-400Z.txt');
    expect(write).toHaveBeenCalledWith(file, 'report 1');
    expect(reveal).toHaveBeenCalledWith(file);
  });

  it('answers false when it cannot write', () => {
    const log = vi.fn();
    const ok = saveSupportFile(
      { supportReport: () => '' },
      {
        dir: '/dl',
        now: new Date(0),
        meta: {},
        write: () => {
          throw new Error('EACCES');
        },
        reveal: vi.fn(),
        log,
      },
    );
    expect(ok).toBe(false);
    expect(log.mock.calls[0]![0]).toContain('EACCES');
  });
});

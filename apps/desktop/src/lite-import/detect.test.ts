import { describe, expect, it } from 'vitest';
import { LITE_PRODUCT, defineProduct } from '../product.js';
import { chooseLiteFolder, liteFolders, litePorts, mtimeOrDenied } from './detect.js';

describe('liteFolders', () => {
  it('Windows: ProgramData and the roaming profile, from the product identity', () => {
    expect(
      liteFolders(LITE_PRODUCT, {
        platform: 'win32',
        env: { ProgramData: 'D:\\ProgramData' },
        appData: 'C:\\Users\\a\\AppData\\Roaming',
      }),
    ).toEqual({
      machine: 'D:\\ProgramData\\wa-team-inbox',
      user: 'C:\\Users\\a\\AppData\\Roaming\\WA Team Inbox\\data',
      profile: 'C:\\Users\\a\\AppData\\Roaming\\WA Team Inbox',
    });
  });

  it('macOS: /Library/Application Support and the user profile', () => {
    expect(
      liteFolders(LITE_PRODUCT, {
        platform: 'darwin',
        env: {},
        appData: '/Users/a/Library/Application Support',
      }),
    ).toEqual({
      machine: '/Library/Application Support/wa-team-inbox',
      user: '/Users/a/Library/Application Support/WA Team Inbox/data',
      profile: '/Users/a/Library/Application Support/WA Team Inbox',
    });
  });
});

const folders = liteFolders(LITE_PRODUCT, {
  platform: 'darwin',
  env: {},
  appData: '/Users/a/Library/Application Support',
});
const machineDb = '/Library/Application Support/wa-team-inbox/app.db';
const userDb = '/Users/a/Library/Application Support/WA Team Inbox/data/app.db';

function choose(dbs: Record<string, number | 'denied'>, serviceInstalled = false) {
  return chooseLiteFolder(folders, {
    platform: 'darwin',
    serviceInstalled,
    fs: { mtimeMs: (p) => dbs[p] ?? null },
  });
}

describe('chooseLiteFolder', () => {
  it('finds nothing without an app.db', () => {
    expect(choose({})).toBeNull();
  });

  it('takes the only folder with an app.db', () => {
    expect(choose({ [userDb]: 1 })).toMatchObject({ kind: 'user', dataDir: folders.user });
    expect(choose({ [machineDb]: 1 })).toMatchObject({ kind: 'machine', dataDir: folders.machine });
  });

  it('prefers the machine folder while Lite’s service is installed, else the newer app.db', () => {
    expect(choose({ [userDb]: 5, [machineDb]: 1 }, true)?.kind).toBe('machine');
    expect(choose({ [userDb]: 5, [machineDb]: 1 })?.kind).toBe('user');
    expect(choose({ [userDb]: 1, [machineDb]: 5 })).toEqual({
      kind: 'machine',
      dataDir: folders.machine,
      profile: folders.profile,
      readable: true,
    });
  });

  it('counts a locked service folder as found but not readable, never as missing', () => {
    expect(choose({ [machineDb]: 'denied' }, true)).toEqual({
      kind: 'machine',
      dataDir: folders.machine,
      profile: folders.profile,
      readable: false,
    });
    // The service runs on the machine folder, even when an older user folder is still there.
    expect(choose({ [machineDb]: 'denied', [userDb]: 9 }, true)).toMatchObject({
      kind: 'machine',
      readable: false,
    });
    // No service but still locked: a "Remove service" that stopped halfway. The user folder may lack
    // secret.key or wa-auth/, so it is never imported; the locked folder stays the one to free.
    expect(choose({ [machineDb]: 'denied', [userDb]: 9 })).toMatchObject({
      kind: 'machine',
      readable: false,
    });
    expect(choose({ [machineDb]: 5, [userDb]: 'denied' })).toMatchObject({
      kind: 'machine',
      readable: true,
    });
  });
});

describe('mtimeOrDenied', () => {
  const failing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it('returns the mtime, null for a missing file and denied for EPERM / EACCES', () => {
    expect(mtimeOrDenied(() => ({ mtimeMs: 42 }), '/x')).toBe(42);
    expect(mtimeOrDenied(failing('ENOENT'), '/x')).toBeNull();
    expect(mtimeOrDenied(failing('EPERM'), '/x')).toBe('denied');
    expect(mtimeOrDenied(failing('EACCES'), '/x')).toBe('denied');
  });
});

describe('litePorts', () => {
  const winFolders = liteFolders(LITE_PRODUCT, {
    platform: 'win32',
    env: {},
    appData: 'C:\\Users\\a\\AppData\\Roaming',
  });
  const files = (map: Record<string, string>) => (p: string) => map[p] ?? null;

  it('reads desktop.json, then the port files, then the default, without duplicates', () => {
    expect(
      litePorts(LITE_PRODUCT, winFolders, {
        platform: 'win32',
        env: {},
        readFile: files({
          'C:\\Users\\a\\AppData\\Roaming\\WA Team Inbox\\desktop.json': '{"port":7431}',
          'C:\\Users\\a\\AppData\\Roaming\\WA Team Inbox\\server-port.json': '{"port":7432}',
          'C:\\ProgramData\\wa-team-inbox\\run\\port.json': '{"port":7431}',
        }),
      }),
    ).toEqual([7431, 7432, 7420]);
  });

  it('falls back to the product default (Lite 7420, else its defaultPort)', () => {
    const opts = { platform: 'win32' as const, env: {}, readFile: files({}) };
    expect(litePorts(LITE_PRODUCT, winFolders, opts)).toEqual([7420]);
    const other = defineProduct({
      ...LITE_PRODUCT,
      upgradeInstallerFeed: null,
      defaultPort: 7500,
    });
    expect(litePorts(other, winFolders, opts)).toEqual([7500]);
    expect(
      litePorts(LITE_PRODUCT, winFolders, {
        ...opts,
        readFile: files({
          'C:\\Users\\a\\AppData\\Roaming\\WA Team Inbox\\desktop.json': 'not json',
        }),
      }),
    ).toEqual([7420]);
  });
});

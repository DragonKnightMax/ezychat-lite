import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import {
  applyLaunchdExitCodes,
  applyRuntimeVersion,
  isShutdownMessage,
  launchdExitCode,
  pickFreePort,
  PORT_TRIES,
  portIsFree,
  prepareServerArgs,
  readSettingFromDb,
  serverBindHost,
  SHUTDOWN_MESSAGE,
  startArgs,
  useFreePort,
  withPort,
} from './server-host.cjs';

const base = ['--data', 'D:\\data', '--port', '7420', '--mode', 'standalone'];

it('reports the updated runtime rather than the old version saved in service configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wati-runtime-version-'));
  try {
    mkdirSync(join(dir, 'server'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.14' }));
    const env = { WATI_VERSION: '0.1.13', WATI_PORT_FILE: 'unchanged' };
    applyRuntimeVersion(join(dir, 'server', 'server.cjs'), env);
    expect(env).toEqual({ WATI_VERSION: '0.1.14', WATI_PORT_FILE: 'unchanged' });
    rmSync(join(dir, 'package.json'));
    env.WATI_VERSION = 'development';
    applyRuntimeVersion(join(dir, 'server', 'server.cjs'), env);
    expect(env.WATI_VERSION).toBe('development');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('prepareServerArgs (persisted port setting wins over --port)', () => {
  it('replaces --port with the persisted setting', () => {
    const r = prepareServerArgs(base, () => 8123);
    expect(r.port).toBe(8123);
    expect(r.args).toEqual(['--data', 'D:\\data', '--port', '8123', '--mode', 'standalone']);
  });
  it('reads the setting from the --data dir', () => {
    let seen = '';
    prepareServerArgs(base, (d) => {
      seen = d;
      return null;
    });
    expect(seen).toBe('D:\\data');
  });
  it('keeps --port when no setting exists', () => {
    const r = prepareServerArgs(base, () => null);
    expect(r.port).toBe(7420);
    expect(r.args).toEqual(base);
  });
  it('keeps --port when reading the db fails (fresh install, no app.db)', () => {
    const r = prepareServerArgs(base, () => {
      throw new Error('SQLITE_CANTOPEN');
    });
    expect(r.port).toBe(7420);
  });
  it('ignores invalid settings', () => {
    expect(prepareServerArgs(base, () => 70000).port).toBe(7420);
  });
  it('adds --port when absent', () => {
    const r = prepareServerArgs(['--data', 'x'], () => 9000);
    expect(r.args).toEqual(['--data', 'x', '--port', '9000']);
  });
  it('leaves --reset-admin runs untouched', () => {
    const args = ['--data', 'x', '--reset-admin'];
    expect(prepareServerArgs(args, () => 9000)).toEqual({ args, port: null });
  });
});

describe('pickFreePort (a taken port moves the server to the next free one)', () => {
  it('keeps a free port', async () => {
    expect(await pickFreePort(7440, '127.0.0.1', async () => true)).toBe(7440);
  });
  it('moves to the first free port after a taken one', async () => {
    const taken = new Set([7440, 7441]);
    const tried: number[] = [];
    const port = await pickFreePort(7440, '127.0.0.1', async (p) => {
      tried.push(p);
      return !taken.has(p);
    });
    expect(port).toBe(7442);
    expect(tried).toEqual([7440, 7441, 7442]);
  });
  it(`gives up after ${PORT_TRIES} ports and keeps the chosen one, so the server reports the error`, async () => {
    let calls = 0;
    const port = await pickFreePort(7440, '127.0.0.1', async () => {
      calls++;
      return false;
    });
    expect(port).toBe(7440);
    expect(calls).toBe(PORT_TRIES);
  });
  it('never tries a port above 65535', async () => {
    const tried: number[] = [];
    await pickFreePort(65534, '127.0.0.1', async (p) => {
      tried.push(p);
      return false;
    });
    expect(tried).toEqual([65534, 65535]);
  });
});

describe('portIsFree', () => {
  it('sees a port held by another listener as taken, and free again after it closes', async () => {
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));
    const { port } = holder.address() as AddressInfo;
    try {
      expect(await portIsFree(port)).toBe(false);
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
    expect(await portIsFree(port)).toBe(true);
  });
  it('also checks loopback for a LAN server', async () => {
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));
    const { port } = holder.address() as AddressInfo;
    try {
      expect(await portIsFree(port, '0.0.0.0')).toBe(false);
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  });
});

describe('readSettingFromDb', () => {
  it('reads JSON settings read-only, undefined when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wati-host-settings-'));
    try {
      const db = new Database(join(dir, 'app.db'));
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO settings VALUES (?, ?), (?, ?)').run(
        'port',
        '7450',
        'lan_enabled',
        'true',
      );
      db.close();
      expect(readSettingFromDb(dir, 'port')).toBe(7450);
      expect(readSettingFromDb(dir, 'lan_enabled')).toBe(true);
      expect(readSettingFromDb(dir, 'history_days')).toBeUndefined();
      expect(() => readSettingFromDb(join(dir, 'missing'), 'port')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('serverBindHost (test the port only where the server listens)', () => {
  const data = ['--data', 'D:\\data', '--port', '7440'];
  it('is loopback by default, so no test listen on every interface (no Windows Firewall prompt)', () => {
    expect(serverBindHost(data, () => false)).toBe('127.0.0.1');
  });
  it('is 0.0.0.0 with LAN access on', () => {
    expect(serverBindHost(data, () => true)).toBe('0.0.0.0');
  });
  it('follows --host, and falls back to loopback when the setting cannot be read', () => {
    expect(serverBindHost([...data, '--host', '192.168.1.5'], () => false)).toBe('192.168.1.5');
    expect(
      serverBindHost(data, () => {
        throw new Error('no app.db');
      }),
    ).toBe('127.0.0.1');
    expect(serverBindHost(['--port', '7440'], () => true)).toBe('127.0.0.1');
  });
});

describe('useFreePort', () => {
  it('moves the server args to the free port and says so', async () => {
    const r = await useFreePort({ args: [...base], port: 7420 }, async () => 7423);
    expect(r).toEqual({
      args: ['--data', 'D:\\data', '--port', '7423', '--mode', 'standalone'],
      port: 7423,
      moved: 'port 7420 is in use; using port 7423',
    });
  });
  it('changes nothing when the port is free or unknown (--reset-admin)', async () => {
    const pick = async (p: number) => p;
    expect(await useFreePort({ args: [...base], port: 7420 }, pick)).toEqual({
      args: base,
      port: 7420,
      moved: null,
    });
    let called = false;
    const none = await useFreePort({ args: ['--reset-admin'], port: null }, async (p) => {
      called = true;
      return p;
    });
    expect(none).toEqual({ args: ['--reset-admin'], port: null, moved: null });
    expect(called).toBe(false);
  });
});

describe('startArgs', () => {
  it('applies the saved setting, then moves a taken port on loopback and logs it once', async () => {
    const lines: string[] = [];
    const hosts: string[] = [];
    const r = await startArgs(
      base,
      (_d, key) => (key === 'port' ? 7440 : undefined),
      async (_p, host) => {
        hosts.push(host);
        return 7441;
      },
      (l) => lines.push(l),
    );
    expect(r).toEqual({
      args: ['--data', 'D:\\data', '--port', '7441', '--mode', 'standalone'],
      port: 7441,
    });
    expect(hosts).toEqual(['127.0.0.1']);
    expect(lines).toEqual(['server-host: port 7440 is in use; using port 7441']);
  });
  it('tests every interface only with LAN access on, and logs nothing when the port is free', async () => {
    const lines: string[] = [];
    const hosts: string[] = [];
    const r = await startArgs(
      base,
      (_d, key) => (key === 'lan_enabled' ? true : 'not a port'),
      async (p, host) => {
        hosts.push(host);
        return p;
      },
      (l) => lines.push(l),
    );
    expect(r).toEqual({ args: base, port: 7420 });
    expect(hosts).toEqual(['0.0.0.0']);
    expect(lines).toEqual([]);
  });
});

describe('withPort', () => {
  it('replaces --port or adds it', () => {
    expect(withPort(base, 7441)).toEqual([
      '--data',
      'D:\\data',
      '--port',
      '7441',
      '--mode',
      'standalone',
    ]);
    expect(withPort(['--data', 'x'], 7441)).toEqual(['--data', 'x', '--port', '7441']);
  });
});

describe('isShutdownMessage', () => {
  it('accepts the raw string (node IPC) and a MessageEvent-like object (utilityProcess)', () => {
    expect(isShutdownMessage(SHUTDOWN_MESSAGE)).toBe(true);
    expect(isShutdownMessage({ data: SHUTDOWN_MESSAGE })).toBe(true);
    expect(isShutdownMessage('other')).toBe(false);
    expect(isShutdownMessage(null)).toBe(false);
  });
});

describe('launchdExitCode', () => {
  it('reports exits a restart cannot fix as success, so launchd does not restart them forever', () => {
    // 2 bad arguments, 3 data folder locked, 4 data folder moved to Enterprise
    for (const code of [2, 3, 4]) expect(launchdExitCode(code)).toBe(0);
  });
  it('keeps crashes and clean exits as they are', () => {
    for (const code of [0, 1, 5, 137]) expect(launchdExitCode(code)).toBe(code);
    expect(launchdExitCode(undefined)).toBeUndefined();
  });
});

describe('applyLaunchdExitCodes', () => {
  const fake = () => {
    const seen: (number | undefined)[] = [];
    const proc = {
      exit: ((code?: number) => seen.push(code)) as unknown as (code?: number) => never,
    };
    return { proc, seen };
  };
  it('under launchd turns a locked data folder into a clean exit', () => {
    const { proc, seen } = fake();
    applyLaunchdExitCodes(proc, { WATI_SERVICE_MANAGER: 'launchd' });
    proc.exit(3);
    proc.exit(1);
    expect(seen).toEqual([0, 1]);
  });
  it('leaves the exit codes alone elsewhere', () => {
    const { proc, seen } = fake();
    applyLaunchdExitCodes(proc, {});
    proc.exit(3);
    expect(seen).toEqual([3]);
  });
});

describe('startArgs under launchd', () => {
  it('applies the launchd exit codes before the server starts', async () => {
    const seen: (number | undefined)[] = [];
    const proc = {
      exit: ((code?: number) => seen.push(code)) as unknown as (code?: number) => never,
    };
    await startArgs(
      ['--data', '/nowhere', '--port', '7420'],
      () => undefined,
      async (p) => p,
      () => {},
      proc,
      {
        WATI_SERVICE_MANAGER: 'launchd',
      },
    );
    proc.exit(3);
    expect(seen).toEqual([0]);
  });
});

// Thin launcher the desktop uses to run the bundled server (standalone and OS service).
// argv: <server entry> <server args...>. It
//  1. applies the persisted `port` setting (Admin > Settings) from <data>/app.db over --port,
//     so a port change takes effect on the next start even though the desktop passes --port;
//  2. moves to the next free port when that one is taken (another program, or a port Windows
//     reserves), and writes the effective port to $WATI_PORT_FILE so the desktop can find the server;
//  3. turns a 'shutdown' IPC message (Electron utilityProcess parentPort or Node child IPC) into
//     the server's SIGTERM handler, because on Windows kill() terminates without running it.
// CommonJS (.cts → .cjs) so it can be loaded by utilityProcess.fork / ELECTRON_RUN_AS_NODE.
/* eslint-disable @typescript-eslint/no-require-imports */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

export const SHUTDOWN_MESSAGE = 'wati:shutdown';

/** How many ports after the chosen one server-host tries before it lets the server fail. */
export const PORT_TRIES = 20;

export function isValidPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

/**
 * Applies the persisted port setting over --port. Returns the server args to use and the
 * effective port (null when the args carry no port and no setting exists).
 */
export function prepareServerArgs(
  args: readonly string[],
  readPortSetting: (dataDir: string) => number | null,
): { args: string[]; port: number | null } {
  const out = [...args];
  if (out.includes('--reset-admin')) return { args: out, port: null };
  const data = flagValue(out, 'data');
  let setting: number | null = null;
  if (data) {
    try {
      const v = readPortSetting(data);
      setting = isValidPort(v) ? v : null;
    } catch {
      setting = null;
    }
  }
  const i = out.indexOf('--port');
  if (setting !== null) return { args: withPort(out, setting), port: setting };
  const explicit = i >= 0 ? Number(out[i + 1]) : NaN;
  return { args: out, port: isValidPort(explicit) ? explicit : null };
}

/**
 * The address the server will listen on: --host, else 0.0.0.0 when LAN access is on, else loopback
 * (the server's own rule in main.ts).
 */
export function serverBindHost(
  args: readonly string[],
  readLanSetting: (dataDir: string) => boolean,
): string {
  const host = flagValue(args, 'host');
  if (host) return host;
  const data = flagValue(args, 'data');
  try {
    return data && readLanSetting(data) ? '0.0.0.0' : '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

/**
 * True when nothing holds `port` where the server will listen. Only a LAN server (0.0.0.0) is tested
 * beyond loopback: a test listen on every interface makes Windows Firewall ask for network access.
 */
export async function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  const bind = (h: string) =>
    new Promise<boolean>((done) => {
      const s = createServer();
      s.once('error', () => done(false));
      s.listen({ port, host: h, exclusive: true }, () => s.close(() => done(true)));
    });
  if (!(await bind('127.0.0.1'))) return false;
  return host === '127.0.0.1' || (await bind(host));
}

/**
 * The first free port from `port` on (at most PORT_TRIES), else `port` itself so the server reports
 * the real error. The desktop follows the port file and saves the new port in desktop.json.
 */
export async function pickFreePort(
  port: number,
  host = '127.0.0.1',
  isFree: (p: number, host: string) => Promise<boolean> = portIsFree,
): Promise<number> {
  for (let p = port; p < port + PORT_TRIES && p <= 65535; p++) {
    if (await isFree(p, host)) return p;
  }
  return port;
}

/** Returns `args` with --port set to `port` (args always carry --port once a port is known). */
export function withPort(args: readonly string[], port: number): string[] {
  const out = [...args];
  const i = out.indexOf('--port');
  if (i >= 0 && out[i + 1] !== undefined) out[i + 1] = String(port);
  else out.push('--port', String(port));
  return out;
}

/** Moves prepared server args to a free port; `moved` names the change for the log. */
export async function useFreePort(
  prepared: { args: string[]; port: number | null },
  pick: (port: number) => Promise<number> = (port) => pickFreePort(port),
): Promise<{ args: string[]; port: number | null; moved: string | null }> {
  if (prepared.port === null) return { ...prepared, moved: null };
  const free = await pick(prepared.port);
  if (free === prepared.port) return { ...prepared, moved: null };
  return {
    args: withPort(prepared.args, free),
    port: free,
    moved: `port ${prepared.port} is in use; using port ${free}`,
  };
}

/** Server args for this start: the saved port setting, then a free port where it listens; logs a move. */
export async function startArgs(
  rest: readonly string[],
  readSetting: (dataDir: string, key: string) => unknown = readSettingFromDb,
  pick: (port: number, host: string) => Promise<number> = (port, host) => pickFreePort(port, host),
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  proc: { exit: (code?: number) => never } = process,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ args: string[]; port: number | null }> {
  applyLaunchdExitCodes(proc, env);
  const prepared = prepareServerArgs(rest, (d) => {
    const v = readSetting(d, 'port');
    return isValidPort(v) ? v : null;
  });
  const host = serverBindHost(rest, (d) => readSetting(d, 'lan_enabled') === true);
  const { args, port, moved } = await useFreePort(prepared, (p) => pick(p, host));
  if (moved) log(`server-host: ${moved}`);
  return { args, port };
}

/** Reads one setting (JSON value) from <dataDir>/app.db read-only; undefined when absent. */
export function readSettingFromDb(dataDir: string, key: string): unknown {
  const file = join(dataDir, 'app.db');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Database = require('better-sqlite3') as any;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value?: string } | undefined;
    return row && typeof row.value === 'string' ? (JSON.parse(row.value) as unknown) : undefined;
  } finally {
    db.close();
  }
}

/**
 * Exit codes of the server CLI that a restart cannot fix: 2 bad arguments, 3 data folder locked by another
 * server, 4 data folder moved to Enterprise. The launchd job restarts only after an unsuccessful exit
 * (KeepAlive SuccessfulExit false), so these leave as 0 instead of restarting every few seconds forever.
 */
export function launchdExitCode(code: number | undefined): number | undefined {
  return code === 2 || code === 3 || code === 4 ? 0 : code;
}

/** Under launchd, ends the exits a restart cannot fix with 0 (see launchdExitCode). */
export function applyLaunchdExitCodes(
  proc: { exit: (code?: number) => never },
  env: NodeJS.ProcessEnv,
): void {
  if (env.WATI_SERVICE_MANAGER !== 'launchd') return;
  const exit = proc.exit.bind(proc);
  proc.exit = (code?: number) => exit(launchdExitCode(code));
}

export function isShutdownMessage(m: unknown): boolean {
  if (m === SHUTDOWN_MESSAGE) return true;
  // Electron parentPort delivers a MessageEvent-like { data }
  return typeof m === 'object' && m !== null && (m as { data?: unknown }).data === SHUTDOWN_MESSAGE;
}

/** Service configuration may retain the version from installation; report the actual runtime. */
export function applyRuntimeVersion(entry: string, env: NodeJS.ProcessEnv): void {
  try {
    const file = join(dirname(resolve(entry)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) env.WATI_VERSION = pkg.version;
  } catch {
    // Unbundled launchers without runtime metadata retain the explicit environment version.
  }
}

async function main(): Promise<void> {
  const [entry, ...rest] = process.argv.slice(2);
  if (!entry) {
    process.stderr.write('server-host: missing server entry\n');
    process.exit(2);
  }
  const { args, port } = await startArgs(rest);
  const portFile = process.env.WATI_PORT_FILE;
  if (portFile && port !== null) {
    try {
      mkdirSync(dirname(portFile), { recursive: true });
      writeFileSync(portFile, JSON.stringify({ port, pid: process.pid }));
    } catch (err) {
      process.stderr.write(`server-host: could not write port file: ${(err as Error).message}\n`);
    }
  }
  const onMessage = (m: unknown) => {
    if (isShutdownMessage(m))
      (process.emit as (ev: string, ...a: unknown[]) => boolean)('SIGTERM', 'SIGTERM');
  };
  const parentPort = (
    process as unknown as { parentPort?: { on(ev: 'message', fn: (m: unknown) => void): void } }
  ).parentPort;
  parentPort?.on('message', onMessage);
  if (typeof process.send === 'function') {
    process.on('message', onMessage);
    // don't let the IPC channel keep the process alive on its own
    process.channel?.unref();
  }
  const entryPath = resolve(entry);
  applyRuntimeVersion(entryPath, process.env);
  process.argv = [process.argv[0] ?? process.execPath, entryPath, ...args];
  require(entryPath);
}

// require.main is the host under ELECTRON_RUN_AS_NODE/node; argv[1] covers utilityProcess.fork.
if (require.main === module || /server-host\.cjs$/.test(process.argv[1] ?? '')) void main();

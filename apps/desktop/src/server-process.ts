// Supervises the standalone server: utilityProcess.fork by default (native modules are Node-API
// prebuilds, so the same binaries load under Electron), or the system `node` when main.ts selects
// the dev-only WATI_DESKTOP_RUNTIME=node fallback.
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { utilityProcess, type UtilityProcess } from 'electron';
import { probeServer } from './detect.js';
import { activeProduct } from './product.js';
import { SHUTDOWN_MESSAGE } from './server-host.cjs';
import { isRestartableExit, MOVED_EXIT_CODE, parsePortFile } from './startup.js';

export type ServerState = 'starting' | 'running' | 'crashed' | 'stopped';

export interface StandaloneServerOptions {
  /** dist/server-host.cjs: applies the persisted port setting, writes portFile, handles graceful shutdown */
  host: string;
  /** where server-host writes the effective port ({ port, pid }) */
  portFile: string;
  entry: string;
  dataDir: string;
  port: number;
  webDist: string;
  cloudflaredDir: string;
  /** full path of the cloudflared binary (exported as WATI_CLOUDFLARED when it exists) */
  cloudflaredBinary?: string | null;
  version?: string;
  log: (s: string) => void;
  /** 'utility' = Electron utilityProcess (default), 'node' = spawn system node (dev) */
  runtime?: 'utility' | 'node';
}

type Child = { kind: 'utility'; p: UtilityProcess } | { kind: 'node'; p: ChildProcess };

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;
const LOG_LINES = 200;
/** how long a graceful shutdown (WA disconnect, tunnel stop, lock release) may take */
const STOP_TIMEOUT = 15_000;

export function serverEnv(
  o: Pick<StandaloneServerOptions, 'cloudflaredDir' | 'cloudflaredBinary' | 'version'> & {
    portFile?: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WATI_CLOUDFLARED_DIR: o.cloudflaredDir };
  if (o.portFile) env.WATI_PORT_FILE = o.portFile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (o.cloudflaredBinary && existsSync(o.cloudflaredBinary))
    env.WATI_CLOUDFLARED = o.cloudflaredBinary;
  if (o.version) env.WATI_VERSION = o.version;
  return env;
}

export class StandaloneServer extends EventEmitter {
  private child: Child | null = null;
  private stopping = false;
  private backoff = MIN_BACKOFF;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private _state: ServerState = 'stopped';
  private _port: number;
  /** --port of the next start (setPort changes it, e.g. after a Lite import takes over Lite's port) */
  private requestedPort: number;
  /** Exit code of the last server process (null until one exited). */
  private _lastExitCode: number | null = null;
  /** true after a non-restartable exit */
  private gaveUp = false;
  readonly logs: string[] = [];

  constructor(private readonly opts: StandaloneServerOptions) {
    super();
    this._port = opts.port;
    this.requestedPort = opts.port;
  }

  /** Exit code of the last server process; MOVED_EXIT_CODE (4) means its number moved to another edition. */
  get lastExitCode(): number | null {
    return this._lastExitCode;
  }

  /** Port for the next start (only while stopped; the running server keeps its port). */
  setPort(port: number): void {
    if (this.child) throw new Error('Stop the server before changing its port');
    this.requestedPort = port;
    this._port = port;
  }

  /** Effective port (the persisted port setting may override opts.port). */
  get port(): number {
    return this._port;
  }

  /** Resolves true once the server answers, false on timeout or when it stops/crashes for good. */
  waitRunning(timeoutMs: number): Promise<boolean> {
    if (this._state === 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const onState = (s: ServerState) => {
        if (s === 'running') finish(true);
        else if (s === 'stopped' || (s === 'crashed' && this.gaveUp)) finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (v: boolean) => {
        clearTimeout(timer);
        this.off('state', onState);
        resolve(v);
      };
      this.on('state', onState);
    });
  }

  private readPortFile(): number | null {
    try {
      return parsePortFile(
        existsSync(this.opts.portFile) ? readFileSync(this.opts.portFile, 'utf8') : null,
      );
    } catch {
      return null;
    }
  }

  get state(): ServerState {
    return this._state;
  }

  override on(event: 'state', listener: (s: ServerState) => void): this;
  override on(event: string | symbol, listener: (...args: never[]) => void): this;
  override on(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  private setState(s: ServerState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  private pushLog(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logs.push(line);
      if (this.logs.length > LOG_LINES) this.logs.shift();
      this.opts.log(line);
    }
  }

  start(): void {
    if (this.child) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.gaveUp = false;
    this.stopping = false;
    this.spawnChild();
  }

  private spawnChild(): void {
    const o = this.opts;
    const args = [
      '--data',
      o.dataDir,
      '--port',
      String(this.requestedPort),
      '--mode',
      'standalone',
      '--web-dist',
      o.webDist,
    ];
    const env = serverEnv(o);
    try {
      rmSync(o.portFile, { force: true });
    } catch {
      // ignore
    }
    this.setState('starting');
    this.startedAt = Date.now();
    this.pushLog(`[desktop] starting server (${o.runtime ?? 'utility'}): ${o.entry}`);
    if (o.runtime === 'node') {
      const p = spawn('node', [o.host, o.entry, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
      this.child = { kind: 'node', p };
    } else {
      const p = utilityProcess.fork(o.host, [o.entry, ...args], {
        env: env as Record<string, string>,
        stdio: 'pipe',
        serviceName: activeProduct().serviceName,
      });
      this.child = { kind: 'utility', p };
    }
    const child = this.child;
    const finish = (code: number | null) => {
      // A spawn error may be followed by exit, or an old child may exit after a forced stop.
      if (this.child !== child) return;
      this.onExit(code ?? 1);
    };
    child.p.stdout?.on('data', (d: Buffer) => this.pushLog(d.toString('utf8')));
    child.p.stderr?.on('data', (d: Buffer) => this.pushLog(d.toString('utf8')));
    if (child.kind === 'node') {
      child.p.on('exit', finish);
      child.p.on('error', (err) => {
        this.pushLog(`[desktop] node server process error: ${err.message}`);
        // A spawn failure has no PID and is not guaranteed to emit exit. Later IPC/kill errors
        // on a successfully spawned child must not orphan it by clearing the child reference.
        if (child.p.pid === undefined) finish(1);
      });
    } else child.p.on('exit', finish);
    this.pollHealth();
  }

  private pollHealth(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    const tick = async () => {
      if (!this.child || this.stopping) return;
      const child = this.child;
      const filePort = this.readPortFile();
      if (filePort !== null && filePort !== this._port) {
        this._port = filePort;
        this.pushLog(`[desktop] server uses port ${filePort} (from settings)`);
        this.emit('port', filePort);
      }
      const r = await probeServer(this._port);
      if (this.child !== child || this.stopping) return;
      if (r) {
        this.setState('running');
        return;
      }
      this.healthTimer = setTimeout(() => void tick(), 400);
    };
    this.healthTimer = setTimeout(() => void tick(), 300);
  }

  private onExit(code: number): void {
    this.child = null;
    this._lastExitCode = code;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.pushLog(`[desktop] server exited with code ${code}`);
    if (this.stopping) {
      this.setState('stopped');
      this.emit('exit', code);
      return;
    }
    if (!isRestartableExit(code)) {
      this.pushLog(
        code === 3
          ? '[desktop] the data folder is in use by another server process; not restarting'
          : code === MOVED_EXIT_CODE
            ? '[desktop] this WhatsApp number moved to another edition (moved.json); not restarting'
            : '[desktop] invalid server arguments; not restarting',
      );
      this.gaveUp = true;
      this.setState('crashed');
      this.emit('exit', code);
      return;
    }
    this.gaveUp = false;
    this.setState('crashed');
    this.emit('exit', code);
    // a run that lasted > 60s resets the backoff
    if (Date.now() - this.startedAt > 60_000) this.backoff = MIN_BACKOFF;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.pushLog(`[desktop] restarting in ${Math.round(delay / 1000)}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnChild();
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.healthTimer) clearTimeout(this.healthTimer);
    const c = this.child;
    if (!c) {
      this.setState('stopped');
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(force);
        resolve();
      };
      this.once('exit', done);
      const hardKill = () => {
        if (c.kind === 'node') c.p.kill('SIGKILL');
        else c.p.kill();
      };
      const force = setTimeout(() => {
        // hard kill if graceful shutdown hangs
        this.pushLog('[desktop] server did not shut down in time; killing it');
        hardKill();
        setTimeout(resolve, 500);
      }, STOP_TIMEOUT);
      // Graceful: server-host turns this message into the server's SIGTERM handler (WA disconnect,
      // tunnel shutdown, lock release). kill() on Windows terminates without running handlers.
      try {
        if (c.kind === 'node') c.p.send(SHUTDOWN_MESSAGE);
        else c.p.postMessage(SHUTDOWN_MESSAGE);
      } catch {
        hardKill();
      }
    });
    this.child = null;
    this.setState('stopped');
  }
}

/** Runs the server entry once with extra args (e.g. --reset-admin) and returns its output. */
export function runServerCommand(o: {
  entry: string;
  args: string[];
  runtime: 'utility' | 'node';
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const exe = o.runtime === 'node' ? 'node' : process.execPath;
    const env: NodeJS.ProcessEnv = { ...process.env, ...o.env };
    if (o.runtime === 'utility') env.ELECTRON_RUN_AS_NODE = '1';
    const p = spawn(exe, [o.entry, ...o.args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    p.stdout?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    p.stderr?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    p.on('error', (err) => resolve({ code: 1, output: output + err.message }));
    p.on('exit', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

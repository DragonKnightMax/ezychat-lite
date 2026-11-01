import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn(), fork: vi.fn(), probe: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }));
vi.mock('node:fs', () => ({ existsSync: () => false, readFileSync: vi.fn(), rmSync: vi.fn() }));
vi.mock('./detect.js', () => ({ probeServer: mock.probe }));
vi.mock('./server-host.cjs', () => ({ SHUTDOWN_MESSAGE: 'wati:shutdown' }));
import { StandaloneServer } from './server-process.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined = 100;
  send = vi.fn(() => this.emit('exit', 0));
  postMessage = vi.fn(() => this.emit('exit', 0));
  kill = vi.fn(() => this.emit('exit', 1));
}

let children: FakeChild[];
let server: StandaloneServer;

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  const spawn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  mock.spawn.mockReset().mockImplementation(spawn);
  mock.fork.mockReset().mockImplementation(spawn);
  mock.probe.mockReset().mockResolvedValue(null);
  server = fixture();
});

afterEach(async () => {
  await server.stop();
  vi.useRealTimers();
});

function fixture(runtime: 'node' | 'utility' = 'node') {
  return new StandaloneServer({
    host: '/fixture/server-host.cjs',
    entry: '/fixture/server.cjs',
    portFile: '/fixture/port.json',
    dataDir: '/fixture/data',
    webDist: '/fixture/web',
    cloudflaredDir: '/fixture/cloudflared',
    port: 7420,
    runtime,
    log: vi.fn(),
  });
}

describe('standalone server lifecycle', () => {
  it('recovers from ENOENT without exit and handles a later exit only once', async () => {
    server.start();
    const running = server.waitRunning(5000);
    const first = children[0]!;
    first.pid = undefined;
    first.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
    expect(server.state).toBe('crashed');
    first.emit('exit', 1);
    expect(server.logs.filter((line) => line.includes('restarting in'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(mock.spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    children[1]!.emit('exit', 3);
    expect(await running).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps restart backoff after repeated spawn failures', async () => {
    server.start();
    children[0]!.pid = undefined;
    children[0]!.emit('error', new Error('ENOENT'));
    await vi.advanceTimersByTimeAsync(1000);
    children[1]!.pid = undefined;
    children[1]!.emit('error', new Error('ENOENT'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.spawn).toHaveBeenCalledTimes(3);
  });

  it('cancels a scheduled restart on stop', async () => {
    server.start();
    children[0]!.pid = undefined;
    children[0]!.emit('error', new Error('ENOENT'));
    await server.stop();
    expect(server.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it('finishes shutdown if a pending spawn fails and does not restart', async () => {
    server.start();
    const child = children[0]!;
    child.send.mockImplementation(() => true);
    const stopping = server.stop();
    child.pid = undefined;
    child.emit('error', new Error('ENOENT'));
    await stopping;
    expect(server.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it('does not orphan a spawned child when IPC emits an error', async () => {
    server.start();
    const child = children[0]!;
    child.emit('error', new Error('IPC channel unavailable'));
    expect(server.state).toBe('starting');
    await server.stop();
    expect(child.send).toHaveBeenCalledWith('wati:shutdown');
    expect(server.state).toBe('stopped');
  });

  it('manual restart cancels the pending timer and ignores exits from an old child', async () => {
    server.start();
    const first = children[0]!;
    first.emit('exit', 1);
    server.start();
    first.emit('exit', 3);
    expect(server.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale health result mark a newer child running', async () => {
    let resolve!: (value: { mode: string; version: string }) => void;
    mock.probe.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    server.start();
    await vi.advanceTimersByTimeAsync(300);
    children[0]!.emit('exit', 1);
    server.start();
    resolve({ mode: 'standalone', version: 'test' });
    await Promise.resolve();
    expect(server.state).toBe('starting');
  });

  it('preserves utility-process graceful shutdown and non-restartable exits', async () => {
    server = fixture('utility');
    server.start();
    children[0]!.emit('exit', 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.fork).toHaveBeenCalledOnce();
    server.start();
    await server.stop();
    expect(children[1]!.postMessage).toHaveBeenCalledWith('wati:shutdown');
    expect(server.state).toBe('stopped');
  });
});

describe('moved data folder and port takeover', () => {
  it('does not restart after exit 4 and reports it as the last exit code', async () => {
    expect(server.lastExitCode).toBeNull();
    server.start();
    const running = server.waitRunning(5000);
    children[0]!.emit('exit', 4);
    expect(await running).toBe(false);
    expect(server.lastExitCode).toBe(4);
    expect(server.logs.some((line) => line.includes('moved to another edition'))).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it('starts on the port set while stopped and refuses a change while running', async () => {
    server.setPort(7431);
    expect(server.port).toBe(7431);
    server.start();
    const args = mock.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--port') + 1]).toBe('7431');
    expect(() => server.setPort(7500)).toThrow(/Stop the server/);
  });
});

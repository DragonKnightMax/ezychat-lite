import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startKeepAwake, type SpawnFn } from './keep-awake.js';

function fakeSpawn() {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
  const spawn = vi.fn(() => child) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
  return { spawn, child };
}
const log = { info: vi.fn(), warn: vi.fn() };

describe('startKeepAwake', () => {
  it('on macOS keeps the computer from idle sleep until this server process ends', () => {
    const { spawn, child } = fakeSpawn();
    const awake = startKeepAwake({ platform: 'darwin', mode: 'standalone', pid: 4242, spawn, log });
    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-w', '4242'], {
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalled();
    awake.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it('also runs for the background service', () => {
    const { spawn } = fakeSpawn();
    startKeepAwake({ platform: 'darwin', mode: 'service', pid: 1, spawn, log });
    expect(spawn).toHaveBeenCalled();
  });

  it('does nothing in dev mode or on other systems', () => {
    for (const [platform, mode] of [
      ['darwin', 'dev'],
      ['win32', 'standalone'],
      ['linux', 'service'],
    ] as const) {
      const { spawn } = fakeSpawn();
      startKeepAwake({ platform, mode, pid: 1, spawn, log }).stop();
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it('keeps the server running when caffeinate cannot start', () => {
    const { spawn, child } = fakeSpawn();
    startKeepAwake({ platform: 'darwin', mode: 'standalone', pid: 1, spawn, log });
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(log.warn).toHaveBeenCalled();
  });
});

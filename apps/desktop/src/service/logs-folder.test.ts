import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sudo = vi.hoisted(() => ({ script: '', body: '', stdout: '' }));
vi.mock('@vscode/sudo-prompt', () => ({
  exec: (
    command: string,
    _options: unknown,
    callback: (err: Error | undefined, stdout: string, stderr: string) => void,
  ) => {
    sudo.script = command;
    const file = /'([^']+)'/.exec(command)?.[1];
    sudo.body = file ? readFileSync(file, 'utf8') : '';
    callback(undefined, sudo.stdout, '');
  },
}));

const { createServiceManager, openLogsFolder } = await import('./index.js');

const deps = {
  execPath: '/Applications/EzyChat Lite.app/Contents/MacOS/EzyChat Lite',
  serverHost: 'host',
  serverEntry: 'entry',
  webDist: 'web',
  cloudflaredBinary: null,
  cloudflaredDir: 'cf',
  winswExe: '',
  userDataDir: '/Users/me/data',
  machineDataDir: '/Library/Application Support/wa-team-inbox',
  port: 7420,
  version: '1.0.0',
};

describe('copyLogs (macOS service)', () => {
  afterEach(() => {
    sudo.script = '';
  });
  it('returns the folder the elevated copy printed last', async () => {
    sudo.stdout = 'some output\n/private/tmp/wa-team-inbox-logs.AbC123\n';
    const manager = createServiceManager('darwin', deps);
    expect(await manager.copyLogs?.()).toBe('/private/tmp/wa-team-inbox-logs.AbC123');
    expect(sudo.script).toContain('/bin/bash');
  });
  it('start names the Allow in the Background switch when macOS refuses the service', async () => {
    sudo.stdout = '';
    await createServiceManager('darwin', deps).start();
    expect(sudo.body).toContain('launchctl kickstart -k');
    expect(sudo.body).toContain('EzyChat Lite is switched off under System Settings');
  });
  it('is only offered on macOS', () => {
    expect(createServiceManager('win32', deps).copyLogs).toBeUndefined();
  });
});

describe('openLogsFolder', () => {
  const base = {
    dataDir: '/Users/me/data',
    machineDataDir: '/Library/Application Support/wa-team-inbox',
    exists: () => true,
    log: vi.fn(),
  };
  it('opens the copy of the root-only service logs', async () => {
    const openPath = vi.fn(async () => '');
    const copyLogs = vi.fn(async () => '/private/tmp/x');
    await openLogsFolder({ ...base, serviceMode: true, service: { copyLogs }, openPath });
    expect(openPath).toHaveBeenCalledWith('/private/tmp/x');
  });
  it('logs a refused prompt instead of throwing', async () => {
    const openPath = vi.fn(async () => '');
    const log = vi.fn();
    const copyLogs = vi.fn(async () => {
      throw new Error('User did not grant permission.');
    });
    await openLogsFolder({ ...base, log, serviceMode: true, service: { copyLogs }, openPath });
    expect(openPath).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain('could not copy the service logs');
  });
  it('opens the logs folder directly without a service copy, or its parent when it is missing', async () => {
    const openPath = vi.fn(async () => '');
    await openLogsFolder({ ...base, serviceMode: false, service: {}, openPath });
    expect(openPath).toHaveBeenLastCalledWith(join('/Users/me/data', 'logs'));
    await openLogsFolder({
      ...base,
      serviceMode: true,
      service: {},
      exists: () => false,
      openPath,
    });
    expect(openPath).toHaveBeenLastCalledWith(
      dirname(join('/Library/Application Support/wa-team-inbox', 'logs')),
    );
  });
});

import { describe, expect, it } from 'vitest';
import util from 'node:util';
import { exec as sudoExec } from '@vscode/sudo-prompt';
import {
  createServiceManager,
  elevatedWindowsOutcome,
  ElevationCancelledError,
  isMacPromptCancelled,
  macRuntimeBundle,
  serviceCommand,
  type ServiceDeps,
} from './index.js';

describe('elevated outcome', () => {
  it('returns the log on success and tells a refused prompt from a failed script', () => {
    expect(elevatedWindowsOutcome(0, 'Service removed.', '')).toBe('Service removed.');
    expect(elevatedWindowsOutcome(0, null, '')).toBe('');
    // No log: the elevated wrapper never ran (UAC refused), so nothing changed.
    expect(() =>
      elevatedWindowsOutcome(1, null, 'The operation was canceled by the user.'),
    ).toThrow(ElevationCancelledError);
    expect(() => elevatedWindowsOutcome(1, 'service uninstall failed', '')).toThrow(
      'service uninstall failed',
    );
    expect(() => elevatedWindowsOutcome(1, '', 'boom')).toThrow('boom');
    expect(() => elevatedWindowsOutcome(1, '', '')).toThrow('Elevated command failed.');
  });

  it('knows the admin prompt’s cancel message on macOS', () => {
    expect(isMacPromptCancelled('User did not grant permission.')).toBe(true);
    expect(isMacPromptCancelled('Command failed: exit 3')).toBe(false);
  });

  it('opens the macOS admin prompt on a Node without util.isObject (Electron 45+)', async () => {
    // sudo-prompt 9.2.1 called util.isObject/isFunction, which Node 23 removed: every macOS
    // update install and service change failed with "Node.util.isObject is not a function".
    const legacy = util as unknown as Record<string, unknown>;
    const saved = Object.entries(legacy).filter(([k]) => k === 'isObject' || k === 'isFunction');
    delete legacy.isObject;
    delete legacy.isFunction;
    try {
      const err = await new Promise<Error | undefined>((resolve) => {
        sudoExec('sudo true', { name: 'EzyChat' }, (e) => resolve(e));
      });
      // The argument checks passed; the command is refused before any prompt opens.
      expect(err?.message).toBe('Command should not be prefixed with "sudo".');
    } finally {
      Object.assign(legacy, Object.fromEntries(saved));
    }
  });
});

const B = String.fromCharCode(92);
const w = (...p: string[]) => p.join(B);

const winDeps: ServiceDeps = {
  execPath: w('C:', 'Program Files', 'WA Team Inbox', 'WA Team Inbox.exe'),
  serverHost: w(
    'C:',
    'Program Files',
    'WA Team Inbox',
    'resources',
    'app.asar',
    'dist',
    'server-host.cjs',
  ),
  serverEntry: w(
    'C:',
    'Program Files',
    'WA Team Inbox',
    'resources',
    'app.asar',
    'dist',
    'server',
    'server.cjs',
  ),
  webDist: w('C:', 'Program Files', 'WA Team Inbox', 'resources', 'web'),
  cloudflaredBinary: null,
  cloudflaredDir: w('C:', 'Program Files', 'WA Team Inbox', 'resources', 'cloudflared'),
  winswExe: 'x',
  userDataDir: 'u',
  machineDataDir: w('C:', 'ProgramData', 'wa-team-inbox'),
  port: 7420,
  version: '0.1.0',
};

describe('serviceCommand', () => {
  it('runs the server through server-host and tells it where to report the effective port', () => {
    const c = serviceCommand(winDeps, 'win32', () => false);
    expect(c.exe).toBe(winDeps.execPath);
    expect(c.args.slice(0, 2)).toEqual([winDeps.serverHost, winDeps.serverEntry]);
    expect(c.args).toContain('--port');
    expect(c.env.WATI_PORT_FILE?.endsWith(w('wa-team-inbox', 'run', 'port.json'))).toBe(true);
    expect(c.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
  it.each(['WA Team Inbox', 'EzyChat Lite'])(
    'on macOS remaps the %s bundle into the existing runtime folder',
    (product) => {
      const app = `/Applications/${product}.app`;
      const c = serviceCommand(
        {
          ...winDeps,
          execPath: `${app}/Contents/MacOS/${product}`,
          serverHost: `${app}/Contents/Resources/app.asar/dist/server-host.cjs`,
          serverEntry: `${app}/Contents/Resources/app.asar/dist/server/server.cjs`,
          webDist: `${app}/Contents/Resources/web`,
          cloudflaredDir: `${app}/Contents/Resources/cloudflared`,
          machineDataDir: '/Library/Application Support/wa-team-inbox',
          appBundle: app,
        },
        'darwin',
        () => false,
      );
      const dest = macRuntimeBundle(app);
      expect(dest).toBe(`/Library/Application Support/wa-team-inbox-runtime/${product}.app`);
      expect(c.exe.startsWith(dest)).toBe(true);
      for (const a of [c.args[0], c.args[1], c.env.WATI_CLOUDFLARED_DIR])
        expect(a?.startsWith(dest)).toBe(true);
      expect(c.args.join(' ')).not.toContain('/Applications/');
      expect(c.env.WATI_SERVICE_MANAGER).toBe('launchd');
    },
  );
  it('marks only the launchd job, so Windows keeps its own restart policy', () => {
    expect(serviceCommand(winDeps, 'win32', () => false).env.WATI_SERVICE_MANAGER).toBeUndefined();
  });
});

describe('macOS privileged operations require a packaged runtime', () => {
  it.each([undefined, null])(
    'rejects service installation and admin reset without appBundle (%s)',
    async (appBundle) => {
      const manager = createServiceManager('darwin', { ...winDeps, appBundle });
      await expect(manager.install()).rejects.toThrow('requires the installed EzyChat Lite app');
      await expect(manager.resetAdmin()).rejects.toThrow('requires the installed EzyChat Lite app');
    },
  );

  it('maps the reset entry and executable into the protected copy', () => {
    const appBundle = '/Applications/EzyChat Lite.app';
    const cmd = serviceCommand(
      {
        ...winDeps,
        appBundle,
        execPath: `${appBundle}/Contents/MacOS/EzyChat Lite`,
        serverHost: `${appBundle}/Contents/Resources/app.asar/dist/server-host.cjs`,
        serverEntry: `${appBundle}/Contents/Resources/app.asar/dist/server/server.cjs`,
      },
      'darwin',
      () => false,
    );
    const protectedBundle = macRuntimeBundle(appBundle);
    expect(cmd.exe).toBe(`${protectedBundle}/Contents/MacOS/EzyChat Lite`);
    expect(cmd.args[1]).toBe(
      `${protectedBundle}/Contents/Resources/app.asar/dist/server/server.cjs`,
    );
  });
});

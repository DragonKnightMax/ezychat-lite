import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopUpgradeState } from '@ezychat/shared';
import { UpgradeInstaller, type UpgradeDeps } from './controller.js';
import { createInstallerLauncher } from './launch.js';
import { installerSuffix, parseInstallerManifest } from './manifest.js';

const sha = 'a'.repeat(64);
const manifest = {
  version: 'v1.4.0',
  assets: [
    {
      name: 'EzyChat-Enterprise-1.4.0-mac-arm64.dmg',
      url: 'https://dl.ezychat.ai/m.dmg',
      sha256: sha,
      size: 10,
    },
    {
      name: 'EzyChat-Enterprise-1.4.0-win-x64.exe',
      url: 'http://dl.ezychat.ai/w.exe',
      sha256: sha,
      size: 10,
    },
    {
      name: 'EzyChat-Enterprise-1.4.0-win-x64.exe',
      url: 'https://dl.ezychat.ai/w.exe',
      sha256: sha.toUpperCase(),
      size: 20,
    },
  ],
};

describe('installer manifest', () => {
  it('picks this computer’s installer with https, size and SHA-256', () => {
    expect(parseInstallerManifest(manifest, { platform: 'win32', arch: 'x64' })).toEqual({
      ok: true,
      release: expect.objectContaining({
        version: '1.4.0',
        assetName: 'EzyChat-Enterprise-1.4.0-win-x64.exe',
        downloadUrl: 'https://dl.ezychat.ai/w.exe',
        assetSize: 20,
        assetSha256: sha,
        prerelease: false,
      }),
    });
    const mac = parseInstallerManifest(manifest, { platform: 'darwin', arch: 'arm64' });
    expect(mac.ok && mac.release.assetName).toBe('EzyChat-Enterprise-1.4.0-mac-arm64.dmg');
  });

  it('reports no installer for this system or without a valid asset', () => {
    expect(parseInstallerManifest(manifest, { platform: 'darwin', arch: 'x64' })).toEqual({
      ok: false,
      error: 'no_installer',
    });
    expect(parseInstallerManifest(manifest, { platform: 'linux', arch: 'x64' })).toEqual({
      ok: false,
      error: 'no_installer',
    });
    const bad = (asset: Record<string, unknown>) =>
      parseInstallerManifest(
        {
          version: '1.4.0',
          assets: [
            { name: 'E-1.4.0-win-x64.exe', url: 'https://x/a', sha256: sha, size: 5, ...asset },
          ],
        },
        { platform: 'win32', arch: 'x64' },
      ).ok;
    expect(bad({})).toBe(true);
    expect(bad({ size: 0 })).toBe(false);
    expect(bad({ size: 2 ** 40 })).toBe(false);
    expect(bad({ sha256: 'nope' })).toBe(false);
    expect(bad({ name: 'E..x-1.4.0-win-x64.exe' })).toBe(false);
    expect(bad({ name: 'E-1.4.1-win-x64.exe' })).toBe(false);
  });

  it.each([
    null,
    [],
    { version: 1, assets: [] },
    { version: '1.4', assets: [] },
    { version: '1.4.0' },
  ])('rejects malformed manifest %j', (value) =>
    expect(parseInstallerManifest(value, { platform: 'win32', arch: 'x64' })).toEqual({
      ok: false,
      error: 'invalid',
    }),
  );

  it('knows the installer suffixes', () => {
    expect(installerSuffix('win32', 'arm64')).toBeNull();
    expect(installerSuffix('darwin', 'x64')).toBe('mac-x64.dmg');
  });
});

function setup(over: Partial<UpgradeDeps> = {}) {
  const changes: DesktopUpgradeState[] = [];
  const deps: UpgradeDeps = {
    feed: 'https://dl.ezychat.ai/enterprise/latest.json',
    isHost: () => true,
    platform: 'win32',
    arch: 'x64',
    directory: '/staging',
    userAgent: 'EzyChat-Lite-Upgrade',
    fetch: vi.fn(async () => Response.json(manifest)),
    download: vi.fn(async (release, options) => {
      options.onProgress?.({ receivedBytes: 5, totalBytes: 20 });
      return {
        filePath: `/staging/${sha}-${release.assetName}`,
        sha256: sha,
        version: release.version,
        assetName: release.assetName!,
        size: 20,
      };
    }),
    launch: vi.fn(async () => {}),
    onChanged: (s) => changes.push(s),
    log: vi.fn(),
    ...over,
  };
  return { upgrade: new UpgradeInstaller(deps), deps, changes };
}

describe('upgrade installer', () => {
  it('is available only with a feed on the host computer', async () => {
    expect(setup().upgrade.getState()).toMatchObject({ available: true, status: 'idle' });
    expect(setup({ feed: null }).upgrade.getState().available).toBe(false);
    const client = setup({ isHost: () => false });
    expect(client.upgrade.getState().available).toBe(false);
    await expect(client.upgrade.install()).rejects.toThrow(/not available/);
  });

  it('fetches the fixed feed, downloads the verified installer and starts it', async () => {
    const { upgrade, deps, changes } = setup();
    const state = await upgrade.install();
    expect(state).toMatchObject({
      status: 'started',
      version: '1.4.0',
      downloadedBytes: 5,
      totalBytes: 20,
    });
    expect(deps.fetch).toHaveBeenCalledWith(
      'https://dl.ezychat.ai/enterprise/latest.json',
      expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
    );
    expect(deps.download).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'https://dl.ezychat.ai/w.exe' }),
      expect.objectContaining({ directory: '/staging', source: 'installer-feed' }),
    );
    expect(deps.launch).toHaveBeenCalledWith(
      `/staging/${sha}-EzyChat-Enterprise-1.4.0-win-x64.exe`,
    );
    expect(changes.map((s) => s.status)).toEqual([
      'checking',
      'downloading',
      'downloading',
      'started',
    ]);
  });

  it.each([
    ['network', { fetch: vi.fn(async () => new Response('', { status: 500 })) }],
    ['network', { fetch: vi.fn(async () => Promise.reject(new Error('offline'))) }],
    ['invalid', { fetch: vi.fn(async () => new Response('{', { status: 200 })) }],
    [
      'invalid',
      {
        fetch: vi.fn(
          async () =>
            new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
        ),
      },
    ],
    ['invalid', { fetch: vi.fn(async () => Response.json({ version: 'x' })) }],
    ['no_installer', { arch: 'arm64' }],
    ['download', { download: vi.fn(async () => Promise.reject(new Error('sha'))) }],
    ['launch', { launch: vi.fn(async () => Promise.reject(new Error('denied'))) }],
  ] as const)('reports %s', async (error, over) => {
    const { upgrade } = setup(over as Partial<UpgradeDeps>);
    expect(await upgrade.install()).toMatchObject({ status: 'error', error });
    // A retry starts again from the feed.
    expect((await upgrade.install()).status).toBe('error');
  });

  it('cancels a running download and ignores a second install meanwhile', async () => {
    let finish!: () => void;
    const download = vi.fn(
      (_release: unknown, options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          finish = () => reject(new Error('aborted'));
          options.signal?.addEventListener('abort', () => finish());
        }),
    );
    const { upgrade, deps } = setup({ download: download as unknown as UpgradeDeps['download'] });
    const running = upgrade.install();
    await vi.waitFor(() => expect(upgrade.getState().status).toBe('downloading'));
    expect((await upgrade.install()).status).toBe('downloading');
    expect(upgrade.cancel()).toMatchObject({ status: 'idle', downloadedBytes: 0 });
    expect((await running).status).toBe('idle');
    expect(deps.launch).not.toHaveBeenCalled();
    expect(upgrade.cancel().status).toBe('idle');
  });

  it('a cancel during the manifest fetch wins over its result', async () => {
    let respond!: (r: Response) => void;
    const { upgrade, deps } = setup({
      fetch: vi.fn(() => new Promise<Response>((r) => (respond = r))),
    });
    const running = upgrade.install();
    upgrade.cancel();
    respond(Response.json(manifest));
    expect((await running).status).toBe('idle');
    expect(deps.download).not.toHaveBeenCalled();
  });
});

class FakeSpawned extends EventEmitter {
  unref = vi.fn();
}

describe('installer launcher', () => {
  it('Windows: spawns the installer detached and lets it run on its own', async () => {
    const child = new FakeSpawned();
    const spawn = vi.fn(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    await createInstallerLauncher({ platform: 'win32', openPath: vi.fn(), spawn })('C:\\s\\i.exe');
    expect(spawn).toHaveBeenCalledWith('C:\\s\\i.exe', [], { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
    const failing = new FakeSpawned();
    const launch = createInstallerLauncher({
      platform: 'win32',
      openPath: vi.fn(),
      spawn: () => {
        setImmediate(() => failing.emit('error', new Error('EACCES')));
        return failing;
      },
    });
    await expect(launch('C:\\s\\i.exe')).rejects.toThrow('EACCES');
  });

  it('macOS: opens the dmg; other systems have no installer', async () => {
    const openPath = vi.fn(async () => '');
    await createInstallerLauncher({ platform: 'darwin', openPath })('/s/i.dmg');
    expect(openPath).toHaveBeenCalledWith('/s/i.dmg');
    await expect(
      createInstallerLauncher({ platform: 'darwin', openPath: async () => 'no app' })('/s/i.dmg'),
    ).rejects.toThrow('no app');
    await expect(createInstallerLauncher({ platform: 'linux', openPath })('/x')).rejects.toThrow();
  });
});

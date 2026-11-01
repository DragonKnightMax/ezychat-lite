import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopRelease } from '../../../../packages/shared/src/desktop-updates.js';
import { LITE_PRODUCT, resetActiveProductForTests, setActiveProduct } from '../product.js';
import { downloadRelease, MAX_UPDATE_BYTES, verifyDownloadedRelease } from './download.js';

const payload = Buffer.from('installer-binary-fixture');
const digest = createHash('sha256').update(payload).digest('hex');
const assetName = 'EzyChat-Lite-0.2.0-win-x64.exe';
const release: DesktopRelease = {
  version: '0.2.0',
  name: 'EzyChat Lite 0.2.0',
  notes: '',
  publishedAt: '2026-10-04T00:00:00Z',
  prerelease: true,
  releaseUrl: 'https://github.com/ossmalaysia/ezychat-lite/releases/tag/v0.2.0',
  downloadUrl: `https://github.com/ossmalaysia/ezychat-lite/releases/download/v0.2.0/${assetName}`,
  assetName,
  assetSize: payload.length,
  assetSha256: digest,
};
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'ezychat-update-test-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function fetcher(body: BodyInit = payload, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(body, { headers }));
}

describe('verified release downloads', () => {
  it('streams, verifies and emits bounded progress without renderer URLs', async () => {
    const fetch = fetcher(payload, { 'content-length': String(payload.length) });
    const onProgress = vi.fn();
    const artifact = await downloadRelease(release, { directory, fetch, onProgress });
    expect(await readFile(artifact.filePath)).toEqual(payload);
    expect(artifact).toMatchObject({
      sha256: digest,
      size: payload.length,
      version: '0.2.0',
      assetName,
    });
    expect(fetch).toHaveBeenCalledWith(
      release.downloadUrl,
      expect.objectContaining({
        redirect: 'manual',
        credentials: 'omit',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(onProgress).toHaveBeenLastCalledWith({
      receivedBytes: payload.length,
      totalBytes: payload.length,
    });
    expect((await readdir(directory)).some((name) => name.endsWith('.part'))).toBe(false);
    await expect(verifyDownloadedRelease(artifact, release)).resolves.toBeUndefined();
  });

  it.each(['mac-x64.dmg', 'mac-arm64.dmg'])('accepts exact %s installers', async (suffix) => {
    const name = `EzyChat-Lite-0.2.0-${suffix}`;
    const item = {
      ...release,
      assetName: name,
      downloadUrl: release.downloadUrl!.replace(assetName, name),
    };
    expect((await downloadRelease(item, { directory, fetch: fetcher() })).assetName).toBe(name);
  });

  it('follows only exact GitHub and legitimate release CDN redirects', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?signature=private',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(payload));
    await downloadRelease(release, { directory, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'http://release-assets.githubusercontent.com/github-production-release-asset/123/abc',
    'https://release-assets.githubusercontent.com.evil.example/github-production-release-asset/123/abc',
    'https://github.com/attacker/project/releases/download/v0.2.0/payload.exe',
    'https://github.com/ossmalaysia/ezychat-lite/releases/download/v0.2.0/other.exe',
    'https://user:password@release-assets.githubusercontent.com/github-production-release-asset/123/abc',
    'https://release-assets.githubusercontent.com:444/github-production-release-asset/123/abc',
    'https://release-assets.githubusercontent.com/not-a-release',
  ])('rejects untrusted redirect %s', async (location) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(downloadRelease(release, { directory, fetch })).rejects.toThrow(
      'untrusted address',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { assetSha256: null },
    { assetSha256: 'sha256:wrong' },
    { assetSize: 0 },
    { assetSize: MAX_UPDATE_BYTES + 1 },
    { assetSize: 1.5 },
    { downloadUrl: 'https://evil.example/installer.exe' },
    { assetName: '../../installer.exe' },
  ])(
    'rejects unsafe or unverifiable release metadata before network requests: %j',
    async (override) => {
      const fetch = fetcher();
      await expect(
        downloadRelease({ ...release, ...override }, { directory, fetch }),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { body: Buffer.from('truncated'), message: 'incomplete' },
    { body: Buffer.alloc(payload.length + 1), message: 'exceeds' },
    { body: Buffer.alloc(payload.length), message: 'SHA-256' },
  ])('removes partial files for $message payloads', async ({ body, message }) => {
    await expect(downloadRelease(release, { directory, fetch: fetcher(body) })).rejects.toThrow(
      message,
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects a mismatching Content-Length before creating a partial file', async () => {
    await expect(
      downloadRelease(release, { directory, fetch: fetcher(payload, { 'content-length': '1' }) }),
    ).rejects.toThrow('size does not match');
    expect(await readdir(directory)).toEqual([]);
  });

  it('coalesces concurrent downloads and verifies cached files again before reuse', async () => {
    const fetch = fetcher();
    const first = downloadRelease(release, { directory, fetch });
    const second = downloadRelease(release, { directory, fetch });
    expect(second).toBe(first);
    const artifact = await first;
    await downloadRelease(release, { directory, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    await writeFile(artifact.filePath, Buffer.alloc(payload.length));
    await expect(downloadRelease(release, { directory, fetch })).rejects.toThrow('SHA-256');
    expect(await readdir(directory)).toEqual([]);
    await downloadRelease(release, { directory, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throttles streaming progress while preserving the initial and completed states', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of payload) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const onProgress = vi.fn();
    await downloadRelease(release, {
      directory,
      onProgress,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream)),
    });
    expect(onProgress.mock.calls.length).toBeLessThanOrEqual(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, { receivedBytes: 0, totalBytes: payload.length });
    expect(onProgress).toHaveBeenLastCalledWith({
      receivedBytes: payload.length,
      totalBytes: payload.length,
    });
  });

  it('revalidates metadata and payload before installer handoff', async () => {
    const artifact = await downloadRelease(release, { directory, fetch: fetcher() });
    await expect(
      verifyDownloadedRelease({ ...artifact, version: '9.0.0' }, release),
    ).rejects.toThrow('selected release');
    await writeFile(artifact.filePath, Buffer.alloc(payload.length));
    await expect(verifyDownloadedRelease(artifact, release)).rejects.toThrow('SHA-256');
  });

  it('rejects symlink/junction staging without touching the target directory', async () => {
    const staging = join(directory, 'staging');
    const target = join(directory, 'target');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target);
    await symlink(target, staging, 'junction');
    const fetch = fetcher();
    await expect(downloadRelease(release, { directory: staging, fetch })).rejects.toThrow(
      'unsafe filesystem link',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(target)).toEqual([]);
  });

  it('refuses hardlinked cached installers', async () => {
    const artifact = await downloadRelease(release, { directory, fetch: fetcher() });
    await link(artifact.filePath, join(directory, 'other-file'));
    await expect(verifyDownloadedRelease(artifact, release)).rejects.toThrow('linked');
  });

  it('aborts stalled response bodies and releases the download job for retry', async () => {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.subarray(0, 3));
      },
      cancel() {
        cancel();
      },
    });
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    const onProgress = vi.fn((progress) => {
      if (progress.receivedBytes === 3) controller.abort(new Error('Download cancelled'));
    });
    await expect(
      downloadRelease(release, { directory, fetch, signal: controller.signal, onProgress }),
    ).rejects.toThrow('Download cancelled');
    await cancelled;
    expect(await readdir(directory)).toEqual([]);
    await expect(downloadRelease(release, { directory, fetch: fetcher() })).resolves.toMatchObject({
      sha256: digest,
    });
  });

  it('times out even when a fetch implementation does not honor AbortSignal', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise(() => undefined));
    await expect(downloadRelease(release, { directory, fetch, timeoutMs: 20 })).rejects.toThrow(
      'timed out',
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects an already-cancelled operation before touching the network', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled by host'));
    const fetch = fetcher();
    await expect(
      downloadRelease(release, { directory, fetch, signal: controller.signal }),
    ).rejects.toThrow('Cancelled by host');
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('URL feed downloads (private editions)', () => {
  const name = 'EzyChat-Enterprise-0.2.0-win-x64.exe';
  const urlRelease: DesktopRelease = {
    ...release,
    name: 'EzyChat Enterprise 0.2.0',
    releaseUrl: '',
    downloadUrl: `https://downloads.example.com/enterprise/${name}`,
    assetName: name,
  };
  beforeEach(() => {
    resetActiveProductForTests();
    setActiveProduct({
      ...LITE_PRODUCT,
      edition: 'enterprise',
      productName: 'EzyChat Enterprise',
      releaseRepository: 'example/ezychat-enterprise',
      releaseRepositories: ['example/ezychat-enterprise'],
      artifactPrefixes: ['EzyChat-Enterprise'],
      executableNames: ['EzyChat Enterprise'],
      updateFeed: { kind: 'url', url: 'https://updates.example.com/enterprise/latest.json' },
    });
  });
  afterEach(() => resetActiveProductForTests());

  it('downloads from the manifest https address (and CDN redirects) and verifies the digest', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.net/signed/installer?sig=1' },
        }),
      )
      .mockResolvedValueOnce(new Response(payload));
    const artifact = await downloadRelease(urlRelease, { directory, fetch });
    expect(await readFile(artifact.filePath)).toEqual(payload);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      urlRelease.downloadUrl,
      'https://cdn.example.net/signed/installer?sig=1',
    ]);
  });

  it('still requires the trusted SHA-256 and size, and https addresses only', async () => {
    const fetch = fetcher();
    await expect(
      downloadRelease({ ...urlRelease, assetSha256: null }, { directory, fetch }),
    ).rejects.toThrow(/SHA-256/);
    await expect(
      downloadRelease({ ...urlRelease, assetSize: null }, { directory, fetch }),
    ).rejects.toThrow(/size/);
    await expect(
      downloadRelease(
        { ...urlRelease, downloadUrl: urlRelease.downloadUrl!.replace('https:', 'http:') },
        { directory, fetch },
      ),
    ).rejects.toThrow(/secure/);
    expect(fetch).not.toHaveBeenCalled();
    const redirectToHttp = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://cdn.example.net/x' } }),
      );
    await expect(downloadRelease(urlRelease, { directory, fetch: redirectToHttp })).rejects.toThrow(
      /untrusted/,
    );
    const tampered = fetcher(Buffer.from('installer-binary-fixturX'));
    await expect(downloadRelease(urlRelease, { directory, fetch: tampered })).rejects.toThrow(
      /SHA-256/,
    );
  });
});

describe('another edition’s installer (upgradeInstallerFeed)', () => {
  const name = 'EzyChat-Enterprise-1.4.0-win-x64.exe';
  const installer: DesktopRelease = {
    ...release,
    version: '1.4.0',
    name,
    releaseUrl: '',
    assetName: name,
    downloadUrl: `https://dl.ezychat.ai/enterprise/1.4.0/${name}`,
  };

  it('downloads an installer-shaped name from any https address and verifies it', async () => {
    const fetch = fetcher();
    const artifact = await downloadRelease(installer, {
      directory,
      fetch,
      source: 'installer-feed',
    });
    expect(artifact.assetName).toBe(name);
    expect(fetch).toHaveBeenCalledWith(installer.downloadUrl, expect.any(Object));
    await expect(
      verifyDownloadedRelease(artifact, installer, { source: 'installer-feed' }),
    ).resolves.toBeUndefined();
  });

  it('is refused as an update of this product, and needs digest, shape and https', async () => {
    await expect(downloadRelease(installer, { directory, fetch: fetcher() })).rejects.toThrow(
      /Invalid update installer/,
    );
    for (const bad of [
      { assetName: 'EzyChat-Enterprise-1.4.1-win-x64.exe' },
      { assetName: '../EzyChat-Enterprise-1.4.0-win-x64.exe' },
      { assetName: 'EzyChat-Enterprise-1.4.0-linux-x64.AppImage' },
      { downloadUrl: `http://dl.ezychat.ai/${name}` },
      { assetSha256: null },
    ])
      await expect(
        downloadRelease(
          { ...installer, ...bad },
          {
            directory,
            fetch: fetcher(),
            source: 'installer-feed',
          },
        ),
      ).rejects.toThrow();
  });
});

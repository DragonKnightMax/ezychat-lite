import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DesktopRelease } from '../../../../packages/shared/src/desktop-updates.js';
import { activeProduct, escapeRegExp, updateFeedOf } from '../product.js';

export const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface DownloadedRelease {
  filePath: string;
  sha256: string;
  version: string;
  assetName: string;
  size: number;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
}

export interface DownloadOptions {
  /** Main-process-owned private directory outside the installed application runtime. */
  directory: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /**
   * 'product' (default): an update of this product (its artifact names and feed).
   * 'installer-feed': another edition's installer from the product's upgradeInstallerFeed manifest
   * (upgrade/): any https address and an installer-shaped name; the manifest's SHA-256 and size are the
   * trust anchor, exactly as for a private edition's own URL feed.
   */
  source?: DownloadSource;
}

export type DownloadSource = 'product' | 'installer-feed';

const INSTALLER_SUFFIXES = ['win-x64.exe', 'mac-x64.dmg', 'mac-arm64.dmg'];

interface DownloadSpec {
  version: string;
  assetName: string;
  sha256: string;
  size: number;
  tag: string;
  url: string;
  /** product.releaseRepositories: the only GitHub repositories the installer may come from */
  repositories: readonly string[];
  userAgent: string;
  /** 'url': a private edition's manifest feed; any https address, the digest is the trust anchor */
  feed?: 'github' | 'url';
}

function httpsAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function specFor(release: DesktopRelease, source: DownloadSource = 'product'): DownloadSpec {
  const product = activeProduct();
  const REPOSITORIES = product.releaseRepositories;
  const { version, assetName, downloadUrl, assetSize, assetSha256 } = release;
  if (!assetSha256 || !/^[a-fA-F0-9]{64}$/.test(assetSha256)) {
    throw new Error(
      'This release has no trusted SHA-256 digest. Open its release page for a manual update.',
    );
  }
  if (
    !Number.isSafeInteger(assetSize) ||
    !assetSize ||
    assetSize < 1 ||
    assetSize > MAX_UPDATE_BYTES
  ) {
    throw new Error('This release has no valid installer size for a verified download.');
  }
  if (
    version.length > 100 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(
      version,
    )
  ) {
    throw new Error('Invalid update version.');
  }
  if (source === 'installer-feed') {
    const shape = new RegExp(
      `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}-${escapeRegExp(version)}-(?:${INSTALLER_SUFFIXES.map(escapeRegExp).join('|')})$`,
    );
    if (!assetName || !shape.test(assetName) || assetName.includes('..') || !downloadUrl)
      throw new Error('Invalid update installer.');
  } else {
    const names = product.artifactPrefixes.flatMap((prefix) =>
      INSTALLER_SUFFIXES.map((suffix) => `${prefix}-${version}-${suffix}`),
    );
    if (!assetName || !names.includes(assetName) || !downloadUrl)
      throw new Error('Invalid update installer.');
  }
  const feed = updateFeedOf(product);
  if (source === 'installer-feed' || feed.kind === 'url') {
    // A private edition's manifest names the installer by its https URL; the trusted digest and
    // size above (from that fixed-address manifest) are what make the download verifiable.
    if (!httpsAddress(downloadUrl) || basename(new URL(downloadUrl).pathname) === '')
      throw new Error('The update installer address is not a secure web address.');
    return {
      version,
      assetName,
      url: downloadUrl,
      tag: '',
      size: assetSize,
      sha256: assetSha256.toLowerCase(),
      repositories: [],
      userAgent: `${product.artifactPrefixes[0]}-Updater`,
      feed: 'url',
    };
  }
  const tag = [version, `v${version}`].find((candidate) =>
    REPOSITORIES.some(
      (repo) => release.releaseUrl === `https://github.com/${repo}/releases/tag/${candidate}`,
    ),
  );
  if (
    !tag ||
    !REPOSITORIES.some(
      (repo) => downloadUrl === `https://github.com/${repo}/releases/download/${tag}/${assetName}`,
    )
  ) {
    throw new Error('The update installer is not from the expected GitHub release.');
  }
  return {
    version,
    assetName,
    url: downloadUrl,
    tag,
    size: assetSize,
    sha256: assetSha256.toLowerCase(),
    repositories: REPOSITORIES,
    userAgent: `${product.artifactPrefixes[0]}-Updater`,
  };
}

function permittedUrl(value: string, spec: DownloadSpec): boolean {
  // URL feed: the installer (and any CDN redirect) only needs to be https; the SHA-256 and size
  // from the manifest are verified before the file is used.
  if (spec.feed === 'url') return httpsAddress(value);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash)
      return false;
    if (url.hostname === 'github.com') {
      return (
        !url.search &&
        spec.repositories.some(
          (repo) => url.pathname === `/${repo}/releases/download/${spec.tag}/${spec.assetName}`,
        )
      );
    }
    return (
      ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
        url.hostname,
      ) && /^\/github-production-release-asset(?:-[a-zA-Z0-9]+)?\//.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    operation
      .then(resolvePromise, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function secureDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory) || dirname(directory) === directory)
    throw new Error('Invalid update staging directory.');
  // Check existing ancestors before mkdir too: never create files through a junction/symlink.
  await assertNoLinkedParents(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoLinkedParents(directory);
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('Update staging is not a private app-owned directory.');
  }
  await chmod(directory, 0o700);
}

async function assertNoLinkedParents(directory: string): Promise<void> {
  for (let path = directory; ; path = dirname(path)) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('Update staging contains an unsafe filesystem link.');
    if (dirname(path) === path) break;
  }
}

async function hashFile(path: string, size: number, signal?: AbortSignal): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== size) {
    throw new Error('The downloaded installer is missing, linked or has an unexpected size.');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.nlink !== 1 ||
      opened.size !== size
    ) {
      throw new Error('The downloaded installer changed during verification.');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let received = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      received += bytesRead;
      if (received > size) throw new Error('The downloaded installer changed during verification.');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (received !== size) throw new Error('The downloaded installer is incomplete.');
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

/** Rehash immediately before installer handoff; never trust a previously verified cache by existence. */
export async function verifyDownloadedRelease(
  artifact: DownloadedRelease,
  release: DesktopRelease,
  options: { signal?: AbortSignal; source?: DownloadSource } = {},
): Promise<void> {
  const spec = specFor(release, options.source);
  if (
    artifact.version !== spec.version ||
    artifact.assetName !== spec.assetName ||
    artifact.sha256 !== spec.sha256 ||
    artifact.size !== spec.size ||
    !isAbsolute(artifact.filePath) ||
    basename(artifact.filePath) !== `${spec.sha256}-${spec.assetName}`
  ) {
    throw new Error('The downloaded installer does not match the selected release.');
  }
  await assertNoLinkedParents(dirname(artifact.filePath));
  if ((await hashFile(artifact.filePath, spec.size, options.signal)) !== spec.sha256) {
    throw new Error('The downloaded installer failed SHA-256 verification. Download it again.');
  }
}

interface Job {
  promise: Promise<DownloadedRelease>;
  observers: Set<NonNullable<DownloadOptions['onProgress']>>;
}
const pending = new Map<string, Job>();

/** The first caller owns cancellation; concurrent callers join the same validated download. */
export function downloadRelease(
  release: DesktopRelease,
  options: DownloadOptions,
): Promise<DownloadedRelease> {
  try {
    options.signal?.throwIfAborted();
    const spec = specFor(release, options.source);
    if (!isAbsolute(options.directory)) throw new Error('Invalid update staging directory.');
    const directory = resolve(options.directory);
    const key = join(directory, `${spec.sha256}-${spec.assetName}`);
    const existing = pending.get(key);
    if (existing) {
      if (options.onProgress) existing.observers.add(options.onProgress);
      return existing.promise;
    }
    const observers: Job['observers'] = new Set(options.onProgress ? [options.onProgress] : []);
    const promise = performDownload(release, spec, directory, options, (progress) => {
      for (const observer of observers) observer(progress);
    }).finally(() => {
      pending.delete(key);
      observers.clear();
    });
    pending.set(key, { promise, observers });
    return promise;
  } catch (error) {
    return Promise.reject(error);
  }
}

async function performDownload(
  release: DesktopRelease,
  spec: DownloadSpec,
  directory: string,
  options: DownloadOptions,
  progress: (value: DownloadProgress) => void,
): Promise<DownloadedRelease> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('The update download timed out. Try again.')),
    options.timeoutMs ?? TIMEOUT_MS,
  );
  timeout.unref();
  const signal = controller.signal;
  const fetch = options.fetch ?? globalThis.fetch;
  const artifact: DownloadedRelease = {
    filePath: join(directory, `${spec.sha256}-${spec.assetName}`),
    sha256: spec.sha256,
    version: spec.version,
    assetName: spec.assetName,
    size: spec.size,
  };
  const partial = join(directory, `${randomUUID()}.part`);
  let file: FileHandle | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let response: Response | null = null;
  let createdReady = false;
  try {
    if (options.signal?.aborted) forwardAbort();
    signal.throwIfAborted();
    await secureDirectory(directory);
    const cached = await lstat(artifact.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (cached) {
      if (!cached.isFile() || cached.isSymbolicLink() || cached.nlink !== 1)
        throw new Error('Unsafe cached installer link.');
      try {
        await verifyDownloadedRelease(artifact, release, { signal, source: options.source });
      } catch (error) {
        if (!signal.aborted) await unlink(artifact.filePath);
        throw error;
      }
      progress({ receivedBytes: spec.size, totalBytes: spec.size });
      return artifact;
    }
    let url = spec.url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (!permittedUrl(url, spec))
        throw new Error('The update download was redirected to an untrusted address.');
      response = await abortable(
        fetch(url, {
          redirect: 'manual',
          credentials: 'omit',
          signal,
          headers: { Accept: 'application/octet-stream', 'User-Agent': spec.userAgent },
        }),
        signal,
      );
      if (response.url && !permittedUrl(response.url, spec))
        throw new Error('Unexpected update download address.');
      if (!REDIRECTS.has(response.status)) break;
      const target = response.headers.get('location');
      if (response.body) await abortable(response.body.cancel(), signal);
      if (!target || redirects === 5)
        throw new Error('The update download returned too many or invalid redirects.');
      url = new URL(target, url).href;
      response = null;
    }
    if (!response || response.status !== 200 || !response.body)
      throw new Error('The update could not be downloaded. Try again.');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== spec.size) {
      await abortable(response.body.cancel(), signal);
      throw new Error('The installer size does not match the release.');
    }
    file = await open(partial, 'wx', 0o600);
    reader = response.body.getReader();
    const hash = createHash('sha256');
    let received = 0;
    let lastProgressAt = 0;
    progress({ receivedBytes: 0, totalBytes: spec.size });
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > spec.size) throw new Error('The update installer exceeds its expected size.');
      hash.update(chunk.value);
      let written = 0;
      while (written < chunk.value.byteLength) {
        const result = await file.write(chunk.value, written, chunk.value.byteLength - written);
        if (!result.bytesWritten) throw new Error('Could not write the update installer.');
        written += result.bytesWritten;
      }
      const now = Date.now();
      if (now - lastProgressAt >= 100) {
        progress({ receivedBytes: received, totalBytes: spec.size });
        lastProgressAt = now;
      }
    }
    if (received !== spec.size) throw new Error('The update installer download is incomplete.');
    if (hash.digest('hex') !== spec.sha256)
      throw new Error('The update installer failed SHA-256 verification. Download it again.');
    await file.sync();
    await file.close();
    file = null;
    signal.throwIfAborted();
    await rename(partial, artifact.filePath);
    createdReady = true;
    await verifyDownloadedRelease(artifact, release, { signal, source: options.source });
    progress({ receivedBytes: received, totalBytes: spec.size });
    return artifact;
  } catch (error) {
    if (createdReady) await unlink(artifact.filePath).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
    if (reader) {
      // Cancellation of an unresponsive network source must not hold the host operation gate.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else {
      void response?.body?.cancel().catch(() => undefined);
    }
    await file?.close().catch(() => undefined);
    await unlink(partial).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

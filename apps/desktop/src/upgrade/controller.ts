// "Install EzyChat Enterprise" from Lite (design §5.7): fetch the product's fixed installer manifest,
// download this computer's installer with the updater's verified download (https only, size + SHA-256
// from the manifest), then start the normal installer (no silent install). The renderer passes no URL
// or path. No electron import: main.ts injects the launcher.
import type { DesktopRelease, DesktopUpgradeState } from '@ezychat/shared';
import type { DownloadedRelease, DownloadOptions } from '../updater/download.js';
import { parseInstallerManifest } from './manifest.js';

const TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export interface UpgradeDeps {
  /** product.upgradeInstallerFeed; null hides the feature. */
  feed: string | null;
  /** Only the computer that runs the server may download and start an installer. */
  isHost(): boolean;
  platform: NodeJS.Platform;
  arch: string;
  /** Private staging folder (Lite's update folder). */
  directory: string;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
  download(release: DesktopRelease, options: DownloadOptions): Promise<DownloadedRelease>;
  /** Starts the downloaded installer (Windows: the exe, detached; macOS: opens the dmg). */
  launch(filePath: string): Promise<void>;
  onChanged?(state: DesktopUpgradeState): void;
  log?(fields: Record<string, unknown>): void;
}

/** Short error codes; the web turns them into words. */
export type UpgradeError = 'network' | 'invalid' | 'no_installer' | 'download' | 'launch';

async function readManifest(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_MANIFEST_BYTES) throw new Error('invalid');
  const text = await response.text();
  if (text.length > MAX_MANIFEST_BYTES) throw new Error('invalid');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid');
  }
}

export class UpgradeInstaller {
  private state: DesktopUpgradeState;
  private abort: AbortController | null = null;

  constructor(private readonly deps: UpgradeDeps) {
    this.state = {
      available: false,
      status: 'idle',
      version: null,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
    };
  }

  private available(): boolean {
    return !!this.deps.feed && this.deps.isHost();
  }

  getState(): DesktopUpgradeState {
    return { ...this.state, available: this.available() };
  }

  private set(patch: Partial<DesktopUpgradeState>): DesktopUpgradeState {
    this.state = { ...this.state, ...patch };
    const state = this.getState();
    this.deps.onChanged?.(state);
    return state;
  }

  private failed(error: UpgradeError, controller: AbortController): DesktopUpgradeState {
    if (this.abort !== controller) return this.getState(); // cancelled meanwhile
    this.abort = null;
    this.deps.log?.({ mod: 'upgrade', event: 'failed', error });
    return this.set({ status: 'error', error });
  }

  async install(): Promise<DesktopUpgradeState> {
    if (!this.available()) throw new Error('The installer is not available on this computer');
    if (this.abort) return this.getState(); // already checking or downloading
    const controller = new AbortController();
    this.abort = controller;
    this.set({ status: 'checking', error: null, downloadedBytes: 0, totalBytes: null });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let manifest: unknown;
    try {
      const response = await (this.deps.fetch ?? globalThis.fetch)(this.deps.feed!, {
        headers: { Accept: 'application/json', 'User-Agent': this.deps.userAgent },
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) return this.failed('network', controller);
      manifest = await readManifest(response);
    } catch (error) {
      return this.failed(
        error instanceof Error && error.message === 'invalid' ? 'invalid' : 'network',
        controller,
      );
    } finally {
      clearTimeout(timer);
    }
    if (this.abort !== controller) return this.getState();
    const parsed = parseInstallerManifest(manifest, this.deps);
    if (!parsed.ok) return this.failed(parsed.error, controller);
    const release = parsed.release;
    this.set({
      status: 'downloading',
      version: release.version,
      totalBytes: release.assetSize ?? null,
    });
    let artifact: DownloadedRelease;
    try {
      artifact = await this.deps.download(release, {
        directory: this.deps.directory,
        signal: controller.signal,
        source: 'installer-feed',
        onProgress: (p) => {
          if (this.abort === controller)
            this.set({ downloadedBytes: p.receivedBytes, totalBytes: p.totalBytes });
        },
      });
    } catch {
      return this.failed('download', controller);
    }
    if (this.abort !== controller) return this.getState();
    try {
      await this.deps.launch(artifact.filePath);
    } catch {
      return this.failed('launch', controller);
    }
    this.abort = null;
    this.deps.log?.({ mod: 'upgrade', event: 'started', version: release.version });
    return this.set({ status: 'started' });
  }

  cancel(): DesktopUpgradeState {
    const controller = this.abort;
    if (!controller) return this.getState();
    this.abort = null;
    controller.abort();
    return this.set({ status: 'idle', downloadedBytes: 0, totalBytes: null, error: null });
  }
}

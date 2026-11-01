// The installer manifest of the edition Lite upgrades to (product.upgradeInstallerFeed, design §5.7):
//   { version, assets: [{ name, url, sha256, size }] }   (the same shape as a private edition's update feed)
// The installer for this computer is the asset named `<prefix>-<version>-<os>-<arch>.<ext>`; its https URL,
// SHA-256 and size come from this fixed-address manifest only. Pure: no electron import.
import type { DesktopRelease } from '@ezychat/shared';
import { escapeRegExp } from '../product.js';
import { MAX_UPDATE_BYTES } from '../updater/download.js';

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

/** Installer suffix for this computer, or null when the edition ships none (e.g. Linux). */
export function installerSuffix(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return 'win-x64.exe';
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return `mac-${arch}.dmg`;
  return null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export type ManifestResult =
  { ok: true; release: DesktopRelease } | { ok: false; error: 'invalid' | 'no_installer' };

/** Picks this computer's verified installer from the manifest. */
export function parseInstallerManifest(
  value: unknown,
  o: { platform: NodeJS.Platform; arch: string },
): ManifestResult {
  const item =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!item || typeof item.version !== 'string' || item.version.length > 100)
    return { ok: false, error: 'invalid' };
  if (!Array.isArray(item.assets) || item.assets.length > 50)
    return { ok: false, error: 'invalid' };
  const version = item.version.startsWith('v') ? item.version.slice(1) : item.version;
  if (!VERSION.test(version)) return { ok: false, error: 'invalid' };
  const suffix = installerSuffix(o.platform, o.arch);
  if (!suffix) return { ok: false, error: 'no_installer' };
  const name = new RegExp(
    `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}-${escapeRegExp(version)}-${escapeRegExp(suffix)}$`,
  );
  for (const raw of item.assets) {
    const asset = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!asset || typeof asset.name !== 'string' || !name.test(asset.name)) continue;
    if (asset.name.includes('..')) continue;
    const url = httpsUrl(asset.url);
    const size = asset.size;
    const sha256 = asset.sha256;
    if (
      !url ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_UPDATE_BYTES ||
      typeof sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(sha256)
    )
      continue;
    return {
      ok: true,
      release: {
        version,
        name: asset.name,
        notes: '',
        publishedAt: '',
        prerelease: version.includes('-'),
        releaseUrl: '',
        downloadUrl: url,
        assetName: asset.name,
        assetSize: size,
        assetSha256: sha256.toLowerCase(),
      },
    };
  }
  return { ok: false, error: 'no_installer' };
}

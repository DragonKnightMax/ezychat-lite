// Lite after its number moved to Enterprise (design §5.6): the server exits 4 on a data folder with
// moved.json, and the desktop shows the moved screen. Pure helpers (no electron import).
import { posix, win32 } from 'node:path';

/** Opened when no installed Enterprise app is found on this computer. */
export const ENTERPRISE_PAGE_URL = 'https://ezychat.ai/enterprise';

const PRODUCT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;

/** The product named in `<data>/moved.json` (e.g. "EzyChat Enterprise"), or null when unreadable. */
export function movedProductName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { to?: unknown; product?: unknown } | null;
    if (!value || value.to !== 'enterprise' || typeof value.product !== 'string') return null;
    return PRODUCT_NAME.test(value.product) && !value.product.includes('..') ? value.product : null;
  } catch {
    return null;
  }
}

/**
 * Where an installed copy of that product usually is: Windows per-machine (Program Files) and
 * per-user (Local\Programs) installs, macOS /Applications and ~/Applications.
 */
export function installedAppCandidates(
  productName: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!PRODUCT_NAME.test(productName) || productName.includes('..')) return [];
  if (platform === 'win32') {
    const exe = `${productName}.exe`;
    return [
      env.ProgramFiles && win32.join(env.ProgramFiles, productName, exe),
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', productName, exe),
    ].filter((p): p is string => !!p);
  }
  if (platform === 'darwin') {
    return [
      posix.join('/Applications', `${productName}.app`),
      env.HOME && posix.join(env.HOME, 'Applications', `${productName}.app`),
    ].filter((p): p is string => !!p);
  }
  return [];
}

export type MovedChoice = 'open' | 'use-lite' | 'close';

/** Maps the moved dialog's button index (Open, Use Lite again, Close) to a choice. */
export function movedChoice(response: number): MovedChoice {
  if (response === 0) return 'open';
  if (response === 1) return 'use-lite';
  return 'close';
}

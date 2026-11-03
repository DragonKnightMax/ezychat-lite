import { release } from 'node:os';
import type { FeedbackServerDiagnostics } from '@ezychat/shared';
import type { AppContext } from '../context.js';

/** A friendly computer name and system version, e.g. Windows 11 / 10.0.26100, macOS / 15.3. */
export function osDetails(
  platform: NodeJS.Platform = process.platform,
  kernel: string = release(),
): { os: string; osVersion: string } {
  const [major = 0, minor = 0] = kernel.split('.').map((n) => Number.parseInt(n, 10) || 0);
  if (platform === 'win32') {
    const build = Number.parseInt(kernel.split('.')[2] ?? '0', 10) || 0;
    return { os: build >= 22000 ? 'Windows 11' : 'Windows 10', osVersion: kernel };
  }
  if (platform === 'darwin') {
    // Darwin 20–24 = macOS 11–15; Darwin 25 = macOS 26 (the year numbering).
    const mac = major >= 25 ? `${major + 1}` : major >= 20 ? `${major - 9}` : `10.${major - 4}`;
    return { os: 'macOS', osVersion: major >= 20 ? `${mac}.${minor}` : mac };
  }
  if (platform === 'linux') return { os: 'Linux', osVersion: kernel };
  return { os: platform, osVersion: kernel };
}

/** `off`, or the mode of a working AI connection (`api`, `chatgpt`, `claude`). Never a key. */
function aiMode(ctx: AppContext): string {
  try {
    const status = ctx.services.ai?.status();
    if (!status || status.connection.state !== 'connected') return 'off';
    return status.settings.mode;
  } catch {
    return 'off';
  }
}

/** The app details the server knows; the browser adds client, language, time zone and screen. */
export function serverDiagnostics(ctx: AppContext): FeedbackServerDiagnostics {
  return {
    edition: ctx.edition === 'lite' ? 'lite' : 'enterprise',
    version: ctx.config.version,
    ...osDetails(),
    mode: ctx.config.mode,
    waConnected: ctx.wa.status.state === 'open',
    aiMode: aiMode(ctx),
  };
}

/**
 * The app path of the screen without anything that names a person: segments with an `@` (chat
 * ids), long numbers, or encoded values become `:id`; the query and hash are dropped.
 */
export function cleanScreen(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? '';
  const parts = bare
    .split('/')
    .map((part) =>
      /@|%40|%2b|\d{5,}|^\+/i.test(part) || part.length > 40
        ? ':id'
        : part.replace(/[^\w.:-]/g, ''),
    );
  const out = parts.join('/');
  return (out.startsWith('/') ? out : `/${out}`).slice(0, 200);
}

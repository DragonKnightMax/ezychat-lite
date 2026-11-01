// Pure startup / supervision decisions (no electron import; unit tested).
import type { ServiceState } from './service/windows.js';

export type StartupAction =
  /** a server already answers: connect to it */
  | 'client'
  /** the OS service is installed but not answering: never start a standalone server on the
   *  (now empty) user data dir, which would also take the service's port — wait for / offer to
   *  start the service instead */
  | 'wait-for-service'
  /** no service: run the server inside the app */
  | 'standalone';

export function decideStartup(serverAnswers: boolean, serviceState: ServiceState): StartupAction {
  if (serverAnswers) return 'client';
  if (serviceState !== 'not-installed') return 'wait-for-service';
  return 'standalone';
}

/**
 * How long to wait for an installed service that is not answering yet. A running service may
 * still be booting. A stopped one shortly after boot may be an automatic service that the OS has
 * not launched yet (it can start after the user logs on) — wait for it instead of showing an
 * error at once.
 */
export function serviceWaitMs(serviceState: ServiceState, uptimeSeconds: number): number {
  if (serviceState === 'running') return 60_000;
  if (serviceState === 'stopped' && uptimeSeconds < 600) return 180_000;
  return 0;
}

/** Server exit code for a data folder whose WhatsApp number moved to another edition (moved.json). */
export const MOVED_EXIT_CODE = 4;

/**
 * Server exit codes the desktop must not restart: 2 = invalid arguments, 3 = the data dir is
 * locked by another server process (restarting would loop forever), 4 = the number moved to
 * another edition (the desktop shows the moved screen instead).
 */
export function isRestartableExit(code: number): boolean {
  return code !== 2 && code !== 3 && code !== MOVED_EXIT_CODE;
}

/** Parses the port file written by server-host ({ port, pid }); null when invalid. */
export function parsePortFile(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { port?: unknown } | null;
    const p = v?.port;
    return typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

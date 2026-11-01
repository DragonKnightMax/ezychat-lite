// Hand-over (design §5.3 step 3): mark Lite's folder as moved, then rename its WhatsApp folders, so
// even an old Lite that ignores the marker can only show a QR, never connect with stale keys.
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { MOVED_SUFFIX, authFolders, movedMarkerPath, writeMovedMarker } from '../moved.js';

export interface Handover {
  /** Folders renamed (live names, relative to Lite's folder). */
  renamed: string[];
  /** Puts everything back as it was: names first, the marker last. Best effort, never throws. */
  undo(): void;
}

export interface HandoverOptions {
  liteDataDir: string;
  product: string;
  version: string;
  log: Logger;
  now?: () => number;
  /** Test hook: runs after each completed part ('marker', then each renamed folder). */
  afterPart?: (part: string) => void;
}

/** Writes the marker and renames the WhatsApp folders; undoes its own part on failure and rethrows. */
export function handOver(opts: HandoverOptions): Handover {
  const { liteDataDir: dir, log } = opts;
  const renamed: string[] = [];
  let marker = false;
  const undo = () => {
    for (const rel of [...renamed].reverse()) {
      const live = join(dir, rel);
      try {
        if (!existsSync(live)) renameSync(live + MOVED_SUFFIX, live);
      } catch (err) {
        log.error({ err, step: 'handover_undo', part: rel }, 'hand-over undo failed');
      }
    }
    renamed.length = 0;
    if (marker) {
      try {
        rmSync(movedMarkerPath(dir), { force: true });
      } catch (err) {
        log.error({ err, step: 'handover_undo', part: 'marker' }, 'hand-over undo failed');
      }
      marker = false;
    }
  };
  try {
    const at = new Date((opts.now ?? Date.now)()).toISOString();
    writeMovedMarker(dir, { to: 'enterprise', product: opts.product, at, version: opts.version });
    marker = true;
    opts.afterPart?.('marker');
    for (const rel of authFolders(dir)) {
      const live = join(dir, rel);
      renameSync(live, live + MOVED_SUFFIX);
      renamed.push(rel);
      opts.afterPart?.(rel);
    }
  } catch (err) {
    undo();
    throw err;
  }
  log.info({ step: 'handover', folders: renamed.length }, 'lite import hand-over done');
  return { renamed: [...renamed], undo };
}

// Hand-over (design §5.3 step 3): mark Lite's folder as moved, release its own address when it moved
// too, then rename its WhatsApp folders, so even an old Lite that ignores the marker can only show a
// QR, never connect with stale keys, and never run the tunnel the target now runs.
import Database from 'better-sqlite3';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { MOVED_SUFFIX, authFolders, movedMarkerPath, writeMovedMarker } from '../moved.js';
import { releaseLiteAddress } from './merge-address.js';

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
  /** Lite's own address moved to the target (merge): turn it off in Lite's settings. */
  releaseAddress?: boolean;
  /** Test hook: runs after each completed part ('marker', 'address', then each renamed folder). */
  afterPart?: (part: string) => void;
}

/** Writes the marker and renames the WhatsApp folders; undoes its own part on failure and rethrows. */
export function handOver(opts: HandoverOptions): Handover {
  const { liteDataDir: dir, log } = opts;
  const renamed: string[] = [];
  let marker = false;
  let undoAddress: ((db: Database.Database) => void) | null = null;
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
    if (undoAddress) {
      try {
        withLiteDb(dir, undoAddress);
      } catch (err) {
        log.error({ err, step: 'handover_undo', part: 'address' }, 'hand-over undo failed');
      }
      undoAddress = null;
    }
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
    if (opts.releaseAddress) {
      undoAddress = withLiteDb(dir, releaseLiteAddress);
      opts.afterPart?.('address');
    }
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
  log.info(
    { step: 'handover', folders: renamed.length, addressReleased: Boolean(opts.releaseAddress) },
    'lite import hand-over done',
  );
  return { renamed: [...renamed], undo };
}

/**
 * Runs `fn` on Lite's own database, opened without migrating it (Lite may be older than this
 * build and must still open its folder after "Use EzyChat Lite again"). Lite is stopped here.
 */
function withLiteDb<T>(dir: string, fn: (db: Database.Database) => T): T {
  const db = new Database(join(dir, 'app.db'));
  try {
    db.pragma('busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

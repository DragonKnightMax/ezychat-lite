// Checks before an import (design §5.2). Each failing check is a LiteImportRefused with one code.
import { statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { latestMigration } from '../db/migrate.js';
import { LockedError, acquireLock } from '../lock.js';
import { LiteImportRefused } from './errors.js';

/** The newest core migration this build ships (its `user_version` after start). */
export function newestCoreMigration(): number {
  return latestMigration();
}

/** Lite's schema must not be newer than this build's (migrations only run forward). */
export function checkSchema(liteVersion: number, newest: number = newestCoreMigration()): void {
  if (liteVersion > newest) throw new LiteImportRefused('lite_newer');
}

/** Free bytes on the volume of `path` (or of its nearest existing parent). */
export function freeBytes(path: string): number {
  let p = resolve(path);
  for (;;) {
    try {
      const s = statfsSync(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch (err) {
      const parent = dirname(p);
      if (parent === p) throw err;
      p = parent;
    }
  }
}

/** Free space beside the target must hold the copy with 10 % to spare. */
export function checkDisk(
  targetDataDir: string,
  neededBytes: number,
  free = freeBytes(targetDataDir),
): void {
  if (free < neededBytes * 1.1) throw new LiteImportRefused('disk');
}

/**
 * Takes Lite's `server.lock` for the whole import, so Lite cannot start while its files are read
 * and handed over; a live Lite holding it refuses the import (`lite_running`).
 */
export function lockLite(liteDataDir: string): { release(): void } {
  try {
    return acquireLock(liteDataDir);
  } catch (err) {
    if (err instanceof LockedError) throw new LiteImportRefused('lite_running');
    throw err;
  }
}

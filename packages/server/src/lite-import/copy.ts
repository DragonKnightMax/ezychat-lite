// Copy mode (design §5.3/§5.4): this install has no chats yet, so Lite's whole data folder becomes
// it. Everything is staged in `<target>.importing` beside the target and verified before Lite's
// folder is handed over; the staging folder replaces the target only at the end. Any failure before
// that deletes the staging folder and undoes the hand-over: Lite is left as it was.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LiteImportProgress, LiteSummary } from '@ezychat/shared';
import type { Logger } from 'pino';
import { COPIED_ITEMS, copyTree, pathBytes } from './files.js';
import { handOver, type Handover } from './handover.js';
import { withLiteDb } from './summary.js';

export const STAGING_SUFFIX = '.importing';

export interface CopyOptions {
  targetDataDir: string;
  liteDataDir: string;
  summary: LiteSummary;
  product: string;
  version: string;
  log: Logger;
  progress: (p: LiteImportProgress) => void;
  /** Writes the notice and audit row into the staged copy (before the hand-over). */
  finishStaged: (stagingDir: string) => void;
  now?: () => number;
  /** Test hook: throws to simulate a failure at that point. */
  fault?: (point: string) => void;
}

/** Removes a folder, retrying briefly (Windows may still hold a just-closed file). */
function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Lite's db into `<staging>/app.db` with VACUUM INTO (consistent, no WAL), then the files. */
function stage(opts: CopyOptions, staging: string): void {
  const { liteDataDir, log, progress } = opts;
  const t0 = Date.now();
  const total = opts.summary.totalBytes;
  let done = 0;
  let lastPct = -1;
  const tick = (n: number) => {
    done += n;
    const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
    if (pct !== lastPct) {
      lastPct = pct;
      progress({ step: 'copy', state: 'running', done: Math.min(done, total), total });
    }
  };
  progress({ step: 'copy', state: 'running', done: 0, total });
  withLiteDb(liteDataDir, (src) => src.prepare('VACUUM INTO ?').run(join(staging, 'app.db')));
  tick(pathBytes(join(staging, 'app.db')));
  opts.fault?.('db');
  let files = 0;
  for (const item of COPIED_ITEMS)
    files += copyTree(join(liteDataDir, item), join(staging, item), tick);
  opts.fault?.('files');
  progress({ step: 'copy', state: 'done', done: total, total });
  log.info({ step: 'copy', files, bytes: done, ms: Date.now() - t0 }, 'lite import copy done');
}

/** The copy must be a sound database of Lite's schema with Lite's WhatsApp link. */
function verify(opts: CopyOptions, staging: string): void {
  const t0 = Date.now();
  opts.progress({ step: 'verify', state: 'running' });
  const db = new Database(join(staging, 'app.db'), { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error('copied database failed the integrity check');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version !== opts.summary.schemaVersion)
      throw new Error('copied database has another schema version');
  } finally {
    db.close();
  }
  const creds = join('wa-auth', 'creds.json');
  if (existsSync(join(opts.liteDataDir, creds)) && !existsSync(join(staging, creds)))
    throw new Error('copied WhatsApp link is missing');
  opts.fault?.('verify');
  opts.progress({ step: 'verify', state: 'done' });
  opts.log.info({ step: 'verify', ms: Date.now() - t0 }, 'lite import verify done');
}

/** Runs the copy; on success the target folder holds Lite's data and Lite's folder is marked moved. */
export function copyLite(opts: CopyOptions): void {
  const { targetDataDir: target, log } = opts;
  const now = opts.now ?? Date.now;
  const staging = target + STAGING_SUFFIX;
  if (existsSync(staging)) removeDir(staging); // left by an earlier failed attempt
  mkdirSync(staging, { recursive: true });
  let handover: Handover | null = null;
  let asideDir: string | null = null;
  try {
    stage(opts, staging);
    verify(opts, staging);
    opts.finishStaged(staging);
    opts.progress({ step: 'handover', state: 'running' });
    handover = handOver({
      liteDataDir: opts.liteDataDir,
      product: opts.product,
      version: opts.version,
      log,
      now,
      afterPart: (part) => opts.fault?.(`handover:${part}`),
    });
    if (existsSync(target)) {
      // An install that was never used (no chats): kept beside, never deleted.
      asideDir = `${target}.empty-${now()}`;
      renameSync(target, asideDir);
      log.info(
        { step: 'handover', movedAside: true },
        'lite import moved the empty data folder aside',
      );
    }
    opts.fault?.('rename');
    renameSync(staging, target);
    opts.progress({ step: 'handover', state: 'done' });
  } catch (err) {
    log.error({ err, step: 'rollback' }, 'lite import copy failed, rolling back');
    if (asideDir && !existsSync(target)) {
      try {
        renameSync(asideDir, target);
      } catch (e) {
        log.error({ err: e, step: 'rollback' }, 'could not put the data folder back');
      }
    }
    handover?.undo();
    try {
      removeDir(staging);
    } catch (e) {
      log.error({ err: e, step: 'rollback' }, 'could not delete the staging folder');
    }
    throw err;
  }
}

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LiteImportPlan, LiteImportProgress, LiteImportResult } from '@ezychat/shared';
import { SecretBox } from '../crypto/secret.js';
import { openDb, type DB } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { inboxAuthDir } from '../inboxes/repo.js';
import type { Logger } from '../logger.js';
import { checkDisk, checkSchema, newestCoreMigration } from './checks.js';
import { LiteImportRefused } from './errors.js';
import { copyTree } from './files.js';
import {
  checkInboxSlot,
  checkSameNumber,
  liteNumber,
  liteOwnJid,
  mergeBytes,
  openReadOnly,
  userVersion,
} from './merge-checks.js';
import { mergeTables } from './merge-tables.js';

export interface MergeOptions {
  targetDataDir: string;
  liteDataDir: string;
  plan: LiteImportPlan;
  maxInboxes: number;
  log: Logger;
  progress: (p: LiteImportProgress) => void;
  /**
   * Gets an undo for the committed merge (restores the pre-import backup, deletes the copied
   * folders). The caller runs it when the hand-over after the merge fails, so Lite and this install
   * never both keep the number. Call it only while the target's server is stopped.
   */
  onCommitted?: (undo: () => void) => void;
}

/** Work folder under the target; deleted after every run. */
export const WORK_DIR = 'lite-import-work';

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Lite's key, read directly (never `loadOrCreate`: nothing is ever written to Lite's folder). */
function readLiteSecret(liteDataDir: string): SecretBox | null {
  const file = join(liteDataDir, 'secret.key');
  if (!existsSync(file)) return null;
  try {
    return SecretBox.fromKey(readFileSync(file));
  } catch {
    return null;
  }
}

/** A path for a pre-import backup that does not exist yet. */
function backupPath(targetDataDir: string, now: Date): string {
  const dir = join(targetDataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const base = `app-pre-import-${stamp(now)}`;
  for (let i = 1; ; i++) {
    const file = join(dir, `${i === 1 ? base : `${base}-${i}`}.db`);
    if (!existsSync(file)) return file;
  }
}

/**
 * Merges a Lite data folder into a target data folder that already has data, as a new inbox
 * (design §5.8). The target's server must be stopped. Checks throw `LiteImportRefused` before
 * anything changes; any other failure rolls everything back (the target database is unchanged,
 * the copied WhatsApp and media folders and the work folder are deleted) and rethrows.
 * Lite's folder is only read. The moved marker is the caller's.
 */
export async function mergeLiteInbox(opts: MergeOptions): Promise<LiteImportResult> {
  const log = opts.log.child({ mod: 'lite-import' });
  const started = Date.now();
  const { targetDataDir, liteDataDir } = opts;
  const step = (s: LiteImportProgress['step'], state: LiteImportProgress['state'], extra = {}) =>
    opts.progress({ step: s, state, ...extra });
  const work = join(targetDataDir, WORK_DIR);
  const created: string[] = [];
  let liteCopy: DB | null = null;
  let target: DB | null = null;
  let current: LiteImportProgress['step'] = 'migrate';
  try {
    // ── Checks that change nothing ──────────────────────────────────────────────────────────
    step('migrate', 'running');
    const liteFile = join(liteDataDir, 'app.db');
    const targetFile = join(targetDataDir, 'app.db');
    const core = newestCoreMigration();
    const liteSrc = openReadOnly(liteFile);
    let liteVersion: number;
    try {
      liteVersion = userVersion(liteSrc);
    } finally {
      liteSrc.close();
    }
    // Lite may be a few versions older, never newer than what the target runs.
    checkSchema(liteVersion, core);
    const targetSrc = openReadOnly(targetFile);
    try {
      if (userVersion(targetSrc) > core)
        throw new Error('the target data is newer than this build');
      checkInboxSlot(targetSrc, opts.maxInboxes);
    } finally {
      targetSrc.close();
    }
    checkDisk(targetDataDir, mergeBytes(targetDataDir, liteDataDir));
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const liteSnap = openReadOnly(liteFile);
    try {
      liteSnap.exec(`VACUUM INTO ${sqlString(join(work, 'lite.db'))}`);
    } finally {
      liteSnap.close();
    }

    // ── 1. Prepare: migrate Lite's copy up to the target's core version ─────────────────────
    liteCopy = new Database(join(work, 'lite.db'));
    liteCopy.pragma('foreign_keys = OFF');
    migrate(liteCopy);
    target = openDb(targetFile);
    if (userVersion(liteCopy) > userVersion(target)) throw new LiteImportRefused('lite_newer');
    // ── 2. Refusals that need both databases ────────────────────────────────────────────────
    checkSameNumber(liteCopy, target);
    checkInboxSlot(target, opts.maxInboxes);
    step('migrate', 'done');

    current = 'merge';
    step('merge', 'running');
    const now = new Date();
    const backup = backupPath(targetDataDir, now);
    target.exec(`VACUUM INTO ${sqlString(backup)}`);
    const { next: inboxId } = target
      .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM inboxes')
      .get() as { next: number };
    const ownJid = liteOwnJid(liteCopy);
    const number = liteNumber(liteCopy, ownJid);
    const inboxName = number ? `Lite – +${number}` : 'EzyChat Lite';

    // Files first (outside the transaction, deleted again on any failure). Ids are never reused,
    // so these folders can only be left over from an earlier failed run.
    const mediaPrefix = `inbox-${inboxId}/`;
    const liteMedia = join(liteDataDir, 'media');
    const copies: Array<[string, string]> = [
      [join(liteDataDir, 'wa-auth'), join(targetDataDir, inboxAuthDir(inboxId))],
      [
        join(liteMedia, 'quarantine'),
        join(targetDataDir, 'media', 'quarantine', `inbox-${inboxId}`),
      ],
    ];
    if (existsSync(liteMedia))
      for (const name of readdirSync(liteMedia))
        if (name !== 'quarantine')
          copies.push([
            join(liteMedia, name),
            join(targetDataDir, 'media', `inbox-${inboxId}`, name),
          ]);
    const mediaRoot = join(targetDataDir, 'media', `inbox-${inboxId}`);
    for (const dir of [copies[0]![1], copies[1]![1], mediaRoot]) {
      rmSync(dir, { recursive: true, force: true });
      created.push(dir);
    }
    for (const [from, to] of copies) {
      mkdirSync(join(to, '..'), { recursive: true });
      copyTree(from, to, () => {});
    }

    // ── 3. One transaction ─────────────────────────────────────────────────────────────────
    const db = target;
    const lite = liteCopy;
    const outcome = db.transaction(() => {
      const result = mergeTables({
        target: db,
        lite,
        inboxId,
        inboxName,
        ownJid,
        plan: opts.plan,
        maxAgents: opts.maxInboxes,
        liteSecret: readLiteSecret(liteDataDir),
        targetSecret: SecretBox.loadOrCreate(join(targetDataDir, 'secret.key')),
        mediaPrefix,
        now: now.getTime(),
        progress: (done, total) => step('merge', 'running', { done, total }),
      });
      step('merge', 'done');
      current = 'verify';
      step('verify', 'running');
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign key check failed (${broken.length} rows)`);
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM chats WHERE inbox_id = ?')
        .get(inboxId) as { n: number };
      if (n !== result.counts.chats) throw new Error('chat count check failed');
      return result;
    })();
    step('verify', 'done');
    const copiedDirs = [...created];
    opts.onCommitted?.(() => {
      target?.close();
      target = null;
      for (const ext of ['-wal', '-shm']) rmSync(targetFile + ext, { force: true });
      copyFileSync(backup, targetFile);
      for (const dir of copiedDirs) rmSync(dir, { recursive: true, force: true });
      log.warn({ step: 'undo', inboxId }, 'lite merge undone from the pre-import backup');
    });
    log.info(
      {
        step: 'merge',
        inboxId,
        ...outcome.counts,
        agentOff: outcome.agentOff,
        ms: Date.now() - started,
      },
      'lite merge done',
    );
    return {
      mode: 'merge',
      inboxId,
      inboxName,
      chats: outcome.counts.chats,
      usersAdded: outcome.counts.usersAdded,
      usersMatched: outcome.counts.usersMatched,
      agentImported: outcome.agentImported,
      agentOff: outcome.agentOff,
      renamedShortcuts: outcome.renamedShortcuts,
    };
  } catch (err) {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    step(current, 'failed');
    log.warn(
      { step: current, code: (err as { code?: unknown }).code ?? null, ms: Date.now() - started },
      'lite merge stopped; nothing was changed',
    );
    throw err;
  } finally {
    liteCopy?.close();
    target?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

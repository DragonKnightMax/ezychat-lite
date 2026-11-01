// `server --import-lite <liteDir> --data <target> [--import-plan <file>]` and `--lite-summary`.
// The import runs with both servers stopped: it holds Lite's and the target's `server.lock` for its
// whole run. stdout carries only JSON lines (progress, then one outcome); logs go to
// `<target>.import-logs/` with step, counts and ms only (`mod: "lite-import"`).
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LiteImportPlan,
  type LiteImportMode,
  type LiteImportNotice,
  type LiteImportOutcome,
  type LiteImportProgress,
  type LiteImportResult,
  type LiteSummary,
} from '@ezychat/shared';
import type { Logger } from 'pino';
import { SecretBox } from '../crypto/secret.js';
import { audit } from '../db/audit.js';
import { openDb } from '../db/index.js';
import { SettingsStore } from '../db/settings.js';
import { LockedError, acquireLock } from '../lock.js';
import { MCP_PATH } from '../mcp/settings.js';
import { TUNNEL_HOSTNAME_KEY, TUNNEL_MODE_KEY } from '../tunnel/manager.js';
import { checkDisk, checkSchema, lockLite } from './checks.js';
import { copyLite } from './copy.js';
import { LiteImportRefused, NoLiteDataError } from './errors.js';
import { handOver } from './handover.js';
import { mergeLiteInbox } from './merge.js';
import { writeNotice } from './notice.js';
import { readLiteSummary, withLiteDb } from './summary.js';

export interface LiteImportOptions {
  targetDataDir: string;
  liteDataDir: string;
  plan: LiteImportPlan;
  /** Most inboxes this build allows (`CliProduct.maxInboxes`). */
  maxInboxes: number;
  /** Edition doing the import (written into Lite's `moved.json`). */
  product: string;
  /** This build's version (written into Lite's `moved.json`). */
  version: string;
  log: Logger;
  progress: (p: LiteImportProgress) => void;
  now?: () => number;
  /** Test hook: throws to simulate a failure at a named point. */
  fault?: (point: string) => void;
}

/** copy when the target has no data yet (no app.db, or no chats and no linked number); else merge. */
export function chooseMode(targetDataDir: string): LiteImportMode {
  const file = join(targetDataDir, 'app.db');
  if (!existsSync(file)) return 'copy';
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const n = (sql: string): number => {
      try {
        return (db.prepare(sql).get() as { n: number }).n;
      } catch {
        return 0; // table not created yet
      }
    };
    const chats = n('SELECT COUNT(*) AS n FROM chats');
    const linked = n('SELECT COUNT(*) AS n FROM inboxes WHERE own_jid IS NOT NULL');
    return chats === 0 && linked === 0 ? 'copy' : 'merge';
  } finally {
    db.close();
  }
}

/** The address AI assistants use now, from the target's saved own-domain tunnel; null when unknown. */
function mcpUrlOf(settings: SettingsStore): string | null {
  if (settings.get<string>(TUNNEL_MODE_KEY, 'off') !== 'named') return null;
  const host = settings.get<string | null>(TUNNEL_HOSTNAME_KEY, null);
  return host ? `https://${host}${MCP_PATH}` : null;
}

/** Writes the after-import notice and the `lite.import` audit row into a data folder's db. */
function recordImport(
  dataDir: string,
  mode: LiteImportMode,
  result: LiteImportResult,
  summary: LiteSummary,
): void {
  const db = openDb(join(dataDir, 'app.db'));
  try {
    const settings = new SettingsStore(db, SecretBox.loadOrCreate(join(dataDir, 'secret.key')));
    let notice: LiteImportNotice;
    if (mode === 'merge') {
      notice = {
        checklist: {
          inboxId: result.inboxId,
          inboxName: result.inboxName,
          liteUsers: result.usersAdded + result.usersMatched,
          tokens: summary.tokens,
          items: { share: false, signin: false, notifications: false, mcp: false },
        },
        mcp: { reason: 'merge', mcpUrl: mcpUrlOf(settings) },
      };
    } else {
      // Copy keeps an own domain (its tunnel settings come along) and the LAN address (the desktop
      // takes over Lite's port); only a quick tunnel gets a new address on the next start.
      const reason = summary.remote === 'quick' ? summary.remote : null;
      notice = { checklist: null, mcp: reason ? { reason, mcpUrl: mcpUrlOf(settings) } : null };
    }
    writeNotice(settings, notice);
    audit(db, {
      userId: null,
      action: 'lite.import',
      ip: null,
      meta: {
        mode,
        inbox: result.inboxId,
        counts: {
          chats: result.chats,
          usersAdded: result.usersAdded,
          usersMatched: result.usersMatched,
          agent: result.agentImported,
        },
      },
    });
  } finally {
    db.close();
  }
}

function copyResult(summary: LiteSummary, liteDataDir: string): LiteImportResult {
  let inboxName = 'WhatsApp';
  try {
    const row = withLiteDb(
      liteDataDir,
      (db) =>
        db.prepare('SELECT name FROM inboxes WHERE id = 1').get() as { name: string } | undefined,
    );
    if (row) inboxName = row.name;
  } catch {
    // an old Lite without inboxes: the default name
  }
  return {
    mode: 'copy',
    inboxId: 1,
    inboxName,
    chats: summary.chats,
    usersAdded: 0,
    usersMatched: 0,
    agentImported: summary.aiAgents.length > 0,
    agentOff: false,
    renamedShortcuts: [],
  };
}

/** Runs the import. Throws LiteImportRefused for a failed check, NoLiteDataError, or the failure. */
export async function runLiteImport(opts: LiteImportOptions): Promise<LiteImportResult> {
  const { targetDataDir: target, liteDataDir: lite, log } = opts;
  const t0 = Date.now();
  let current: LiteImportProgress['step'] | null = null;
  const progress = (p: LiteImportProgress) => {
    current = p.state === 'running' ? p.step : null;
    opts.progress(p);
  };
  const summary = readLiteSummary(lite);
  checkSchema(summary.schemaVersion);
  const liteLock = lockLite(lite);
  let targetLock: { release(): void } | null = null;
  try {
    try {
      targetLock = acquireLock(target);
    } catch (err) {
      if (err instanceof LockedError)
        throw new Error('the EzyChat server is still running on this data folder', { cause: err });
      throw err;
    }
    const mode = chooseMode(target);
    log.info(
      { step: 'start', mode, chats: summary.chats, bytes: summary.totalBytes },
      'lite import started',
    );
    let result: LiteImportResult;
    if (mode === 'copy') {
      checkDisk(target, summary.totalBytes);
      // The target's lock must go before its folder is moved aside (Windows cannot rename it held).
      targetLock.release();
      targetLock = null;
      result = copyResult(summary, lite);
      copyLite({
        targetDataDir: target,
        liteDataDir: lite,
        summary,
        product: opts.product,
        version: opts.version,
        log,
        progress,
        now: opts.now,
        fault: opts.fault,
        finishStaged: (staging) => recordImport(staging, 'copy', result, summary),
      });
    } else {
      let undoMerge: (() => void) | null = null;
      result = await mergeLiteInbox({
        targetDataDir: target,
        liteDataDir: lite,
        plan: opts.plan,
        maxInboxes: opts.maxInboxes,
        log,
        progress,
        onCommitted: (undo) => (undoMerge = undo),
      });
      // Only after the merge committed (design §5.8 step 5). A failed hand-over undoes the merge,
      // so Lite and this install never both keep the number.
      current = 'handover';
      progress({ step: 'handover', state: 'running' });
      try {
        handOver({
          liteDataDir: lite,
          product: opts.product,
          version: opts.version,
          log,
          now: opts.now,
          afterPart: (part) => opts.fault?.(`handover:${part}`),
        });
      } catch (err) {
        (undoMerge as (() => void) | null)?.();
        throw err;
      }
      try {
        opts.fault?.('record');
        recordImport(target, 'merge', result, summary);
      } catch (err) {
        // The inbox is in; the notice is only a reminder. Lite stays handed over.
        log.error({ err, step: 'record' }, 'lite import notice not saved');
      }
      progress({ step: 'handover', state: 'done' });
    }
    log.info({ step: 'done', mode, ms: Date.now() - t0 }, 'lite import done');
    return result;
  } catch (err) {
    if (current) opts.progress({ step: current, state: 'failed' });
    throw err;
  } finally {
    targetLock?.release();
    liteLock.release();
  }
}

/** Reads and checks the merge plan file (empty plan when none is given). */
export function readPlan(file: string | undefined): LiteImportPlan {
  if (!file) return LiteImportPlan.parse({});
  return LiteImportPlan.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const line = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

/** `--lite-summary`: one JSON line; exit 0, or 2 when the folder has no app.db. */
export function liteSummaryCommand(liteDataDir: string): number {
  try {
    line(readLiteSummary(liteDataDir));
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return err instanceof NoLiteDataError ? 2 : 1;
  }
}

/**
 * `--import-lite`: progress lines and one outcome line. Exit 0 imported; 5 a check refused it;
 * 2 no Lite data or a bad plan; 1 failed (rolled back).
 */
export async function importLiteCommand(
  opts: Omit<LiteImportOptions, 'progress' | 'plan'> & { planFile?: string },
): Promise<number> {
  const outcome = (o: LiteImportOutcome) => line(o);
  let plan: LiteImportPlan;
  try {
    plan = readPlan(opts.planFile);
  } catch (err) {
    opts.log.warn({ step: 'plan', errName: (err as Error).name }, 'lite import plan unreadable');
    outcome({ error: { code: 'bad_plan', message: 'The import plan could not be read' } });
    return 2;
  }
  try {
    const result = await runLiteImport({ ...opts, plan, progress: line });
    outcome({ result });
    return 0;
  } catch (err) {
    if (err instanceof LiteImportRefused) {
      opts.log.warn({ step: 'check', code: err.code }, 'lite import refused');
      outcome({ error: { code: err.code } });
      return 5;
    }
    if (err instanceof NoLiteDataError) {
      outcome({ error: { code: err.code, message: err.message } });
      return 2;
    }
    opts.log.error({ err, step: 'failed' }, 'lite import failed');
    outcome({ error: { code: 'failed', message: (err as Error).message } });
    return 1;
  }
}

import { join } from 'node:path';
import { parseArgs, type CliConfig } from './config.js';
import { openDb } from './db/index.js';
import { preferIpv4 } from './dns-order.js';
import type { ServerExtension } from './extensions.js';
import { LockedError } from './lock.js';
import { mkdirSync } from 'node:fs';
import { pino, type Logger } from 'pino';
import { LOG_REDACT_PATHS, LOG_SERIALIZERS } from './log-redaction.js';
import { startServer } from './main.js';
import { resetFirstAdmin } from './auth/reset.js';
import { importLiteCommand, liteSummaryCommand } from './lite-import/run.js';
import { isMoved, readMovedMarker, restoreMoved } from './moved.js';

/** What another product build (e.g. EzyChat Enterprise) passes to reuse the server CLI. */
export interface CliProduct {
  /** Edition reported by /api/health; default 'lite'. */
  edition?: string;
  /** Server extensions; Lite passes none. */
  extensions?: readonly ServerExtension[];
  /** Most linked WhatsApp numbers (inboxes); default 1 (Lite: no inbox UI). */
  maxInboxes?: number;
  /**
   * Most AI agents (several may share one number: one for direct chats, others for groups);
   * default `maxInboxes` (Lite 1). `--max-agents` (dev with fake WhatsApp) overrides it.
   */
  maxAgents?: number;
  /** Process exit (tests replace it); default process.exit. */
  exit?: (code: number) => never;
  /** Test hook for --import-lite: throws to simulate a failure at a named point. */
  importFault?: (point: string) => void;
}

const USAGE =
  'Usage: server --data <dir> [--port <n>] [--host <h>] [--mode standalone|service|dev] [--fake-wa] [--web-dist <dir>] [--reset-admin] [--max-inboxes <n>] [--max-agents <n>] (dev with --fake-wa) [--ignore-moved]\n' +
  '       server --data <dir> --restore-moved\n' +
  '       server --lite-summary <lite data dir>\n' +
  '       server --data <dir> --import-lite <lite data dir> [--import-plan <file.json>]\n';

/**
 * A file logger for a one-shot command: `<logsDir>/<file>`, written synchronously so nothing is lost
 * when the command exits right after, and never to stdout (it carries the command's JSON lines).
 */
function commandLogger(logsDir: string, file: string): { log: Logger; close(): void } {
  try {
    mkdirSync(logsDir, { recursive: true });
    const dest = pino.destination({ dest: join(logsDir, file), sync: true, append: true });
    const log = pino(
      {
        base: { app: 'wa-team-inbox' },
        redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
        serializers: LOG_SERIALIZERS,
      },
      dest,
    );
    return { log, close: () => dest.end() };
  } catch {
    // a folder we cannot write to must not stop the command
    return { log: pino({ level: 'silent' }), close: () => undefined };
  }
}

/**
 * The server command line: parses argv/env, handles the one-shot commands, starts the server.
 * Exit codes: 0 a one-shot command succeeded, 2 bad arguments (or no Lite data for
 * --lite-summary / --import-lite), 3 data dir locked by another server, 4 the data folder was moved
 * to EzyChat Enterprise (`moved.json`; --ignore-moved starts anyway), 5 --import-lite refused by a
 * check (nothing changed), 1 any other failure (an import is rolled back).
 */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  product?: CliProduct,
): Promise<void> {
  preferIpv4();
  const exit: (code: number) => never = product?.exit ?? ((code) => process.exit(code));
  let cfg: CliConfig;
  try {
    cfg = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.stderr.write(USAGE);
    exit(2);
  }

  if (cfg.resetAdmin) {
    try {
      const db = openDb(join(cfg.dataDir, 'app.db'));
      const { username, password } = await resetFirstAdmin(db);
      db.close();
      process.stdout.write(`New admin password for ${username}: ${password}\n`);
    } catch (err) {
      process.stderr.write(`Reset failed: ${(err as Error).message}\n`);
      exit(1);
    }
    exit(0);
  }

  if (cfg.restoreMoved) {
    let code = 0;
    const logger = commandLogger(join(cfg.dataDir, 'logs'), 'cli.log');
    try {
      const r = restoreMoved(cfg.dataDir);
      logger.log.info(
        {
          mod: 'lite-import',
          step: 'restore',
          marker: r.markerRemoved,
          restored: r.restored.length,
          kept: r.kept.length,
        },
        'moved data folder restored',
      );
      process.stdout.write(`${JSON.stringify(r)}\n`);
    } catch (err) {
      logger.log.error({ mod: 'lite-import', err, step: 'restore' }, 'restore failed');
      process.stderr.write(`Restore failed: ${(err as Error).message}\n`);
      code = 1;
    } finally {
      logger.close();
    }
    exit(code);
  }

  if (cfg.liteSummary !== undefined) exit(liteSummaryCommand(cfg.liteSummary));

  if (cfg.importLite !== undefined) {
    const logger = commandLogger(`${cfg.dataDir}.import-logs`, 'lite-import.log');
    let code: number;
    try {
      code = await importLiteCommand({
        targetDataDir: cfg.dataDir,
        liteDataDir: cfg.importLite,
        planFile: cfg.importPlan,
        maxInboxes: cfg.maxInboxes ?? product?.maxInboxes ?? 1,
        product: product?.edition ?? 'lite',
        version: cfg.version,
        log: logger.log.child({ mod: 'lite-import' }),
        fault: product?.importFault,
      });
    } finally {
      logger.close();
    }
    exit(code);
  }

  if (!cfg.ignoreMoved && isMoved(cfg.dataDir)) {
    const marker = readMovedMarker(cfg.dataDir);
    const logger = commandLogger(join(cfg.dataDir, 'logs'), 'cli.log');
    logger.log.warn(
      { mod: 'lite-import', step: 'moved', at: marker?.at ?? null },
      'data folder was moved, not starting',
    );
    logger.close();
    process.stderr.write(
      `This data folder was moved to EzyChat Enterprise${marker ? ` (${marker.at})` : ''}. Start with --ignore-moved to use it anyway.\n`,
    );
    exit(4);
  }

  const {
    resetAdmin: _r,
    ignoreMoved: _i,
    restoreMoved: _m,
    liteSummary: _s,
    importLite: _l,
    importPlan: _p,
    ...serverCfg
  } = cfg;
  try {
    const maxAgents = serverCfg.maxAgents ?? product?.maxAgents;
    await startServer(maxAgents !== undefined ? { ...serverCfg, maxAgents } : serverCfg, {
      extensions: product?.extensions,
      edition: product?.edition,
      maxInboxes: product?.maxInboxes,
    });
  } catch (err) {
    if (err instanceof LockedError) {
      process.stderr.write(`${err.message}\n`);
      exit(3);
    }
    process.stderr.write(`Failed to start server: ${(err as Error).stack ?? String(err)}\n`);
    exit(1);
  }
}

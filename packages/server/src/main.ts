import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import type { WaAdapter } from '@ezychat/wa';
import type { Logger } from 'pino';
import { createAccessGate } from './access/gate.js';
import { buildApp } from './app.js';
import { Bus } from './bus.js';
import type { ServerConfig } from './config.js';
import type { AppContext } from './context.js';
import { SecretBox } from './crypto/secret.js';
import { openDb } from './db/index.js';
import { SettingsStore } from './db/settings.js';
import { migrateExtension } from './db/extension-migrate.js';
import { validateEdition, validateExtensions, type ServerExtension } from './extensions.js';
import { acquireLock } from './lock.js';
import { startKeepAwake } from './keep-awake.js';
import { createLogger } from './logger.js';
import { InboxConnections, defaultAdapterFactory } from './inboxes/connections.js';
import { PRIMARY_INBOX_ID } from './inboxes/keys.js';
import { InboxRepo } from './inboxes/repo.js';
import { createInboxAdapterFactory, detachInboxType } from './inboxes/types.js';
import { initializers } from './services.js';
import { attachRealtime } from './realtime/index.js';
import { DEFAULT_HISTORY_DAYS, SETTINGS_KEYS } from './admin/settings-service.js';
import { isTransientNetworkError } from './transient-error.js';

/** Builds the AppContext (db, secrets, settings, bus, wa) without listening. Shared by startServer and tests. */
export async function createContext(
  cfg: ServerConfig,
  deps: {
    wa?: WaAdapter;
    log: Logger;
    /** Extensions added by another product build (Lite passes none). */
    extensions?: readonly ServerExtension[];
    /** Edition reported by /api/health; default 'lite'. */
    edition?: string;
    /** Most linked numbers (inboxes) this build allows; default 1. `--max-inboxes` overrides it. */
    maxInboxes?: number;
    /** Adapters to use for these inbox ids instead of building one (`wa` is inbox 1). */
    inboxAdapters?: Readonly<Record<number, WaAdapter>>;
    /** Pause between two inboxes when connecting them all (default 500 ms). */
    connectStaggerMs?: number;
  },
): Promise<AppContext> {
  const { log } = deps;
  const extensions = deps.extensions ?? [];
  const edition = deps.edition ?? 'lite';
  validateExtensions(extensions);
  validateEdition(edition);
  const db = openDb(join(cfg.dataDir, 'app.db'));
  try {
    for (const ext of extensions) {
      if (!ext.migrationsDir) continue;
      const applied = migrateExtension(db, ext.name, ext.migrationsDir);
      if (applied.length)
        log.info({ extension: ext.name, applied }, 'extension migrations applied');
    }
  } catch (err) {
    db.close();
    throw err;
  }
  const secret = SecretBox.loadOrCreate(join(cfg.dataDir, 'secret.key'));
  const settings = new SettingsStore(db, secret);
  const bus = new Bus((err, ev) => log.error({ err, event: ev }, 'bus listener failed'));
  // a getter: a changed history_days applies on the next (re)link without a restart
  const historyDays = () => settings.get<number>(SETTINGS_KEYS.historyDays, DEFAULT_HISTORY_DAYS);
  const inboxRepo = new InboxRepo(db);
  // Inbox adapters by type: extension types get the context, which is complete before init().
  let ctx: AppContext | null = null;
  const context = (): AppContext => {
    if (!ctx) throw new Error('context not ready');
    return ctx;
  };
  const create = createInboxAdapterFactory({
    linkedPhone: defaultAdapterFactory({
      dataDir: cfg.dataDir,
      fakeWa: cfg.fakeWa,
      historyDays,
      log,
      fakeScan: cfg.maxInboxes !== undefined,
    }),
    ctx: context,
    log,
  });
  const connections = new InboxConnections({
    repo: inboxRepo,
    maxInboxes: cfg.maxInboxes ?? deps.maxInboxes ?? 1,
    log,
    primary: deps.wa ?? deps.inboxAdapters?.[PRIMARY_INBOX_ID],
    create,
    adapters: deps.inboxAdapters,
    dataDir: cfg.dataDir,
    staggerMs: deps.connectStaggerMs,
    detachType: (type, inboxId) => detachInboxType(context(), type, inboxId),
  });
  const access = createAccessGate({ db, bus, log });
  const built: AppContext = {
    config: cfg,
    db,
    bus,
    log,
    secret,
    settings,
    // set below, once init() has built (or adopted) inbox 1's adapter
    wa: undefined as unknown as WaAdapter,
    inboxes: { repo: inboxRepo, connections },
    services: {},
    edition,
    extensions,
    access,
  };
  ctx = built;
  await connections.init();
  built.wa = connections.adapter(PRIMARY_INBOX_ID);
  // inbox 1 changed type: `ctx.wa` follows its new adapter
  connections.on('added', (inboxId, wa) => {
    if (inboxId === PRIMARY_INBOX_ID) built.wa = wa;
  });
  return built;
}

/** Runs the initializers registered in services.ts, in order, then each extension's init. */
export async function runInitializers(ctx: AppContext): Promise<void> {
  for (const init of initializers) await init(ctx);
  for (const ext of ctx.extensions) await ext.init?.(ctx);
}

/** Calls shutdown()/close() on every registered service that has one (best effort). */
export async function shutdownServices(ctx: AppContext): Promise<void> {
  for (const [name, svc] of Object.entries(ctx.services).reverse()) {
    const s = svc as { shutdown?: () => unknown; close?: () => unknown } | null;
    try {
      if (s && typeof s.shutdown === 'function') await s.shutdown();
      else if (s && typeof s.close === 'function') await s.close();
    } catch (err) {
      ctx.log.warn({ err, service: name }, 'service shutdown failed');
    }
  }
}

export async function startServer(
  cfg: ServerConfig,
  deps?: {
    wa?: WaAdapter;
    extensions?: readonly ServerExtension[];
    edition?: string;
    /** Most linked numbers (inboxes); default 1 (Lite). */
    maxInboxes?: number;
  },
): Promise<{ app: FastifyInstance; ctx: AppContext; close(): Promise<void> }> {
  const lock = acquireLock(cfg.dataDir);
  const logger = await createLogger({ dataDir: cfg.dataDir });
  const log = logger.log;
  const awake = startKeepAwake({ mode: cfg.mode, log });

  const onUncaught = (err: unknown) => {
    // e.g. undici "TypeError: terminated" (read ECONNRESET) escaping a Baileys media stream:
    // a network blip must not kill the server
    if (isTransientNetworkError(err)) {
      log.warn({ err }, 'uncaught transient network error (ignored)');
      return;
    }
    log.fatal({ err }, 'uncaught exception');
    logger.close();
    lock.release();
    process.exit(1);
  };
  const onUnhandled = (reason: unknown) => {
    log.error({ err: reason }, 'unhandled rejection');
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  const removeErrorHandlers = () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  };

  let ctx: AppContext;
  try {
    ctx = await createContext(cfg, {
      wa: deps?.wa,
      log,
      extensions: deps?.extensions,
      edition: deps?.edition,
      maxInboxes: deps?.maxInboxes,
    });
  } catch (err) {
    removeErrorHandlers();
    lock.release();
    logger.close();
    throw err;
  }

  // Port / bind host fall back to persisted settings unless given explicitly.
  if (cfg.portExplicit === false) cfg.port = ctx.settings.get<number>('port', cfg.port);
  if (cfg.hostExplicit === false)
    cfg.host = ctx.settings.get<boolean>('lan_enabled', false) ? '0.0.0.0' : '127.0.0.1';

  // Initializers start side effects (e.g. cloudflared via tunnel restore). If anything up to a
  // successful listen fails (EADDRINUSE...), tear everything down before rethrowing so no child
  // process is orphaned and the data-dir lock is released.
  let app: FastifyInstance | null = null;
  try {
    await runInitializers(ctx);
    app = await buildApp(ctx);
    await app.listen({ port: cfg.port, host: cfg.host });
  } catch (err) {
    log.error({ err }, 'server startup failed');
    if (app) await app.close().catch(() => undefined);
    await shutdownServices(ctx);
    ctx.bus.removeAllListeners();
    try {
      ctx.db.close();
    } catch {
      // ignore
    }
    removeErrorHandlers();
    lock.release();
    logger.close();
    throw err;
  }
  log.info(
    {
      port: cfg.port,
      host: cfg.host,
      mode: cfg.mode,
      version: cfg.version,
      fakeWa: cfg.fakeWa,
      edition: ctx.edition,
      maxInboxes: ctx.inboxes.connections.maxInboxes(),
      extensions: ctx.extensions.map((e) => e.name),
    },
    'server listening',
  );
  const realtime = attachRealtime(app.server, ctx);

  // every inbox connects, 500 ms apart; one failing number never blocks the others
  ctx.inboxes.connections
    .connectAll()
    .catch((err: unknown) => log.error({ err }, 'wa connect failed'));

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      log.info('shutting down');
      realtime.close(); // drop websocket clients first so the HTTP server can close
      try {
        await app.close();
      } catch (err) {
        log.warn({ err }, 'http close failed');
      }
      await shutdownServices(ctx);
      await ctx.inboxes.connections.disconnectAll(); // allSettled: logs each failure
      ctx.bus.removeAllListeners();
      try {
        ctx.db.close();
      } catch {
        // ignore
      }
      awake.stop();
      lock.release();
      removeErrorHandlers();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      logger.close();
    })();
    return closing;
  };

  const onSignal = (sig: string) => {
    log.info({ sig }, 'signal received');
    void close().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { app, ctx, close };
}

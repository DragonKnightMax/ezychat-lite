import { randomUUID } from 'node:crypto';
import { USAGE_DAILY_EVENT, USAGE_EVENTS, UsageEvent, type UsageEventName } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import type { SettingsStore } from '../db/settings.js';

/**
 * Anonymous usage stats (design: docs/superpowers/specs/2026-11-04-usage-stats-design.md). The ONLY place the app sends
 * usage data: one `UsageEvent` (install id made for this only, product, version, OS, mode, event name)
 * to our licence portal, which forwards it to Google Analytics. Never a name, number, chat, message,
 * email, IP or key. On by default; admins switch it off in Settings (`usage_stats`), and then
 * nothing more is sent.
 */
export const USAGE_PORTAL_URL = 'https://license.anchorsprint.app/v1/usage';
/** Dev and test only (`--mode dev --fake-wa`): a local portal. */
export const USAGE_URL_ENV = 'EZYCHAT_USAGE_ENDPOINT';
export const USAGE_STATS_KEY = 'usage_stats';
export const USAGE_INSTALL_ID_KEY = 'usage_install_id';
/** `{ events: [...one-time events sent], activeDay: 'YYYY-MM-DD' | null }`. */
export const USAGE_SENT_KEY = 'usage_sent';
export const USAGE_TIMEOUT_MS = 10_000;
/** How often the milestones are checked again (bus events check sooner). */
export const USAGE_CHECK_MS = 3_600_000;

export function usageStatsEnabled(settings: SettingsStore): boolean {
  return settings.get<unknown>(USAGE_STATS_KEY, true) !== false;
}

/** Saves the switch; a real change is audited with its before and after values only. */
export function setUsageStats(
  ctx: AppContext,
  enabled: boolean,
  actor: { userId: number | null; ip: string | null },
): void {
  const before = usageStatsEnabled(ctx.settings);
  ctx.settings.set(USAGE_STATS_KEY, enabled);
  if (before !== enabled)
    audit(ctx.db, {
      userId: actor.userId,
      action: 'usage_stats.update',
      ip: actor.ip,
      meta: { before, after: enabled },
    });
}

export function usageOs(platform: NodeJS.Platform = process.platform): UsageEvent['os'] {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

export function usageProduct(edition: string): UsageEvent['product'] | null {
  if (edition === 'lite') return 'EZC-LITE';
  if (edition === 'enterprise') return 'EZC-ENT';
  return null;
}

export interface UsageServiceOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Hourly re-check timer (tests pass false). */
  timer?: boolean;
}

export interface UsageService {
  /** Sends every milestone reached and not sent yet, and today's app_active. */
  check(): Promise<void>;
  shutdown(): void;
}

declare module '../context.js' {
  interface Services {
    usage?: UsageService;
  }
}

interface Sent {
  events: UsageEventName[];
  activeDay: string | null;
}

const exists = (ctx: AppContext, sql: string): boolean => {
  try {
    return ctx.db.prepare(sql).get() !== undefined;
  } catch {
    return false;
  }
};

/** Whether each one-time milestone is reached now, read from the app's own state. */
function reached(ctx: AppContext, event: UsageEventName): boolean {
  switch (event) {
    case 'app_installed':
      return true;
    case 'admin_created':
      return exists(ctx, "SELECT 1 FROM users WHERE kind = 'human' AND role = 'admin' LIMIT 1");
    case 'wa_linked':
      return [...ctx.inboxes.connections.statuses().values()].some((s) => s.state === 'open');
    case 'ai_connected':
      try {
        return ctx.services.ai?.connectionReady() === true;
      } catch {
        return false;
      }
    case 'ai_agent_on':
      return exists(
        ctx,
        `SELECT 1 FROM ai_agents a JOIN users u ON u.id = a.user_id
         WHERE u.kind = 'ai' AND u.disabled_at IS NULL AND u.ai_deleted_at IS NULL LIMIT 1`,
      );
    case 'first_message_sent':
      return exists(
        ctx,
        `SELECT 1 FROM messages m JOIN users u ON u.id = m.sent_by_user_id
         WHERE m.from_me = 1 AND u.kind = 'human' AND m.status IN ('sent', 'delivered', 'read') LIMIT 1`,
      );
    default:
      return false;
  }
}

export function createUsageService(
  ctx: AppContext,
  options: UsageServiceOptions = {},
): UsageService {
  const log = ctx.log.child({ mod: 'usage' });
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? fetch;
  let closed = false;
  let running: Promise<void> | null = null;

  /** Where events go, or null when this app must not send (tests, fake WhatsApp, dev, other editions). */
  function target(): { url: string; mode: UsageEvent['mode'] } | null {
    const { mode, fakeWa } = ctx.config;
    if (mode === 'dev') {
      if (!fakeWa) return null;
      const dev = (options.env ?? process.env)[USAGE_URL_ENV]?.trim();
      return dev ? { url: dev, mode: 'standalone' } : null;
    }
    if (fakeWa) return null;
    return { url: USAGE_PORTAL_URL, mode };
  }

  function installId(): string {
    const saved = ctx.settings.get<string | null>(USAGE_INSTALL_ID_KEY, null);
    if (typeof saved === 'string' && saved) return saved;
    const id = randomUUID();
    ctx.settings.set(USAGE_INSTALL_ID_KEY, id);
    return id;
  }

  function sent(): Sent {
    const raw = ctx.settings.get<Partial<Sent> | null>(USAGE_SENT_KEY, null);
    const events = Array.isArray(raw?.events)
      ? raw.events.filter((e): e is UsageEventName =>
          (USAGE_EVENTS as readonly string[]).includes(e),
        )
      : [];
    return { events, activeDay: typeof raw?.activeDay === 'string' ? raw.activeDay : null };
  }

  /** true when the portal took it (or refused it for good: a 4xx is never retried). */
  async function post(url: string, body: UsageEvent): Promise<boolean> {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return true;
      log.info({ event: body.event, status: res.status }, 'usage event not taken');
      return res.status >= 400 && res.status < 500 && res.status !== 429;
    } catch (err) {
      log.info(
        { event: body.event, errName: err instanceof Error ? err.name : typeof err },
        'usage event failed',
      );
      return false;
    }
  }

  async function run(): Promise<void> {
    if (closed || !usageStatsEnabled(ctx.settings) || !ctx.access.state().open) return;
    const to = target();
    const product = usageProduct(ctx.edition);
    if (!to || !product) return;
    const base = {
      product,
      version: ctx.config.version,
      os: usageOs(options.platform),
      mode: to.mode,
    };
    const today = now().toISOString().slice(0, 10);
    const done = sent();
    const due: UsageEventName[] = USAGE_EVENTS.filter((e) =>
      e === USAGE_DAILY_EVENT
        ? done.activeDay !== today
        : !done.events.includes(e) && reached(ctx, e),
    );
    let count = 0;
    for (const event of due) {
      // Read again before each send: switching off stops the rest of this round.
      if (closed || !usageStatsEnabled(ctx.settings)) break;
      const parsed = UsageEvent.safeParse({ installId: installId(), ...base, event });
      if (!parsed.success) {
        log.warn({ event }, 'usage event invalid, not sent');
        return;
      }
      if (!(await post(to.url, parsed.data))) continue;
      const latest = sent();
      if (event === USAGE_DAILY_EVENT) latest.activeDay = today;
      else if (!latest.events.includes(event)) latest.events.push(event);
      ctx.settings.set(USAGE_SENT_KEY, latest);
      count++;
    }
    if (count) log.info({ sent: count }, 'usage events sent');
  }

  const service: UsageService = {
    check() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    shutdown() {
      closed = true;
      clearInterval(interval);
      for (const [ev, fn] of listeners) ctx.bus.off(ev, fn as never);
    },
  };

  const kick = () => void service.check();
  const listeners = [
    ['inbox:status', kick],
    ['ai:connection-changed', kick],
    ['message:status', kick],
    ['access:opened', kick],
  ] as const;
  for (const [ev, fn] of listeners) ctx.bus.on(ev, fn);
  const interval = options.timer === false ? undefined : setInterval(kick, USAGE_CHECK_MS);
  interval?.unref?.();
  return service;
}

/** Initializer: start-up sends app_installed / today's app_active (when on), then re-checks. */
export function initUsage(ctx: AppContext): void {
  const usage = createUsageService(ctx);
  ctx.services.usage = usage;
  void usage.check();
}

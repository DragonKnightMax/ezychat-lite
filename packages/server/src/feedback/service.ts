import { randomUUID } from 'node:crypto';
import type { FeedbackDefaults, FeedbackReportBody } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import type { FeedbackAuth } from '../extensions.js';
import { errors, HttpError } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { cleanScreen, serverDiagnostics } from './diagnostics.js';
import { recentFeedbackLog } from './log.js';
import {
  FEEDBACK_PORTAL_URL,
  FEEDBACK_URL_ENV,
  forwardFeedback,
  portalUrlFromOrigin,
  type PortalFile,
} from './portal.js';

/** Reports per user: 5 an hour and 20 a day (a retry of the same report is not counted again). */
export const FEEDBACK_PER_HOUR = 5;
export const FEEDBACK_PER_DAY = 20;
/** Lite's random id for the portal's rate limits, created on the first send. */
export const INSTALL_REF_SETTING = 'feedback_install_ref';
const REMEMBERED = 500;

export interface FeedbackServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Environment for the dev switch (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface FeedbackService {
  defaults(): Promise<FeedbackDefaults>;
  send(userId: number, report: FeedbackReportBody, files: readonly PortalFile[]): Promise<string>;
}

declare module '../context.js' {
  interface Services {
    feedback?: FeedbackService;
  }
}

/** A bounded map: the oldest entry goes first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > REMEMBERED) map.delete(map.keys().next().value as K);
}

export function createFeedbackService(
  ctx: AppContext,
  options: FeedbackServiceOptions = {},
): FeedbackService {
  const log = ctx.log.child({ mod: 'feedback' });
  const now = options.now ?? Date.now;
  const hourly = new WindowLimiter({ windowMs: 3_600_000, max: FEEDBACK_PER_HOUR, now });
  const daily = new WindowLimiter({ windowMs: 86_400_000, max: FEEDBACK_PER_DAY, now });
  /** user:clientReportId → reference of a report the portal accepted (a retry answers it again). */
  const sent = new Map<string, string>();
  /** user:clientReportId already counted by the limiters. */
  const counted = new Map<string, true>();

  /** The edition's identity: the first extension's answer (an error counts as none). */
  async function editionAuth(): Promise<FeedbackAuth | null> {
    for (const ext of ctx.extensions) {
      if (!ext.feedbackAuth) continue;
      try {
        const auth = await ext.feedbackAuth(ctx);
        if (auth) return auth;
      } catch (err) {
        log.warn(
          { extension: ext.name, errName: err instanceof Error ? err.name : typeof err },
          'feedback auth failed',
        );
      }
    }
    return null;
  }

  function portalUrl(auth: FeedbackAuth | null): string {
    if (auth?.portalOrigin) {
      const url = portalUrlFromOrigin(auth.portalOrigin);
      if (!url)
        throw new HttpError(503, 'feedback_unavailable', 'Feedback cannot be sent from this app');
      return url;
    }
    if (ctx.config.mode === 'dev' && ctx.config.fakeWa) {
      const dev = (options.env ?? process.env)[FEEDBACK_URL_ENV]?.trim();
      if (dev) return dev;
    }
    return FEEDBACK_PORTAL_URL;
  }

  function installRef(): string {
    const saved = ctx.settings.get<string | null>(INSTALL_REF_SETTING, null);
    if (typeof saved === 'string' && saved) return saved;
    const ref = randomUUID();
    ctx.settings.set(INSTALL_REF_SETTING, ref);
    return ref;
  }

  function limit(key: string): void {
    if (counted.has(key)) return;
    const hour = hourly.hit(key.split(':')[0]!);
    if (!hour.allowed) throw errors.rateLimited(hour.retryAfterSec);
    const day = daily.hit(key.split(':')[0]!);
    if (!day.allowed) throw errors.rateLimited(day.retryAfterSec);
    remember(counted, key, true);
  }

  return {
    async defaults() {
      const auth = await editionAuth();
      const recent = recentFeedbackLog(ctx.config.dataDir);
      return {
        company: auth?.company?.trim() || null,
        logLines: recent.lines,
        logPreview: recent.text,
        diagnostics: serverDiagnostics(ctx),
      };
    },

    async send(userId, report, files) {
      const key = `${userId}:${report.clientReportId}`;
      const again = sent.get(key);
      if (again) return again;
      const auth = await editionAuth();
      if (!auth && ctx.edition !== 'lite')
        throw new HttpError(503, 'feedback_unavailable', 'Feedback cannot be sent from this app');
      const url = portalUrl(auth);
      limit(key);
      const identity = auth
        ? { product: auth.product, installId: auth.installId, secret: auth.secret }
        : { product: 'EZC-LITE', installRef: installRef() };
      const recent = report.includeLog ? recentFeedbackLog(ctx.config.dataDir) : null;
      const body: Record<string, unknown> = {
        ...identity,
        clientReportId: report.clientReportId,
        type: report.type,
        title: report.title,
        details: report.details,
        area: report.area,
        ...(report.type === 'problem' && report.frequency ? { frequency: report.frequency } : {}),
        ...(report.type === 'problem' && report.impact ? { impact: report.impact } : {}),
        name: report.name,
        email: report.email,
        ...(report.company ? { company: report.company } : {}),
        contactOk: report.contactOk,
        ...(report.includeDetails
          ? {
              diagnostics: {
                ...serverDiagnostics(ctx),
                client: report.client,
                language: report.language,
                timeZone: report.timeZone,
                screen: cleanScreen(report.screen),
              },
            }
          : {}),
        ...(recent?.text ? { log: recent.text } : {}),
      };
      const started = now();
      const meta = {
        type: report.type,
        area: report.area,
        files: files.length,
        sizes: files.map((f) => f.bytes.length),
        log: !!recent?.text,
      };
      try {
        const reference = await forwardFeedback({ url, report: body, files, fetch: options.fetch });
        remember(sent, key, reference);
        log.info({ ...meta, ms: now() - started, reference }, 'feedback sent');
        return reference;
      } catch (err) {
        const code = err instanceof HttpError ? err.code : 'unknown';
        log.warn({ ...meta, ms: now() - started, code }, 'feedback not sent');
        throw err;
      }
    },
  };
}

export function initFeedback(ctx: AppContext): void {
  ctx.services.feedback = createFeedbackService(ctx);
}

export function getFeedback(ctx: AppContext): FeedbackService {
  const service = ctx.services.feedback;
  if (!service) throw new Error('Feedback service not initialised');
  return service;
}

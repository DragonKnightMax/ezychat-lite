import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireUser } from '../../../../packages/server/src/auth/guards.js';
import { HttpError, errors, parse } from '../../../../packages/server/src/http/errors.js';

/**
 * Proposed (in-app-feedback): the app's future `POST /api/feedback`, which forwards a report to the
 * licence portal (`POST /v1/feedback`). In this mock nothing leaves the computer: the "portal" is the
 * in-memory list below, shown in the Mock only box with what the portal would record (IP, country).
 */

const TYPES = ['problem', 'idea', 'question', 'other'] as const;
const AREAS = [
  'inbox',
  'ai',
  'whatsapp',
  'connectors',
  'reports',
  'settings',
  'install',
  'other',
] as const;

export const FeedbackFields = z
  .object({
    clientReportId: z.string().uuid(),
    type: z.enum(TYPES),
    title: z.string().trim().min(3).max(120),
    details: z.string().trim().min(10).max(5000),
    area: z.enum(AREAS),
    frequency: z.enum(['always', 'sometimes', 'once']).optional(),
    impact: z.enum(['blocking', 'slow', 'minor']).optional(),
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(200),
    company: z.string().trim().max(120).optional(),
    contactOk: z.boolean(),
    includeDetails: z.boolean(),
    includeLog: z.boolean(),
    screen: z.string().max(200),
    edition: z.enum(['lite', 'enterprise']),
  })
  .strict();

const ALLOWED = /\.(png|jpe?g|webp|pdf|txt|log|mp4)$/i;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;

type Scenario = 'ok' | 'offline' | 'rate_limited';

interface SentReport {
  reference: string;
  receivedAt: string;
  product: 'EZC-LITE' | 'EZC-ENT';
  report: z.infer<typeof FeedbackFields>;
  files: { name: string; size: number }[];
  diagnostics: ReturnType<typeof diagnostics> | null;
  logLines: number | null;
  recorded: { ip: string; country: string; region: string; city: string };
  install: string | null;
  notified: string;
}

function diagnostics(ctx: AppContext, edition: 'lite' | 'enterprise', screen: string) {
  const ai = ctx.services.ai?.status().connection;
  return {
    edition: edition === 'enterprise' ? 'EzyChat Enterprise' : 'EzyChat Lite',
    version: '0.1.73',
    os: 'Windows 11',
    osVersion: '24H2 (10.0.26100)',
    client: 'Desktop app',
    mode: 'On this computer (not a service)',
    language: 'English',
    timeZone: 'Asia/Kuala_Lumpur',
    screen,
    waConnected: ctx.wa.status.state === 'open',
    aiMode: ai?.state === 'connected' ? 'ChatGPT sign-in' : 'Off',
  };
}

/** A redacted server log, as the app would attach it: phone numbers, emails, tokens and message text removed. */
function demoLog(): string[] {
  const lines: string[] = [];
  const start = Date.now() - 200 * 7_000;
  const msgs = [
    '{"level":30,"mod":"wa","msg":"connection update","state":"open"}',
    '{"level":30,"mod":"messages","msg":"message stored","chat":"[number removed]","type":"text"}',
    '{"level":30,"mod":"ai","msg":"AI answer sent","ms":2140,"model":"fast"}',
    '{"level":40,"mod":"wa","msg":"media download retry","attempt":2,"chat":"[number removed]"}',
    '{"level":30,"mod":"web","msg":"request completed","url":"/api/chats","statusCode":200}',
    '{"level":50,"mod":"wa","msg":"media download failed","err":"ETIMEDOUT","chat":"[number removed]"}',
  ];
  for (let i = 0; i < 200; i += 1)
    lines.push(
      `${new Date(start + i * 7_000).toISOString()} ${msgs[i % msgs.length]!.replace('}', `,"token":"[removed]"}`)}`,
    );
  return lines;
}

export function registerFeedback(app: FastifyInstance, ctx: AppContext): void {
  let scenario: Scenario = 'ok';
  let next = 43;
  const sent: SentReport[] = [];
  const seen = new Map<string, string>();

  // What the dialog shows under "What we include" before anything is sent.
  app.get('/api/mock/feedback/preview', { preHandler: requireUser(ctx) }, async (req) => {
    const q = z
      .object({ screen: z.string().max(200).default('/'), edition: z.enum(['lite', 'enterprise']) })
      .parse(req.query);
    const log = demoLog();
    return {
      diagnostics: diagnostics(ctx, q.edition, q.screen),
      log: { lines: log.length, preview: log.slice(-40).join('\n') },
      company: q.edition === 'enterprise' ? 'Kopi Apong Sdn Bhd' : null,
    };
  });

  app.post('/api/feedback', { preHandler: requireUser(ctx) }, async (req, reply) => {
    if (!req.isMultipart()) throw errors.validation('Expected multipart/form-data');
    let raw: unknown = null;
    const files: { name: string; size: number }[] = [];
    let total = 0;
    // The app-wide multipart limit is 1 file; this route allows 3 (the real route sets the same).
    for await (const part of req.parts({ limits: { files: 3, fileSize: MAX_FILE } })) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.fieldname !== 'file') continue;
        if (files.length >= 3) throw errors.validation('At most 3 files');
        if (!ALLOWED.test(part.filename))
          throw new HttpError(415, 'file_type' as never, 'This kind of file cannot be attached');
        if (buffer.length > MAX_FILE)
          throw new HttpError(413, 'too_large' as never, 'File too large');
        total += buffer.length;
        if (total > MAX_TOTAL) throw new HttpError(413, 'too_large' as never, 'Files too large');
        files.push({ name: part.filename, size: buffer.length });
      } else if (part.fieldname === 'report' && typeof part.value === 'string') {
        raw = JSON.parse(part.value);
      }
    }
    const report = parse(FeedbackFields, raw);
    if (scenario === 'offline')
      throw new HttpError(502, 'portal_unreachable' as never, 'Feedback service unreachable');
    if (scenario === 'rate_limited') throw errors.rateLimited(1800);
    const again = seen.get(report.clientReportId);
    if (again) return reply.status(201).send({ reference: again });
    const reference = `FB-${String(next++).padStart(4, '0')}`;
    seen.set(report.clientReportId, reference);
    const product = report.edition === 'enterprise' ? 'EZC-ENT' : 'EZC-LITE';
    sent.unshift({
      reference,
      receivedAt: new Date().toISOString(),
      product,
      report,
      files,
      diagnostics: report.includeDetails ? diagnostics(ctx, report.edition, report.screen) : null,
      logLines: report.includeLog ? demoLog().length : null,
      recorded: { ip: '175.139.42.18', country: 'MY', region: 'Selangor', city: 'Petaling Jaya' },
      install: report.edition === 'enterprise' ? 'K7QD-2M9X-PL4A (Kopi Apong Sdn Bhd)' : null,
      notified: 'general@ezychat.ai',
    });
    return reply.status(201).send({ reference });
  });

  app.get('/api/mock/feedback', { preHandler: requireUser(ctx) }, async () => ({ scenario, sent }));
  app.put('/api/mock/feedback/scenario', { preHandler: requireUser(ctx) }, async (req) => {
    scenario = z
      .object({ scenario: z.enum(['ok', 'offline', 'rate_limited']) })
      .parse(req.body).scenario;
    return { scenario, sent };
  });
  app.delete('/api/mock/feedback', { preHandler: requireUser(ctx) }, async () => {
    sent.length = 0;
    seen.clear();
    return { scenario, sent };
  });
}

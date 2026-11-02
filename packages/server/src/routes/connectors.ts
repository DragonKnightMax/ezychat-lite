import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BookingSettings } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { getGoogleCalendar } from '../connectors/google-calendar/service.js';
import { isHostRequest } from '../http/access.js';
import { clientIp } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';

const AgentParams = z.object({ agentId: z.coerce.number().int().positive() });
const RequestParams = z.object({ requestId: z.string().regex(/^[a-f0-9]{24}$/) });
const CallbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});
const FakeGoogleBody = z.object({
  state: z.enum(['ok', 'expired', 'unavailable']).optional(),
  busy: z
    .array(
      z.object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      }),
    )
    .max(500)
    .optional(),
});

export const CALLBACK_PATH = '/api/connectors/google-calendar/callback';

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A tiny standalone page (no script, no outside resources). */
export function sendPage(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .status(status)
    .header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2933}a{display:inline-block;margin:0 1rem 0 0;padding:.5rem 1rem;border:1px solid #1f2933;border-radius:.5rem;color:inherit;text-decoration:none}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    );
}

/** This server's own callback address, on the port it really listens on. */
function redirectUri(req: FastifyRequest, ctx: AppContext): string {
  const address = req.server.server.address();
  const port = address && typeof address === 'object' ? address.port : ctx.config.port;
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/**
 * Core connectors (Admin → Connectors). Google Calendar: sign-in, per-agent booking settings, the
 * activity and bookings lists (admins), and Google's redirect back (this computer only, no session).
 */
export default async function connectorsRoutes(app: FastifyInstance, ctx: AppContext) {
  const calendar = getGoogleCalendar(ctx);
  const admin = { preHandler: requireAdmin(ctx) };
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });

  app.get('/connectors/google-calendar', admin, async () => calendar.status());

  app.post('/connectors/google-calendar/connect', admin, async (req) =>
    calendar.startConnect(redirectUri(req, ctx), actor(req)),
  );

  app.get('/connectors/google-calendar/connect/:requestId', admin, async (req) => {
    const { requestId } = parse(RequestParams, req.params);
    const progress = calendar.progress(requestId);
    if (!progress) throw errors.notFound('Sign-in request');
    return progress;
  });

  // Google sends the browser here. Only this computer (the redirect address is 127.0.0.1): never
  // the LAN or the tunnel. The one-time state and the PKCE verifier guard the rest.
  app.get('/connectors/google-calendar/callback', async (req, reply) => {
    if (!isHostRequest(req))
      return sendPage(
        reply,
        403,
        'Not allowed',
        '<p>Finish the Google sign-in on the computer that runs EzyChat.</p>',
      );
    const query = CallbackQuery.safeParse(req.query ?? {});
    const page = await calendar.callback(query.success ? query.data : {});
    return sendPage(reply, page.status, page.title, `<p>${escapeHtml(page.message)}</p>`);
  });

  app.post('/connectors/google-calendar/disconnect', admin, async (req) => {
    await calendar.disconnect(actor(req));
    return calendar.status();
  });

  app.get('/connectors/google-calendar/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    return calendar.getSettings(agentId);
  });

  app.put('/connectors/google-calendar/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    // Unknown agent first (404), then the body (400).
    calendar.getSettings(agentId);
    const body = parse(BookingSettings, req.body ?? {});
    return calendar.putSettings(agentId, body, actor(req));
  });

  app.get('/connectors/google-calendar/activity', admin, async () => ({
    activity: calendar.activity(),
  }));

  app.get('/connectors/google-calendar/bookings', admin, async () => calendar.bookings());

  // Fake Google (--fake-wa only): the consent page and a switch for the connector's states.
  const fake = calendar.fake;
  if (!fake) return;

  app.get('/dev/fake-google/consent', async (req, reply) => {
    const state = String((req.query as { state?: unknown } | null)?.state ?? '');
    const allow = calendar.fakeConsent(state, true);
    const cancel = calendar.fakeConsent(state, false);
    if (!allow || !cancel)
      return sendPage(reply, 400, 'Sign-in link expired', '<p>Start the sign-in again.</p>');
    return sendPage(
      reply,
      200,
      'Fake Google sign-in',
      `<p>EzyChat (test) wants to see your calendars, their free and busy times, and add events.</p><p><a id="allow" href="${escapeHtml(allow)}">Allow</a><a id="cancel" href="${escapeHtml(cancel)}">Cancel</a></p>`,
    );
  });

  app.post('/dev/fake-google-calendar', admin, async (req) => {
    const body = parse(FakeGoogleBody, req.body ?? {});
    if (body.state) fake.mode = body.state;
    if (body.busy) fake.busy = body.busy;
    return calendar.refreshStatus();
  });

  app.get('/dev/fake-google-calendar', admin, async () => ({
    mode: fake.mode,
    busy: fake.busy,
    events: fake.events,
  }));
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SheetsAgentSettings, SheetsPickerResult, SpreadsheetLookupBody } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import {
  PICKER_PAGE_CSP,
  PICKER_PAGE_HTML,
  PICKER_SCRIPT,
} from '../connectors/google-sheets/picker-page.js';
import { getGoogleSheets } from '../connectors/google-sheets/service.js';
import { isHostRequest } from '../http/access.js';
import { clientIp } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';
import { escapeHtml, sendPage } from './connectors.js';

const AgentParams = z.object({ agentId: z.coerce.number().int().positive() });
const RequestParams = z.object({ requestId: z.string().regex(/^[a-f0-9]{24}$/) });
const CallbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});
const FakeSheetsBody = z.object({ state: z.enum(['ok', 'expired', 'unavailable']) });

export const SHEETS_CALLBACK_PATH = '/api/connectors/google-sheets/callback';

/** This server on this computer, on the port it really listens on. */
function loopbackOrigin(req: FastifyRequest, ctx: AppContext): string {
  const address = req.server.server.address();
  const port = address && typeof address === 'object' ? address.port : ctx.config.port;
  return `http://127.0.0.1:${port}`;
}

const redirectUri = (req: FastifyRequest, ctx: AppContext) =>
  `${loopbackOrigin(req, ctx)}${SHEETS_CALLBACK_PATH}`;

const TokenQuery = z.object({ token: z.string().max(100).default('') });

const NOT_HERE = '<p>Choose the sheet on the computer that runs EzyChat.</p>';
const EXPIRED = '<p>This link expired. Choose the sheet again from EzyChat.</p>';

/**
 * Admin → Connectors → Google Sheets: sign-in, the spreadsheet behind a pasted link, per-agent
 * settings and the activity list (admins), and Google's redirect back (this computer only, no
 * session).
 */
export default async function connectorGoogleSheetsRoutes(app: FastifyInstance, ctx: AppContext) {
  const sheets = getGoogleSheets(ctx);
  const admin = { preHandler: requireAdmin(ctx) };
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });

  app.get('/connectors/google-sheets', admin, async () => sheets.status());

  app.post('/connectors/google-sheets/connect', admin, async (req) =>
    sheets.startConnect(redirectUri(req, ctx), actor(req)),
  );

  app.get('/connectors/google-sheets/connect/:requestId', admin, async (req) => {
    const { requestId } = parse(RequestParams, req.params);
    const progress = sheets.progress(requestId);
    if (!progress) throw errors.notFound('Sign-in request');
    return progress;
  });

  // Google sends the browser here. Only this computer (the redirect address is 127.0.0.1): never
  // the LAN or the tunnel. The one-time state and the PKCE verifier guard the rest.
  app.get('/connectors/google-sheets/callback', async (req, reply) => {
    if (!isHostRequest(req))
      return sendPage(
        reply,
        403,
        'Not allowed',
        '<p>Finish the Google sign-in on the computer that runs EzyChat.</p>',
      );
    const query = CallbackQuery.safeParse(req.query ?? {});
    const page = await sheets.callback(query.success ? query.data : {});
    return sendPage(reply, page.status, page.title, `<p>${escapeHtml(page.message)}</p>`);
  });

  app.post('/connectors/google-sheets/disconnect', admin, async (req) => {
    await sheets.disconnect(actor(req));
    return sheets.status();
  });

  app.post('/connectors/google-sheets/spreadsheet', admin, async (req) => {
    const { link } = parse(SpreadsheetLookupBody, req.body ?? {});
    return sheets.spreadsheetInfo(link);
  });

  // Google's file picker: the admin starts it here; its page, script, token and answer are served
  // only to this computer (like the sign-in callback), guarded by the one-time picker token.
  app.post('/connectors/google-sheets/picker', admin, async (req) =>
    sheets.startPicker(loopbackOrigin(req, ctx), actor(req)),
  );

  app.get('/connectors/google-sheets/picker/:requestId', admin, async (req) => {
    const { requestId } = parse(RequestParams, req.params);
    const progress = sheets.pickerProgress(requestId);
    if (!progress) throw errors.notFound('Picker');
    return progress;
  });

  app.get('/connectors/google-sheets/picker-page', async (req, reply) => {
    if (!isHostRequest(req)) return sendPage(reply, 403, 'Not allowed', NOT_HERE);
    const { token } = parse(TokenQuery, req.query ?? {});
    if (!sheets.pickerSession(token)) return sendPage(reply, 400, 'Link expired', EXPIRED);
    return reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', PICKER_PAGE_CSP)
      .type('text/html; charset=utf-8')
      .send(PICKER_PAGE_HTML);
  });

  app.get('/connectors/google-sheets/picker.js', async (req, reply) => {
    if (!isHostRequest(req)) return reply.status(403).send();
    return reply.header('cache-control', 'no-store').type('text/javascript').send(PICKER_SCRIPT);
  });

  app.get('/connectors/google-sheets/picker-config', async (req, reply) => {
    if (!isHostRequest(req)) throw errors.notFound('Picker');
    const { token } = parse(TokenQuery, req.query ?? {});
    const config = await sheets.pickerConfig(token);
    if (!config) throw errors.notFound('Picker');
    return reply.header('cache-control', 'no-store').send(config);
  });

  app.post('/connectors/google-sheets/picker-result', async (req) => {
    if (!isHostRequest(req)) throw errors.notFound('Picker');
    const body = parse(SheetsPickerResult, req.body ?? {});
    if (!(await sheets.pickerResult(body.token, body)))
      throw errors.validation('EzyChat could not open that spreadsheet');
    return { ok: true };
  });

  app.get('/connectors/google-sheets/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    return sheets.getSettings(agentId);
  });

  app.put('/connectors/google-sheets/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    // Unknown agent first (404), then the body (400).
    sheets.getSettings(agentId);
    const body = parse(SheetsAgentSettings, req.body ?? {});
    return sheets.putSettings(agentId, body, actor(req));
  });

  app.get('/connectors/google-sheets/activity', admin, async () => ({
    activity: sheets.activity(),
  }));

  // Fake Google (--fake-wa only): the consent page and a switch for the connector's states.
  const fake = sheets.fake;
  if (!fake) return;

  app.get('/dev/fake-google-sheets/consent', async (req, reply) => {
    const state = String((req.query as { state?: unknown } | null)?.state ?? '');
    const allow = sheets.fakeConsent(state, true);
    const cancel = sheets.fakeConsent(state, false);
    if (!allow || !cancel)
      return sendPage(reply, 400, 'Sign-in link expired', '<p>Start the sign-in again.</p>');
    return sendPage(
      reply,
      200,
      'Fake Google sign-in',
      `<p>EzyChat (test) wants to see, edit, create and delete your Google Sheets spreadsheets.</p><p><a id="allow" href="${escapeHtml(allow)}">Allow</a><a id="cancel" href="${escapeHtml(cancel)}">Cancel</a></p>`,
    );
  });

  // The fake file picker: a list of the fake's spreadsheets (this computer only).
  app.get('/dev/fake-google-sheets/picker', async (req, reply) => {
    if (!isHostRequest(req)) return sendPage(reply, 403, 'Not allowed', NOT_HERE);
    const { token } = parse(TokenQuery, req.query ?? {});
    if (!sheets.pickerSession(token)) return sendPage(reply, 400, 'Link expired', EXPIRED);
    const link = (query: string) =>
      `/api/dev/fake-google-sheets/pick?token=${encodeURIComponent(token)}&${query}`;
    const items = [...fake.sheets]
      .map(
        ([id, sheet]) =>
          `<li><a class="sheet" href="${escapeHtml(link(`id=${encodeURIComponent(id)}`))}">${escapeHtml(sheet.name)}</a></li>`,
      )
      .join('');
    return sendPage(
      reply,
      200,
      'Fake Google file picker',
      `<ul>${items}</ul><p><a id="cancel" href="${escapeHtml(link('cancel=1'))}">Cancel</a></p>`,
    );
  });

  app.get('/dev/fake-google-sheets/pick', async (req, reply) => {
    if (!isHostRequest(req)) return sendPage(reply, 403, 'Not allowed', NOT_HERE);
    const query = z
      .object({
        token: z.string().max(100),
        id: z.string().max(120).optional(),
        cancel: z.string().optional(),
      })
      .parse(req.query ?? {});
    const ok = await sheets.pickerResult(query.token, {
      id: query.id,
      cancelled: query.cancel !== undefined,
    });
    return ok
      ? sendPage(reply, 200, 'Done', '<p>Close this window and return to EzyChat.</p>')
      : sendPage(reply, 400, 'Not picked', EXPIRED);
  });

  app.post('/dev/fake-google-sheets', admin, async (req) => {
    fake.mode = parse(FakeSheetsBody, req.body ?? {}).state;
    return sheets.status();
  });

  app.get('/dev/fake-google-sheets', admin, async () => ({
    mode: fake.mode,
    sheets: [...fake.sheets].map(([id, sheet]) => ({
      id,
      name: sheet.name,
      tabs: Object.fromEntries(sheet.tabs),
    })),
  }));
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DriveAgentSettings, DrivePickerBody, DrivePickerResult } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import {
  DRIVE_PICKER_PAGE_HTML,
  DRIVE_PICKER_SCRIPT,
  PICKER_PAGE_CSP,
} from '../connectors/google-drive/picker-page.js';
import { getGoogleDrive } from '../connectors/google-drive/service.js';
import { FOLDER_MIME } from '../connectors/google-drive/drive.js';
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
const FakeDriveBody = z.object({ state: z.enum(['ok', 'expired', 'unavailable']) });
const TokenQuery = z.object({ token: z.string().max(100).default('') });

/** A query value given once or several times, as a list. */
const toList = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

export const DRIVE_CALLBACK_PATH = '/api/connectors/google-drive/callback';

const NOT_HERE = '<p>Choose in Google Drive on the computer that runs EzyChat.</p>';
const EXPIRED = '<p>This link expired. Choose again from EzyChat.</p>';

/** This server on this computer, on the port it really listens on. */
function loopbackOrigin(req: FastifyRequest, ctx: AppContext): string {
  const address = req.server.server.address();
  const port = address && typeof address === 'object' ? address.port : ctx.config.port;
  return `http://127.0.0.1:${port}`;
}

/**
 * Admin → Connectors → Google Drive: sign-in, Google's file picker (folder or files), per-agent
 * settings and the activity list (admins), and Google's redirect back and the picker page (this
 * computer only, no session).
 */
export default async function connectorGoogleDriveRoutes(app: FastifyInstance, ctx: AppContext) {
  const drive = getGoogleDrive(ctx);
  const admin = { preHandler: requireAdmin(ctx) };
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });

  app.get('/connectors/google-drive', admin, async () => drive.status());

  app.post('/connectors/google-drive/connect', admin, async (req) =>
    drive.startConnect(`${loopbackOrigin(req, ctx)}${DRIVE_CALLBACK_PATH}`, actor(req)),
  );

  app.get('/connectors/google-drive/connect/:requestId', admin, async (req) => {
    const { requestId } = parse(RequestParams, req.params);
    const progress = drive.progress(requestId);
    if (!progress) throw errors.notFound('Sign-in request');
    return progress;
  });

  // Google sends the browser here. Only this computer (the redirect address is 127.0.0.1): never
  // the LAN or the tunnel. The one-time state and the PKCE verifier guard the rest.
  app.get('/connectors/google-drive/callback', async (req, reply) => {
    if (!isHostRequest(req))
      return sendPage(
        reply,
        403,
        'Not allowed',
        '<p>Finish the Google sign-in on the computer that runs EzyChat.</p>',
      );
    const query = CallbackQuery.safeParse(req.query ?? {});
    const page = await drive.callback(query.success ? query.data : {});
    return sendPage(reply, page.status, page.title, `<p>${escapeHtml(page.message)}</p>`);
  });

  app.post('/connectors/google-drive/disconnect', admin, async (req) => {
    await drive.disconnect(actor(req));
    return drive.status();
  });

  // Google's file picker: the admin starts it here; its page, script, token and answer are served
  // only to this computer (like the sign-in callback), guarded by the one-time picker token.
  app.post('/connectors/google-drive/picker', admin, async (req) => {
    const body = parse(DrivePickerBody, req.body ?? {});
    return drive.startPicker(loopbackOrigin(req, ctx), body, actor(req));
  });

  app.get('/connectors/google-drive/picker/:requestId', admin, async (req) => {
    const { requestId } = parse(RequestParams, req.params);
    const progress = drive.pickerProgress(requestId);
    if (!progress) throw errors.notFound('Picker');
    return progress;
  });

  app.get('/connectors/google-drive/picker-page', async (req, reply) => {
    if (!isHostRequest(req)) return sendPage(reply, 403, 'Not allowed', NOT_HERE);
    const { token } = parse(TokenQuery, req.query ?? {});
    if (!drive.pickerSession(token)) return sendPage(reply, 400, 'Link expired', EXPIRED);
    return reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', PICKER_PAGE_CSP)
      .type('text/html; charset=utf-8')
      .send(DRIVE_PICKER_PAGE_HTML);
  });

  app.get('/connectors/google-drive/picker.js', async (req, reply) => {
    if (!isHostRequest(req)) return reply.status(403).send();
    return reply
      .header('cache-control', 'no-store')
      .type('text/javascript')
      .send(DRIVE_PICKER_SCRIPT);
  });

  app.get('/connectors/google-drive/picker-config', async (req, reply) => {
    if (!isHostRequest(req)) throw errors.notFound('Picker');
    const { token } = parse(TokenQuery, req.query ?? {});
    const config = await drive.pickerConfig(token);
    if (!config) throw errors.notFound('Picker');
    return reply.header('cache-control', 'no-store').send(config);
  });

  app.post('/connectors/google-drive/picker-result', async (req) => {
    if (!isHostRequest(req)) throw errors.notFound('Picker');
    const body = parse(DrivePickerResult, req.body ?? {});
    if (!(await drive.pickerResult(body.token, body)))
      throw errors.validation('EzyChat could not open that in Google Drive');
    return { ok: true };
  });

  app.get('/connectors/google-drive/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    return drive.getSettings(agentId);
  });

  app.put('/connectors/google-drive/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    // Unknown agent first (404), then the body (400).
    drive.getSettings(agentId);
    const body = parse(DriveAgentSettings, req.body ?? {});
    return drive.putSettings(agentId, body, actor(req));
  });

  app.get('/connectors/google-drive/activity', admin, async () => ({
    activity: drive.activity(),
  }));

  // Fake Google (--fake-wa only): the consent page, the file picker and a switch for the states.
  const fake = drive.fake;
  if (!fake) return;

  app.get('/dev/fake-google-drive/consent', async (req, reply) => {
    const raw = (req.query as { state?: unknown } | null)?.state;
    const state = typeof raw === 'string' ? raw : '';
    const allow = drive.fakeConsent(state, true);
    const cancel = drive.fakeConsent(state, false);
    if (!allow || !cancel)
      return sendPage(reply, 400, 'Sign-in link expired', '<p>Start the sign-in again.</p>');
    return sendPage(
      reply,
      200,
      'Fake Google sign-in',
      `<p>EzyChat (test) wants to see, edit, create and delete only the specific Google Drive files you use with this app.</p><p><a id="allow" href="${escapeHtml(allow)}">Allow</a><a id="cancel" href="${escapeHtml(cancel)}">Cancel</a></p>`,
    );
  });

  // The fake file picker: the fake's folders, or the files of the agent's folder (this computer).
  app.get('/dev/fake-google-drive/picker', async (req, reply) => {
    if (!isHostRequest(req)) return sendPage(reply, 403, 'Not allowed', NOT_HERE);
    const { token } = parse(TokenQuery, req.query ?? {});
    const session = drive.pickerSession(token);
    if (!session) return sendPage(reply, 400, 'Link expired', EXPIRED);
    const link = (query: string) =>
      `/api/dev/fake-google-drive/pick?token=${encodeURIComponent(token)}&${query}`;
    const items =
      session.kind === 'folder'
        ? fake.folders()
        : fake.filesIn(session.parent ?? '').filter((i) => i.mimeType !== FOLDER_MIME);
    const idParam = (id: string) => 'ids=' + encodeURIComponent(id);
    const list = items
      .map((item) => {
        const href = escapeHtml(link(idParam(item.id)));
        return `<li><a class="item" href="${href}">${escapeHtml(item.name)}</a></li>`;
      })
      .join('');
    const allHref = escapeHtml(link(items.map((i) => idParam(i.id)).join('&')));
    const all =
      session.kind === 'files' && items.length
        ? `<p><a id="all" href="${allHref}">All files</a></p>`
        : '';
    return sendPage(
      reply,
      200,
      'Fake Google file picker',
      `<ul>${list}</ul>${all}<p><a id="cancel" href="${escapeHtml(link('cancel=1'))}">Cancel</a></p>`,
    );
  });

  app.get('/dev/fake-google-drive/pick', async (req, reply) => {
    if (!isHostRequest(req)) return sendPage(reply, 403, 'Not allowed', NOT_HERE);
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const query = z
      .object({
        token: z.string().max(100),
        ids: z
          .union([z.string().max(200), z.array(z.string().max(200)).max(50)])
          .optional()
          .transform(toList),
        cancel: z.string().optional(),
      })
      .parse(raw);
    const ok = await drive.pickerResult(query.token, {
      ids: query.ids,
      cancelled: query.cancel !== undefined,
    });
    return ok
      ? sendPage(reply, 200, 'Done', '<p>Close this window and return to EzyChat.</p>')
      : sendPage(reply, 400, 'Not picked', EXPIRED);
  });

  app.post('/dev/fake-google-drive', admin, async (req) => {
    fake.mode = parse(FakeDriveBody, req.body ?? {}).state;
    return drive.status();
  });

  app.get('/dev/fake-google-drive', admin, async () => ({
    mode: fake.mode,
    items: [...fake.items.values()].map((i) => ({
      id: i.id,
      name: i.name,
      mimeType: i.mimeType,
      parents: i.parents,
      size: i.content.length,
      granted: fake.granted.has(i.id),
      created: fake.created.has(i.id),
    })),
  }));
}

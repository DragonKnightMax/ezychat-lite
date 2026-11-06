import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SendTemplateBody, type TemplateListResponse } from '@ezychat/shared';
import { requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { errors, parse } from '../http/errors.js';
import { canOpen, visibleInboxIds } from '../inboxes/access.js';
import { getMessages } from '../wa-bridge/index.js';
import { chatJidParam } from './chats.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ListQuery = z.object({ refresh: z.enum(['0', '1']).optional() });

/**
 * Approved message templates (WhatsApp Business API inboxes): `GET /inboxes/:id/templates` for
 * anyone who may open the inbox (404 otherwise), `POST /chats/:jid/template` to send one, also
 * after the reply window closed. The sent message is the record; nothing extra is audited.
 */
export default async function templateRoutes(app: FastifyInstance, ctx: AppContext) {
  const messages = getMessages(ctx);
  app.addHook('preHandler', requireUser(ctx));

  app.get('/inboxes/:id/templates', async (req): Promise<TemplateListResponse> => {
    const { id } = parse(IdParams, req.params);
    const { refresh } = parse(ListQuery, req.query ?? {});
    const row = ctx.inboxes.repo.get(id);
    if (!row || row.removed_at !== null || !canOpen(visibleInboxIds(ctx, req.user!), id))
      throw errors.notFound('Inbox');
    return { templates: await messages.listTemplates(id, refresh === '1') };
  });

  app.post('/chats/:jid/template', async (req, reply) => {
    const jid = chatJidParam(ctx, req);
    const body = parse(SendTemplateBody, req.body);
    return reply.status(201).send(await messages.sendTemplate(jid, body, req.user!.id));
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NewChatBody,
  NewChatCheckBody,
  NewChatSettingsBody,
  type NewChatCheckResponse,
  type NewChatResponse,
  type NewChatStatus,
} from '@ezychat/shared';
import { requireAdmin, requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { clientIp } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { createNewChatService, type NewChatService } from '../chats/new-chat.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * New chat (design docs/features/new-chat/design.md): `GET /new-chat` (anyone signed in: may they start
 * chats, from which inboxes), `PUT /new-chat/settings` (admins), and per inbox `POST …/new-chat/check`
 * (never asks WhatsApp) and `POST …/new-chat` (counted; checks the number or sends the template).
 */
export default async function newChatRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireUser(ctx));
  const service = (): NewChatService => (ctx.services.newChat ??= createNewChatService(ctx));
  const checks = new WindowLimiter({ windowMs: 60_000, max: 60 });

  app.get('/new-chat', async (req): Promise<NewChatStatus> => service().status(req.user!));

  app.put(
    '/new-chat/settings',
    { preHandler: requireAdmin(ctx) },
    async (req): Promise<NewChatStatus> => {
      service().updateSettings(parse(NewChatSettingsBody, req.body), {
        userId: req.user!.id,
        ip: clientIp(req),
      });
      return service().status(req.user!);
    },
  );

  app.post('/inboxes/:id/new-chat/check', async (req): Promise<NewChatCheckResponse> => {
    const hit = checks.hit(String(req.user!.id));
    if (!hit.allowed) throw errors.rateLimited(hit.retryAfterSec);
    const { id } = parse(IdParams, req.params);
    return service().check(req.user!, id, parse(NewChatCheckBody, req.body).phone);
  });

  app.post('/inboxes/:id/new-chat', async (req, reply): Promise<NewChatResponse> => {
    const { id } = parse(IdParams, req.params);
    const out = await service().start(req.user!, id, parse(NewChatBody, req.body), clientIp(req));
    return reply.status(out.created ? 201 : 200).send(out);
  });
}

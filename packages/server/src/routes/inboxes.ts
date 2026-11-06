import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateInboxBody,
  SetMemberChatsBody,
  SetUserInboxesBody,
  UpdateInboxBody,
} from '@ezychat/shared';
import { requireAdmin, requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { clientIp } from '../http/client-ip.js';
import { parse } from '../http/errors.js';
import { getInboxService, type InboxActor } from '../inboxes/service.js';
import { registerWaActions } from './wa.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * Linked WhatsApp numbers (inboxes). `GET /inboxes` for everyone (their own inboxes); adding,
 * renaming, removing, the phone actions and Members → Inbox access are admin-only and audited.
 */
export default async function inboxRoutes(app: FastifyInstance, ctx: AppContext) {
  const inboxes = getInboxService(ctx);
  const adminOnly = requireAdmin(ctx);
  const actor = (req: FastifyRequest): InboxActor => ({ userId: req.user!.id, ip: clientIp(req) });
  const idOf = (req: FastifyRequest) => parse(IdParams, req.params).id;

  app.get('/inboxes', { preHandler: requireUser(ctx) }, async (req) => inboxes.list(req.user!));

  app.post('/inboxes', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(CreateInboxBody, req.body);
    return reply.status(201).send(await inboxes.create(body, actor(req)));
  });

  app.patch('/inboxes/:id', { preHandler: adminOnly }, async (req) => {
    const id = idOf(req);
    return inboxes.update(id, parse(UpdateInboxBody, req.body ?? {}), actor(req));
  });

  app.delete('/inboxes/:id', { preHandler: adminOnly }, async (req, reply) => {
    await inboxes.remove(idOf(req), actor(req));
    return reply.status(204).send();
  });

  registerWaActions(app, ctx, '/inboxes/:id/wa', (req) => {
    const inboxId = idOf(req);
    return { wa: inboxes.adapter(inboxId), inboxId };
  });

  app.put('/users/:id/inboxes', { preHandler: adminOnly }, async (req) => {
    const id = idOf(req);
    const { inboxIds } = parse(SetUserInboxesBody, req.body);
    return inboxes.setUserInboxes(id, inboxIds, actor(req));
  });

  // Members → Edit → "Chats this member can see" (an agent: all chats or only chosen chats).
  app.get('/users/:id/chats', { preHandler: adminOnly }, async (req) =>
    inboxes.memberChats(idOf(req)),
  );

  app.put('/users/:id/chats', { preHandler: adminOnly }, async (req) =>
    inboxes.setMemberChats(idOf(req), parse(SetMemberChatsBody, req.body), actor(req)),
  );
}

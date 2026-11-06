import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateUserBody, PatchUserBody } from '@ezychat/shared';
import { getAuth, requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { clientIp } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';
import { getInboxService } from '../inboxes/service.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

export default async function usersRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = getAuth(ctx);
  const inboxes = getInboxService(ctx);
  app.addHook('preHandler', requireAdmin(ctx));

  // agents carry the inboxes they may open when the build allows several ([] for none), and an
  // agent limited to chosen chats carries those chats (assignment offers them only there)
  app.get('/users', async (req) => ({
    users: auth.listUsers().map((u) => {
      const inboxIds = inboxes.usersListInboxIds(u);
      const chatJids = inboxes.directoryChatJids(u, req.user!);
      return { ...u, ...(inboxIds ? { inboxIds } : {}), ...(chatJids ? { chatJids } : {}) };
    }),
  }));

  app.post('/users', async (req, reply) => {
    const body = parse(CreateUserBody, req.body);
    const user = auth.createUser({ ...body, mustChangePassword: true });
    inboxes.onUserCreated(user);
    audit(ctx.db, {
      userId: req.user!.id,
      action: 'user.create',
      ip: clientIp(req),
      meta: { targetId: user.id, username: user.username, role: user.role },
    });
    return reply.status(201).send(user);
  });

  app.patch('/users/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    const patch = parse(PatchUserBody, req.body);
    const user = auth.updateUser(id, patch, req.user!.id);
    audit(ctx.db, {
      userId: req.user!.id,
      action: 'user.update',
      ip: clientIp(req),
      meta: { targetId: id, ...patch },
    });
    return user;
  });

  app.post('/users/:id/reset-password', async (req) => {
    const { id } = parse(IdParams, req.params);
    if (!auth.getUser(id)) throw errors.notFound('User');
    const password = await auth.resetPassword(id, req.sessionToken!);
    audit(ctx.db, {
      userId: req.user!.id,
      action: 'user.reset_password',
      ip: clientIp(req),
      meta: { targetId: id },
    });
    return { password };
  });

  app.delete('/users/:id/sessions', async (req) => {
    const { id } = parse(IdParams, req.params);
    if (!auth.getUser(id)) throw errors.notFound('User');
    auth.revokeAll(id);
    audit(ctx.db, {
      userId: req.user!.id,
      action: 'user.revoke_sessions',
      ip: clientIp(req),
      meta: { targetId: id },
    });
    return { ok: true };
  });
}

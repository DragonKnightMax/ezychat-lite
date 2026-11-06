import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ScheduledPreviewBody, ScheduledTaskBody, ScheduledTaskPatch } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { clientIp } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';

const AgentParams = z.object({ agentId: z.coerce.number().int().positive() });
const TaskParams = AgentParams.extend({ id: z.coerce.number().int().positive() });

/**
 * Scheduled tasks of an AI agent (docs/features/scheduled-tasks/design.md), admins only: the list,
 * create / edit / delete, the run history, Run now and a preview that sends nothing. Every write is
 * audited with ids only.
 */
export default async function scheduledTaskRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireAdmin(ctx));
  const service = () => {
    const scheduled = ctx.services.scheduled;
    if (!scheduled) throw errors.notFound('Scheduled tasks');
    return scheduled;
  };
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });
  const agent = (req: FastifyRequest) => parse(AgentParams, req.params).agentId;
  const task = (req: FastifyRequest) => parse(TaskParams, req.params);

  app.get('/ai/agents/:agentId/scheduled-tasks', async (req) => service().list(agent(req)));
  app.post('/ai/agents/:agentId/scheduled-tasks', async (req) =>
    service().create(agent(req), parse(ScheduledTaskBody, req.body), actor(req)),
  );
  app.post('/ai/agents/:agentId/scheduled-tasks/preview', async (req) =>
    service().preview(agent(req), parse(ScheduledPreviewBody, req.body), actor(req)),
  );
  app.patch('/ai/agents/:agentId/scheduled-tasks/:id', async (req) => {
    const { agentId, id: taskId } = task(req);
    return service().update(agentId, taskId, parse(ScheduledTaskPatch, req.body), actor(req));
  });
  app.delete('/ai/agents/:agentId/scheduled-tasks/:id', async (req) => {
    const { agentId, id: taskId } = task(req);
    service().remove(agentId, taskId, actor(req));
    return { ok: true };
  });
  app.get('/ai/agents/:agentId/scheduled-tasks/:id/runs', async (req) => {
    const { agentId, id: taskId } = task(req);
    return service().runs(agentId, taskId);
  });
  app.post('/ai/agents/:agentId/scheduled-tasks/:id/run', async (req) => {
    const { agentId, id: taskId } = task(req);
    return { run: await service().runNow(agentId, taskId, actor(req)) };
  });
}

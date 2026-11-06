import type { FastifyInstance } from 'fastify';
import type { DirectoryUser } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { getAuth, requireUser } from '../auth/guards.js';
import { getInboxService } from '../inboxes/service.js';
import { agentById } from '../ai/agents.js';
import { answersDirect } from '../ai/direct.js';

/**
 * Names and assignment availability only; every teammate can recognize the AI agents. Deleted AI agents stay
 * listed (`aiDeleted`, disabled) so their old messages keep a name; the web never offers them as assignees.
 * `inboxIds` tells who may open which inbox, so assignment offers only people who can open the chat;
 * an agent sees only the inboxes that agent opens too (other inboxes stay invisible).
 */
export default async function directoryRoutes(app: FastifyInstance, ctx: AppContext) {
  const inboxes = getInboxService(ctx);
  const noDirect = (agentId: number | undefined) => {
    const agent = agentId ? agentById(ctx.db, agentId) : null;
    return !!agent && !answersDirect(ctx, agent);
  };
  app.get('/users/directory', { preHandler: requireUser(ctx) }, async (req) => ({
    users: getAuth(ctx)
      .listUsers({ includeDeleted: true })
      .map((u): DirectoryUser => {
        const chatJids = inboxes.directoryChatJids(u, req.user!);
        return {
          id: u.id,
          displayName: u.displayName,
          role: u.role,
          disabled: u.disabled,
          kind: u.kind,
          aiRole: u.aiRole,
          ...(u.aiAgentId ? { aiAgentId: u.aiAgentId } : {}),
          ...(u.aiDeleted ? { aiDeleted: true } : {}),
          ...(noDirect(u.aiAgentId) ? { aiNoDirect: true } : {}),
          inboxIds: inboxes.directoryInboxIds(u, req.user!),
          ...(chatJids ? { chatJids } : {}),
        };
      }),
  }));
}

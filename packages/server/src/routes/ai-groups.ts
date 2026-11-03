import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AiAgentDirectBody,
  AiAgentGroupChatsBody,
  AiAgentGroupsBody,
  AiGroupChatBody,
} from '@ezychat/shared';
import { requireAdmin, requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import {
  agentGroups,
  groupChatStatus,
  setAgentDirect,
  setAgentGroupChats,
  setAgentGroups,
  setGroupChat,
} from '../ai/groups.js';
import { clientIp } from '../http/client-ip.js';
import { parse } from '../http/errors.js';
import { chatJidParam } from './chats.js';

const AgentParams = z.object({ agentId: z.coerce.number().int().positive() });

/**
 * AI agents in WhatsApp groups (docs/features/ai-groups/design.md): the agent's "Answer in groups"
 * switch with its inbox's groups, the groups given to it (`group-chats`) and its "Answer direct
 * chats" switch (admins), and one group's switch, agent and "Reads every message" (read: anyone who
 * may open the chat, 404 outside their inboxes; write: admins). Every write is audited.
 */
export default async function aiGroupRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireUser(ctx));
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });
  const agentId = (req: FastifyRequest) => parse(AgentParams, req.params).agentId;

  app.get('/ai/agents/:agentId/groups', { preHandler: requireAdmin(ctx) }, async (req) =>
    agentGroups(ctx, agentId(req)),
  );
  app.put('/ai/agents/:agentId/groups', { preHandler: requireAdmin(ctx) }, async (req) =>
    setAgentGroups(ctx, agentId(req), parse(AiAgentGroupsBody, req.body).enabled, actor(req)),
  );
  app.put('/ai/agents/:agentId/group-chats', { preHandler: requireAdmin(ctx) }, async (req) =>
    setAgentGroupChats(ctx, agentId(req), parse(AiAgentGroupChatsBody, req.body), actor(req)),
  );
  app.put('/ai/agents/:agentId/direct', { preHandler: requireAdmin(ctx) }, async (req) =>
    setAgentDirect(ctx, agentId(req), parse(AiAgentDirectBody, req.body).enabled, actor(req)),
  );
  app.get('/chats/:jid/ai-group', async (req) => groupChatStatus(ctx, chatJidParam(ctx, req)));
  app.put('/chats/:jid/ai-group', { preHandler: requireAdmin(ctx) }, async (req) =>
    setGroupChat(ctx, chatJidParam(ctx, req), parse(AiGroupChatBody, req.body), actor(req)),
  );
}

import type { AppContext } from '../context.js';
import { capabilitiesOf } from '../inboxes/types.js';
import { agentsForInbox, type AgentRow } from './agents.js';

/**
 * Whether the connection of an inbox has WhatsApp groups (`WaAdapter.capabilities.groups`; a linked
 * phone has, the WhatsApp Business API has not). An inbox without a live connection (removed,
 * unknown) counts as having none.
 */
export function inboxHasGroups(ctx: AppContext, inboxId: number | null): boolean {
  if (inboxId === null) return false;
  try {
    return capabilitiesOf(ctx.inboxes.connections.adapter(inboxId)).groups;
  } catch {
    return false;
  }
}

/**
 * Whether the agent answers (and may be assigned) direct chats (design
 * docs/features/ai-direct-chats/design.md). Its "Answer direct chats" switch counts only where groups
 * exist: on an inbox without groups a group-only agent would answer nothing, so it answers direct
 * chats whatever was saved (a later type change cannot silence it).
 */
export function answersDirect(ctx: AppContext, agent: AgentRow): boolean {
  return agent.answerDirect || !inboxHasGroups(ctx, agent.inboxId);
}

/**
 * The agent that answers direct chats of an inbox (at most one: the one with "Answer direct chats"
 * on; on an inbox without groups the switch does not count, the oldest agent answers), else null.
 */
export function directAgentOf(ctx: AppContext, inboxId: number): AgentRow | null {
  const agents = agentsForInbox(ctx.db, inboxId);
  return (
    agents.find((agent) => agent.answerDirect) ?? agents.find((a) => answersDirect(ctx, a)) ?? null
  );
}

/**
 * A second agent that would answer direct chats in this inbox: on an inbox without groups every
 * agent does (its switch does not count there), so only one agent fits such an inbox.
 */
export function directSlotTaken(
  ctx: AppContext,
  inboxId: number | null,
  agentId: number | null,
): boolean {
  if (inboxId === null || inboxHasGroups(ctx, inboxId)) return false;
  return agentsForInbox(ctx.db, inboxId).some((agent) => agent.id !== agentId);
}

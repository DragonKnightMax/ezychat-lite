import { z } from 'zod';

/**
 * AI agents in WhatsApp groups (design docs/features/ai-groups/design.md, confirmed 2026-10-28).
 * An agent with "Answer in groups" on answers, in a group an admin switched on, only a live message
 * that tags the business number (@mention) or quotes a message the AI sent. Every other group
 * message gets no reply. The AI never takes the group chat; the loop guard pauses it after
 * `AI_GROUP_LOOP_GUARD` answers in a row without a teammate message.
 */
export const AI_GROUP_LOOP_GUARD = 10;
/** The conversation part of a group answer: at most this many of the group's last messages. */
export const AI_GROUP_CONTEXT_MESSAGES = 20;

/** The group part of an `ai_tool_used` chat event (the lines in a group chat). */
export const AiGroupEvent = z.object({
  kind: z.enum(['answered', 'handover', 'paused']),
  /** The member the AI answered or handed over (a display name, never a number). */
  member: z.string().max(120).nullable(),
  /** answered: the member quoted an AI message (no @mention). */
  quoted: z.boolean().optional(),
});
export type AiGroupEvent = z.infer<typeof AiGroupEvent>;

/** One WhatsApp group of the agent's inbox on the agent page. */
export const AiGroupRow = z.object({
  jid: z.string(),
  name: z.string(),
  memberCount: z.number().int().nonnegative().nullable(),
  enabled: z.boolean(),
  /** The loop guard holds now in this group (the AI waits for a teammate message). */
  paused: z.boolean().default(false),
  /** The agent this group is given to (several agents per inbox), null = none. */
  agentId: z.number().int().positive().nullable().default(null),
  agentName: z.string().nullable().default(null),
  /** "Reads every message": every live member message starts a turn (else tags and quotes only). */
  listen: z.boolean().default(false),
});
export type AiGroupRow = z.infer<typeof AiGroupRow>;

/** `GET /api/ai/agents/:agentId/groups` (admins): the switch, the inbox's groups and the guard. */
export const AiAgentGroups = z.object({
  enabled: z.boolean(),
  /** The agent's inbox (its WhatsApp number's name), null when the agent serves no inbox. */
  inboxName: z.string().nullable().default(null),
  groups: z.array(AiGroupRow),
  loopGuard: z.number().int().positive(),
  /**
   * "Answer direct chats" (design docs/features/ai-direct-chats/design.md, confirmed 2026-10-30).
   * Off with `enabled` on = a group-only agent. Older servers: on.
   */
  answerDirect: z.boolean().default(true),
  /** The agent's inbox has WhatsApp groups (else the direct switch is hidden and does not apply). */
  directAvailable: z.boolean().default(false),
  /** Open direct chats the agent holds now (they go back to the team when direct turns off). */
  heldDirect: z.number().int().nonnegative().default(0),
});
export type AiAgentGroups = z.infer<typeof AiAgentGroups>;

/** `PUT /api/ai/agents/:agentId/groups` (admins): the agent's "Answer in groups" switch. */
export const AiAgentGroupsBody = z.strictObject({ enabled: z.boolean() });
export type AiAgentGroupsBody = z.infer<typeof AiAgentGroupsBody>;
/** `PUT /api/ai/agents/:agentId/direct` (admins): "Answer direct chats"; answers `AiAgentGroups`. */
export const AiAgentDirectBody = z.strictObject({ enabled: z.boolean() });
export type AiAgentDirectBody = z.infer<typeof AiAgentDirectBody>;
/**
 * `PUT /api/ai/agents/:agentId/group-chats` (admins): give groups of the agent's inbox to this agent
 * (`enabled` true, optionally with `listen`) or take them back (`enabled` false). A group another
 * agent holds is refused (409 `group_has_agent`). Answers `AiAgentGroups`.
 */
export const AiAgentGroupChatsBody = z.strictObject({
  jids: z.array(z.string().min(1).max(200)).min(1).max(200),
  enabled: z.boolean(),
  listen: z.boolean().optional(),
});
export type AiAgentGroupChatsBody = z.infer<typeof AiAgentGroupChatsBody>;

/**
 * `GET /api/chats/:jid/ai-group` (anyone who may open the chat) and `PUT` (admins, body
 * `AiGroupChatBody`): whether the AI answers tags and quotes in this group.
 */
export const AiGroupChat = z.object({
  /** This group is switched on. */
  enabled: z.boolean(),
  /** The agent of the group's inbox, if any. */
  agentId: z.number().int().positive().nullable(),
  agentName: z.string().nullable(),
  /** The agent itself is on (else nothing is answered, whatever the switches say). */
  agentEnabled: z.boolean().default(false),
  /** The agent is on and its "Answer in groups" is on (else the group switch has no effect). */
  agentAnswersGroups: z.boolean(),
  /** The loop guard holds now: the AI waits for a teammate message in this group. */
  paused: z.boolean(),
  /** "Reads every message" in this group. */
  listen: z.boolean().default(false),
  /** Agents of the group's inbox with "Answer in groups" on (the choices for this group). */
  agents: z.array(z.object({ id: z.number().int().positive(), name: z.string() })).default([]),
});
export type AiGroupChat = z.infer<typeof AiGroupChat>;
/**
 * `agentId`: the agent for this group (else the group keeps its agent, or the inbox's only group
 * agent; several and none chosen → 400 `agent_required`). `listen`: "Reads every message".
 */
export const AiGroupChatBody = z.strictObject({
  enabled: z.boolean(),
  agentId: z.number().int().positive().optional(),
  listen: z.boolean().optional(),
});
export type AiGroupChatBody = z.infer<typeof AiGroupChatBody>;

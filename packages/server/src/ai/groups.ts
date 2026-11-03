import {
  AI_GROUP_LOOP_GUARD,
  type AiAgentGroupChatsBody,
  type AiAgentGroups,
  type AiGroupChat,
  type AiGroupChatBody,
  type AiGroupEvent,
  type AiToolUsedPayload,
  type Message,
} from '@ezychat/shared';
import { normalizeContactJid } from '@ezychat/wa';
import type { AppContext } from '../context.js';
import type { DB } from '../db/index.js';
import { audit } from '../db/audit.js';
import { getAliases } from '../chats/aliases.js';
import { HttpError, errors } from '../http/errors.js';
import { inboxOfKey, parseChatKey } from '../inboxes/keys.js';
import { getChats } from '../wa-bridge/index.js';
import {
  AgentError,
  agentById,
  agentForInbox,
  agentsForInbox,
  setAgentAnswerDirect,
  setAgentAnswerGroups,
  type AgentRow,
} from './agents.js';
import { directAgentOf, inboxHasGroups } from './direct.js';

/**
 * AI agents in WhatsApp groups (design docs/features/ai-groups/design.md). The switches (the agent's
 * "Answer in groups", one row per group in `ai_group_chats`, migration 024), whether a live group
 * message is addressed to the AI (a tag of the business number or a quote of an AI answer) and the
 * loop guard. The turn itself runs in `ai/service.ts`.
 */

/** How a member addressed the AI. */
export type GroupTrigger = 'tag' | 'quote';

type Actor = { userId: number; ip: string | null };

/** The own JIDs and LIDs of one inbox, normalized: its session now, else the remembered number. */
export function inboxOwnJids(ctx: AppContext, inboxId: number): Set<string> {
  const ids: Array<string | null | undefined> = [];
  try {
    const me = ctx.inboxes.connections.adapter(inboxId).status.me;
    ids.push(me?.jid, me?.lid);
  } catch {
    // a removed inbox has no connection: its remembered number only
  }
  ids.push(ctx.inboxes.repo.get(inboxId)?.own_jid);
  return new Set(
    ids.flatMap((jid) => {
      const normalized = normalizeContactJid(jid);
      return normalized ? [normalized] : [];
    }),
  );
}

/** The stored WhatsApp mentions of a message; corrupt metadata is no mention. */
function storedMentions(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.flatMap((jid: unknown) => {
          const normalized = normalizeContactJid(jid);
          return normalized ? [normalized] : [];
        })
      : [];
  } catch {
    return [];
  }
}

/**
 * Whether a stored live group message is addressed to the AI: `tag` when its WhatsApp mentions
 * name the inbox's own number (JID or LID, through known aliases), `quote` when it quotes a message
 * of this chat sent by the agent's AI user; else null. Keyword or name matches never count.
 */
export function addressedToAi(
  ctx: AppContext,
  input: { chatJid: string; messageId: string; quotedId: string | null; aiUserId: number },
): GroupTrigger | null {
  const row = ctx.db
    .prepare('SELECT mentioned_jids FROM messages WHERE id = ? AND chat_jid = ?')
    .get(input.messageId, input.chatJid) as { mentioned_jids: string | null } | undefined;
  const mentions = storedMentions(row?.mentioned_jids);
  if (mentions.length) {
    const own = inboxOwnJids(ctx, inboxOfKey(input.chatJid));
    const aliases = getAliases(ctx);
    if (mentions.some((jid) => own.has(jid) || aliases.group(jid).some((id) => own.has(id))))
      return 'tag';
  }
  if (
    input.quotedId &&
    ctx.db
      .prepare(
        'SELECT 1 FROM messages WHERE id = ? AND chat_jid = ? AND from_me = 1 AND sent_by_user_id = ?',
      )
      .get(input.quotedId, input.chatJid, input.aiUserId)
  )
    return 'quote';
  return null;
}

/** One group's row in `ai_group_chats` (migrations 024, 032); a group without a row is off. */
export interface GroupChatRow {
  enabled: boolean;
  /** The agent the group is given to; null = none. */
  agentId: number | null;
  /** "Reads every message". */
  listen: boolean;
}

export function groupChatRow(db: DB, jid: string): GroupChatRow {
  const row = db
    .prepare('SELECT enabled, agent_id AS agentId, listen FROM ai_group_chats WHERE chat_jid = ?')
    .get(jid) as { enabled: number; agentId: number | null; listen: number } | undefined;
  return {
    enabled: row?.enabled === 1,
    agentId: row?.agentId ?? null,
    listen: row?.listen === 1,
  };
}

/** Whether an admin switched this group on (new groups start off). */
export function groupEnabled(db: DB, jid: string): boolean {
  return groupChatRow(db, jid).enabled;
}

function writeGroupRow(db: DB, jid: string, row: GroupChatRow, userId: number) {
  db.prepare(
    `INSERT INTO ai_group_chats (chat_jid, enabled, agent_id, listen, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_jid) DO UPDATE SET enabled = excluded.enabled, agent_id = excluded.agent_id,
     listen = excluded.listen, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(jid, row.enabled ? 1 : 0, row.agentId, row.listen ? 1 : 0, Date.now(), userId);
}

/** A chat key of a WhatsApp group (`…@g.us`, any inbox). */
export const isGroupKey = (jid: string): boolean => parseChatKey(jid).waJid.endsWith('@g.us');

/** The agent a group is given to, when it still serves the group's inbox (whatever its switches). */
function groupOwner(ctx: AppContext, jid: string, row = groupChatRow(ctx.db, jid)) {
  if (row.agentId === null) return null;
  const agent = agentById(ctx.db, row.agentId);
  return agent && agent.inboxId === inboxOfKey(jid) ? agent : null;
}

/**
 * The agent that answers this chat (design docs/features/group-agents/design.md): in a group the
 * agent its row names, while the group is switched on and that agent is on with "Answer in groups";
 * in a direct chat the inbox's direct agent (`directAgentOf`, on or off: the caller checks).
 */
export function agentForChat(ctx: AppContext, jid: string): AgentRow | null {
  if (!isGroupKey(jid)) return directAgentOf(ctx, inboxOfKey(jid));
  const row = groupChatRow(ctx.db, jid);
  const agent = row.enabled ? groupOwner(ctx, jid, row) : null;
  return agent?.enabled && agent.answerGroups ? agent : null;
}

/**
 * The agent whose knowledge and settings belong to this chat (reply suggestions, Fix English,
 * phrase lists, stopping work): the group's agent, else the inbox's direct agent, else its main one.
 */
export function chatAgent(ctx: AppContext, jid: string): AgentRow | null {
  const inboxId = inboxOfKey(jid);
  return (
    (isGroupKey(jid) ? groupOwner(ctx, jid) : null) ??
    directAgentOf(ctx, inboxId) ??
    agentForInbox(ctx.db, inboxId)
  );
}

/**
 * Permanent, idempotent start-up step: a switched-on group with no agent (switched on before its
 * inbox had one) gets the inbox's agent when the inbox has exactly one. Migration 032 gave existing
 * rows their inbox's agent; this only covers rows written while no agent existed.
 */
export function backfillGroupAgents(db: DB, now = Date.now()): number {
  const rows = db
    .prepare('SELECT chat_jid AS jid FROM ai_group_chats WHERE enabled = 1 AND agent_id IS NULL')
    .all() as Array<{ jid: string }>;
  let changed = 0;
  for (const { jid } of rows) {
    let inboxId: number;
    try {
      inboxId = inboxOfKey(jid);
    } catch {
      continue;
    }
    const agents = agentsForInbox(db, inboxId);
    if (agents.length !== 1) continue;
    changed += db
      .prepare(
        'UPDATE ai_group_chats SET agent_id = ?, updated_at = ? WHERE chat_jid = ? AND agent_id IS NULL',
      )
      .run(agents[0]!.id, now, jid).changes;
  }
  return changed;
}

/** The loop guard of one group: AI messages since the last teammate (or phone) message. */
export interface LoopGuardState {
  /** AI messages in a row (failed sends not counted). */
  inRow: number;
  paused: boolean;
  /** epoch ms of the last teammate message (0 = none): the start of the current run. */
  since: number;
}

/**
 * `listen` ("Reads every message"): the run is broken by any person's message (a member's too), so
 * a busy group of members never trips it; else only a teammate (or phone) message breaks it.
 */
export function loopGuard(db: DB, jid: string, listen = false): LoopGuardState {
  const last = db
    .prepare(
      `SELECT max(m.timestamp) AS at FROM messages m LEFT JOIN users u ON u.id = m.sent_by_user_id
       WHERE m.chat_jid = ? AND (m.from_me = 1 OR ?) AND (u.id IS NULL OR u.kind <> 'ai')`,
    )
    .get(jid, listen ? 1 : 0) as { at: number | null };
  const since = last.at ?? 0;
  const { n } = db
    .prepare(
      `SELECT count(*) AS n FROM messages m JOIN users u ON u.id = m.sent_by_user_id
       WHERE m.chat_jid = ? AND m.from_me = 1 AND u.kind = 'ai' AND m.status <> 'failed'
       AND m.timestamp > ?`,
    )
    .get(jid, since) as { n: number };
  return { inRow: n, paused: n >= AI_GROUP_LOOP_GUARD, since };
}

/** Whether this run (since the last teammate message) already has its "AI paused" line. */
export function pausedLineWritten(db: DB, jid: string, since: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM chat_events WHERE chat_jid = ? AND type = 'ai_tool_used' AND at >= ?
       AND json_extract(payload, '$.group.kind') = 'paused' LIMIT 1`,
    )
    .get(jid, since);
}

const PHONE_LIKE = /^[+\d\s().-]*$/;
const MEMBER_NAME_CHARACTERS = 120;

/**
 * A group member's display name for the prompt, the chat line and the notification: the team's
 * customer profile name, else the saved contact name, else their WhatsApp name. Never a number
 * (a name that is only digits counts as none).
 */
export function memberName(ctx: AppContext, message: Message): string | null {
  const saved = message.senderJid
    ? (
        ctx.db.prepare('SELECT saved_name FROM contacts WHERE jid = ?').get(message.senderJid) as
          { saved_name: string | null } | undefined
      )?.saved_name
    : null;
  for (const candidate of [message.senderProfile?.name, saved, message.senderName]) {
    const name = candidate?.trim();
    if (name && !PHONE_LIKE.test(name)) return name.slice(0, MEMBER_NAME_CHARACTERS);
  }
  return null;
}

/** Group text for the model: numeric tags (unknown people) never show a phone number. */
export const groupText = (text: string): string => text.replace(/@\+?\d{5,}/g, '@member');

/** One group line of the agent (`ai_tool_used` chat event with `group`). */
export function groupLine(
  agent: Pick<AgentRow, 'displayName'>,
  group: AiGroupEvent,
): AiToolUsedPayload {
  return {
    title: agent.displayName.trim().slice(0, 120) || 'AI',
    sourceLabel: 'WhatsApp group',
    group,
  };
}

/** The group chats of an inbox with their switch, agent and "Reads every message", by name. */
function inboxGroups(db: DB, inboxId: number) {
  return (
    db
      .prepare(
        `SELECT c.jid, c.name, coalesce(g.enabled, 0) AS enabled, a.id AS agentId,
         u.display_name AS agentName, coalesce(g.listen, 0) AS listen FROM chats c
         LEFT JOIN ai_group_chats g ON g.chat_jid = c.jid
         LEFT JOIN ai_agents a ON a.id = g.agent_id AND a.inbox_id = c.inbox_id
         LEFT JOIN users u ON u.id = a.user_id
         WHERE c.type = 'group' AND c.inbox_id = ? ORDER BY lower(c.name), c.jid`,
      )
      .all(inboxId) as Array<{
      jid: string;
      name: string | null;
      enabled: number;
      agentId: number | null;
      agentName: string | null;
      listen: number;
    }>
  ).map((row) => ({
    jid: row.jid,
    name: row.name?.trim() || parseChatKey(row.jid).waJid,
    memberCount: null,
    enabled: row.enabled === 1,
    paused: loopGuard(db, row.jid, row.listen === 1).paused,
    agentId: row.agentId,
    agentName: row.agentName,
    listen: row.listen === 1,
  }));
}

const agentNotFound = () => new HttpError(404, 'agent_not_found', 'AI agent not found');

const requireAgent = (ctx: AppContext, agentId: number): AgentRow => {
  const agent = agentById(ctx.db, agentId);
  if (!agent) throw agentNotFound();
  return agent;
};

/** `GET /api/ai/agents/:agentId/groups`: the switch, the groups of the agent's inbox, the guard. */
export function agentGroups(ctx: AppContext, agentId: number): AiAgentGroups {
  const agent = requireAgent(ctx, agentId);
  return {
    enabled: agent.answerGroups,
    inboxName: agent.inboxId === null ? null : (ctx.inboxes.repo.get(agent.inboxId)?.name ?? null),
    groups: agent.inboxId === null ? [] : inboxGroups(ctx.db, agent.inboxId),
    loopGuard: AI_GROUP_LOOP_GUARD,
    answerDirect: agent.answerDirect,
    directAvailable: inboxHasGroups(ctx, agent.inboxId),
    heldDirect: heldDirectChats(ctx.db, agent.userId),
  };
}

const heldDirectChats = (db: DB, userId: number): number =>
  (
    db
      .prepare(
        "SELECT count(*) AS n FROM chats WHERE type = 'dm' AND status = 'open' AND assigned_to = ?",
      )
      .get(userId) as { n: number }
  ).n;

/** 409 for a second agent that would answer direct chats in one inbox. */
export const directAgentTaken = () =>
  new HttpError(
    409,
    'inbox_has_direct_agent',
    'Another AI agent already answers direct chats on this number',
  );

/**
 * `PUT /api/ai/agents/:agentId/direct`: the agent's "Answer direct chats" switch (audited). Off
 * returns its open direct chats to the team, unassigned (design docs/features/ai-direct-chats). On
 * while another agent of the inbox answers direct chats: 409 `inbox_has_direct_agent`.
 */
export function setAgentDirect(
  ctx: AppContext,
  agentId: number,
  enabled: boolean,
  actor: Actor,
): AiAgentGroups {
  const agent = requireAgent(ctx, agentId);
  try {
    setAgentAnswerDirect(ctx.db, agent.id, enabled);
  } catch (error) {
    if (error instanceof AgentError && error.code === 'inbox_has_direct_agent')
      throw directAgentTaken();
    throw error;
  }
  audit(ctx.db, {
    userId: actor.userId,
    action: 'ai.direct_switch',
    ip: actor.ip,
    meta: { agentId: agent.id, agentName: agent.displayName, enabled },
  });
  if (!enabled) ctx.services.ai?.releaseDirect(agent.id);
  return agentGroups(ctx, agent.id);
}

/**
 * `PUT /api/ai/agents/:agentId/groups`: the agent's "Answer in groups" switch (audited). Off turns
 * the AI off in its groups (rows kept, agent cleared), never moving them to another agent.
 */
export function setAgentGroups(
  ctx: AppContext,
  agentId: number,
  enabled: boolean,
  actor: Actor,
): AiAgentGroups {
  const agent = requireAgent(ctx, agentId);
  // Stop its group work while the rows still name it.
  if (!enabled) ctx.services.ai?.stopGroupTurns({ agentId: agent.id });
  setAgentAnswerGroups(ctx.db, agent.id, enabled);
  audit(ctx.db, {
    userId: actor.userId,
    action: 'ai.groups_switch',
    ip: actor.ip,
    meta: { agentId: agent.id, agentName: agent.displayName, enabled },
  });
  return agentGroups(ctx, agent.id);
}

/** One `ai.group_switch` audit row: the switch, agent and "Reads every message" before and after. */
function auditGroupSwitch(
  ctx: AppContext,
  actor: Actor,
  jid: string,
  groupName: string | null,
  before: GroupChatRow,
  after: GroupChatRow,
) {
  audit(ctx.db, {
    userId: actor.userId,
    action: 'ai.group_switch',
    ip: actor.ip,
    meta: {
      chatJid: jid,
      groupName,
      enabled: after.enabled,
      agentId: after.agentId,
      listen: after.listen,
      before: { enabled: before.enabled, agentId: before.agentId, listen: before.listen },
    },
  });
}

const groupHasAgent = () =>
  new HttpError(409, 'group_has_agent', 'Another AI agent already answers this group');

/**
 * `PUT /api/ai/agents/:agentId/group-chats` (admins): gives groups of the agent's inbox to this
 * agent (`enabled` true, with `listen` when given, else kept for its own groups and off for new
 * ones) or takes its groups back (`enabled` false: AI off, agent cleared). A group another agent
 * holds is refused as a whole (409 `group_has_agent`); a jid that is not a group of the agent's
 * inbox is 400. Audited per group.
 */
export function setAgentGroupChats(
  ctx: AppContext,
  agentId: number,
  body: AiAgentGroupChatsBody,
  actor: Actor,
): AiAgentGroups {
  const agent = requireAgent(ctx, agentId);
  if (agent.inboxId === null) throw errors.validation('This AI agent has no WhatsApp number');
  const chats = getChats(ctx);
  const jids = [...new Set(body.jids)];
  const groups = jids.map((jid) => {
    const chat = chats.get(jid);
    if (!chat || chat.type !== 'group' || chat.inboxId !== agent.inboxId)
      throw errors.validation("Choose WhatsApp groups of this AI agent's number");
    return { jid, name: chat.name, row: groupChatRow(ctx.db, jid) };
  });
  const changes = ctx.db.transaction(() => {
    const out: Array<{
      jid: string;
      name: string | null;
      before: GroupChatRow;
      after: GroupChatRow;
    }> = [];
    for (const { jid, name, row } of groups) {
      const owner = groupOwner(ctx, jid, row);
      const own = owner?.id === agent.id;
      let after: GroupChatRow;
      if (body.enabled) {
        if (row.enabled && owner && !own) throw groupHasAgent();
        after = {
          enabled: true,
          agentId: agent.id,
          listen: body.listen ?? (own ? row.listen : false),
        };
      } else {
        // only its own groups go back; a group of another agent is left as it is
        if (!own) continue;
        after = { enabled: false, agentId: null, listen: false };
      }
      if (
        after.enabled === row.enabled &&
        after.agentId === row.agentId &&
        after.listen === row.listen
      )
        continue;
      writeGroupRow(ctx.db, jid, after, actor.userId);
      out.push({ jid, name, before: row, after });
    }
    return out;
  })();
  for (const change of changes) {
    auditGroupSwitch(ctx, actor, change.jid, change.name, change.before, change.after);
    // a different agent, AI off or listening off: running or waiting work of the old setting stops
    if (
      !change.after.enabled ||
      change.after.agentId !== change.before.agentId ||
      change.before.listen !== change.after.listen
    )
      ctx.services.ai?.stopGroupTurns({ jid: change.jid });
  }
  return agentGroups(ctx, agent.id);
}

const requireGroupChat = (ctx: AppContext, jid: string) => {
  const chat = getChats(ctx).get(jid);
  if (!chat) throw errors.notFound('Chat');
  if (chat.type !== 'group') throw errors.validation('Only a WhatsApp group has this switch');
  return chat;
};

/** Agents of the group's inbox with "Answer in groups" on: the choices for a group. */
const groupAgentChoices = (ctx: AppContext, jid: string): AgentRow[] =>
  agentsForInbox(ctx.db, inboxOfKey(jid)).filter((agent) => agent.answerGroups);

/**
 * The agent a group without its own gets: the inbox's only agent with "Answer in groups" on, else
 * (none has it on) the inbox's only agent; null when there is none. Several: `agent_required`.
 */
function defaultGroupAgent(ctx: AppContext, jid: string): AgentRow | null | 'several' {
  const choices = groupAgentChoices(ctx, jid);
  if (choices.length === 1) return choices[0]!;
  if (choices.length > 1) return 'several';
  const all = agentsForInbox(ctx.db, inboxOfKey(jid));
  if (all.length > 1) return 'several';
  return all[0] ?? null;
}

/** `GET /api/chats/:jid/ai-group`: the group's switch, its agent, the choices and the guard. */
export function groupChatStatus(ctx: AppContext, jid: string): AiGroupChat {
  requireGroupChat(ctx, jid);
  const row = groupChatRow(ctx.db, jid);
  const fallback = defaultGroupAgent(ctx, jid);
  const agent = groupOwner(ctx, jid, row) ?? (fallback === 'several' ? null : fallback);
  return {
    enabled: row.enabled,
    agentId: agent?.id ?? null,
    agentName: agent?.displayName ?? null,
    agentEnabled: !!agent?.enabled,
    agentAnswersGroups: !!agent && agent.enabled && agent.answerGroups,
    paused: loopGuard(ctx.db, jid, row.listen).paused,
    listen: row.listen,
    agents: groupAgentChoices(ctx, jid).map((choice) => ({
      id: choice.id,
      name: choice.displayName,
    })),
  };
}

/**
 * `PUT /api/chats/:jid/ai-group` (admins): switches the AI on or off in one group, and sets its
 * agent and "Reads every message" (audited). `agentId` must be an agent of the group's inbox with
 * "Answer in groups" on (else 400); without it the group keeps its agent, else gets
 * `defaultGroupAgent` (several: 400 `agent_required`).
 */
export function setGroupChat(
  ctx: AppContext,
  jid: string,
  body: boolean | AiGroupChatBody,
  actor: Actor,
): AiGroupChat {
  const input = typeof body === 'boolean' ? { enabled: body } : body;
  const chat = requireGroupChat(ctx, jid);
  const before = groupChatRow(ctx.db, jid);
  let agentId = groupOwner(ctx, jid, before)?.id ?? null;
  if (input.agentId !== undefined) {
    const chosen = agentById(ctx.db, input.agentId);
    if (!chosen || chosen.inboxId !== inboxOfKey(jid) || !chosen.answerGroups)
      throw new HttpError(
        400,
        'agent_not_group_agent',
        'Choose an AI agent of this number that answers in groups',
      );
    agentId = chosen.id;
  } else if (agentId === null && input.enabled) {
    const fallback = defaultGroupAgent(ctx, jid);
    if (fallback === 'several')
      throw new HttpError(400, 'agent_required', 'Choose the AI agent for this group');
    agentId = fallback?.id ?? null;
  }
  const after: GroupChatRow = {
    enabled: input.enabled,
    agentId,
    listen: input.listen ?? before.listen,
  };
  writeGroupRow(ctx.db, jid, after, actor.userId);
  auditGroupSwitch(ctx, actor, jid, chat.name, before, after);
  if (!after.enabled || after.agentId !== before.agentId || (before.listen && !after.listen))
    ctx.services.ai?.stopGroupTurns({ jid });
  return groupChatStatus(ctx, jid);
}

import { randomUUID } from 'node:crypto';
import type { AiAgentPreset } from '@ezychat/shared';
import type { DB } from '../db/index.js';
import type { SettingsStore } from '../db/settings.js';

/**
 * The only SQL for AI agents (table `ai_agents`, migration 015). The name and on/off of an agent
 * live on its `users` row (`display_name`, `disabled_at`) so assignee and sender rendering keep
 * working; a deleted agent has no `ai_agents` row and its user is flagged `ai_deleted_at`.
 */
export interface AgentRow {
  id: number;
  userId: number;
  /** The inbox this agent serves; null = none. */
  inboxId: number | null;
  preset: AiAgentPreset;
  /** null = never saved: the preset's defaults apply. A saved blank stays blank. */
  instructions: string | null;
  handoffRules: string | null;
  displayName: string;
  enabled: boolean;
  /** "Answer in groups": the agent answers tags and quotes in the groups an admin switched on. */
  answerGroups: boolean;
  /** Ends answers with a resolution question and may close the chat (migration 026). */
  resolutionCheck: boolean;
  /**
   * "Answer direct chats" (migration 027, default on). Off: the agent never answers or takes a direct
   * chat. Read it through `answersDirect` (ai/direct.ts): an inbox without groups ignores it.
   */
  answerDirect: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentErrorCode =
  'agent_limit' | 'inbox_has_direct_agent' | 'agent_not_found' | 'internal_too_large';

export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode) {
    super(code);
    this.name = 'AgentError';
  }
}

/** The setting that held the one AI Sales Agent's texts before migration 015. */
const MEMBER_KEY = 'ai_sales_member';
/** Set once the member texts moved into agent 1 (and other active inboxes got an agent). */
const AGENTS_MIGRATED_KEY = 'ai_agents_migrated';

interface Row {
  id: number;
  userId: number;
  inboxId: number | null;
  preset: AiAgentPreset;
  instructions: string | null;
  handoffRules: string | null;
  displayName: string;
  disabledAt: number | null;
  answerGroups: number;
  resolutionCheck: number;
  answerDirect: number;
  createdAt: number;
  updatedAt: number;
}

const SELECT = `SELECT a.id, a.user_id AS userId, a.inbox_id AS inboxId, a.preset,
  a.instructions, a.handoff_rules AS handoffRules, u.display_name AS displayName,
  u.disabled_at AS disabledAt, a.answer_groups AS answerGroups,
  a.resolution_check AS resolutionCheck, a.answer_direct AS answerDirect,
  a.created_at AS createdAt, a.updated_at AS updatedAt
  FROM ai_agents a JOIN users u ON u.id = a.user_id
  WHERE u.ai_deleted_at IS NULL`;

const toAgent = ({
  disabledAt,
  answerGroups,
  resolutionCheck,
  answerDirect,
  ...row
}: Row): AgentRow => ({
  ...row,
  enabled: disabledAt === null,
  answerGroups: answerGroups === 1,
  resolutionCheck: resolutionCheck === 1,
  answerDirect: answerDirect === 1,
});

/**
 * A new agent's "Ask if the question is answered": off for every preset (owner, 2026-10-30): no check-in
 * lines and the team closes chats until an admin switches it on.
 */
export const defaultResolutionCheck = (_preset: AiAgentPreset): boolean => false;

function one(db: DB, where: string, value: number): AgentRow | null {
  const row = db.prepare(`${SELECT} AND ${where} = ?`).get(value) as Row | undefined;
  return row ? toAgent(row) : null;
}

/** Every agent, oldest first. */
export function listAgents(db: DB): AgentRow[] {
  return (db.prepare(`${SELECT} ORDER BY a.id`).all() as Row[]).map(toAgent);
}

export const agentById = (db: DB, id: number): AgentRow | null => one(db, 'a.id', id);

export const agentByUserId = (db: DB, userId: number): AgentRow | null =>
  one(db, 'a.user_id', userId);

/** Every agent of an inbox, oldest first (several per inbox: one for direct chats, others for groups). */
export function agentsForInbox(db: DB, inboxId: number): AgentRow[] {
  return (db.prepare(`${SELECT} AND a.inbox_id = ? ORDER BY a.id`).all(inboxId) as Row[]).map(
    toAgent,
  );
}

/**
 * The main agent of an inbox: the one with "Answer direct chats" on, else the oldest. For the
 * agent that actually answers a chat use `agentForChat` / `directAgentOf` (ai/groups.ts, ai/direct.ts).
 */
export const agentForInbox = (db: DB, inboxId: number): AgentRow | null => {
  const row = db
    .prepare(`${SELECT} AND a.inbox_id = ? ORDER BY a.answer_direct DESC, a.id LIMIT 1`)
    .get(inboxId) as Row | undefined;
  return row ? toAgent(row) : null;
};

/**
 * The agent old clients mean when they name none: the only agent, else the agent of inbox 1,
 * else the lowest id.
 */
export function defaultAgent(db: DB): AgentRow | null {
  const agents = listAgents(db);
  if (agents.length <= 1) return agents[0] ?? null;
  return agents.find((a) => a.inboxId === 1) ?? agents[0]!;
}

/** Another agent of this inbox has "Answer direct chats" on (at most one per inbox may). */
export function inboxHasDirectAgent(
  db: DB,
  inboxId: number | null,
  agentId: number | null,
): boolean {
  if (inboxId === null) return false;
  return !!db
    .prepare('SELECT 1 FROM ai_agents WHERE inbox_id = ? AND answer_direct = 1 AND id IS NOT ?')
    .get(inboxId, agentId);
}

function assertDirectFree(db: DB, inboxId: number | null, agentId: number | null): void {
  if (inboxHasDirectAgent(db, inboxId, agentId)) throw new AgentError('inbox_has_direct_agent');
}

export interface NewAgent {
  userId: number;
  inboxId: number | null;
  preset: AiAgentPreset;
  instructions: string | null;
  handoffRules: string | null;
  /** Default: `defaultResolutionCheck(preset)`. */
  resolutionCheck?: boolean;
  /**
   * "Answer direct chats". Default: on, unless another agent of the inbox already answers them
   * (the new agent is then group-only). true while another one does: `inbox_has_direct_agent`.
   */
  answerDirect?: boolean;
}

/** Adds the `ai_agents` row for an existing `kind = 'ai'` user. */
export function createAgentRow(db: DB, agent: NewAgent, now = Date.now()): AgentRow {
  if (agent.answerDirect) assertDirectFree(db, agent.inboxId, null);
  const answerDirect = agent.answerDirect ?? !inboxHasDirectAgent(db, agent.inboxId, null);
  const id = Number(
    db
      .prepare(
        `INSERT INTO ai_agents (user_id, inbox_id, preset, instructions, handoff_rules, resolution_check, answer_direct, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.userId,
        agent.inboxId,
        agent.preset,
        agent.instructions,
        agent.handoffRules,
        (agent.resolutionCheck ?? defaultResolutionCheck(agent.preset)) ? 1 : 0,
        answerDirect ? 1 : 0,
        now,
        now,
      ).lastInsertRowid,
  );
  return agentById(db, id)!;
}

export interface AgentTexts {
  preset?: AiAgentPreset;
  /** null = back to the preset's defaults. */
  instructions?: string | null;
  handoffRules?: string | null;
  resolutionCheck?: boolean;
}

/** Changes only the given fields. */
export function updateAgentTexts(db: DB, id: number, texts: AgentTexts, now = Date.now()): void {
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];
  if (texts.preset !== undefined) {
    sets.push('preset = ?');
    values.push(texts.preset);
  }
  if (texts.instructions !== undefined) {
    sets.push('instructions = ?');
    values.push(texts.instructions);
  }
  if (texts.handoffRules !== undefined) {
    sets.push('handoff_rules = ?');
    values.push(texts.handoffRules);
  }
  if (texts.resolutionCheck !== undefined) {
    sets.push('resolution_check = ?');
    values.push(texts.resolutionCheck ? 1 : 0);
  }
  const changed = db
    .prepare(`UPDATE ai_agents SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id).changes;
  if (!changed) throw new AgentError('agent_not_found');
}

/**
 * The agent's groups go back to no agent, AI off (rows kept, never moved to another agent): the
 * agent was removed from its inbox, deleted or its "Answer in groups" went off.
 */
export function releaseAgentGroups(db: DB, agentId: number, now = Date.now()): number {
  return db
    .prepare(
      'UPDATE ai_group_chats SET enabled = 0, agent_id = NULL, listen = 0, updated_at = ? WHERE agent_id = ?',
    )
    .run(now, agentId).changes;
}

/** The agent's "Answer in groups" switch (migration 024); off releases its groups. */
export function setAgentAnswerGroups(db: DB, id: number, on: boolean, now = Date.now()): void {
  db.transaction(() => {
    const changed = db
      .prepare('UPDATE ai_agents SET answer_groups = ?, updated_at = ? WHERE id = ?')
      .run(on ? 1 : 0, now, id).changes;
    if (!changed) throw new AgentError('agent_not_found');
    if (!on) releaseAgentGroups(db, id, now);
  })();
}

/**
 * The agent's "Answer direct chats" switch (migration 027). On while another agent of its inbox
 * answers direct chats: `inbox_has_direct_agent`.
 */
export function setAgentAnswerDirect(db: DB, id: number, on: boolean, now = Date.now()): void {
  db.transaction(() => {
    const row = db.prepare('SELECT inbox_id AS inboxId FROM ai_agents WHERE id = ?').get(id) as
      { inboxId: number | null } | undefined;
    if (!row) throw new AgentError('agent_not_found');
    if (on) assertDirectFree(db, row.inboxId, id);
    db.prepare('UPDATE ai_agents SET answer_direct = ?, updated_at = ? WHERE id = ?').run(
      on ? 1 : 0,
      now,
      id,
    );
  })();
}

/**
 * Binds the agent to an inbox (null = none). An inbox may have several agents, but only one that
 * answers direct chats: moving such an agent next to another one is `inbox_has_direct_agent`.
 */
export function setAgentInbox(db: DB, id: number, inboxId: number | null, now = Date.now()): void {
  db.transaction(() => {
    const row = db.prepare('SELECT answer_direct AS direct FROM ai_agents WHERE id = ?').get(id) as
      { direct: number } | undefined;
    if (!row) throw new AgentError('agent_not_found');
    if (row.direct === 1) assertDirectFree(db, inboxId, id);
    releaseAgentGroups(db, id, now);
    db.prepare('UPDATE ai_agents SET inbox_id = ?, updated_at = ? WHERE id = ?').run(
      inboxId,
      now,
      id,
    );
  })();
}

/**
 * Removes the agent and its Business context items. Its user row stays for message history,
 * disabled and flagged deleted. Release its chats before calling this.
 */
export function deleteAgentRow(db: DB, id: number, now = Date.now()): void {
  db.transaction(() => {
    const row = db.prepare('SELECT user_id AS userId FROM ai_agents WHERE id = ?').get(id) as
      { userId: number } | undefined;
    if (!row) throw new AgentError('agent_not_found');
    db.prepare('DELETE FROM ai_documents WHERE agent_id = ?').run(id);
    db.prepare('DELETE FROM reply_phrases WHERE agent_id = ?').run(id);
    releaseAgentGroups(db, id, now);
    db.prepare('DELETE FROM ai_agents WHERE id = ?').run(id);
    db.prepare(
      'UPDATE users SET disabled_at = coalesce(disabled_at, ?), ai_deleted_at = ? WHERE id = ?',
    ).run(now, now, row.userId);
  })();
}

const storedText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Permanent, idempotent start-up step (updates skip versions, so it never leaves the code). Once:
 * copies the `ai_sales_member` texts into agent 1 (a non-string is "never saved" = NULL, a blank
 * stays blank), gives agent 1 any item or version written without an agent, and creates one agent
 * per other active inbox that has none (a new AI user with the same name and on/off, the same
 * preset and texts, and copies of the items) so no inbox loses its AI. The chats agent 1's user
 * owned in such an inbox move to that inbox's new agent, so none stays with an AI that will not
 * answer it.
 */
export function migrateMemberSetting(db: DB, settings: SettingsStore, now = Date.now()): void {
  db.transaction(() => {
    if (settings.get<boolean>(AGENTS_MIGRATED_KEY, false)) return;
    const first = agentForInbox(db, 1) ?? defaultAgent(db);
    if (first) {
      const stored = settings.get<unknown>(MEMBER_KEY, null);
      const old =
        stored && typeof stored === 'object' && !Array.isArray(stored)
          ? (stored as Record<string, unknown>)
          : {};
      const texts = {
        instructions: storedText(old.instructions),
        handoffRules: storedText(old.handoffRules),
      };
      updateAgentTexts(db, first.id, texts, now);
      db.prepare('UPDATE ai_documents SET agent_id = ? WHERE agent_id IS NULL').run(first.id);
      db.prepare('UPDATE ai_setup_versions SET agent_id = ? WHERE agent_id IS NULL').run(first.id);

      const user = db
        .prepare('SELECT display_name AS name, disabled_at AS disabledAt FROM users WHERE id = ?')
        .get(first.userId) as { name: string; disabledAt: number | null };
      const inboxes = db
        .prepare(
          `SELECT id FROM inboxes WHERE removed_at IS NULL
           AND id NOT IN (SELECT inbox_id FROM ai_agents WHERE inbox_id IS NOT NULL) ORDER BY id`,
        )
        .all() as Array<{ id: number }>;
      for (const inbox of inboxes) {
        const userId = Number(
          db
            .prepare(
              "INSERT INTO users(username, display_name, password_hash, role, kind, disabled_at, created_at) VALUES (?, ?, '', 'agent', 'ai', ?, ?)",
            )
            .run(`ai-${randomUUID()}`, user.name, user.disabledAt, now).lastInsertRowid,
        );
        const agent = createAgentRow(
          db,
          { userId, inboxId: inbox.id, preset: first.preset, ...texts },
          now,
        );
        db.prepare(
          `INSERT INTO ai_documents (agent_id, name, kind, size, text, internal, created_at, updated_at)
           SELECT ?, name, kind, size, text, internal, created_at, updated_at
           FROM ai_documents WHERE agent_id = ? ORDER BY created_at, id`,
        ).run(agent.id, first.id);
        // The one AI member owned chats in every inbox: they stay with the AI of their inbox.
        db.prepare('UPDATE chats SET assigned_to = ? WHERE inbox_id = ? AND assigned_to = ?').run(
          userId,
          inbox.id,
          first.userId,
        );
      }
    }
    settings.set(AGENTS_MIGRATED_KEY, true);
  })();
}

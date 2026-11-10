import {
  DEFAULT_GITHUB_SETTINGS,
  GitHubAgentSettings,
  type GitHubActivity,
  type GitHubActivityKind,
} from '@ezychat/shared';
import type { DB } from '../../db/index.js';

/** The only SQL of the GitHub connector (migration 042). */

export const ACTIVITY_LIMIT = 50;

/** Parses a stored settings JSON; anything unreadable is the defaults. */
export function parseStoredSettings(json: string): GitHubAgentSettings {
  try {
    const parsed = GitHubAgentSettings.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : { ...DEFAULT_GITHUB_SETTINGS };
  } catch {
    return { ...DEFAULT_GITHUB_SETTINGS };
  }
}

export function readSettings(db: DB, agentId: number): GitHubAgentSettings {
  const row = db
    .prepare('SELECT settings FROM github_agent_settings WHERE agent_id = ?')
    .get(agentId) as { settings: string } | undefined;
  return row ? parseStoredSettings(row.settings) : { ...DEFAULT_GITHUB_SETTINGS };
}

export function writeSettings(db: DB, agentId: number, settings: GitHubAgentSettings, now: number) {
  db.prepare(
    `INSERT INTO github_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  ).run(agentId, JSON.stringify(settings), now);
}

export interface ActivityInput {
  kind: GitHubActivityKind;
  agentId: number | null;
  chatJid: string | null;
  /** The chat's name when it is a group. */
  group?: string | null;
}

export function addActivity(db: DB, row: ActivityInput, now: number) {
  db.prepare(
    'INSERT INTO github_activity (kind, agent_id, chat_jid, at, group_name) VALUES (?, ?, ?, ?, ?)',
  ).run(row.kind, row.agentId, row.chatJid, now, row.group ?? null);
}

interface ActivityRow {
  id: number;
  at: number;
  kind: GitHubActivityKind;
  agentId: number | null;
  agentName: string | null;
  chatJid: string | null;
  chatName: string | null;
  profileName: string | null;
  groupName: string | null;
}

/** Newest first, at most 50; names from the agent's user row and the chat (saved name first). */
export function listActivity(db: DB): GitHubActivity[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.at, a.kind, a.agent_id AS agentId, u.display_name AS agentName,
              a.chat_jid AS chatJid, c.name AS chatName, p.name AS profileName,
              a.group_name AS groupName
       FROM github_activity a
       LEFT JOIN ai_agents g ON g.id = a.agent_id
       LEFT JOIN users u ON u.id = g.user_id
       LEFT JOIN chats c ON c.jid = a.chat_jid
       LEFT JOIN customer_profiles p ON p.chat_jid = a.chat_jid
       ORDER BY a.at DESC, a.id DESC LIMIT ?`,
    )
    .all(ACTIVITY_LIMIT) as ActivityRow[];
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    agentId: row.agentId,
    agentName: row.agentName ?? '',
    chatJid: row.chatJid,
    customer: row.profileName?.trim() || row.chatName || '',
    group: row.groupName,
  }));
}

/** chats/merge.ts: moves every GitHub activity row of chat `from` to `to` (inside its transaction). */
export function mergeGitHubRows(db: DB, from: string, to: string): number {
  return db.prepare('UPDATE github_activity SET chat_jid = ? WHERE chat_jid = ?').run(to, from)
    .changes;
}

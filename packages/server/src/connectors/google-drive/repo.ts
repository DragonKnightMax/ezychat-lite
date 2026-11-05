import {
  DEFAULT_DRIVE_SETTINGS,
  DriveAgentSettings,
  type DriveActivity,
  type DriveActivityKind,
  type DriveSkipReason,
} from '@ezychat/shared';
import type { DB } from '../../db/index.js';

/** The only SQL of the Google Drive connector (migration 034). */

export const ACTIVITY_LIMIT = 50;

/** Parses a stored settings JSON; anything unreadable is the defaults. */
export function parseStoredSettings(json: string): DriveAgentSettings {
  try {
    const parsed = DriveAgentSettings.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : { ...DEFAULT_DRIVE_SETTINGS };
  } catch {
    return { ...DEFAULT_DRIVE_SETTINGS };
  }
}

export function readSettings(db: DB, agentId: number): DriveAgentSettings {
  const row = db
    .prepare('SELECT settings FROM drive_agent_settings WHERE agent_id = ?')
    .get(agentId) as { settings: string } | undefined;
  return row ? parseStoredSettings(row.settings) : { ...DEFAULT_DRIVE_SETTINGS };
}

export function writeSettings(db: DB, agentId: number, settings: DriveAgentSettings, now: number) {
  db.prepare(
    `INSERT INTO drive_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  ).run(agentId, JSON.stringify(settings), now);
}

/** The Drive file this message was already saved as in this folder, else null. */
export function savedFile(db: DB, messageId: string, folderId: string): string | null {
  const row = db
    .prepare(
      'SELECT file_id AS fileId FROM drive_saved_files WHERE message_id = ? AND folder_id = ?',
    )
    .get(messageId, folderId) as { fileId: string } | undefined;
  return row?.fileId ?? null;
}

/** Message ids of this chat already saved into this folder (the tool marks them). */
export function savedMessageIds(db: DB, chatJid: string, folderId: string): Set<string> {
  const rows = db
    .prepare('SELECT message_id AS id FROM drive_saved_files WHERE chat_jid = ? AND folder_id = ?')
    .all(chatJid, folderId) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export function insertSaved(
  db: DB,
  row: { agentId: number; chatJid: string; messageId: string; folderId: string; fileId: string },
  now: number,
) {
  db.prepare(
    `INSERT OR IGNORE INTO drive_saved_files (agent_id, chat_jid, message_id, folder_id, file_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.agentId, row.chatJid, row.messageId, row.folderId, row.fileId, now);
}

/** A sub-folder EzyChat created in `parentId` with this name, else null. */
export function knownFolder(db: DB, parentId: string, name: string): string | null {
  const row = db
    .prepare('SELECT folder_id AS id FROM drive_folders WHERE parent_id = ? AND name = ?')
    .get(parentId, name) as { id: string } | undefined;
  return row?.id ?? null;
}

export function rememberFolder(
  db: DB,
  parentId: string,
  name: string,
  folderId: string,
  now: number,
) {
  db.prepare(
    `INSERT INTO drive_folders (parent_id, name, folder_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(parent_id, name) DO UPDATE SET folder_id = excluded.folder_id`,
  ).run(parentId, name, folderId, now);
}

export function forgetFolder(db: DB, parentId: string, name: string) {
  db.prepare('DELETE FROM drive_folders WHERE parent_id = ? AND name = ?').run(parentId, name);
}

export interface ActivityInput {
  kind: DriveActivityKind;
  agentId: number | null;
  chatJid: string | null;
  /** The chat's name when it is a group. */
  group?: string | null;
  reason?: DriveSkipReason | null;
}

export function addActivity(db: DB, row: ActivityInput, now: number) {
  db.prepare(
    'INSERT INTO drive_activity (kind, agent_id, chat_jid, at, group_name, reason) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.kind, row.agentId, row.chatJid, now, row.group ?? null, row.reason ?? null);
}

interface ActivityRow {
  id: number;
  at: number;
  kind: DriveActivityKind;
  agentId: number | null;
  agentName: string | null;
  chatJid: string | null;
  chatName: string | null;
  profileName: string | null;
  groupName: string | null;
  reason: DriveSkipReason | null;
}

/** Newest first, at most 50; names from the agent's user row and the chat (saved name first). */
export function listActivity(db: DB): DriveActivity[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.at, a.kind, a.agent_id AS agentId, u.display_name AS agentName,
              a.chat_jid AS chatJid, c.name AS chatName, p.name AS profileName,
              a.group_name AS groupName, a.reason
       FROM drive_activity a
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
    reason: row.reason,
  }));
}

/** An inbound media message the AI may save. */
export interface MediaCandidate {
  id: string;
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mime: string | null;
  senderJid: string | null;
  senderName: string | null;
  timestamp: number;
}

/**
 * Inbound media messages of the chat a save may use: `ids` when given (the turn's batch), else the
 * newest inbound files of the last `sinceMs`; never deleted or hidden ones; at most `limit`.
 */
export function mediaCandidates(
  db: DB,
  chatJid: string,
  opts: { ids: readonly string[] | null; since: number; limit: number },
): MediaCandidate[] {
  const select = `SELECT id, type, media_mime AS mime, sender_jid AS senderJid,
      sender_name AS senderName, timestamp FROM messages
    WHERE chat_jid = ? AND from_me = 0 AND deleted_at IS NULL AND hidden_at IS NULL
      AND type IN ('image', 'video', 'audio', 'document', 'sticker') AND media_status != 'none'`;
  if (opts.ids) {
    if (!opts.ids.length) return [];
    return db
      .prepare(
        `${select} AND id IN (${opts.ids.map(() => '?').join(', ')})
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(chatJid, ...opts.ids, opts.limit) as MediaCandidate[];
  }
  return db
    .prepare(`${select} AND timestamp >= ? ORDER BY timestamp DESC, rowid DESC LIMIT ?`)
    .all(chatJid, opts.since, opts.limit) as MediaCandidate[];
}

/** chats/merge.ts: moves every Drive row of chat `from` to `to` (inside its transaction). */
export function mergeDriveRows(db: DB, from: string, to: string): number {
  let moved = 0;
  moved += db
    .prepare('UPDATE drive_saved_files SET chat_jid = ? WHERE chat_jid = ?')
    .run(to, from).changes;
  moved += db
    .prepare('UPDATE drive_activity SET chat_jid = ? WHERE chat_jid = ?')
    .run(to, from).changes;
  return moved;
}

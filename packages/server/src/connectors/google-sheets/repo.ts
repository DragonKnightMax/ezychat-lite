import {
  DEFAULT_SHEETS_SETTINGS,
  SheetsAgentSettings,
  type SheetsActivity,
  type SheetsActivityKind,
} from '@ezychat/shared';
import type { DB } from '../../db/index.js';

/** The only SQL of the Google Sheets connector (migration 030). */

export const ACTIVITY_LIMIT = 50;
/** One lead row per chat and spreadsheet in this time. */
export const LEAD_WINDOW_MS = 24 * 3_600_000;

export function readSettings(db: DB, agentId: number): SheetsAgentSettings {
  const row = db
    .prepare('SELECT settings FROM sheets_agent_settings WHERE agent_id = ?')
    .get(agentId) as { settings: string } | undefined;
  if (!row) return { ...DEFAULT_SHEETS_SETTINGS };
  try {
    const parsed = SheetsAgentSettings.safeParse(JSON.parse(row.settings));
    return parsed.success ? parsed.data : { ...DEFAULT_SHEETS_SETTINGS };
  } catch {
    return { ...DEFAULT_SHEETS_SETTINGS };
  }
}

export function writeSettings(db: DB, agentId: number, settings: SheetsAgentSettings, now: number) {
  db.prepare(
    `INSERT INTO sheets_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  ).run(agentId, JSON.stringify(settings), now);
}

/** True when a lead row of this chat went into this spreadsheet in the last 24 hours. */
export function leadAddedSince(
  db: DB,
  chatJid: string,
  spreadsheetId: string,
  now: number,
): boolean {
  return !!db
    .prepare(
      'SELECT 1 FROM sheets_leads WHERE chat_jid = ? AND spreadsheet_id = ? AND created_at >= ? LIMIT 1',
    )
    .get(chatJid, spreadsheetId, now - LEAD_WINDOW_MS);
}

export function insertLead(
  db: DB,
  row: { agentId: number; chatJid: string; spreadsheetId: string },
  now: number,
) {
  db.prepare(
    'INSERT INTO sheets_leads (agent_id, chat_jid, spreadsheet_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(row.agentId, row.chatJid, row.spreadsheetId, now);
}

export function addActivity(
  db: DB,
  row: { kind: SheetsActivityKind; agentId: number | null; chatJid: string | null },
  now: number,
) {
  db.prepare('INSERT INTO sheets_activity (kind, agent_id, chat_jid, at) VALUES (?, ?, ?, ?)').run(
    row.kind,
    row.agentId,
    row.chatJid,
    now,
  );
}

interface ActivityRow {
  id: number;
  at: number;
  kind: SheetsActivityKind;
  agentId: number | null;
  agentName: string | null;
  chatJid: string | null;
  chatName: string | null;
  profileName: string | null;
}

/** Newest first, at most 50; names from the agent's user row and the chat (saved name first). */
export function listActivity(db: DB): SheetsActivity[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.at, a.kind, a.agent_id AS agentId, u.display_name AS agentName,
              a.chat_jid AS chatJid, c.name AS chatName, p.name AS profileName
       FROM sheets_activity a
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
  }));
}

/** chats/merge.ts: moves every Sheets row of chat `from` to `to` (inside its transaction). */
export function mergeSheetsRows(db: DB, from: string, to: string): number {
  let moved = 0;
  moved += db
    .prepare('UPDATE sheets_leads SET chat_jid = ? WHERE chat_jid = ?')
    .run(to, from).changes;
  moved += db
    .prepare('UPDATE sheets_activity SET chat_jid = ? WHERE chat_jid = ?')
    .run(to, from).changes;
  return moved;
}

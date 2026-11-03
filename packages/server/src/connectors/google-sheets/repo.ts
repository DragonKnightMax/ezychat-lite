import {
  DEFAULT_SHEETS_SETTINGS,
  SHEET_TAB_CHARACTERS,
  SheetsAgentSettings,
  type SheetTabSetting,
  type SheetsActivity,
  type SheetsActivityKind,
} from '@ezychat/shared';
import type { DB } from '../../db/index.js';

/** The only SQL of the Google Sheets connector (migrations 030 and 031). */

export const ACTIVITY_LIMIT = 50;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const legacyTab = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, SHEET_TAB_CHARACTERS) : null;

/**
 * A save made before tab access (`lookupTab` + `lookup`, `leadsTab` + `addLeads`), i.e. no `tabs`
 * list. Permanent: an install may jump from any older release straight to this one.
 */
export function isLegacySettings(raw: unknown): raw is Record<string, unknown> {
  return (
    isObject(raw) &&
    !Array.isArray(raw.tabs) &&
    ['lookupTab', 'lookup', 'leadsTab', 'addLeads'].some((key) => key in raw)
  );
}

/** The tab an older save added leads to (Add leads on), else null. */
export function legacyLeadsTab(raw: unknown): string | null {
  if (!isLegacySettings(raw) || raw.addLeads !== true || !raw.spreadsheetId) return null;
  return legacyTab(raw.leadsTab);
}

/**
 * Maps an older save to tab access: the look-up tab → Read (Answer questions was on by default),
 * the leads tab → Add rows; a switched-off tab is left out (off). One tab used for both → Add rows.
 */
export function mapLegacySettings(raw: Record<string, unknown>): SheetsAgentSettings {
  const tabs: SheetTabSetting[] = [];
  const lookupTab = raw.lookup === false ? null : legacyTab(raw.lookupTab);
  const leadsTab = raw.addLeads === true ? legacyTab(raw.leadsTab) : null;
  if (lookupTab && lookupTab !== leadsTab) tabs.push({ title: lookupTab, access: 'read' });
  if (leadsTab) tabs.push({ title: leadsTab, access: 'add' });
  const parsed = SheetsAgentSettings.safeParse({
    spreadsheetId: raw.spreadsheetId ?? null,
    spreadsheetName: raw.spreadsheetName ?? null,
    tabs,
  });
  return parsed.success ? parsed.data : { ...DEFAULT_SHEETS_SETTINGS };
}

/** Parses a stored settings JSON (either shape); anything unreadable is the defaults. */
export function parseStoredSettings(json: string): SheetsAgentSettings {
  try {
    const raw: unknown = JSON.parse(json);
    if (isLegacySettings(raw)) return mapLegacySettings(raw);
    const parsed = SheetsAgentSettings.safeParse(raw);
    return parsed.success ? parsed.data : { ...DEFAULT_SHEETS_SETTINGS };
  } catch {
    return { ...DEFAULT_SHEETS_SETTINGS };
  }
}

export function readSettings(db: DB, agentId: number): SheetsAgentSettings {
  const row = db
    .prepare('SELECT settings FROM sheets_agent_settings WHERE agent_id = ?')
    .get(agentId) as { settings: string } | undefined;
  return row ? parseStoredSettings(row.settings) : { ...DEFAULT_SHEETS_SETTINGS };
}

/** Every stored settings row, as saved (the start-up upgrade reads the older shape). */
export function storedSettings(db: DB): Array<{ agentId: number; settings: string }> {
  return db
    .prepare('SELECT agent_id AS agentId, settings FROM sheets_agent_settings ORDER BY agent_id')
    .all() as Array<{ agentId: number; settings: string }>;
}

export function writeSettings(db: DB, agentId: number, settings: SheetsAgentSettings, now: number) {
  db.prepare(
    `INSERT INTO sheets_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  ).run(agentId, JSON.stringify(settings), now);
}

/** The duplicate guard's key: one row per chat, tab, newest batch message and values. */
export interface SheetRowKey {
  chatJid: string;
  spreadsheetId: string;
  tab: string;
  messageId: string | null;
  valuesHash: string;
}

/** True when this exact row was already added (a retry or a re-read batch adds nothing). */
export function rowAdded(db: DB, key: SheetRowKey): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM sheets_leads WHERE chat_jid = ? AND tab = ? AND message_id IS ?
       AND values_hash = ? AND spreadsheet_id = ? LIMIT 1`,
    )
    .get(key.chatJid, key.tab, key.messageId, key.valuesHash, key.spreadsheetId);
}

export function insertRow(db: DB, row: SheetRowKey & { agentId: number }, now: number) {
  db.prepare(
    `INSERT INTO sheets_leads (agent_id, chat_jid, spreadsheet_id, tab, message_id, values_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.agentId, row.chatJid, row.spreadsheetId, row.tab, row.messageId, row.valuesHash, now);
}

export interface ActivityInput {
  kind: SheetsActivityKind;
  agentId: number | null;
  chatJid: string | null;
  tab?: string | null;
  /** The chat's name when it is a group. */
  group?: string | null;
}

export function addActivity(db: DB, row: ActivityInput, now: number) {
  db.prepare(
    'INSERT INTO sheets_activity (kind, agent_id, chat_jid, at, tab, group_name) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.kind, row.agentId, row.chatJid, now, row.tab ?? null, row.group ?? null);
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
  tab: string | null;
  groupName: string | null;
}

/** Newest first, at most 50; names from the agent's user row and the chat (saved name first). */
export function listActivity(db: DB): SheetsActivity[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.at, a.kind, a.agent_id AS agentId, u.display_name AS agentName,
              a.chat_jid AS chatJid, c.name AS chatName, p.name AS profileName,
              a.tab, a.group_name AS groupName
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
    tab: row.tab,
    group: row.groupName,
  }));
}

/** The person texts a sheet value is checked against (their own messages in this chat). */
export function personTexts(
  db: DB,
  chatJid: string,
  personJids: readonly string[] | null,
  limit = 200,
): string[] {
  const select = `SELECT COALESCE(body, '') || ' ' || COALESCE(transcript, '') AS text FROM messages
    WHERE chat_jid = ? AND from_me = 0 AND deleted_at IS NULL`;
  const rows = personJids
    ? personJids.length
      ? (db
          .prepare(
            `${select} AND sender_jid IN (${personJids.map(() => '?').join(', ')})
             ORDER BY timestamp DESC LIMIT ?`,
          )
          .all(chatJid, ...personJids, limit) as Array<{ text: string }>)
      : []
    : (db.prepare(`${select} ORDER BY timestamp DESC LIMIT ?`).all(chatJid, limit) as Array<{
        text: string;
      }>);
  return rows.map((row) => row.text);
}

/** The chat's newest message from a person (not the linked number): its id and sender. */
export function newestInbound(
  db: DB,
  chatJid: string,
): { id: string; senderJid: string | null; senderName: string | null } | null {
  return (
    (db
      .prepare(
        `SELECT id, sender_jid AS senderJid, sender_name AS senderName FROM messages
         WHERE chat_jid = ? AND from_me = 0 ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
      )
      .get(chatJid) as
      { id: string; senderJid: string | null; senderName: string | null } | undefined) ?? null
  );
}

/** A group member's name and number as WhatsApp and the team know them (contacts, else their messages). */
export function memberContact(
  db: DB,
  chatJid: string,
  memberJid: string,
): { name: string | null; phone: string | null } {
  const contact = db
    .prepare('SELECT saved_name AS saved, push_name AS push, phone FROM contacts WHERE jid = ?')
    .get(memberJid) as
    { saved: string | null; push: string | null; phone: string | null } | undefined;
  const sent = db
    .prepare(
      `SELECT sender_name AS name FROM messages WHERE chat_jid = ? AND sender_jid = ?
       AND sender_name IS NOT NULL AND sender_name != '' ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid, memberJid) as { name: string } | undefined;
  const name = contact?.saved?.trim() || contact?.push?.trim() || sent?.name.trim() || null;
  const phone =
    contact?.phone?.replace(/\D/g, '') ||
    (memberJid.endsWith('@s.whatsapp.net') ? memberJid.split('@')[0]!.split(':')[0]! : null);
  return { name, phone: phone || null };
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

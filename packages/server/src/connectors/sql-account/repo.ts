import {
  DEFAULT_SQL_AGENT_SETTINGS,
  SqlAgentSettings,
  type SqlActivity,
  type SqlActivityTool,
} from '@ezychat/shared';
import type { DB } from '../../db/index.js';

/** The only SQL of the SQL Account connector (migration 035). */

export const ACTIVITY_LIMIT = 100;

export function readAgentSettings(db: DB, agentId: number): SqlAgentSettings {
  const row = db
    .prepare('SELECT settings FROM sql_account_agent_settings WHERE agent_id = ?')
    .get(agentId) as { settings: string } | undefined;
  if (!row) return { ...DEFAULT_SQL_AGENT_SETTINGS, access: {} };
  try {
    const parsed = SqlAgentSettings.safeParse(JSON.parse(row.settings));
    if (parsed.success) return parsed.data;
  } catch {
    // unreadable: defaults
  }
  return { ...DEFAULT_SQL_AGENT_SETTINGS, access: {} };
}

export function writeAgentSettings(
  db: DB,
  agentId: number,
  settings: SqlAgentSettings,
  now: number,
): void {
  db.prepare(
    `INSERT INTO sql_account_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  ).run(agentId, JSON.stringify(settings), now);
}

export function linkOf(db: DB, chatJid: string): string | null {
  const row = db
    .prepare('SELECT customer_code AS code FROM sql_account_links WHERE chat_jid = ?')
    .get(chatJid) as { code: string } | undefined;
  return row?.code ?? null;
}

export function allLinks(db: DB): Map<string, string> {
  const rows = db
    .prepare('SELECT chat_jid AS jid, customer_code AS code FROM sql_account_links')
    .all() as Array<{ jid: string; code: string }>;
  return new Map(rows.map((r) => [r.jid, r.code]));
}

export function setLink(
  db: DB,
  chatJid: string,
  code: string | null,
  userId: number,
  now: number,
): void {
  if (code === null) {
    db.prepare('DELETE FROM sql_account_links WHERE chat_jid = ?').run(chatJid);
    return;
  }
  db.prepare(
    `INSERT INTO sql_account_links (chat_jid, customer_code, linked_by, linked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_jid) DO UPDATE SET customer_code = excluded.customer_code,
       linked_by = excluded.linked_by, linked_at = excluded.linked_at`,
  ).run(chatJid, code, userId, now);
}

/** Direct chats (newest first) with the team's name for each; no group chats. */
export function directChats(db: DB, limit = 500): Array<{ jid: string; name: string }> {
  return db
    .prepare(
      `SELECT c.jid AS jid,
              COALESCE(NULLIF(p.name, ''), NULLIF(c.name, ''), '+' || substr(c.jid, 1, instr(c.jid, '@') - 1)) AS name
       FROM chats c LEFT JOIN customer_profiles p ON p.chat_jid = c.jid
       WHERE c.jid NOT LIKE '%@g.us' AND c.jid NOT LIKE 'status@%'
       ORDER BY c.last_message_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{ jid: string; name: string }>;
}

/** The chat's WhatsApp number and the saved other phone (digits as stored). */
export function chatPhones(db: DB, chatJid: string): string[] {
  const out: string[] = [];
  const chat = db.prepare('SELECT wa_jid AS waJid FROM chats WHERE jid = ?').get(chatJid) as
    { waJid: string | null } | undefined;
  const jid = chat?.waJid ?? chatJid;
  if (jid.endsWith('@s.whatsapp.net')) out.push(jid.split('@')[0]!);
  for (const row of db
    .prepare(
      `SELECT alias_jid AS pn FROM jid_aliases
       WHERE canonical_jid = ? AND repointed_from IS NULL AND alias_jid LIKE '%@s.whatsapp.net'`,
    )
    .all(jid) as Array<{ pn: string }>)
    out.push(row.pn.split('@')[0]!);
  const profile = db
    .prepare('SELECT other_phone AS other FROM customer_profiles WHERE chat_jid = ?')
    .get(chatJid) as { other: string | null } | undefined;
  if (profile?.other) out.push(profile.other);
  return out;
}

export function rememberItems(
  db: DB,
  chatJid: string,
  codes: readonly string[],
  now: number,
): void {
  const stmt = db.prepare(
    `INSERT INTO sql_account_seen_items (chat_jid, item_code, at) VALUES (?, ?, ?)
     ON CONFLICT(chat_jid, item_code) DO UPDATE SET at = excluded.at`,
  );
  for (const code of codes) stmt.run(chatJid, code, now);
}

export function seenItem(db: DB, chatJid: string, code: string, since: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM sql_account_seen_items WHERE chat_jid = ? AND item_code = ? AND at > ?')
    .get(chatJid, code, since);
}

export interface QuoteItem {
  code: string;
  description: string;
  qty: number;
  unitPrice: string;
  uom: string | null;
}

export interface QuoteDraft {
  id: number;
  agentId: number;
  chatJid: string;
  customerCode: string;
  items: QuoteItem[];
  createdAt: number;
  consentMessageId: string | null;
  dockey: number | null;
  doneAt: number | null;
}

export function insertDraft(
  db: DB,
  d: { agentId: number; chatJid: string; customerCode: string; items: QuoteItem[] },
  now: number,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO sql_account_quotes (agent_id, chat_jid, customer_code, items, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(d.agentId, d.chatJid, d.customerCode, JSON.stringify(d.items), now).lastInsertRowid,
  );
}

export function draftById(db: DB, id: number): QuoteDraft | null {
  const row = db
    .prepare(
      `SELECT id, agent_id AS agentId, chat_jid AS chatJid, customer_code AS customerCode, items,
              created_at AS createdAt, consent_message_id AS consentMessageId, dockey, done_at AS doneAt
       FROM sql_account_quotes WHERE id = ?`,
    )
    .get(id) as (Omit<QuoteDraft, 'items'> & { items: string }) | undefined;
  if (!row) return null;
  return { ...row, items: JSON.parse(row.items) as QuoteItem[] };
}

export function consentUsedForQuote(db: DB, chatJid: string, messageId: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM sql_account_quotes WHERE chat_jid = ? AND consent_message_id = ?')
    .get(chatJid, messageId);
}

export function quotesSince(
  db: DB,
  by: { chatJid?: string; agentId?: number },
  since: number,
): number {
  const row = by.chatJid
    ? db
        .prepare('SELECT COUNT(*) AS n FROM sql_account_quotes WHERE chat_jid = ? AND done_at > ?')
        .get(by.chatJid, since)
    : db
        .prepare('SELECT COUNT(*) AS n FROM sql_account_quotes WHERE agent_id = ? AND done_at > ?')
        .get(by.agentId, since);
  return (row as { n: number }).n;
}

/** Claims the consent message for this draft before the request (a retry cannot create twice). */
export function claimDraft(db: DB, id: number, messageId: string): boolean {
  return (
    db
      .prepare(
        'UPDATE sql_account_quotes SET consent_message_id = ? WHERE id = ? AND consent_message_id IS NULL',
      )
      .run(messageId, id).changes === 1
  );
}

export function releaseDraft(db: DB, id: number): void {
  db.prepare(
    'UPDATE sql_account_quotes SET consent_message_id = NULL WHERE id = ? AND done_at IS NULL',
  ).run(id);
}

export function finishDraft(db: DB, id: number, dockey: number | null, now: number): void {
  db.prepare('UPDATE sql_account_quotes SET dockey = ?, done_at = ? WHERE id = ?').run(
    dockey,
    now,
    id,
  );
}

export function addActivity(
  db: DB,
  row: {
    tool: SqlActivityTool;
    result: 'done' | 'refused' | 'failed';
    reason?: string | null;
    agentId: number | null;
    chatJid: string | null;
    dockey?: number | null;
  },
  now: number,
): void {
  db.prepare(
    `INSERT INTO sql_account_activity (tool, result, reason, agent_id, chat_jid, dockey, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.tool,
    row.result,
    row.reason ?? null,
    row.agentId,
    row.chatJid,
    row.dockey ?? null,
    now,
  );
}

export function listActivity(db: DB): SqlActivity[] {
  return db
    .prepare(
      `SELECT a.id, a.at, a.agent_id AS agentId, u.display_name AS agentName, a.chat_jid AS chatJid,
              COALESCE(NULLIF(p.name, ''), NULLIF(c.name, '')) AS chatName,
              a.tool, a.result, a.reason, a.dockey
       FROM sql_account_activity a
       LEFT JOIN ai_agents g ON g.id = a.agent_id
       LEFT JOIN users u ON u.id = g.user_id
       LEFT JOIN chats c ON c.jid = a.chat_jid
       LEFT JOIN customer_profiles p ON p.chat_jid = a.chat_jid
       ORDER BY a.at DESC, a.id DESC LIMIT ?`,
    )
    .all(ACTIVITY_LIMIT) as SqlActivity[];
}

/** The customer's own recent text messages (newest first). */
export function customerTexts(db: DB, chatJid: string, limit = 50): string[] {
  return (
    db
      .prepare(
        `SELECT body FROM messages WHERE chat_jid = ? AND from_me = 0 AND body IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(chatJid, limit) as Array<{ body: string }>
  ).map((r) => r.body);
}

/** chats/merge.ts: moves this connector's chat rows to the surviving chat. */
export function mergeSqlAccountRows(db: DB, from: string, to: string): void {
  if (!linkOf(db, to))
    db.prepare('UPDATE sql_account_links SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
  db.prepare('DELETE FROM sql_account_links WHERE chat_jid = ?').run(from);
  db.prepare(
    `INSERT OR IGNORE INTO sql_account_seen_items (chat_jid, item_code, at)
     SELECT ?, item_code, at FROM sql_account_seen_items WHERE chat_jid = ?`,
  ).run(to, from);
  db.prepare('DELETE FROM sql_account_seen_items WHERE chat_jid = ?').run(from);
  db.prepare('UPDATE sql_account_quotes SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
  db.prepare('UPDATE sql_account_activity SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
}

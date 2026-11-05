import { mergeCalendarRows } from '../connectors/google-calendar/repo.js';
import { mergeDriveRows } from '../connectors/google-drive/repo.js';
import { mergeSheetsRows } from '../connectors/google-sheets/repo.js';
import { mergeConnectorRows } from '../connectors/mcp/repo.js';
import { mergeCustomerProfile } from '../customers/merge.js';
import { audit } from '../db/audit.js';
import type { DB } from '../db/index.js';
import { parseChatKey } from '../inboxes/keys.js';
import { ChatRepo, jidUser, waJidOf, type ChatColumns } from './repo.js';
import { isFallbackName } from './service.js';

export interface MergeResult {
  from: string;
  to: string;
  /** `to` had no chat row: `from` was renamed instead */
  rekeyed: boolean;
  /** `aiState`: 1 when the AI Sales Agent's `ai_chat_state` row of `from` was moved/merged */
  moved: {
    messages: number;
    events: number;
    notes: number;
    aiState: number;
    /** customer profiles carried over (counts only; values never leave the tables) */
    profiles: number;
    tags: number;
    tagsDropped: number;
  };
  assignedTo: number | null;
  /** owner removed because both chats had different owners (one owner per chat) */
  assigneeDropped: number | null;
}

const pnDigits = (jid: string) => (jid.endsWith('@s.whatsapp.net') ? jidUser(jid) : null);

function lastInboundAt(db: DB, jid: string): number {
  const r = db
    .prepare('SELECT MAX(timestamp) AS ts FROM messages WHERE chat_jid = ? AND from_me = 0')
    .get(jid) as { ts: number | null };
  return r.ts ?? -1;
}

const isAiMember = (db: DB, id: number | null): boolean =>
  id !== null &&
  (db.prepare('SELECT kind FROM users WHERE id = ?').get(id) as { kind: string } | undefined)
    ?.kind === 'ai';

interface AiStateRow {
  paused: number;
  awaiting_confirmation: number;
  last_customer_message_id: string | null;
  last_replied_message_id: string | null;
  due_at: number | null;
}

/**
 * Moves the AI Sales Agent's per-chat state: `ai_chat_state` has ON DELETE CASCADE and would vanish
 * with the `from` row. Both present: the newer-inbound chat's state wins, and a handoff (paused) in
 * either chat keeps the AI out until a teammate acts. Returns 1 when a row was moved or merged.
 */
function mergeAiState(db: DB, from: string, to: string, fromNewer: boolean): number {
  const get = db.prepare('SELECT * FROM ai_chat_state WHERE chat_jid = ?');
  const a = get.get(from) as AiStateRow | undefined;
  if (!a) return 0;
  const b = get.get(to) as AiStateRow | undefined;
  if (!b) {
    db.prepare('UPDATE ai_chat_state SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
    return 1;
  }
  const keep = fromNewer ? a : b;
  const paused = Math.max(a.paused, b.paused);
  db.prepare(
    `UPDATE ai_chat_state SET paused = ?, awaiting_confirmation = ?, last_customer_message_id = ?,
       last_replied_message_id = ?, due_at = ? WHERE chat_jid = ?`,
  ).run(
    paused,
    paused ? 0 : keep.awaiting_confirmation,
    keep.last_customer_message_id,
    keep.last_replied_message_id,
    paused ? null : keep.due_at,
    to,
  );
  db.prepare('DELETE FROM ai_chat_state WHERE chat_jid = ?').run(from);
  return 1;
}

/**
 * Name for a re-keyed chat: saved contact name > WhatsApp push name > the chat's own real name.
 * Contacts are keyed by WhatsApp JID (`toWa`), chats by chat key.
 */
function rekeyName(db: DB, from: ChatColumns, toWa: string): string {
  const fromWa = waJidOf(from);
  const contact = db
    .prepare(
      `SELECT saved_name, push_name FROM contacts WHERE jid IN (?, ?)
       ORDER BY (saved_name IS NOT NULL AND saved_name <> '') DESC, jid = ? DESC LIMIT 1`,
    )
    .get(toWa, fromWa, toWa) as { saved_name: string | null; push_name: string | null } | undefined;
  if (contact?.saved_name) return contact.saved_name;
  if (!isFallbackName(from.name, fromWa)) return from.name;
  return contact?.push_name ?? '';
}

/** saved contact name > a real (non-fallback) chat name > the canonical chat's name */
function bestName(db: DB, from: ChatColumns, to: ChatColumns): string {
  const fromWa = waJidOf(from);
  const toWa = waJidOf(to);
  const saved = db
    .prepare(
      `SELECT saved_name FROM contacts WHERE jid IN (?, ?) AND saved_name IS NOT NULL AND saved_name <> ''
       ORDER BY jid = ? DESC LIMIT 1`,
    )
    .get(toWa, fromWa, toWa) as { saved_name: string } | undefined;
  if (saved) return saved.saved_name;
  if (!isFallbackName(to.name, toWa)) return to.name;
  if (!isFallbackName(from.name, fromWa)) return from.name;
  return to.name;
}

/**
 * Merges chat `from` (the PN) into `to` (the LID) in one synchronous transaction. Both are chat keys
 * of the same inbox: a merge never joins two inboxes (throws). Only the startup identity migration
 * calls this. Returns null when `from` has no chat row (idempotent). Media files are not moved:
 * `media_path` stays valid. `jid_aliases` is not touched (the pair already exists).
 */
export function mergeChat(
  db: DB,
  from: string,
  to: string,
  opts: { now: number },
): MergeResult | null {
  if (from === to) return null;
  const src = parseChatKey(from);
  const dst = parseChatKey(to);
  if (src.inboxId !== dst.inboxId) throw new Error('chat merge across two inboxes refused');
  const repo = new ChatRepo(db);
  return db.transaction((): MergeResult | null => {
    const a = repo.get(from);
    if (!a) return null;
    const b = repo.get(to);
    // Decide before any message moves: which chat heard from the customer last.
    const fromNewer = lastInboundAt(db, from) > lastInboundAt(db, to);
    const phone = pnDigits(waJidOf(a)) ?? a.phone;
    let assignedTo = a.assigned_to;
    let assigneeDropped: number | null = null;

    if (!b) {
      db.prepare(
        `INSERT INTO chats (jid, type, name, avatar_path, unread_count, last_message_at, last_message_preview,
           status, assigned_to, updated_at, phone, inbox_id, wa_jid)
         VALUES (@jid, 'dm', @name, @avatar, @unread, @lastAt, @preview, @status, @assigned, @now, @phone,
           @inboxId, @waJid)`,
      ).run({
        jid: to,
        inboxId: dst.inboxId,
        waJid: dst.waJid,
        name: rekeyName(db, a, dst.waJid),
        avatar: a.avatar_path,
        unread: a.unread_count,
        lastAt: a.last_message_at,
        preview: a.last_message_preview,
        status: a.status,
        assigned: a.assigned_to,
        now: opts.now,
        phone,
      });
    } else {
      const newest = (b.last_message_at ?? -1) >= (a.last_message_at ?? -1) ? b : a;
      if (a.assigned_to === null || b.assigned_to === null || a.assigned_to === b.assigned_to) {
        assignedTo = b.assigned_to ?? a.assigned_to;
      } else {
        // A teammate always beats the AI Sales Agent (human ownership cancels AI work);
        // otherwise the chat with the newest inbound keeps its owner.
        const aiFrom = isAiMember(db, a.assigned_to);
        const aiTo = isAiMember(db, b.assigned_to);
        const keepFrom = aiFrom !== aiTo ? aiTo : fromNewer;
        assignedTo = keepFrom ? a.assigned_to : b.assigned_to;
        assigneeDropped = keepFrom ? b.assigned_to : a.assigned_to;
      }
      repo.update(to, {
        type: 'dm',
        name: bestName(db, a, b),
        avatar_path: b.avatar_path ?? a.avatar_path,
        unread_count: a.unread_count + b.unread_count,
        last_message_at: newest.last_message_at,
        last_message_preview: newest.last_message_preview,
        status: a.status === 'open' || b.status === 'open' ? 'open' : 'resolved',
        assigned_to: assignedTo,
        phone: phone ?? b.phone,
        updated_at: opts.now,
      });
    }

    const moved = {
      messages: db.prepare('UPDATE messages SET chat_jid = ? WHERE chat_jid = ?').run(to, from)
        .changes,
      events: db.prepare('UPDATE chat_events SET chat_jid = ? WHERE chat_jid = ?').run(to, from)
        .changes,
      notes: db.prepare('UPDATE notes SET chat_jid = ? WHERE chat_jid = ?').run(to, from).changes,
      // must run before DELETE FROM chats (cascade) and after the `to` row exists (foreign key)
      aiState: mergeAiState(db, from, to, fromNewer),
      ...mergeCustomerProfile(db, from, to),
    };
    // Google Calendar offers, bookings and activity lines (no foreign key: moved explicitly).
    mergeCalendarRows(db, from, to);
    // Google Sheets lead rows and activity lines (no foreign key either).
    mergeSheetsRows(db, from, to);
    // Google Drive saved files and activity lines (no foreign key either).
    mergeDriveRows(db, from, to);
    // Partner (MCP) connector activity, returned values and call counts (no foreign key either).
    mergeConnectorRows(db, from, to);
    // WhatsApp Safety findings follow their messages (no foreign key).
    db.prepare('UPDATE safety_items SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
    if (isAiMember(db, assigneeDropped)) {
      // A teammate took the chat from the AI Sales Agent: no AI follow-up may survive the merge.
      db.prepare(
        'UPDATE ai_chat_state SET paused = 1, awaiting_confirmation = 0, due_at = NULL WHERE chat_jid = ?',
      ).run(to);
    }
    if (assigneeDropped !== null) {
      repo.insertEvent({
        chatJid: to,
        type: 'assigned',
        actorId: null,
        payload: { assignedTo, previous: assigneeDropped, reason: 'merge' },
        at: opts.now,
      });
    }
    db.prepare('DELETE FROM chats WHERE jid = ?').run(from);
    audit(db, {
      userId: null,
      action: 'chat.merge',
      ip: null,
      meta: { from, to, rekeyed: !b, moved, assigneeDropped },
    });
    return { from, to, rekeyed: !b, moved, assignedTo, assigneeDropped };
  })();
}

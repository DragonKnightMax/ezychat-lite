import type { MessageDeletedBy, MessageEdit, MessageEditedBy } from '@ezychat/shared';
import { normalizeContactJid, type WaMessageRevoke } from '@ezychat/wa';
import type { DB } from '../db/index.js';
import type { AliasStore } from '../chats/aliases.js';
import type { MessageRow } from './repo.js';

/** WhatsApp lets the sender edit a message for 15 minutes. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** WhatsApp lets the sender delete a message for everyone for about 2 days. */
export const DELETE_WINDOW_MS = 2 * 24 * 60 * 60_000;
/** Edits and deletes per user and minute (each one is a WhatsApp send). */
export const CHANGES_PER_MINUTE = 30;

interface EditRow {
  previous_body: string | null;
  edited_at: number;
  edited_by: MessageEditedBy;
  user_id: number | null;
}

export interface PendingChange {
  message_id: string;
  kind: 'edit' | 'delete';
  /** the chat key the change routed to; it applies only to a message of that chat */
  chat_jid: string;
  from_me: number;
  sender_jid: string | null;
  body: string | null;
  changed_at: number;
  received_at: number;
}

/** Pending changes older than this never find their message (history beyond the import window). */
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** SQL of `message_edits` and `message_changes_pending` (migration 029). */
export class MessageChangeRepo {
  private readonly editsStmt;
  private readonly countStmt;
  private readonly addEditStmt;
  private readonly savePendingStmt;
  private readonly takePendingStmt;
  private readonly dropPendingStmt;
  private readonly prunePendingStmt;

  constructor(db: DB) {
    this.editsStmt = db.prepare(
      'SELECT previous_body, edited_at, edited_by, user_id FROM message_edits WHERE message_id = ? ORDER BY id',
    );
    this.countStmt = db.prepare(
      `SELECT e.message_id AS id, COUNT(*) AS n FROM json_each(?) ids
         JOIN message_edits e ON e.message_id = ids.value GROUP BY e.message_id`,
    );
    this.addEditStmt = db.prepare(
      'INSERT INTO message_edits (message_id, previous_body, edited_at, edited_by, user_id) VALUES (?, ?, ?, ?, ?)',
    );
    this.savePendingStmt = db.prepare(
      `INSERT INTO message_changes_pending (message_id, kind, chat_jid, from_me, sender_jid, body, changed_at, received_at)
       VALUES (@message_id, @kind, @chat_jid, @from_me, @sender_jid, @body, @changed_at, @received_at)
       ON CONFLICT (message_id, kind) DO UPDATE SET chat_jid = excluded.chat_jid, from_me = excluded.from_me,
         sender_jid = excluded.sender_jid, body = excluded.body, changed_at = excluded.changed_at,
         received_at = excluded.received_at
       WHERE excluded.changed_at >= message_changes_pending.changed_at`,
    );
    this.takePendingStmt = db.prepare(
      "SELECT * FROM message_changes_pending WHERE message_id = ? ORDER BY CASE kind WHEN 'edit' THEN 0 ELSE 1 END",
    );
    this.dropPendingStmt = db.prepare('DELETE FROM message_changes_pending WHERE message_id = ?');
    this.prunePendingStmt = db.prepare('DELETE FROM message_changes_pending WHERE received_at < ?');
  }

  edits(messageId: string): MessageEdit[] {
    return (this.editsStmt.all(messageId) as EditRow[]).map((r) => ({
      previousBody: r.previous_body,
      at: r.edited_at,
      by: r.edited_by,
      userId: r.user_id,
    }));
  }

  /** Number of earlier versions per message id (one query for a page). */
  editCounts(ids: string[]): Map<string, number> {
    if (!ids.length) return new Map();
    const rows = this.countStmt.all(JSON.stringify(ids)) as Array<{ id: string; n: number }>;
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  addEdit(
    messageId: string,
    previousBody: string | null,
    at: number,
    by: MessageEditedBy,
    userId: number | null,
  ): void {
    this.addEditStmt.run(messageId, previousBody, at, by, userId);
  }

  savePending(p: PendingChange): void {
    this.prunePendingStmt.run(p.received_at - PENDING_MAX_AGE_MS);
    this.savePendingStmt.run(p);
  }

  /** The waiting changes of a message (edit first), removed from the table. */
  takePending(messageId: string): PendingChange[] {
    const rows = this.takePendingStmt.all(messageId) as PendingChange[];
    if (rows.length) this.dropPendingStmt.run(messageId);
    return rows;
  }
}

/**
 * Who may change a stored message, as WhatsApp reports the change: only its own author edits it
 * (the customer their message, the linked number ours); a delete for everyone also comes from a
 * group admin (another member, or our own phone when the number is an admin). Returns the
 * `deletedBy` / `editedBy` value, or null when the change must be ignored.
 */
export function changeAuthor(
  row: Pick<MessageRow, 'from_me' | 'sender_jid' | 'chat_jid'>,
  change: Pick<WaMessageRevoke, 'fromMe' | 'senderJid'>,
  kind: 'edit' | 'delete',
  isGroup: boolean,
  aliases: Pick<AliasStore, 'resolve'>,
): MessageDeletedBy | null {
  const ownMessage = row.from_me === 1;
  if (!isGroup) {
    if (change.fromMe !== ownMessage) return null;
    return change.fromMe ? 'phone' : 'sender';
  }
  const by = normalizeContactJid(change.senderJid);
  const author = normalizeContactJid(row.sender_jid);
  const sameAuthor = change.fromMe
    ? ownMessage
    : !ownMessage && !!by && !!author && aliases.resolve(by) === aliases.resolve(author);
  if (sameAuthor) return change.fromMe ? 'phone' : 'sender';
  // Only a group admin deletes someone else's message; WhatsApp checks the admin right.
  if (kind === 'edit') return null;
  return change.fromMe ? 'phone' : 'group_admin';
}

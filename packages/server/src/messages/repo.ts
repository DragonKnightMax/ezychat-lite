import type {
  MediaStatus,
  Message,
  MessageDeletedBy,
  MessageStatus,
  MessageType,
  TranscriptStatus,
} from '@ezychat/shared';
import { forwardedManyTimes } from '@ezychat/shared';
import type { DB } from '../db/index.js';

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number;
  sent_by_user_id: number | null;
  type: MessageType;
  body: string | null;
  /** JSON mention JIDs; NULL = older message without preserved metadata. */
  mentioned_jids?: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_name: string | null;
  media_status: MediaStatus;
  quoted_id: string | null;
  status: MessageStatus;
  error: string | null;
  timestamp: number;
  created_at: number;
  client_id: string | null;
  /** JID WhatsApp used for this message (PN or LID); replies and read receipts go back to it */
  wa_remote_jid: string | null;
  /** Voice note transcript columns (006); optional so inserts need not name them. */
  transcript?: string | null;
  transcript_lang?: string | null;
  transcript_status?: TranscriptStatus | null;
  /** 1 = sent as a WhatsApp voice note (010); optional so inserts need not name it. */
  voice_note?: number;
  /** Access token whose AI assistant sent it through MCP (013); optional so inserts need not name it. */
  sent_via_token_id?: number | null;
  /** Sent by a scheduled task of an AI agent (036); optional so inserts need not name it. */
  scheduled_task_id?: number | null;
  /** Sent as an approved template (019): name, language and JSON body values; NULL otherwise. */
  template_name?: string | null;
  template_language?: string | null;
  template_params?: string | null;
  /** Edits and deletes (025); optional so inserts need not name them. */
  edited_at?: number | null;
  deleted_at?: number | null;
  deleted_by?: MessageDeletedBy | null;
  deleted_by_user_id?: number | null;
  /** "Delete for me": hidden for the whole team. */
  hidden_at?: number | null;
  hidden_by_user_id?: number | null;
  /**
   * WhatsApp's forwarding score (038): an inbound forwarded message's, or a copy we forwarded (the
   * source's + 1); NULL = not forwarded. Optional so inserts need not name it.
   */
  forwarding_score?: number | null;
  /** Bytes of the stored file (038); NULL = not known yet. */
  media_size?: number | null;
}

export function mediaUrlFor(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

/**
 * A stored row as clients see it. A message deleted for everyone keeps its row (admins can read the
 * original through `GET /messages/:id/edits`) but goes out without body, media, quote or transcript.
 */
export function rowToMessage(r: MessageRow): Message {
  if (r.deleted_at != null) {
    return {
      ...rowToMessage({
        ...r,
        deleted_at: null,
        body: null,
        media_path: null,
        media_mime: null,
        media_name: null,
        media_status: 'none',
        quoted_id: null,
        transcript: null,
        transcript_lang: null,
        transcript_status: null,
        voice_note: 0,
        forwarding_score: null,
        media_size: null,
      }),
      deletedAt: r.deleted_at,
      deletedBy: r.deleted_by ?? null,
      deletedByUserId: r.deleted_by_user_id ?? null,
      editedAt: null,
    };
  }
  return {
    id: r.id,
    chatJid: r.chat_jid,
    senderJid: r.sender_jid,
    senderName: r.sender_name,
    fromMe: r.from_me === 1,
    sentByUserId: r.sent_by_user_id,
    type: r.type,
    body: r.body,
    mediaUrl: r.media_path ? mediaUrlFor(r.id) : null,
    mediaMime: r.media_mime,
    mediaName: r.media_name,
    mediaStatus: r.media_status,
    quotedId: r.quoted_id,
    status: r.status,
    error: r.error,
    timestamp: r.timestamp,
    clientId: r.client_id,
    // Filled by the message service's present() (one batched lookup per page).
    reactions: [],
    ...(r.voice_note === 1 ? { voiceNote: true } : {}),
    ...(r.forwarding_score != null && r.forwarding_score > 0
      ? { forwarded: { manyTimes: forwardedManyTimes(r.forwarding_score) } }
      : {}),
    ...(r.media_size != null && r.media_path ? { mediaSize: r.media_size } : {}),
    ...(r.sent_via_token_id != null ? { viaAssistant: true } : {}),
    ...(r.template_name
      ? { template: { name: r.template_name, language: r.template_language ?? '' } }
      : {}),
    ...(r.edited_at != null ? { editedAt: r.edited_at } : {}),
    ...(r.hidden_at != null ? { hidden: true } : {}),
    // Only voice notes that went through transcription carry these fields.
    ...(r.transcript_status
      ? {
          transcript: r.transcript ?? null,
          transcriptLang: r.transcript_lang ?? null,
          transcriptStatus: r.transcript_status,
        }
      : {}),
  };
}

/** Chat list preview: body truncated to 120 chars or a media label ("deleted" once deleted). */
export function previewOf(m: {
  type: MessageType;
  body: string | null;
  media_name?: string | null;
  mediaName?: string | null;
  voice_note?: number;
  deleted_at?: number | null;
}): string {
  if (m.deleted_at != null) return 'This message was deleted';
  const name = m.media_name ?? m.mediaName ?? null;
  const label = (l: string) => (m.body ? `${l} ${truncate(m.body, 100)}` : l);
  switch (m.type) {
    case 'image':
      return label('[Image]');
    case 'video':
      return label('[Video]');
    case 'audio':
      return m.voice_note === 1 ? '[Voice note]' : '[Audio]';
    case 'document':
      return name ? `[Document] ${truncate(name, 100)}` : '[Document]';
    case 'sticker':
      return '[Sticker]';
    default:
      return truncate(m.body ?? '', 120);
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

export const STATUS_RANK: Record<MessageStatus, number> = {
  pending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

export class MessageRepo {
  constructor(private readonly db: DB) {}

  get(id: string): MessageRow | null {
    return (
      (this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) ??
      null
    );
  }

  byClientId(clientId: string): MessageRow | null {
    return (
      (this.db.prepare('SELECT * FROM messages WHERE client_id = ?').get(clientId) as
        MessageRow | undefined) ?? null
    );
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
  }

  /** INSERT OR IGNORE; returns true if a new row was inserted. */
  insert(r: MessageRow): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, sender_name, from_me, sent_by_user_id, type, body,
           media_path, media_mime, media_name, media_status, quoted_id, status, error, timestamp, created_at, client_id,
           wa_remote_jid, voice_note, mentioned_jids, sent_via_token_id, template_name, template_language,
           template_params, scheduled_task_id, forwarding_score, media_size)
         VALUES (@id, @chat_jid, @sender_jid, @sender_name, @from_me, @sent_by_user_id, @type, @body,
           @media_path, @media_mime, @media_name, @media_status, @quoted_id, @status, @error, @timestamp, @created_at, @client_id,
           @wa_remote_jid, @voice_note, @mentioned_jids, @sent_via_token_id, @template_name, @template_language,
           @template_params, @scheduled_task_id, @forwarding_score, @media_size)`,
      )
      .run({
        ...r,
        voice_note: r.voice_note ?? 0,
        sent_via_token_id: r.sent_via_token_id ?? null,
        scheduled_task_id: r.scheduled_task_id ?? null,
        forwarding_score: r.forwarding_score ?? null,
        media_size: r.media_size ?? null,
        template_name: r.template_name ?? null,
        template_language: r.template_language ?? null,
        template_params: r.template_params ?? null,
        mentioned_jids: r.mentioned_jids === undefined ? '[]' : r.mentioned_jids,
      });
    return info.changes > 0;
  }

  update(id: string, fields: Partial<Omit<MessageRow, 'id'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE messages SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  rename(oldId: string, newId: string): void {
    this.db.prepare('UPDATE messages SET id = ? WHERE id = ?').run(newId, oldId);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  /** Newest first, strictly before (ts,id) if given. */
  pageDesc(
    chatJid: string,
    before: { ts: number; id: string } | null,
    limit: number,
  ): MessageRow[] {
    if (before) {
      return this.db
        .prepare(
          `SELECT * FROM messages WHERE chat_jid = ? AND hidden_at IS NULL
           AND (timestamp < ? OR (timestamp = ? AND id < ?))
           ORDER BY timestamp DESC, id DESC LIMIT ?`,
        )
        .all(chatJid, before.ts, before.ts, before.id, limit) as MessageRow[];
    }
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE chat_jid = ? AND hidden_at IS NULL ORDER BY timestamp DESC, id DESC LIMIT ?',
      )
      .all(chatJid, limit) as MessageRow[];
  }

  /** How many visible messages of a chat come after (ts,id), in `pageDesc` order. */
  countNewer(chatJid: string, ts: number, id: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND hidden_at IS NULL
         AND (timestamp > ? OR (timestamp = ? AND id > ?))`,
      )
      .get(chatJid, ts, ts, id) as { n: number };
    return r.n;
  }

  /** The newest message of a chat the team still sees (not hidden), for the chat list preview. */
  newestVisible(chatJid: string): MessageRow | null {
    return (
      (this.db
        .prepare(
          'SELECT * FROM messages WHERE chat_jid = ? AND hidden_at IS NULL ORDER BY timestamp DESC, id DESC LIMIT 1',
        )
        .get(chatJid) as MessageRow | undefined) ?? null
    );
  }

  /** The JID WhatsApp used for the newest inbound message of a chat (where replies should go). */
  lastInboundRemoteJid(chatJid: string): string | null {
    const r = this.db
      .prepare(
        `SELECT wa_remote_jid FROM messages WHERE chat_jid = ? AND from_me = 0 AND wa_remote_jid IS NOT NULL
         ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )
      .get(chatJid) as { wa_remote_jid: string } | undefined;
    return r?.wa_remote_jid ?? null;
  }

  /** Outgoing rows waiting to be sent: new sends (`local-…`) and retries kept under their WhatsApp id. */
  pendingLocal(): MessageRow[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE status = 'pending' AND (id LIKE 'local-%' OR from_me = 1) ORDER BY created_at ASC",
      )
      .all() as MessageRow[];
  }
}

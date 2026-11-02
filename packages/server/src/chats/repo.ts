import type { Chat, ChatEvent, ChatEventType, ChatStatus, ChatType, Note } from '@ezychat/shared';
import { customerTagKey } from '@ezychat/shared';
import {
  PROFILE_JOIN,
  PROFILE_NAME_COLUMN,
  PROFILE_SEARCH,
  TAG_FILTER,
  tagsByChat,
} from '../customers/sql.js';
import { seedFromLinked } from '../customers/linked.js';
import type { DB } from '../db/index.js';
import { chatKey, parseChatKey } from '../inboxes/keys.js';

/** Columns of the `chats` table itself (e.g. `SELECT * FROM chats`). */
export interface ChatColumns {
  jid: string;
  type: ChatType;
  name: string;
  avatar_path: string | null;
  unread_count: number;
  last_message_at: number | null;
  last_message_preview: string | null;
  status: ChatStatus;
  assigned_to: number | null;
  updated_at: number;
  phone: string | null;
  /** The chat's inbox (migration 014; default 1). */
  inbox_id: number;
  /** The chat's WhatsApp JID inside its inbox; null only on rows written by old code (read waJidOf). */
  wa_jid: string | null;
  /** epoch ms of the customer's last live message (migration 019; the reply window starts there). */
  last_inbound_at?: number | null;
}

/**
 * A chat as the read model needs it: its columns plus the customer profile name and tags. Only
 * `ChatRepo.get()`/`list()` build these (profile join + one batched tag query), so a raw
 * `SELECT * FROM chats` row cannot reach rowToChat by mistake.
 */
export interface ChatRow extends ChatColumns {
  /** customer_profiles.name (null when none). */
  profile_name: string | null;
  /** Customer tags in saved order. */
  profile_tags: string[];
}

/** Chat columns plus the customer profile name; FROM `chats c`. Tags are attached by withTags(). */
const CHAT_SELECT = `SELECT c.*, ${PROFILE_NAME_COLUMN} FROM chats c ${PROFILE_JOIN}`;

export interface ChatEventRow {
  id: number;
  chat_jid: string;
  type: ChatEventType;
  actor_id: number | null;
  payload: string;
  at: number;
}

export interface NoteRow {
  id: number;
  chat_jid: string;
  user_id: number;
  body: string;
  created_at: number;
}

export interface ContactRow {
  jid: string;
  push_name: string | null;
  saved_name: string | null;
  phone: string | null;
}

/**
 * The WhatsApp JID of a chat row inside its inbox. JID shape (`@lid`, `@g.us`, …) is read from it,
 * never from the key (`<waJid>#<inboxId>` for inboxes other than 1).
 */
export function waJidOf(r: Pick<ChatColumns, 'jid' | 'wa_jid'>): string {
  return r.wa_jid ?? parseChatKey(r.jid).waJid;
}

export function rowToChat(r: ChatRow): Chat {
  const waJid = waJidOf(r);
  const lid = waJid.endsWith('@lid');
  // A LID is an opaque WhatsApp ID, never a phone number: do not show its digits as a name.
  const lidDigits = lid && r.name === jidUser(waJid);
  const waName = (r.name && !lidDigits ? r.name : null) || r.phone || (lid ? '' : jidUser(waJid));
  const dm = r.type === 'dm';
  // A customer profile name wins; a cleared (NULL/blank) one falls back to the WhatsApp name.
  const profileName = dm ? r.profile_name?.trim() || null : null;
  return {
    jid: r.jid,
    inboxId: r.inbox_id,
    waJid,
    type: r.type,
    name: profileName ?? waName,
    avatarUrl: `/api/chats/${encodeURIComponent(r.jid)}/avatar`,
    unreadCount: r.unread_count,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: r.last_message_preview,
    status: r.status,
    assignedTo: r.assigned_to,
    updatedAt: r.updated_at,
    phone: r.phone ?? null,
    tags: dm ? r.profile_tags : [],
    whatsappName: dm ? waName || null : null,
    lastInboundAt: r.last_inbound_at ?? null,
  };
}

export function rowToEvent(r: ChatEventRow): ChatEvent {
  let payload: Record<string, unknown> = {};
  try {
    const p = JSON.parse(r.payload) as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) payload = p as Record<string, unknown>;
  } catch {
    // ignore malformed payload
  }
  return { id: r.id, chatJid: r.chat_jid, type: r.type, actorId: r.actor_id, payload, at: r.at };
}

export function rowToNote(r: NoteRow): Note {
  return {
    id: r.id,
    chatJid: r.chat_jid,
    userId: r.user_id,
    body: r.body,
    createdAt: r.created_at,
  };
}

/** User part of a jid ("60123@s.whatsapp.net" → "60123"); used as a fallback display name. */
export function jidUser(jid: string): string {
  const at = jid.indexOf('@');
  const user = at >= 0 ? jid.slice(0, at) : jid;
  const colon = user.indexOf(':');
  return colon >= 0 ? user.slice(0, colon) : user;
}

export function chatTypeOf(jid: string): ChatType {
  return jid.endsWith('@g.us') ? 'group' : 'dm';
}

type JoinedRow = Omit<ChatRow, 'profile_tags'>;

/**
 * Every chat key `waJid` can have: one per inbox, removed ones too. Built from the small inboxes
 * table so a look-up by WhatsApp JID stays a primary-key search (`wa_jid` alone is not indexed).
 */
export function candidateChatKeys(db: DB, waJid: string): string[] {
  const ids = (db.prepare('SELECT id FROM inboxes ORDER BY id').all() as Array<{ id: number }>).map(
    (r) => r.id,
  );
  return (ids.length ? ids : [1]).map((id) => chatKey(id, waJid));
}

/** The keys of the existing chats with this WhatsApp JID, in inbox order (primary-key look-ups). */
export function existingChatKeys(db: DB, waJid: string): string[] {
  const keys = candidateChatKeys(db, waJid);
  return (
    db
      .prepare(
        `SELECT jid FROM chats WHERE jid IN (${keys.map(() => '?').join(', ')}) ORDER BY inbox_id`,
      )
      .all(...keys) as Array<{ jid: string }>
  ).map((r) => r.jid);
}

export class ChatRepo {
  constructor(private readonly db: DB) {}

  /** Attaches each chat's customer tags with one batched query. */
  private withTags(rows: JoinedRow[]): ChatRow[] {
    const tags = tagsByChat(
      this.db,
      rows.filter((r) => r.type === 'dm').map((r) => r.jid),
    );
    return rows.map((r) => ({ ...r, profile_tags: tags.get(r.jid) ?? [] }));
  }

  get(jid: string): ChatRow | null {
    const r = this.db.prepare(`${CHAT_SELECT} WHERE c.jid = ?`).get(jid) as JoinedRow | undefined;
    return r ? this.withTags([r])[0]! : null;
  }

  /** The chat of a WhatsApp JID inside one inbox. */
  byWa(inboxId: number, waJid: string): ChatRow | null {
    return this.get(chatKey(inboxId, waJid));
  }

  /** Keys of the chats with this WhatsApp JID, in every inbox (contact names are per JID). */
  keysOf(waJid: string): string[] {
    return existingChatKeys(this.db, waJid);
  }

  /** PN digits for a DM: from a PN JID itself, or from the newest phone number aliased to a LID. */
  phoneFor(jid: string): string | null {
    if (jid.endsWith('@s.whatsapp.net')) return jidUser(jid);
    if (!jid.endsWith('@lid')) return null;
    const row = this.db
      .prepare(
        'SELECT alias_jid FROM jid_aliases WHERE canonical_jid = ? ORDER BY learned_at DESC LIMIT 1',
      )
      .get(jid) as { alias_jid: string } | undefined;
    return row ? jidUser(row.alias_jid) : null;
  }

  openCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS count FROM chats WHERE status = 'open'").get() as {
        count: number;
      }
    ).count;
  }

  openChats(): ChatColumns[] {
    return this.db
      .prepare("SELECT * FROM chats WHERE status = 'open' ORDER BY jid")
      .all() as ChatColumns[];
  }

  /**
   * Inserts the chat of `waJid` in `inboxId` if missing; returns the row (its `jid` is the chat
   * key). The one-key form takes a chat key (a plain WhatsApp JID is inbox 1's key).
   */
  ensure(
    inboxId: number,
    waJid: string,
    init: { type?: ChatType; name?: string | null },
    now: number,
  ): ChatRow;
  ensure(key: string, init: { type?: ChatType; name?: string | null }, now: number): ChatRow;
  ensure(
    a: number | string,
    b: string | { type?: ChatType; name?: string | null },
    c: { type?: ChatType; name?: string | null } | number,
    d?: number,
  ): ChatRow {
    const { inboxId, waJid } =
      typeof a === 'number' ? { inboxId: a, waJid: b as string } : parseChatKey(a);
    const init = (typeof a === 'number' ? c : b) as { type?: ChatType; name?: string | null };
    const now = (typeof a === 'number' ? d : c) as number;
    const key = chatKey(inboxId, waJid);
    const type = init.type ?? chatTypeOf(waJid);
    const contact = type === 'dm' ? this.getContact(waJid) : null;
    const supplied = init.name?.trim() || '';
    const meaningful = supplied && supplied !== waJid && supplied !== jidUser(waJid);
    const name = contact?.saved_name || (meaningful ? supplied : contact?.push_name || supplied);
    const { changes } = this.db
      .prepare(
        `INSERT INTO chats (jid, type, name, unread_count, status, updated_at, phone, inbox_id, wa_jid)
         VALUES (?, ?, ?, 0, 'open', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(key, type, name, now, type === 'dm' ? this.phoneFor(waJid) : null, inboxId, waJid);
    // A new chat of a customer we already know in another inbox starts with their profile.
    if (changes && type === 'dm') seedFromLinked(this.db, key);
    return this.get(key)!;
  }

  setName(jid: string, name: string, now: number): void {
    this.db.prepare('UPDATE chats SET name = ?, updated_at = ? WHERE jid = ?').run(name, now, jid);
  }

  update(jid: string, fields: Partial<Omit<ChatColumns, 'jid'>>): void {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE chats SET ${sets} WHERE jid = @jid`).run({ ...fields, jid });
  }

  list(f: {
    status?: ChatStatus;
    assigned: 'me' | 'none' | 'any';
    userId: number;
    q?: string;
    /** Customer tag, matched by key (case-insensitive). */
    tag?: string;
    since?: number;
    cursor?: { ts: number; jid: string } | null;
    limit: number;
    /** Inboxes the caller may open; omitted = every inbox, empty = none. */
    inboxIds?: readonly number[];
    /** Narrows to one inbox (the inbox filter). */
    inbox?: number;
  }): ChatRow[] {
    if (f.inboxIds && f.inboxIds.length === 0) return [];
    if (f.inbox !== undefined && f.inboxIds && !f.inboxIds.includes(f.inbox)) return [];
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: f.limit };
    if (f.inbox !== undefined) {
      where.push('c.inbox_id = @inbox');
      params.inbox = f.inbox;
    } else if (f.inboxIds) {
      where.push('c.inbox_id IN (SELECT value FROM json_each(@inboxIds))');
      params.inboxIds = JSON.stringify(f.inboxIds);
    }
    if (f.status) {
      where.push('c.status = @status');
      params.status = f.status;
    }
    if (f.assigned === 'me') {
      where.push('c.assigned_to = @userId');
      params.userId = f.userId;
    } else if (f.assigned === 'none') {
      where.push('c.assigned_to IS NULL');
    }
    if (f.since !== undefined) {
      where.push('c.updated_at > @since');
      params.since = f.since;
    }
    if (f.tag) {
      where.push(TAG_FILTER);
      params.tagKey = customerTagKey(f.tag);
    }
    const q = f.q?.trim();
    if (q) {
      params.q = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(
        `(c.name LIKE @q ESCAPE '\\' OR COALESCE(c.wa_jid, c.jid) LIKE @q ESCAPE '\\' OR c.phone LIKE @q ESCAPE '\\'
          OR ct.push_name LIKE @q ESCAPE '\\' OR ct.saved_name LIKE @q ESCAPE '\\' OR ct.phone LIKE @q ESCAPE '\\'
          OR ${PROFILE_SEARCH})`,
      );
    }
    if (f.cursor) {
      where.push(
        '(COALESCE(c.last_message_at, 0) < @cts OR (COALESCE(c.last_message_at, 0) = @cts AND c.jid > @cjid))',
      );
      params.cts = f.cursor.ts;
      params.cjid = f.cursor.jid;
    }
    const sql = `${CHAT_SELECT} LEFT JOIN contacts ct ON ct.jid = COALESCE(c.wa_jid, c.jid)
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(c.last_message_at, 0) DESC, c.jid ASC LIMIT @limit`;
    return this.withTags(this.db.prepare(sql).all(params) as JoinedRow[]);
  }

  insertEvent(e: {
    chatJid: string;
    type: ChatEventType;
    actorId: number | null;
    payload: Record<string, unknown>;
    at: number;
  }): ChatEvent {
    const info = this.db
      .prepare(
        'INSERT INTO chat_events (chat_jid, type, actor_id, payload, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.chatJid, e.type, e.actorId, JSON.stringify(e.payload), e.at);
    return {
      id: Number(info.lastInsertRowid),
      chatJid: e.chatJid,
      type: e.type,
      actorId: e.actorId,
      payload: e.payload,
      at: e.at,
    };
  }

  events(jid: string): ChatEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_events WHERE chat_jid = ? ORDER BY at ASC, id ASC')
      .all(jid) as ChatEventRow[];
    return rows.map(rowToEvent);
  }

  insertNote(chatJid: string, userId: number, body: string, at: number): Note {
    const info = this.db
      .prepare('INSERT INTO notes (chat_jid, user_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(chatJid, userId, body, at);
    return { id: Number(info.lastInsertRowid), chatJid, userId, body, createdAt: at };
  }

  notes(jid: string): Note[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE chat_jid = ? ORDER BY created_at ASC, id ASC')
      .all(jid) as NoteRow[];
    return rows.map(rowToNote);
  }

  upsertContact(c: { jid: string; pushName: string | null; savedName: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (jid, push_name, saved_name, phone) VALUES (@jid, @pushName, @savedName, @phone)
         ON CONFLICT(jid) DO UPDATE SET
           push_name = COALESCE(excluded.push_name, contacts.push_name),
           saved_name = COALESCE(excluded.saved_name, contacts.saved_name),
           phone = COALESCE(excluded.phone, contacts.phone)`,
      )
      .run({
        jid: c.jid,
        pushName: c.pushName?.trim() || null,
        savedName: c.savedName?.trim() || null,
        phone: c.jid.endsWith('@s.whatsapp.net') ? jidUser(c.jid) : null,
      });
  }

  getContact(jid: string): ContactRow | null {
    return (
      (this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid) as
        | ContactRow
        | undefined) ?? null
    );
  }

  contactJids(): string[] {
    return (
      this.db
        .prepare(
          "SELECT jid FROM contacts UNION SELECT COALESCE(wa_jid, jid) FROM chats WHERE type = 'dm'",
        )
        .all() as Array<{ jid: string }>
    ).map((r) => r.jid);
  }

  directChats(): ChatColumns[] {
    return this.db.prepare("SELECT * FROM chats WHERE type = 'dm'").all() as ChatColumns[];
  }
}

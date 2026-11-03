import type {
  AiToolUsedPayload,
  Chat,
  ChatEvent,
  ChatListQuery,
  ChatPatchBody,
  Note,
} from '@ezychat/shared';
import type { WaChatInfo, WaContactInfo, WaContactAlias } from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { agentByUserId } from '../ai/agents.js';
import { answersDirect, directAgentOf } from '../ai/direct.js';
import { audit } from '../db/audit.js';
import { HttpError, errors } from '../http/errors.js';
import { canOpen, scopeFor } from '../inboxes/access.js';
import { getAliases } from './aliases.js';
import { PRIMARY_INBOX_ID, chatKey, parseChatKey, waMessageId } from '../inboxes/keys.js';
import { ChatRepo, chatTypeOf, jidUser, waJidOf, type ChatRow } from './repo.js';
import { createChatPresenter } from '../messages/mentions.js';

/** Which inboxes a chat list reads (the caller's scope and the inbox filter). */
export interface ChatListScope {
  /** Inboxes the caller may open; omitted = every inbox, empty = none. */
  inboxIds?: readonly number[];
  /** One inbox only. */
  inbox?: number;
}

export interface ChatService {
  list(
    q: ChatListQuery,
    userId: number,
    scope?: ChatListScope,
  ): { chats: Chat[]; nextCursor: string | null };
  get(jid: string): Chat | null;
  /**
   * The chat key `key` opens: itself when it has its own chat row, else the chat it routes to
   * inside the same inbox (old links, push URLs). A plain JID is an inbox 1 key.
   */
  resolveJid(key: string): string;
  openCount(): number;
  resolveAll(actorId: number, ip?: string | null): number;
  events(jid: string): ChatEvent[];
  /**
   * "AI looked up …" lines: one `ai_tool_used` event per look-up (title and source label only,
   * never the tool's input or output), emitted on the bus for every teammate.
   */
  addAiToolUsed(jid: string, actorId: number, lookups: readonly AiToolUsedPayload[]): ChatEvent[];
  /** A chat WhatsApp reported through `inboxId` (default inbox 1); `info.jid` is a WhatsApp JID. */
  upsertFromWa(info: WaChatInfo, inboxId?: number): Chat;
  /** actorId null = system */
  /** `eventDetail` is merged into the assignment event's payload (e.g. `{ handoff: reason }`). */
  patch(
    jid: string,
    body: ChatPatchBody,
    actorId: number | null,
    eventDetail?: Record<string, unknown>,
  ): Chat;
  markRead(jid: string, userId: number): Promise<void>;
  addNote(jid: string, userId: number, body: string): Note;
  listNotes(jid: string): Note[];
  /**
   * Contacts from WA: upserts contacts table and fills DM chat names that are still fallbacks.
   * Contacts are keyed by WhatsApp JID, so a name reaches that person's chat in every inbox.
   */
  upsertContacts(list: WaContactInfo[]): void;
  /** Explicit WhatsApp phone/LID identities; never infer a match from a name or number. */
  upsertContactAliases(list: WaContactAlias[]): void;
  contactJids(): string[];
}

export function encodeCursor(ts: number | null, jid: string): string {
  return Buffer.from(`${ts ?? 0}_${jid}`, 'utf8').toString('base64url');
}

export function decodeCursor(c: string): { ts: number; jid: string } | null {
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    const i = s.indexOf('_');
    if (i <= 0) return null;
    const ts = Number(s.slice(0, i));
    const jid = s.slice(i + 1);
    if (!Number.isFinite(ts) || !jid) return null;
    return { ts, jid };
  } catch {
    return null;
  }
}

/** A chat name counts as "fallback" (replaceable by a better one) when empty or equal to the jid's number. */
export function isFallbackName(name: string, jid: string): boolean {
  return !name.trim() || name === jidUser(jid) || name === jid;
}

export function createChatService(ctx: AppContext, deps?: { now?: () => number }): ChatService {
  /** The adapter of the inbox a chat key belongs to (inbox 1: ctx.wa); null for a removed inbox. */
  const adapterFor = (key: string) => {
    const { inboxId } = parseChatKey(key);
    if (inboxId === PRIMARY_INBOX_ID) return ctx.wa;
    return ctx.inboxes.connections.entries().find(([id]) => id === inboxId)?.[1] ?? null;
  };
  const repo = new ChatRepo(ctx.db);
  const now = deps?.now ?? Date.now;
  const aliases = getAliases(ctx);
  const log = ctx.log.child({ mod: 'contacts' });
  const presentAll = createChatPresenter(ctx, ctx.log.child({ mod: 'messages' }));
  const present = (row: ChatRow): Chat => presentAll([row])[0]!;

  const emitChat = (jid: string): Chat => {
    const chat = present(repo.get(jid)!);
    ctx.bus.emit('chat:updated', chat);
    return chat;
  };

  const syncNames = (ids: Iterable<string>, t: number, incoming?: WaContactInfo): Set<string> => {
    const group = [...ids];
    // A moved number's stored names are its previous owner's: never read them for this person.
    const stored = group.map((jid) => (aliases.movedAway(jid) ? undefined : repo.getContact(jid)));
    // ...and neither are names arriving on the moved number itself.
    const fresh = incoming && !aliases.movedAway(incoming.jid) ? incoming : undefined;
    const savedName =
      fresh?.savedName?.trim() || stored.find((c) => c?.saved_name)?.saved_name || null;
    const pushName = fresh?.pushName?.trim() || stored.find((c) => c?.push_name)?.push_name || null;
    const phoneJid = group.find((jid) => jid.endsWith('@s.whatsapp.net'));
    const phone = stored.find((c) => c?.phone)?.phone || (phoneJid ? jidUser(phoneJid) : null);
    const renamed = new Set<string>();
    for (const [index, jid] of group.entries()) {
      // Nor is a moved number a destination: its contact and chat stay the previous owner's.
      if (aliases.movedAway(jid)) continue;
      repo.upsertContact({ jid, savedName, pushName });
      // Retain the phone-number search field on the opaque LID row as well.
      if (phone) ctx.db.prepare('UPDATE contacts SET phone = ? WHERE jid = ?').run(phone, jid);
      const best = savedName || pushName;
      for (const key of repo.keysOf(jid)) {
        const chat = repo.get(key);
        const followsPushName =
          !!stored[index]?.push_name && chat?.name === stored[index]?.push_name;
        if (
          chat?.type === 'dm' &&
          best &&
          chat.name !== best &&
          (savedName || isFallbackName(chat.name, jid) || followsPushName)
        ) {
          repo.setName(key, best, t);
          renamed.add(key);
        }
      }
    }
    return renamed;
  };

  // Older imports may have saved the contact before its chat and left a numeric name.
  // Saved address-book names are authoritative; a push name only replaces a fallback.
  const backfilled = ctx.db.transaction(() => {
    let count = 0;
    for (const chat of repo.directChats()) {
      const waJid = waJidOf(chat);
      const contact = repo.getContact(waJid);
      const best = contact?.saved_name || contact?.push_name;
      if (best && (contact?.saved_name || isFallbackName(chat.name, waJid)) && chat.name !== best) {
        repo.setName(chat.jid, best, now());
        count++;
      }
    }
    return count;
  })();
  log.info({ renamedCount: backfilled }, 'contact name startup backfill');

  const svc: ChatService = {
    list(q, userId, scope = {}) {
      let cursor: { ts: number; jid: string } | null = null;
      if (q.cursor) {
        cursor = decodeCursor(q.cursor);
        if (!cursor) throw errors.validation('Invalid cursor');
      }
      const rows = repo.list({
        status: q.status,
        assigned: q.assigned ?? 'any',
        userId,
        q: q.q,
        tag: q.tag,
        since: q.since,
        cursor,
        limit: q.limit + 1,
        inboxIds: scope.inboxIds,
        inbox: scope.inbox,
      });
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const last = page[page.length - 1];
      return {
        chats: presentAll(page),
        nextCursor: more && last ? encodeCursor(last.last_message_at, last.jid) : null,
      };
    },

    get(jid) {
      const r = repo.get(jid) ?? repo.get(aliases.route(jid));
      return r ? present(r) : null;
    },

    resolveJid(jid) {
      return repo.get(jid) ? jid : aliases.route(jid);
    },

    openCount() {
      return repo.openCount();
    },

    resolveAll(actorId, ip = null) {
      // Commit the complete reset before publishing any changes to connected teammates.
      const result = ctx.db.transaction(() => {
        const chats = repo.openChats();
        const events: ChatEvent[] = [];
        const t = now();
        for (const chat of chats) {
          repo.update(chat.jid, { status: 'resolved', assigned_to: null, updated_at: t });
          events.push(
            repo.insertEvent({ chatJid: chat.jid, type: 'resolved', actorId, payload: {}, at: t }),
          );
          if (chat.assigned_to !== null) {
            events.push(
              repo.insertEvent({
                chatJid: chat.jid,
                type: 'unassigned',
                actorId,
                payload: { previous: chat.assigned_to, reason: 'resolved' },
                at: t,
              }),
            );
          }
        }
        audit(ctx.db, {
          userId: actorId,
          action: 'chats.resolve_all',
          ip,
          meta: { resolvedCount: chats.length },
        });
        return { chats, events };
      })();
      for (const event of result.events) ctx.bus.emit('chat:event', event);
      for (const chat of result.chats) emitChat(chat.jid);
      return result.chats.length;
    },

    events(jid) {
      return repo.events(jid);
    },
    addAiToolUsed(jid, actorId, lookups) {
      if (!lookups.length) return [];
      const at = now();
      const events = ctx.db.transaction(() =>
        lookups.map((lookup) =>
          repo.insertEvent({
            chatJid: jid,
            type: 'ai_tool_used',
            actorId,
            payload: {
              title: lookup.title,
              sourceLabel: lookup.sourceLabel,
              ...(lookup.calendar ? { calendar: lookup.calendar } : {}),
              ...(lookup.group ? { group: lookup.group } : {}),
              ...(lookup.sheet ? { sheet: lookup.sheet } : {}),
            },
            at,
          }),
        ),
      )();
      for (const event of events) ctx.bus.emit('chat:event', event);
      return events;
    },

    upsertFromWa(info, inboxId = PRIMARY_INBOX_ID) {
      // History chats.upsert must not recreate a merged phone-number chat (inside this inbox).
      const jid =
        info.type === 'dm' ? aliases.route(inboxId, info.jid) : chatKey(inboxId, info.jid);
      const t = now();
      const existing = repo.get(jid);
      if (!existing) {
        repo.ensure(jid, { type: info.type, name: info.name ?? '' }, t);
        return emitChat(jid);
      }
      const waJid = waJidOf(existing);
      const contact = existing.type === 'dm' ? repo.getContact(waJid) : null;
      const supplied = info.name?.trim() || null;
      const best =
        contact?.saved_name ||
        (supplied && !isFallbackName(supplied, waJid) ? supplied : contact?.push_name || supplied);
      if (
        best &&
        best !== existing.name &&
        (existing.type === 'group' || !!contact?.saved_name || isFallbackName(existing.name, waJid))
      ) {
        repo.setName(jid, best, t);
        return emitChat(jid);
      }
      return present(existing);
    },

    patch(jid, body, actorId, eventDetail = {}) {
      const cur = repo.get(jid);
      if (!cur) throw errors.notFound('Chat');
      const t = now();
      const events: ChatEvent[] = [];
      const fields: Partial<Parameters<ChatRepo['update']>[1]> = {};

      if (body.assignedTo !== undefined && body.assignedTo !== cur.assigned_to) {
        if (body.assignedTo !== null) {
          const user = ctx.services.auth?.getUser(body.assignedTo) ?? null;
          if (!user || user.disabled) throw errors.validation('Assignee must be an active user');
          // assigning gives no access: the assignee must already open the chat's inbox
          if (user.kind !== 'ai' && !canOpen(scopeFor(ctx, user), cur.inbox_id))
            throw new HttpError(400, 'assignee_no_access', 'The assignee cannot open this inbox');
          // an AI agent answers only its own inbox: on any other chat it would never reply
          const aiAgent = user.kind === 'ai' ? agentByUserId(ctx.db, user.id) : null;
          if (user.kind === 'ai' && aiAgent?.inboxId !== cur.inbox_id)
            throw new HttpError(
              400,
              'assignee_not_inbox_agent',
              "The assignee is not this inbox's AI agent",
            );
          // only the inbox's direct agent answers a direct chat (a group-only agent never does)
          if (aiAgent && cur.type === 'dm') {
            const agent = aiAgent;
            if (!answersDirect(ctx, agent) || directAgentOf(ctx, cur.inbox_id)?.id !== agent.id)
              throw new HttpError(
                400,
                'agent_no_direct_chats',
                'This AI agent does not answer direct chats',
              );
          }
          fields.assigned_to = body.assignedTo;
          events.push(
            repo.insertEvent({
              chatJid: jid,
              type: 'assigned',
              actorId,
              payload: { assignedTo: body.assignedTo, previous: cur.assigned_to, ...eventDetail },
              at: t,
            }),
          );
        } else {
          fields.assigned_to = null;
          events.push(
            repo.insertEvent({
              chatJid: jid,
              type: 'unassigned',
              actorId,
              payload: { previous: cur.assigned_to, ...eventDetail },
              at: t,
            }),
          );
        }
      }
      if (body.status !== undefined && body.status !== cur.status) {
        fields.status = body.status;
        events.push(
          repo.insertEvent({
            chatJid: jid,
            type: body.status === 'resolved' ? 'resolved' : 'reopened',
            actorId,
            payload: {},
            at: t,
          }),
        );
        // Resolving hands the customer back to the team, unless this request also names an owner.
        if (
          body.status === 'resolved' &&
          body.assignedTo === undefined &&
          cur.assigned_to !== null
        ) {
          fields.assigned_to = null;
          events.push(
            repo.insertEvent({
              chatJid: jid,
              type: 'unassigned',
              actorId,
              payload: { previous: cur.assigned_to, reason: 'resolved' },
              at: t,
            }),
          );
        }
      }
      if (!events.length) return present(cur);
      fields.updated_at = t;
      repo.update(jid, fields);
      for (const e of events) ctx.bus.emit('chat:event', e);
      return emitChat(jid);
    },

    async markRead(jid, _userId) {
      const cur = repo.get(jid);
      if (!cur) throw errors.notFound('Chat');
      const rows = ctx.db
        .prepare(
          `SELECT id, wa_remote_jid AS remote FROM messages
           WHERE chat_jid = ? AND from_me = 0 ORDER BY timestamp DESC, id DESC LIMIT 20`,
        )
        .all(jid) as Array<{ id: string; remote: string | null }>;
      if (cur.unread_count !== 0) {
        repo.update(jid, { unread_count: 0, updated_at: now() });
        emitChat(jid);
      }
      // Receipts go out through the chat's own inbox, with WhatsApp's ids (no inbox suffix).
      const wa = adapterFor(jid);
      if (rows.length && wa?.status.state === 'open') {
        // Receipt keys carry remoteJid = the address WhatsApp used; never mix PN and LID ids.
        const byRemote = new Map<string, string[]>();
        const oldestFirst = [...rows].reverse();
        for (const r of oldestFirst) {
          const remote = r.remote ?? waJidOf(cur);
          const ids = byRemote.get(remote) ?? [];
          ids.push(waMessageId(r.id));
          byRemote.set(remote, ids);
        }
        for (const [remote, ids] of byRemote) {
          try {
            await wa.markRead(remote, ids);
          } catch (err) {
            ctx.log.debug({ err, jid: remote }, 'wa markRead failed (ignored)');
          }
        }
      }
    },

    addNote(jid, userId, body) {
      if (!repo.get(jid)) throw errors.notFound('Chat');
      const note = repo.insertNote(jid, userId, body, now());
      ctx.bus.emit('note:new', note);
      return note;
    },

    listNotes(jid) {
      return repo.notes(jid);
    },

    upsertContacts(list) {
      const t = now();
      // Learn pairs outside the name transaction so the alias cache never outlives a rollback.
      aliases.batch(() => {
        for (const c of list) {
          if (chatTypeOf(c.jid) !== 'dm') continue;
          for (const alias of c.aliases ?? []) aliases.learn({ jid: c.jid, alias }, 'contacts');
        }
      });
      const renamed = ctx.db.transaction((items: WaContactInfo[]) => {
        const out = new Set<string>();
        for (const c of items) {
          if (chatTypeOf(c.jid) !== 'dm') continue;
          for (const jid of syncNames(aliases.group(c.jid), t, c)) out.add(jid);
        }
        return out;
      })(list);
      for (const jid of renamed) emitChat(jid);
      log.info(
        { contactCount: list.length, renamedCount: renamed.size },
        'contact names synchronized',
      );
    },

    upsertContactAliases(list) {
      const outcomes = aliases.batch(() =>
        list.map((p) => aliases.learn(p, p.source ?? 'contacts')),
      );
      const changed = ctx.db.transaction(() => {
        const out = new Set<string>();
        for (const o of outcomes) {
          // A re-pointed number's stored names belong to its previous owner: never copy them over,
          // neither when it moves nor on any later sighting of the new pair.
          if (o.kind === 'ignored' || o.kind === 'repointed' || aliases.movedAway(o.pn)) continue;
          for (const jid of syncNames(aliases.group(o.lid), now())) out.add(jid);
        }
        return out;
      })();
      // a newly known phone number shows in the WhatsApp ID chat's header, in every inbox
      for (const o of outcomes) {
        if (o.kind === 'added' || o.kind === 'repointed')
          for (const key of repo.keysOf(o.lid)) changed.add(key);
      }
      for (const jid of changed) emitChat(jid);
      log.info(
        { aliasCount: list.length, renamedCount: changed.size },
        'contact aliases synchronized',
      );
    },

    contactJids() {
      return repo.contactJids();
    },
  };
  return svc;
}

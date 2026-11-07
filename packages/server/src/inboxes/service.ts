import {
  DEFAULT_INBOX_CAPABILITIES,
  LINKED_PHONE,
  type CreateInboxBody,
  type Inbox,
  type InboxListResponse,
  type MemberChatsResponse,
  type SetMemberChatsBody,
  type UpdateInboxBody,
  type User,
  type WaStatus,
} from '@ezychat/shared';
import { LINKED_PHONE_MEDIA_LIMITS, type WaAdapter } from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { agentById, agentForInbox, agentsForInbox, setAgentInbox } from '../ai/agents.js';
import { ChatRepo, type ChatRow } from '../chats/repo.js';
import { audit } from '../db/audit.js';
import { HttpError, errors } from '../http/errors.js';
import { getChats } from '../wa-bridge/index.js';
import { canOpen, canOpenChat, chosenChats, scopeFor, visibleInboxIds } from './access.js';
import { PRIMARY_INBOX_ID, inboxOfKey } from './keys.js';
import type { InboxRow } from './repo.js';
import { isKnownInboxType } from './types.js';

declare module '../context.js' {
  interface Services {
    inboxService?: InboxService;
  }
}

/** Who made a change, for the audit log. */
export interface InboxActor {
  userId: number;
  ip: string | null;
}

type Viewer = Pick<User, 'id' | 'role' | 'kind'>;

/**
 * Runs once the inbox row has its (new) type and before its adapter is built, so an extension can
 * store that inbox id's own settings (credentials) first. Throwing undoes the create/type change.
 */
export type BeforeConnect = (row: InboxRow) => void | Promise<void>;

export interface InboxService {
  /** `GET /inboxes`: the inboxes the viewer may open; QR, members and removed ones for admins. */
  list(viewer: Viewer): InboxListResponse;
  /**
   * Adds an inbox (409 `inbox_limit` above the build's limit); its phone starts linking. `type`:
   * `linked_phone` (default) or a registered extension type (400 `unknown_inbox_type`).
   */
  create(
    body: CreateInboxBody,
    actor: InboxActor,
    opts?: { type?: string; beforeConnect?: BeforeConnect },
  ): Promise<Inbox>;
  /**
   * Switches an active inbox to another connection type (`linked_phone` or a registered one; 400
   * `unknown_inbox_type`, 409 `inbox_removed`): the adapter is swapped, chats, keys, notes, tags
   * and assignments stay. The same type is a no-op. Audited `inbox.type_change` {from, to}.
   */
  changeType(
    id: number,
    type: string,
    actor: InboxActor,
    opts?: { beforeConnect?: BeforeConnect },
  ): Promise<Inbox>;
  update(id: number, body: UpdateInboxBody, actor: InboxActor): Inbox;
  /** Unlinks the phone, deletes its own folder and keeps its chats read only (409 for inbox 1). */
  remove(id: number, actor: InboxActor): Promise<void>;
  /** Members → Inbox access: replaces the inboxes one user may open. */
  setUserInboxes(userId: number, inboxIds: number[], actor: InboxActor): User;
  /** The WhatsApp adapter of an active, connected inbox; 404 otherwise. */
  adapter(id: number): WaAdapter;
  /** `GET /users`: an agent's active inboxes when the build allows several, else undefined. */
  usersListInboxIds(user: User): number[] | undefined;
  /**
   * `GET /users/directory`: `'all'` for admins and the AI member, else the inboxes they open;
   * for a viewer who is not an admin, only those the viewer opens too.
   */
  directoryInboxIds(user: User, viewer: Viewer): 'all' | number[];
  /**
   * `GET /users/directory`: for an agent limited to chosen chats, the chosen chats the viewer may
   * open too (all of them for an admin); undefined for everyone else.
   */
  directoryChatJids(user: User, viewer: Viewer): string[] | undefined;
  /** "Chats this member can see" of one agent (`GET /api/users/:id/chats`, admins). */
  memberChats(userId: number): MemberChatsResponse;
  /**
   * Replaces it (`PUT /api/users/:id/chats`): 400 `not_an_agent` for an admin or AI member, 400
   * `unknown_chat` for a key that is no chat of an active inbox. The open chats the agent can no
   * longer open are unassigned; live sockets rebuild their rooms. Audited `user.chat_scope` (ids only).
   */
  setMemberChats(userId: number, body: SetMemberChatsBody, actor: InboxActor): MemberChatsResponse;
  /** A new agent joins the only inbox when exactly one is active (Lite, a one-inbox install). */
  onUserCreated(user: User): void;
}

export const OFFLINE: WaStatus = { state: 'logged_out', me: null, qr: null, lastError: null };

/** Phone-number digits of a WhatsApp JID's user part (`60123:4@s.whatsapp.net` → `60123`). */
export function numberOfJid(jid: string | null | undefined): string | null {
  const user = jid?.split('@')[0]?.split(':')[0] ?? '';
  const digits = user.replace(/\D/g, '');
  return digits || null;
}

/** Snapshot of an adapter status; the QR string is only revealed to admins. */
export function waStatusFor(status: WaStatus, isAdmin: boolean): WaStatus {
  return { ...status, me: status.me ? { ...status.me } : null, qr: isAdmin ? status.qr : null };
}

const isAdmin = (u: Viewer) => u.role === 'admin';
const sortedUnique = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);

/** The inbox of a chat or message key; null for a key that does not parse (never a 500). */
export function inboxOfKeyOrNull(key: string): number | null {
  try {
    return inboxOfKey(key);
  } catch {
    return null;
  }
}

/**
 * The chat a request may open: `key` resolved like `chatJidParam` (old links route to the chat),
 * then checked against the user's inboxes. A chat the user may not open answers 404, exactly as a
 * missing one, so nothing tells that it exists.
 */
export function requireChatAccess(ctx: AppContext, user: Viewer, key: string): ChatRow {
  let resolved: string;
  try {
    resolved = getChats(ctx).resolveJid(key);
  } catch {
    throw errors.notFound('Chat'); // a malformed key
  }
  const row = new ChatRepo(ctx.db).get(resolved);
  if (!row || !canOpenChat(ctx, user, row)) throw errors.notFound('Chat');
  return row;
}

/**
 * Message-id routes (media, retry): the message's chat must be one the user may open, else 404.
 * An unknown id passes, so the route answers its own 404 as before. `local-<clientId>` finds a
 * pending send by its client id, as the media route does.
 */
export function requireMessageAccess(ctx: AppContext, user: Viewer, id: string): void {
  const row =
    (ctx.db.prepare('SELECT chat_jid FROM messages WHERE id = ?').get(id) as
      { chat_jid: string } | undefined) ??
    (id.startsWith('local-')
      ? (ctx.db
          .prepare('SELECT chat_jid FROM messages WHERE client_id = ?')
          .get(id.slice('local-'.length)) as { chat_jid: string } | undefined)
      : undefined);
  if (!row) return;
  const inboxId = inboxOfKeyOrNull(row.chat_jid);
  if (inboxId === null || !canOpenChat(ctx, user, { jid: row.chat_jid, inbox_id: inboxId }))
    throw errors.notFound('Message');
}

/** Connection state of the number a chat key belongs to; null for a removed or unknown inbox. */
export function chatWaState(ctx: AppContext, key: string): WaStatus['state'] | null {
  try {
    return ctx.inboxes.connections.forChatKey(key).status.state;
  } catch {
    return null;
  }
}

export function createInboxService(ctx: AppContext, deps?: { now?: () => number }): InboxService {
  const { repo, connections } = ctx.inboxes;
  const now = deps?.now ?? Date.now;
  const log = ctx.log.child({ mod: 'inboxes' });

  const adapterOrNull = (id: number): WaAdapter | null => {
    try {
      return connections.adapter(id);
    } catch {
      return null;
    }
  };

  const toInbox = (row: InboxRow, admin: boolean): Inbox => {
    const wa = row.removed_at === null ? adapterOrNull(row.id) : null;
    return {
      id: row.id,
      name: row.name,
      tone: row.tone,
      // the linked phone now, else the last one linked (kept after an unlink)
      number: numberOfJid(wa?.status.me?.jid ?? row.own_jid),
      status: wa ? waStatusFor(wa.status, admin) : { ...OFFLINE },
      removed: row.removed_at !== null,
      aiAgentId: agentForInbox(ctx.db, row.id)?.id ?? null,
      ...(admin ? { memberIds: repo.members(row.id) } : {}),
      type: row.type,
      capabilities: wa?.capabilities
        ? { ...wa.capabilities, mentions: wa.capabilities.mentions === true }
        : wa
          ? // a linked phone (Baileys, the fake) declares none: its media limits and Forwarded mark
            {
              ...DEFAULT_INBOX_CAPABILITIES,
              mediaLimits: { ...LINKED_PHONE_MEDIA_LIMITS },
              forwardedMark: true,
            }
          : { ...DEFAULT_INBOX_CAPABILITIES },
    };
  };

  const activeRow = (id: number): InboxRow => {
    const row = repo.get(id);
    if (!row) throw errors.notFound('Inbox');
    if (row.removed_at !== null)
      throw new HttpError(409, 'inbox_removed', 'This inbox was removed');
    return row;
  };

  /** Members must be existing team members (people, not the AI member). */
  const checkMembers = (ids: number[]): number[] => {
    const auth = ctx.services.auth;
    const out = sortedUnique(ids);
    for (const id of out) {
      const u = auth?.getUser(id) ?? null;
      if (!u || u.kind === 'ai') throw errors.validation(`Unknown team member: ${id}`);
    }
    return out;
  };

  /**
   * Hands back the open chats agents lost access to: unassigned, with an event, so the team sees
   * them in Unassigned. Admins and the AI member open every inbox and keep theirs.
   * `actorId` null = system (a role change).
   */
  const unassignLost = (userId: number, inboxIds: number[], actorId: number | null) => {
    if (!inboxIds.length) return;
    const user = ctx.services.auth?.getUser(userId) ?? null;
    if (!user || user.role === 'admin' || user.kind === 'ai') return;
    const rows = ctx.db
      .prepare(
        `SELECT jid FROM chats WHERE assigned_to = ? AND status = 'open'
         AND inbox_id IN (${inboxIds.map(() => '?').join(', ')})`,
      )
      .all(userId, ...inboxIds) as Array<{ jid: string }>;
    const chats = getChats(ctx);
    for (const { jid } of rows)
      chats.patch(jid, { assignedTo: null }, actorId, { reason: 'inbox_access' });
    if (rows.length)
      log.info({ userId, count: rows.length }, 'chats unassigned after access change');
  };

  const changed = () => ctx.bus.emit('inboxes:changed');

  const requireKnownType = (type: string) => {
    if (!isKnownInboxType(ctx, type))
      throw new HttpError(400, 'unknown_inbox_type', `Unknown inbox type: ${type}`);
  };

  /** The AI service: binding an agent cancels its work and hands back its chats there. */
  const aiService = () => {
    const ai = ctx.services.ai;
    if (!ai) throw new HttpError(503, 'ai_unavailable', 'The AI service is not running');
    return ai;
  };
  const requireAgent = (agentId: number) => {
    if (!agentById(ctx.db, agentId))
      throw new HttpError(404, 'agent_not_found', 'AI agent not found');
  };

  /**
   * Admin → Inboxes: the inbox's main agent (null = none). null unbinds the main agent; another
   * agent joins the inbox (an inbox may have several, only one answering direct chats: else 409
   * `inbox_has_direct_agent`). A move releases the agent's chats of its old inbox. Returns true
   * when the binding changed.
   */
  const bindAgent = (inboxId: number, agentId: number | null, actor: InboxActor): boolean => {
    const current = agentForInbox(ctx.db, inboxId);
    if ((current?.id ?? null) === agentId) return false;
    if (agentId === null) {
      aiService().setAgentInbox(current!.id, null, actor);
      return true;
    }
    requireAgent(agentId);
    if (agentById(ctx.db, agentId)?.inboxId === inboxId) return false;
    aiService().setAgentInbox(agentId, inboxId, actor);
    return true;
  };

  /** Open chats assigned to an agent that the agent can no longer open: unassigned, with an event. */
  const unassignUnopenable = (userId: number, actorId: number | null) => {
    const user = ctx.services.auth?.getUser(userId) ?? null;
    if (!user || user.role === 'admin' || user.kind === 'ai') return;
    const rows = ctx.db
      .prepare(`SELECT jid, inbox_id FROM chats WHERE assigned_to = ? AND status = 'open'`)
      .all(userId) as Array<{ jid: string; inbox_id: number }>;
    const chats = getChats(ctx);
    let count = 0;
    for (const row of rows) {
      if (canOpenChat(ctx, user, row)) continue;
      chats.patch(row.jid, { assignedTo: null }, actorId, { reason: 'chat_access' });
      count++;
    }
    if (count) log.info({ userId, count }, 'chats unassigned after chat access change');
  };

  const listMemberChats = (userId: number): MemberChatsResponse => {
    const row = ctx.db.prepare('SELECT chat_scope FROM users WHERE id = ?').get(userId) as
      { chat_scope: string } | undefined;
    const scope = row?.chat_scope === 'chosen' ? 'chosen' : 'all';
    const jids = (
      ctx.db
        .prepare('SELECT chat_jid FROM member_chats WHERE user_id = ? ORDER BY added_at, chat_jid')
        .all(userId) as Array<{ chat_jid: string }>
    ).map((r) => r.chat_jid);
    const chats = getChats(ctx);
    return {
      scope,
      chats: jids.map((jid) => {
        const chat = chats.get(jid);
        return { jid, name: chat?.name || jid, type: chat?.type ?? 'dm' };
      }),
    };
  };

  /** An admin sees every chat: a promotion drops the chosen chats (no hidden leftovers). */
  const clearMemberChats = (userId: number) => {
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE users SET chat_scope = 'all' WHERE id = ?").run(userId);
      ctx.db.prepare('DELETE FROM member_chats WHERE user_id = ?').run(userId);
    })();
  };

  // a demoted admin keeps only the inboxes they are a member of: hand back the others' chats
  ctx.bus.on('user:role-changed', (userId, role) => {
    if (role === 'admin') clearMemberChats(userId);
    if (role !== 'agent') return;
    const scope = scopeFor(ctx, { id: userId, role, kind: 'human' });
    if (scope === 'all') return;
    unassignLost(
      userId,
      repo
        .list()
        .map((r) => r.id)
        .filter((id) => !scope.has(id)),
      null,
    );
  });

  const svc: InboxService = {
    list(viewer) {
      const admin = isAdmin(viewer);
      // an agent limited to chosen chats sees the inboxes of those chats (names, connection state)
      const scope = visibleInboxIds(ctx, viewer);
      const rows = admin ? repo.list() : repo.active().filter((r) => canOpen(scope, r.id));
      const maxInboxes = connections.maxInboxes();
      return {
        inboxes: rows.map((r) => toInbox(r, admin)),
        maxInboxes,
        canAdd: admin && repo.active().length < maxInboxes,
      };
    },

    async create(body, actor, opts) {
      const type = opts?.type ?? LINKED_PHONE;
      requireKnownType(type);
      const memberIds = checkMembers(body.memberIds);
      // refuse before the insert: a refused binding creates no inbox
      if (body.aiAgentId != null) {
        aiService();
        requireAgent(body.aiAgentId);
      }
      // check and insert without a pause between them: two admins cannot pass the limit together
      if (repo.active().length >= connections.maxInboxes())
        throw new HttpError(409, 'inbox_limit', 'The inbox limit is reached');
      const row = repo.insert(body.name, repo.nextTone(), now(), type);
      repo.setMembers(row.id, memberIds);
      try {
        await opts?.beforeConnect?.(row);
        await connections.add(row);
      } catch (err) {
        repo.markRemoved(row.id, now());
        log.error({ err, inboxId: row.id }, 'inbox connection not created');
        throw err;
      }
      audit(ctx.db, {
        userId: actor.userId,
        action: 'inbox.create',
        ip: actor.ip,
        meta: { inboxId: row.id, memberCount: memberIds.length, type },
      });
      if (body.aiAgentId != null) bindAgent(row.id, body.aiAgentId, actor);
      changed();
      return toInbox(repo.get(row.id)!, true);
    },

    async changeType(id, type, actor, opts) {
      const row = activeRow(id);
      requireKnownType(type);
      if (row.type === type) return toInbox(row, true);
      if (adapterOrNull(id) === null)
        throw new HttpError(
          409,
          'inbox_not_connected',
          'This inbox is not connected in this edition',
        );
      const from = row.type;
      repo.setType(id, type);
      try {
        await opts?.beforeConnect?.(repo.get(id)!);
        // builds the new adapter before letting go of the old one: a failure changes nothing
        await connections.replace(id, from);
      } catch (err) {
        repo.setType(id, from);
        log.warn({ err, inboxId: id, from, to: type }, 'inbox type not changed');
        throw err;
      }
      log.info({ inboxId: id, from, to: type }, 'inbox type changed');
      audit(ctx.db, {
        userId: actor.userId,
        action: 'inbox.type_change',
        ip: actor.ip,
        meta: { inboxId: id, from, to: type },
      });
      changed();
      return toInbox(repo.get(id)!, true);
    },

    update(id, body, actor) {
      const row = activeRow(id);
      const fields: string[] = [];
      // check the members first, then bind: a refused member list or binding (409
      // inbox_has_agent, 404) leaves the inbox unchanged
      const next = body.memberIds !== undefined ? checkMembers(body.memberIds) : undefined;
      if (body.aiAgentId !== undefined && bindAgent(id, body.aiAgentId, actor))
        fields.push('aiAgentId');
      if (body.name !== undefined && body.name !== row.name) {
        repo.rename(id, body.name);
        fields.push('name');
      }
      if (next !== undefined) {
        const before = repo.members(id);
        repo.setMembers(id, next);
        if (before.join() !== next.join()) fields.push('memberIds');
        for (const lost of before.filter((u) => !next.includes(u)))
          unassignLost(lost, [id], actor.userId);
      }
      if (fields.length) {
        audit(ctx.db, {
          userId: actor.userId,
          action: 'inbox.update',
          ip: actor.ip,
          meta: { inboxId: id, fields },
        });
        changed();
      }
      return toInbox(repo.get(id)!, true);
    },

    async remove(id, actor) {
      if (id === PRIMARY_INBOX_ID)
        throw new HttpError(409, 'primary_inbox', 'The first inbox cannot be removed');
      const row = repo.get(id);
      if (!row || row.removed_at !== null) throw errors.notFound('Inbox');
      // unlink first: the message service fails this inbox's pending sends on 'removed'
      await connections.remove(id);
      repo.markRemoved(id, now());
      // its AI agents answer no inbox now: unbind them and hand back their chats
      for (const agent of agentsForInbox(ctx.db, id)) {
        const ai = ctx.services.ai;
        // the service also stops the agent's running work (it refuses "no inbox" with one agent)
        if (ai && ai.maxAgents() > 1) ai.setAgentInbox(agent.id, null, actor);
        else {
          setAgentInbox(ctx.db, agent.id, null, now());
          audit(ctx.db, {
            userId: actor.userId,
            action: 'ai.agent_inbox_update',
            ip: actor.ip,
            meta: { agentId: agent.id, from: id, to: null },
          });
          ai?.releaseAgent(agent.id);
        }
      }
      // agents no longer open a removed inbox: its open chats go back to Unassigned for admins
      const assignees = ctx.db
        .prepare(
          `SELECT DISTINCT assigned_to AS id FROM chats
           WHERE inbox_id = ? AND status = 'open' AND assigned_to IS NOT NULL`,
        )
        .all(id) as Array<{ id: number }>;
      for (const a of assignees) unassignLost(a.id, [id], actor.userId);
      audit(ctx.db, {
        userId: actor.userId,
        action: 'inbox.remove',
        ip: actor.ip,
        meta: { inboxId: id },
      });
      changed();
    },

    setUserInboxes(userId, inboxIds, actor) {
      const user = ctx.services.auth?.getUser(userId) ?? null;
      if (!user) throw errors.notFound('User');
      if (user.kind === 'ai') throw errors.validation('The AI member opens every inbox');
      const ids = sortedUnique(inboxIds);
      const active = new Set(repo.active().map((r) => r.id));
      for (const id of ids) if (!active.has(id)) throw errors.validation(`Unknown inbox: ${id}`);
      const before = repo.userInboxIds(userId);
      repo.setUserInboxes(userId, ids);
      unassignLost(
        userId,
        before.filter((id) => !ids.includes(id)),
        actor.userId,
      );
      audit(ctx.db, {
        userId: actor.userId,
        action: 'inbox.access_update',
        ip: actor.ip,
        meta: { targetId: userId, inboxIds: ids },
      });
      changed();
      return { ...user, inboxIds: ids };
    },

    adapter(id) {
      const row = repo.get(id);
      const wa = row && row.removed_at === null ? adapterOrNull(id) : null;
      if (!wa) throw errors.notFound('Inbox');
      return wa;
    },

    usersListInboxIds(user) {
      if (connections.maxInboxes() <= 1 || user.role === 'admin' || user.kind === 'ai')
        return undefined;
      const active = new Set(repo.active().map((r) => r.id));
      return repo.userInboxIds(user.id).filter((id) => active.has(id));
    },

    memberChats(userId) {
      const user = ctx.services.auth?.getUser(userId) ?? null;
      if (!user) throw errors.notFound('User');
      return listMemberChats(userId);
    },

    setMemberChats(userId, body, actor) {
      const user = ctx.services.auth?.getUser(userId) ?? null;
      if (!user) throw errors.notFound('User');
      if (user.role !== 'agent' || user.kind === 'ai')
        throw new HttpError(400, 'not_an_agent', 'Only an agent can be limited to chosen chats');
      const chats = getChats(ctx);
      const chatRepo = new ChatRepo(ctx.db);
      const jids: string[] = [];
      if (body.scope === 'chosen')
        for (const key of body.chats) {
          let jid: string;
          try {
            jid = chats.resolveJid(key);
          } catch {
            throw new HttpError(400, 'unknown_chat', 'Unknown chat');
          }
          const row = chatRepo.get(jid);
          const inbox = row ? repo.get(row.inbox_id) : undefined;
          if (!row || !inbox || inbox.removed_at !== null)
            throw new HttpError(400, 'unknown_chat', 'Unknown chat');
          if (!jids.includes(jid)) jids.push(jid);
        }
      const before = listMemberChats(userId);
      const was = new Set(before.chats.map((c) => c.jid));
      const now = Date.now();
      ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE users SET chat_scope = ? WHERE id = ?').run(body.scope, userId);
        ctx.db
          .prepare(
            `DELETE FROM member_chats WHERE user_id = ?
             AND chat_jid NOT IN (SELECT value FROM json_each(?))`,
          )
          .run(userId, JSON.stringify(jids));
        const insert = ctx.db.prepare(
          'INSERT OR IGNORE INTO member_chats (user_id, chat_jid, added_by, added_at) VALUES (?, ?, ?, ?)',
        );
        jids.forEach((jid, i) => insert.run(userId, jid, actor.userId, now + i));
      })();
      unassignUnopenable(userId, actor.userId);
      audit(ctx.db, {
        userId: actor.userId,
        action: 'user.chat_scope',
        ip: actor.ip,
        meta: {
          targetId: userId,
          before: before.scope,
          after: body.scope,
          added: jids.filter((j) => !was.has(j)),
          removed: [...was].filter((j) => !jids.includes(j)),
        },
      });
      ctx.bus.emit('member-chats:changed', userId);
      return listMemberChats(userId);
    },

    directoryChatJids(user, viewer) {
      const chosen = chosenChats(ctx, user);
      if (!chosen) return undefined;
      const repoChats = new ChatRepo(ctx.db);
      return [...chosen]
        .filter((jid) => {
          if (isAdmin(viewer)) return true;
          const row = repoChats.get(jid);
          return !!row && canOpenChat(ctx, viewer, row);
        })
        .sort((a, b) => a.localeCompare(b));
    },

    directoryInboxIds(user, viewer) {
      const scope = scopeFor(ctx, user);
      if (scope === 'all') return 'all';
      const seen = isAdmin(viewer) ? 'all' : scopeFor(ctx, viewer);
      return [...scope].filter((id) => canOpen(seen, id)).sort((a, b) => a - b);
    },

    onUserCreated(user) {
      if (user.role !== 'agent' || user.kind === 'ai') return;
      const active = repo.active();
      if (active.length === 1) repo.setUserInboxes(user.id, [active[0]!.id]);
    },
  };
  return svc;
}

/** The inbox service of this context (created on first use). */
export function getInboxService(ctx: AppContext): InboxService {
  return (ctx.services.inboxService ??= createInboxService(ctx));
}

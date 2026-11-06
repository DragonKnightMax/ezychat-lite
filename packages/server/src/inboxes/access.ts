import type { User } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { inboxOfKey } from './keys.js';

/** Inboxes a user may open: every inbox, or a set of inbox ids. */
export type InboxScope = 'all' | ReadonlySet<number>;

type InboxCtx = Pick<AppContext, 'db' | 'inboxes'>;
type Viewer = Pick<User, 'id' | 'role' | 'kind'>;

/**
 * The chats an agent limited to chosen chats may open (`users.chat_scope = 'chosen'`, rows in
 * `member_chats`, any inbox); null for everyone else. Read from the database on every check, so a
 * change takes effect on the next request. "Chosen" with no rows is an empty set: no chats, never all.
 */
export function chosenChats(ctx: Pick<AppContext, 'db'>, user: Viewer): ReadonlySet<string> | null {
  if (user.role !== 'agent' || user.kind === 'ai') return null;
  const row = ctx.db.prepare('SELECT chat_scope FROM users WHERE id = ?').get(user.id) as
    { chat_scope: string } | undefined;
  if (row?.chat_scope !== 'chosen') return null;
  const rows = ctx.db
    .prepare('SELECT chat_jid FROM member_chats WHERE user_id = ?')
    .all(user.id) as Array<{ chat_jid: string }>;
  return new Set(rows.map((r) => r.chat_jid));
}

/**
 * Admins and the AI member open every inbox (removed ones too, read only). Agents open the active
 * inboxes they are members of. With a single-inbox build (Lite) that has only inbox 1, everyone
 * opens it. An agent limited to chosen chats opens **no inbox** (empty set, checked before the
 * single-inbox shortcut): their chats are opened one by one through `canOpenChat`.
 */
export function scopeFor(ctx: InboxCtx, user: Viewer): InboxScope {
  if (user.role === 'admin' || user.kind === 'ai') return 'all';
  if (chosenChats(ctx, user)) return new Set();
  if (isSingleInbox(ctx)) return 'all';
  const active = new Set(ctx.inboxes.repo.active().map((r) => r.id));
  return new Set(ctx.inboxes.repo.userInboxIds(user.id).filter((id) => active.has(id)));
}

/**
 * The Lite shortcut: a build limited to one inbox whose data dir holds only inbox 1. A data dir
 * left with more active inboxes by a bigger build keeps member scoping.
 */
function isSingleInbox(ctx: InboxCtx): boolean {
  if (ctx.inboxes.connections.maxInboxes() !== 1) return false;
  const active = ctx.inboxes.repo.active();
  return active.length === 1 && active[0]!.id === 1;
}

export function canOpen(scope: InboxScope, inboxId: number): boolean {
  return scope === 'all' || scope.has(inboxId);
}

/**
 * The one per-chat check: a chosen chat for a limited agent (its inbox still active, or any inbox for
 * nobody else), else the inbox scope. Use it wherever one chat is opened, sent to or notified about.
 */
export function canOpenChat(
  ctx: InboxCtx,
  user: Viewer,
  chat: { jid: string; inbox_id: number },
): boolean {
  const chosen = chosenChats(ctx, user);
  if (chosen) return chosen.has(chat.jid) && inboxActive(ctx, chat.inbox_id);
  return canOpen(scopeFor(ctx, user), chat.inbox_id);
}

const inboxActive = (ctx: InboxCtx, inboxId: number) => {
  const row = ctx.inboxes.repo.get(inboxId);
  return !!row && row.removed_at === null;
};

/**
 * The inboxes a user may see the name and connection state of: their inbox scope, or for an agent
 * limited to chosen chats the active inboxes their chosen chats belong to (never their other chats).
 */
export function visibleInboxIds(ctx: InboxCtx, user: Viewer): InboxScope {
  const chosen = chosenChats(ctx, user);
  if (!chosen) return scopeFor(ctx, user);
  const ids = new Set<number>();
  for (const jid of chosen) {
    try {
      const id = inboxOfKey(jid);
      if (inboxActive(ctx, id)) ids.add(id);
    } catch {
      /* a key that does not parse opens nothing */
    }
  }
  return ids;
}

/** Active inbox ids in the scope, ascending. */
export function scopeIds(ctx: InboxCtx, scope: InboxScope): number[] {
  return ctx.inboxes.repo
    .active()
    .map((r) => r.id)
    .filter((id) => canOpen(scope, id));
}

/**
 * Active human users who may open the inbox: admins plus its members (every active human with a
 * single-inbox build). A removed inbox is for admins only. Agents limited to chosen chats never
 * open a whole inbox. Ascending ids.
 */
export function usersWhoCanOpen(ctx: InboxCtx, inboxId: number): number[] {
  const row = ctx.inboxes.repo.get(inboxId);
  if (!row) return [];
  const everyone = row.removed_at === null && isSingleInbox(ctx);
  const members = row.removed_at === null;
  const rows = ctx.db
    .prepare(
      `SELECT id FROM users
       WHERE kind = 'human' AND disabled_at IS NULL
         AND (role = 'admin' OR (chat_scope = 'all' AND (? = 1
              OR (? = 1 AND id IN (SELECT user_id FROM inbox_members WHERE inbox_id = ?)))))
       ORDER BY id`,
    )
    .all(everyone ? 1 : 0, members ? 1 : 0, inboxId) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/**
 * Active human users who may open one chat: `usersWhoCanOpen(its inbox)` plus the agents limited to
 * chosen chats who chose it (only while its inbox is active). Every notification about a chat (push,
 * `notification:new`, AI hand-off) is sent only to these people. Ascending ids; a key that does not
 * parse reaches nobody.
 */
export function usersWhoCanOpenChat(ctx: InboxCtx, jid: string): number[] {
  let inboxId: number;
  try {
    inboxId = inboxOfKey(jid);
  } catch {
    return [];
  }
  const ids = new Set(usersWhoCanOpen(ctx, inboxId));
  if (inboxActive(ctx, inboxId)) {
    const limited = ctx.db
      .prepare(
        `SELECT u.id FROM users u JOIN member_chats m ON m.user_id = u.id
         WHERE m.chat_jid = ? AND u.kind = 'human' AND u.role = 'agent'
           AND u.chat_scope = 'chosen' AND u.disabled_at IS NULL`,
      )
      .all(jid) as Array<{ id: number }>;
    for (const r of limited) ids.add(r.id);
  }
  return [...ids].sort((a, b) => a - b);
}

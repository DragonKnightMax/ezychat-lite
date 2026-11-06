import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { User } from '@ezychat/shared';
import { useInboxes, useUserDirectory, useUsers, type DirectoryUser } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { i18n } from '@/i18n';

/**
 * A team member as the inbox knows them: the directory row (agents), or the full user (admins read
 * `GET /api/users`, where `inboxIds` is set for agents only). No `inboxIds` means every inbox only
 * in a single-inbox install; with several inboxes it means no inbox (fail closed).
 */
export type DirectoryEntry = Omit<DirectoryUser, 'inboxIds'> & {
  inboxIds?: DirectoryUser['inboxIds'];
  /** 'chosen': an agent limited to chosen chats (`chatJids`, as far as the viewer may know them). */
  chatScope?: User['chatScope'];
};

/** An agent limited to chosen chats opens only those (never a whole inbox). */
const limited = (u: DirectoryEntry) => u.chatScope === 'chosen' || u.chatJids !== undefined;

/**
 * The member may open chats of this inbox (admins and the AI member open every inbox). A row without
 * `inboxIds` opens every inbox only when `multiInbox` is false (one inbox, no inbox UI).
 */
export function canOpenInbox(u: DirectoryEntry, inboxId: number, multiInbox = false): boolean {
  if (u.role === 'admin' || u.kind === 'ai') return true;
  if (u.inboxIds == null) return !multiInbox;
  if (u.inboxIds === 'all') return true;
  return u.inboxIds.includes(inboxId);
}

export interface Directory {
  me: User | null;
  isAdmin: boolean;
  byId: Map<number, DirectoryEntry>;
  /** Users that can be picked as assignee (active only; never a deleted AI agent). */
  assignable: DirectoryEntry[];
  /**
   * The assign dropdown of a chat of this inbox: active people who may open it, and the AI agent
   * that answers this inbox (no other AI agent: the server refuses it). `direct`: a direct chat, which
   * a group-only agent (`aiNoDirect`) never takes.
   */
  assignableFor(inboxId: number, opts?: { direct?: boolean; chatJid?: string }): DirectoryEntry[];
  /** Display name for a user id ("You" for the current user when `youLabel`). */
  nameOf(id: number | null | undefined, opts?: { youLabel?: boolean }): string | null;
}

/** Pure builder (exported for tests). */
export function buildDirectory(
  me: User | null,
  isAdmin: boolean,
  list: readonly DirectoryEntry[] | undefined,
  opts: {
    multiInbox?: boolean;
    /** Inbox id -> the AI agent that answers it (`Inbox.aiAgentId`); unknown = no AI offered. */
    inboxAgents?: ReadonlyMap<number, number | null>;
  } = {},
): Directory {
  const multiInbox = opts.multiInbox ?? false;
  const inboxAgents = opts.inboxAgents ?? new Map<number, number | null>();
  const mayAssign = (u: DirectoryEntry, inboxId: number, chatJid?: string) =>
    u.kind === 'ai'
      ? u.aiAgentId !== undefined && inboxAgents.get(inboxId) === u.aiAgentId
      : limited(u) && u.role !== 'admin'
        ? chatJid !== undefined && (u.chatJids ?? []).includes(chatJid)
        : canOpenInbox(u, inboxId, multiInbox);
  const byId = new Map<number, DirectoryEntry>();
  for (const u of list ?? []) byId.set(u.id, u);
  // Keep the directory's inbox list for the signed-in user (`/api/me` does not carry it).
  if (me)
    byId.set(me.id, {
      ...me,
      inboxIds: me.inboxIds ?? byId.get(me.id)?.inboxIds,
      chatJids: me.chatJids ?? byId.get(me.id)?.chatJids,
    });
  const assignable = [...byId.values()]
    .filter((u) => !u.disabled && !u.aiDeleted)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    me,
    isAdmin,
    byId,
    assignable,
    assignableFor: (inboxId, { direct = false, chatJid } = {}) =>
      assignable.filter((u) => mayAssign(u, inboxId, chatJid) && !(direct && u.aiNoDirect)),
    nameOf(id, opts) {
      if (id == null) return null;
      if (opts?.youLabel && me && id === me.id) return i18n.t('inbox:directory.you');
      const user = byId.get(id);
      return user
        ? user.kind === 'ai'
          ? i18n.t('inbox:directory.ai', { name: user.displayName })
          : user.displayName
        : i18n.t('inbox:directory.agent', { id });
    },
  };
}

/**
 * Team member lookup for the inbox. Admins use the full `GET /api/users`; every other role
 * uses the public `GET /api/users/directory` ({id, displayName, role, disabled}). Ids that are
 * still unknown render as "Agent #<id>".
 */
export function useDirectory(): Directory {
  const { user: me, isAdmin } = useAuth();
  // Rebuild on language change so "You" / "Agent #n" follow the UI language.
  const { i18n: active } = useTranslation();
  const language = active.language;
  const users = useUsers({ enabled: isAdmin });
  const directory = useUserDirectory({ enabled: !isAdmin && me != null });
  const list: readonly DirectoryEntry[] | undefined = isAdmin ? users.data : directory.data;
  const inboxes = useInboxes({ enabled: me != null });
  const multiInbox =
    (inboxes.data?.maxInboxes ?? 1) > 1 || (inboxes.data?.inboxes?.length ?? 0) > 1;
  const inboxList = inboxes.data?.inboxes;

  return useMemo(
    () =>
      buildDirectory(me, isAdmin, list, {
        multiInbox,
        inboxAgents: new Map((inboxList ?? []).map((i) => [i.id, i.aiAgentId])),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `language` invalidates localized labels
    [list, me, isAdmin, multiInbox, inboxList, language],
  );
}

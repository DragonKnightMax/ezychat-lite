import type { useTranslation } from 'react-i18next';
import type { GroupAdminCaps, GroupAdminResponse } from '@ezychat/shared';
import { ApiError, errorMessage } from '../api/client';
import { useGroupAdmin } from '../api/group-admin';

export type T = ReturnType<typeof useTranslation<'inbox'>>['t'];

/** Each refusal of the group routes in plain words; anything else falls back to the app's own text. */
const ERROR_KEYS = {
  wa_unavailable: 'groupAdmin.err.offline',
  not_group_admin: 'groupAdmin.err.notAdmin',
  already_member: 'groupAdmin.err.already',
  not_member: 'groupAdmin.err.notMember',
  not_on_whatsapp: 'groupAdmin.err.notOnWhatsApp',
  too_many_adds: 'groupAdmin.err.tooMany',
  cannot_change_owner: 'groupAdmin.err.owner',
  not_supported: 'groupAdmin.err.notSupported',
  group_full: 'groupAdmin.err.full',
  invite_expired: 'groupAdmin.err.inviteExpired',
  inbox_removed: 'groupAdmin.err.inboxRemoved',
  group_change_failed: 'groupAdmin.err.failed',
} as const;

export function groupAdminErrorText(err: unknown, t: T): string {
  if (err instanceof ApiError && Object.hasOwn(ERROR_KEYS, err.code))
    return t(ERROR_KEYS[err.code as keyof typeof ERROR_KEYS]);
  // rate_limited and network errors: the app's shared wording.
  return errorMessage(err);
}

/** Whether the connection lets EzyChat change anything in this group. */
export function hasAnyGroupCap(caps: GroupAdminCaps): boolean {
  return (
    caps.editInfo ||
    caps.addMembers ||
    caps.removeMembers ||
    caps.admins ||
    caps.inviteLink ||
    caps.resetInviteLink ||
    caps.joinRequests ||
    caps.settings.length > 0
  );
}

/** Why nothing can be changed right now: one reason, in this order. */
export type GroupAdminBlock = 'agent' | 'notAdmin' | 'offline' | null;

export function groupAdminBlock(view: GroupAdminResponse): GroupAdminBlock {
  if (!view.canManage) return 'agent';
  // Unknown role while connected = the number is not (or no longer) a group admin.
  if (view.myRole === 'member' || (view.myRole === null && view.online)) return 'notAdmin';
  if (!view.online) return 'offline';
  return null;
}

/** The admin view of a group, and whether this user may change it now. */
export function useGroupAdminState(jid: string) {
  const q = useGroupAdmin(jid);
  const view = q.data;
  const anyCap = !!view && hasAnyGroupCap(view.caps);
  const block = view ? groupAdminBlock(view) : null;
  return { view, anyCap, block, can: anyCap && block === null };
}

/** Members besides the business number (the count the Business API limit uses). */
export function othersCount(view: GroupAdminResponse, fallbackSize: number): number {
  const size = view.size ?? fallbackSize;
  return Math.max(0, size - (view.myRole ? 1 : 0));
}

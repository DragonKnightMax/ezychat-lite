import type { InboxCapabilities, Message } from '@ezychat/shared';

/** WhatsApp lets the sender edit a message for 15 minutes (the server checks it too). */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** WhatsApp lets the sender delete a message for everyone for about 2 days. */
export const DELETE_WINDOW_MS = 2 * 24 * 60 * 60_000;

/** What the signed-in user may do with one message now. */
export interface MessageRights {
  canEdit: boolean;
  /** Edit is shown but disabled: the 15 minutes are over. */
  editWindowClosed: boolean;
  canDeleteForEveryone: boolean;
  /** Delete for everyone is not offered any more: the 2 days are over. */
  deleteWindowClosed: boolean;
  canDeleteForMe: boolean;
}

export const NO_RIGHTS: MessageRights = Object.freeze({
  canEdit: false,
  editWindowClosed: false,
  canDeleteForEveryone: false,
  deleteWindowClosed: false,
  canDeleteForMe: false,
});

/**
 * The same rules as the server: only on a connection that can (linked phone), only messages the
 * team sent, by the teammate who sent it or an admin (messages from the phone or the AI agent:
 * admins only); text and captions only, within 15 minutes; delete for everyone within 2 days;
 * delete for me (hidden for the team) for admins, any message.
 */
export function messageRights(
  m: Message,
  user: { id: number; role: string } | null,
  caps: Pick<InboxCapabilities, 'editMessage' | 'deleteForEveryone' | 'deleteForMe'>,
  now: number,
): MessageRights {
  if (!user || m.type === 'system' || m.deletedAt != null || m.hidden) return NO_RIGHTS;
  const admin = user.role === 'admin';
  const canDeleteForMe = admin && !!caps.deleteForMe && !m.id.startsWith('local-');
  const own = m.fromMe && (admin || (m.sentByUserId !== null && m.sentByUserId === user.id));
  // Still sending (or failed before WhatsApp had it): nothing to change on WhatsApp yet.
  if (!own || m.id.startsWith('local-') || m.status === 'failed')
    return { ...NO_RIGHTS, canDeleteForMe };
  const age = now - m.timestamp;
  const editable = !!caps.editMessage && !m.template && (m.type === 'text' || !!m.body);
  return {
    canEdit: editable,
    editWindowClosed: editable && age > EDIT_WINDOW_MS,
    canDeleteForEveryone: !!caps.deleteForEveryone,
    deleteWindowClosed: !!caps.deleteForEveryone && age > DELETE_WINDOW_MS,
    canDeleteForMe,
  };
}

/** Anything to offer in the message's menu. */
export function hasActions(r: MessageRights): boolean {
  return r.canEdit || r.canDeleteForEveryone || r.canDeleteForMe;
}

/** Handlers and rights the conversation gives each bubble. */
export interface MessageChangeProps {
  rightsOf(m: Message): MessageRights;
  /** WhatsApp is not connected: every change waits. */
  disabledReason: string | null;
  onEdit(m: Message): void;
  onDelete(m: Message): void;
  /** Admins may read the original of a deleted message. */
  isAdmin: boolean;
}

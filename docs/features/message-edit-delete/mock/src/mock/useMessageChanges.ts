import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Message } from '@ezychat/shared';
import { api } from '@/api/client';

/** WhatsApp lets the sender edit a message for 15 minutes. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** WhatsApp lets the sender delete a message for everyone for about 2 days. */
export const DELETE_WINDOW_MS = 2 * 24 * 60 * 60_000;

export type ChangeBy = 'customer' | 'team' | 'phone';

export interface MessageEdit {
  previous: string;
  at: number;
  by: ChangeBy;
  name: string | null;
}

/** What the proposal adds to a message (the app will carry these fields on `Message`). */
export interface MessageChange {
  body?: string;
  editedAt?: number;
  edits: MessageEdit[];
  deletedAt?: number;
  deletedBy?: ChangeBy;
  deletedByName?: string | null;
  /** Admins only: the text before deletion. */
  original?: string | null;
  hiddenAt?: number;
}

interface ChangesResponse {
  now: number;
  offsetMinutes: number;
  changes: Record<string, MessageChange>;
}

const key = ['mock', 'messageChanges'] as const;

/**
 * Proposed (message-edit-delete): edits and deletes laid over the stored messages. The app will
 * send them on each message (`message:updated`); the mock asks its stand-in route and refreshes it
 * often so a change in another browser, or one the simulator makes, shows too.
 */
export function useMessageChanges() {
  return useQuery({
    queryKey: key,
    queryFn: () => api<ChangesResponse>('/mock/message-changes'),
    refetchInterval: 3_000,
  });
}

/** What the signed-in user may do with one message now. Reasons are i18n keys under `editDelete`. */
export interface MessageRights {
  canEdit: boolean;
  /** Why Edit is shown but disabled (time window), else null. */
  editBlocked: 'editWindow' | null;
  canDeleteForEveryone: boolean;
  deleteBlocked: 'deleteWindow' | null;
  canDeleteForMe: boolean;
}

export function messageRights(
  m: Message,
  change: MessageChange | undefined,
  user: { id: number; isAdmin: boolean } | null,
  now: number,
  /** The chat's inbox is a linked phone (Baileys). The WhatsApp Business API supports none of this. */
  linkedPhone: boolean,
): MessageRights {
  const none: MessageRights = {
    canEdit: false,
    editBlocked: null,
    canDeleteForEveryone: false,
    deleteBlocked: null,
    canDeleteForMe: false,
  };
  if (
    !linkedPhone ||
    !user ||
    m.type === 'system' ||
    m.id.startsWith('local-') ||
    change?.deletedAt
  )
    return none;
  const canDeleteForMe = user.isAdmin;
  // The teammate who sent it, or an admin (messages from the phone or the AI agent: admins only).
  const own = m.fromMe && (user.isAdmin || (m.sentByUserId !== null && m.sentByUserId === user.id));
  if (!own || m.status === 'failed') return { ...none, canDeleteForMe };
  const age = now - m.timestamp;
  const editable = m.type === 'text' || !!m.body;
  return {
    canEdit: editable,
    editBlocked: editable && age > EDIT_WINDOW_MS ? 'editWindow' : null,
    canDeleteForEveryone: true,
    deleteBlocked: age > DELETE_WINDOW_MS ? 'deleteWindow' : null,
    canDeleteForMe,
  };
}

export function useEditMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      api<MessageChange>(`/mock/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { text },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteMessage() {
  const { t } = useTranslation('inbox');
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scope }: { id: string; scope: 'everyone' | 'me' }) =>
      api<MessageChange>(`/mock/messages/${encodeURIComponent(id)}/delete`, { body: { scope } }),
    onSuccess: (_data, { scope }) => {
      void qc.invalidateQueries({ queryKey: key });
      toast.success(
        t(scope === 'me' ? 'editDelete.deletedForMe' : 'editDelete.deletedForEveryone'),
      );
    },
    onError: (err) =>
      toast.error(t('editDelete.notDeleted'), { description: (err as Error).message }),
  });
}

/** Mock only: incoming edits and deletes, the clock, and a reset. */
export function useMessageChangeSimulator() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: key });
  return {
    simulate: (chatJid: string, action: string) =>
      api('/mock/message-changes/simulate', { body: { chatJid, action } }).then(done),
    clock: (offsetMinutes: number) =>
      api('/mock/message-changes/clock', { body: { offsetMinutes } }).then(done),
    reset: () => api('/mock/message-changes/reset', { body: {} }).then(done),
  };
}

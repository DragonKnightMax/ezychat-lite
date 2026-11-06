import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  NewChatBodyInput,
  NewChatCheckResponse,
  NewChatResponse,
  NewChatSettingsBody,
  NewChatStatus,
} from '@ezychat/shared';
import { api } from './client';
import { qk } from './queries';

/** New chat (docs/features/new-chat/design.md). */
export const newChatKey = ['new-chat'] as const;

/** May the signed-in user start new chats, from which inboxes, and the team's settings. */
export function useNewChatStatus(enabled = true) {
  return useQuery({
    queryKey: newChatKey,
    queryFn: ({ signal }) => api<NewChatStatus>('/new-chat', { signal }),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** Admins: the team-members switch and the daily limit (each audited before/after). */
export function useUpdateNewChatSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewChatSettingsBody) =>
      api<NewChatStatus>('/new-chat/settings', { method: 'PUT', body }),
    onSuccess: (data) => qc.setQueryData(newChatKey, data),
  });
}

/** Format, own number and an existing chat: never asks WhatsApp, not counted. */
export function useCheckNewChat() {
  return useMutation({
    mutationFn: ({ inboxId, phone }: { inboxId: number; phone: string }) =>
      api<NewChatCheckResponse>(`/inboxes/${inboxId}/new-chat/check`, {
        method: 'POST',
        body: { phone },
      }),
  });
}

/** Start: checks the number on WhatsApp, or sends the first template (Business API). */
export function useStartNewChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ inboxId, body }: { inboxId: number; body: NewChatBodyInput }) =>
      api<NewChatResponse>(`/inboxes/${inboxId}/new-chat`, { method: 'POST', body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: newChatKey });
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
    },
  });
}

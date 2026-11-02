import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageEditsResponse, MessageSchema, type Message } from '@ezychat/shared';
import { api } from './client';
import { upsertMessageInCache } from './queries';

/**
 * Edit and delete sent messages (design docs/features/message-edit-delete/design.md). The answer
 * carries the changed message; `message:updated` brings the same message to every teammate.
 */
export const messageEditsKey = (id: string) => ['message-edits', id] as const;

/** Earlier versions of a message (and, for admins, the original of a deleted one). */
export function useMessageEdits(id: string, enabled: boolean) {
  return useQuery({
    queryKey: messageEditsKey(id),
    queryFn: ({ signal }) =>
      api(`/messages/${encodeURIComponent(id)}/edits`, { signal, schema: MessageEditsResponse }),
    enabled,
  });
}

export function useEditMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; text: string }) =>
      api(`/messages/${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        body: { text: input.text },
        schema: MessageSchema,
      }),
    onSuccess: (m: Message) => {
      upsertMessageInCache(qc, m);
      void qc.invalidateQueries({ queryKey: messageEditsKey(m.id) });
    },
  });
}

export function useDeleteMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; scope: 'everyone' | 'me' }) =>
      api(`/messages/${encodeURIComponent(input.id)}?scope=${input.scope}`, {
        method: 'DELETE',
        schema: MessageSchema,
      }),
    onSuccess: (m: Message) => upsertMessageInCache(qc, m),
  });
}

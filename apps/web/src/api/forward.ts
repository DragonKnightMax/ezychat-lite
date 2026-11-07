import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ForwardMessageResponse, type ForwardMessageBody } from '@ezychat/shared';
import { api } from './client';
import { qk, upsertMessageInCache } from './queries';

/**
 * Forward one message to 1–5 existing chats (docs/features/forward-message/design.md). The server
 * checks every chat before anything is sent and answers the copies, one per chat.
 */
export function useForwardMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ForwardMessageBody }) =>
      api(`/messages/${encodeURIComponent(id)}/forward`, {
        method: 'POST',
        body,
        schema: ForwardMessageResponse,
      }),
    onSuccess: (res, { body }) => {
      for (const m of res.messages) upsertMessageInCache(qc, m);
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
      for (const jid of body.to) void qc.invalidateQueries({ queryKey: qk.messages(jid) });
    },
  });
}

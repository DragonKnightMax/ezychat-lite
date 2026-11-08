// Proposed (mobile-redesign, owner 2026-11-07): tags on group chats. In the app a group's tags come
// on `Chat.tags` like a direct chat's (the read model stops hiding them) and are saved with
// `PUT /api/chats/:jid/tags`; the mock reads them from GET /api/mock/group-tags and saves them with
// PUT /api/mock/group-tags/:jid (the runner writes the real `customer_tags` table, so the server's
// tag filter, search and suggestions include them).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Chat } from '@ezychat/shared';
import { api } from '../api/client';
import { qk } from '../api/queries';
import { encodeJid } from '../lib/jid';

export const groupTagsKey = ['mock', 'group-tags'] as const;

export function useGroupTags() {
  return useQuery({
    queryKey: groupTagsKey,
    queryFn: () => api<Record<string, string[]>>('/mock/group-tags'),
    staleTime: 10_000,
  });
}

/** A chat's tags, direct chat or group: one rule for every screen that shows tags. */
export function useChatTags(chat: Pick<Chat, 'jid' | 'type' | 'tags'>): string[] {
  const groups = useGroupTags();
  return chat.type === 'group' ? (groups.data?.[chat.jid] ?? []) : (chat.tags ?? []);
}

export function useSaveGroupTags(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tags: string[]) =>
      api<{ tags: string[] }>(`/mock/group-tags/${encodeJid(jid)}`, {
        method: 'PUT',
        body: { tags },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groupTagsKey });
      void qc.invalidateQueries({ queryKey: ['customer-tags'] });
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
    },
  });
}

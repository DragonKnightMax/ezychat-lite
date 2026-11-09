import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api/client';

/** Which teammate sent the linked number's current reaction to a message (mock route). */
export interface TeamReaction {
  userId: number;
  name: string;
  emoji: string;
  at: number;
}

const teamKey = ['mock', 'teamReactions'] as const;

/**
 * Proposed (send-reactions): the names behind the linked number's reactions. The app will carry
 * them on each reaction from the server; the mock asks its stand-in route and refreshes it often
 * so a teammate's reaction in another browser is named too.
 */
export function useTeamReactions() {
  return useQuery({
    queryKey: teamKey,
    queryFn: () => api<Record<string, TeamReaction>>('/mock/react'),
    refetchInterval: 4_000,
  });
}

/**
 * Proposed (send-reactions): send the linked number's reaction ('' removes it). The badge
 * itself updates through the normal `message:reactions` event when WhatsApp confirms it.
 */
export function useSendReaction() {
  const { t } = useTranslation('inbox');
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { messageId: string; emoji: string }) =>
      api<{ messageId: string; emoji: string; at: number }>('/mock/react', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKey }),
    onError: (err) =>
      toast.error(t('message.reactions.notSent'), { description: (err as Error).message }),
  });
}

/** Proposed (send-reactions): take the fake phone offline and back (mock-only). */
export function setMockWaOffline(offline: boolean) {
  return api<{ state: string }>('/mock/wa-offline', { body: { offline } });
}

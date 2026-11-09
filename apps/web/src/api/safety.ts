import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SafetyChatState,
  SafetyReport,
  SafetySettings,
  SafetyState,
  type ReportPeriod,
  type SafetyAction,
  type SafetyActionBody,
  type SafetyChatAction,
} from '@ezychat/shared';
import { api } from './client';

/**
 * WhatsApp Safety (docs/features/whatsapp-safety/design.md): Admin → Safety, the chat bar and
 * Admin → Reports → WhatsApp Safety. A message's own finding comes with the message (`safety`).
 */
export const safetyKeys = {
  state: ['safety'] as const,
  chat: (jid: string) => ['safety', 'chat', jid] as const,
  report: (days: ReportPeriod, inbox: number | null = null) =>
    ['safety', 'report', days, inbox] as const,
};

export function useSafety() {
  return useQuery({
    queryKey: safetyKeys.state,
    queryFn: ({ signal }) => api('/safety', { schema: SafetyState, signal }),
    refetchInterval: 30_000,
  });
}

export function useSafetyChat(jid: string) {
  return useQuery({
    queryKey: safetyKeys.chat(jid),
    queryFn: ({ signal }) =>
      api(`/safety/chats/${encodeURIComponent(jid)}`, { schema: SafetyChatState, signal }),
    refetchInterval: 30_000,
  });
}

/** `inbox` null = every inbox together. */
export function useSafetyReport(days: ReportPeriod, inbox: number | null = null) {
  const scope = inbox === null ? '' : `&inbox=${inbox}`;
  return useQuery({
    queryKey: safetyKeys.report(days, inbox),
    queryFn: ({ signal }) =>
      api(`/reports/safety?days=${days}${scope}`, { schema: SafetyReport, signal }),
    staleTime: 60_000,
  });
}

export function useSafetySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<SafetySettings>) =>
      api('/safety/settings', { method: 'PUT', body, schema: SafetySettings }),
    onSuccess: () => qc.invalidateQueries({ queryKey: safetyKeys.state }),
  });
}

export function useSafetyAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body = {},
    }: {
      id: number;
      action: SafetyAction;
      body?: SafetyActionBody;
    }) => api(`/safety/items/${id}/${action}`, { method: 'POST', body, schema: SafetyState }),
    onSuccess: (state) => {
      qc.setQueryData(safetyKeys.state, state);
      // The chat bars and the report follow (blocked, reported).
      void qc.invalidateQueries({ queryKey: ['safety'] });
    },
  });
}

/** Admins: block or unblock any direct chat's number (the Customer panel), flagged or not. */
export function useSafetyChatAction(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, spam }: { action: SafetyChatAction; spam?: boolean }) =>
      api(`/safety/chats/${encodeURIComponent(jid)}/${action}`, {
        method: 'POST',
        body: action === 'block' ? { spam: spam === true } : {},
        schema: SafetyChatState,
      }),
    onSuccess: (state) => {
      qc.setQueryData(safetyKeys.chat(jid), state);
      // Admin → Safety (blocked numbers) and the report follow.
      void qc.invalidateQueries({ queryKey: ['safety'] });
    },
  });
}

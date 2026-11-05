import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Proposed (reports): the shape of the future `GET /api/reports?days=` (see ../../reports.ts). */
export interface ReportTotals {
  newCustomers: number;
  messagesIn: number;
  messagesOut: number;
  activeChats: number;
  medianFirstReplyMinutes: number | null;
  missedLeads: number;
  waitingAfterHandoff: number;
  oldestWaitingAt: number | null;
  aiAnswered: number;
  aiResolved: number;
  aiHandoffs: number;
}

export interface ReportDay {
  date: string;
  inbound: number;
  outbound: number;
  newCustomers: number;
  activeChats: number;
}

export interface Report {
  days: ReportPeriod;
  timeZone: string;
  firstDate: string | null;
  historyImportedUntil: string | null;
  totals: ReportTotals;
  previous: ReportTotals | null;
  daily: ReportDay[];
  weekdays: Array<{ weekday: number; avgInbound: number; avgChats: number }>;
  hours: number[][];
  handoffReasons: Array<{ reason: string; count: number }>;
  team: Array<{
    name: string;
    kind: 'human' | 'ai';
    chats: number;
    replies: number;
    medianReplyMinutes: number | null;
  }>;
}

export type ReportPeriod = 7 | 30 | 90;
export type MockReportScenario = 'normal' | 'short' | 'empty' | 'slow' | 'error';

export function useReport(days: ReportPeriod) {
  return useQuery({
    queryKey: ['mock', 'reports', days],
    queryFn: () => api<Report>(`/mock/reports?days=${days}`),
    retry: false,
  });
}

export function useReportScenario() {
  return useQuery({
    queryKey: ['mock', 'reports', 'scenario'],
    queryFn: () => api<{ scenario: MockReportScenario }>('/mock/reports/scenario'),
  });
}

export function useSetReportScenario() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (scenario: MockReportScenario) =>
      api<{ scenario: MockReportScenario }>('/mock/reports/scenario', {
        method: 'PUT',
        body: { scenario },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['mock', 'reports'] }),
  });
}

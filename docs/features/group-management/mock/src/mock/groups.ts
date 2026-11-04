import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { useShownAgents } from './useAgents';
import { inboxOfChat, useMockInboxes } from './inboxes';
import type { MockAgent } from './agents';

/**
 * Proposed (ai-groups), mock only: whether an AI agent answers in WhatsApp groups when mentioned,
 * and in which groups, as the stand-in routes `/api/mock/groups*` serve it (../../groups.ts).
 * Production: a per-agent setting, a per-group setting and the loop guard on the server.
 */
export interface MockGroupRow {
  jid: string;
  name: string;
  size: number | null;
  enabled: boolean;
  /** AI answers since the last teammate message (the loop guard counts these). */
  inRow: number;
  paused: boolean;
  demo: boolean;
}

export interface MockGroupNotification {
  agent: string;
  group: string;
  member: string;
  question: string;
  to: string | null;
  at: number;
}

export interface MockGroupsView {
  agents: Record<string, boolean>;
  loopGuardAnswers: number;
  loopGuard: boolean;
  viewAs: 'admin' | 'agent';
  notification: MockGroupNotification | null;
  groups: MockGroupRow[];
}

export type SimulateKind = 'question' | 'followUp' | 'unrelated' | 'handover' | 'teammate';
export type SimulateOutcome = 'answered' | 'handover' | 'paused' | 'off' | 'silent' | 'teammate';

const key = ['mock', 'groups'] as const;

export function useMockGroups() {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<MockGroupsView>('/mock/groups', { signal }),
  });
}

function useGroupsMutation<I>(fn: (input: I) => Promise<MockGroupsView>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (view) => client.setQueryData(key, view),
  });
}

export function useSetAnswerInGroups() {
  return useGroupsMutation((input: { agentId: string; enabled: boolean }) =>
    api<MockGroupsView>(`/mock/groups/agents/${encodeURIComponent(input.agentId)}`, {
      method: 'PUT',
      body: { enabled: input.enabled },
    }),
  );
}

export function useSetGroupAnswers() {
  return useGroupsMutation((input: { jid: string; enabled: boolean }) =>
    api<MockGroupsView>(`/mock/groups/chats/${encodeURIComponent(input.jid)}`, {
      method: 'PUT',
      body: { enabled: input.enabled },
    }),
  );
}

export function useGroupsScenario() {
  return useGroupsMutation(
    (input: { loopGuard?: boolean; viewAs?: 'admin' | 'agent'; reset?: boolean }) =>
      api<MockGroupsView>('/mock/groups/scenario', { method: 'PUT', body: input }),
  );
}

export function useSimulateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { jid: string; kind: SimulateKind }) =>
      api<{ outcome: SimulateOutcome; view: MockGroupsView }>('/mock/groups/simulate', {
        method: 'POST',
        body: input,
      }),
    onSuccess: (data) => client.setQueryData(key, data.view),
  });
}

export interface GroupAiState {
  row: MockGroupRow | undefined;
  /** The agent of the group's inbox (none: no agent answers there). */
  agent: MockAgent | undefined;
  /** The agent's "Answer in groups" switch. */
  agentOn: boolean;
  /** The AI answers mentions in this group now. */
  active: boolean;
  /** Admins switch groups; agents (and the mock's agent view) only see the state. */
  canEdit: boolean;
  view: MockGroupsView | undefined;
}

/** Everything a group screen needs: the group's row, its inbox's agent and who may change it. */
export function useGroupAi(jid: string): GroupAiState {
  const q = useMockGroups();
  const inboxes = useMockInboxes();
  const { agents } = useShownAgents();
  const { user } = useAuth();
  const inbox = inboxOfChat(inboxes, jid);
  const agent = inbox ? agents.find((a) => a.inboxId === inbox.id) : undefined;
  const row = q.data?.groups.find((g) => g.jid === jid);
  const agentOn = Boolean(agent && q.data?.agents[agent.id]);
  return {
    row,
    agent,
    agentOn,
    active: Boolean(row?.enabled && agentOn),
    canEdit: user?.role === 'admin' && q.data?.viewAs !== 'agent',
    view: q.data,
  };
}

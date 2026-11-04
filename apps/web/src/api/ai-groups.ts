import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AiAgentGroups,
  AiGroupChat,
  type AiAgentDirectBody,
  type AiAgentGroupChatsBody,
  type AiGroupChatBody,
} from '@ezychat/shared';
import { api } from './client';
import { qk } from './queries';

/**
 * AI agents in WhatsApp groups (design docs/features/ai-groups/design.md): the agent's "Answer in
 * groups" switch with the groups of its inbox (admins), and each group's own switch.
 */
export const aiGroupsKey = ['ai-groups'] as const;
export const agentGroupsKey = (agentId: number) => [...aiGroupsKey, 'agent', agentId] as const;
export const groupChatAiKey = (jid: string) => [...aiGroupsKey, 'chat', jid] as const;

export function useAgentGroups(agentId: number) {
  return useQuery({
    queryKey: agentGroupsKey(agentId),
    queryFn: ({ signal }) => api(`/ai/agents/${agentId}/groups`, { signal, schema: AiAgentGroups }),
  });
}

export function useSetAnswerInGroups(agentId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/ai/agents/${agentId}/groups`, {
        method: 'PUT',
        body: { enabled },
        schema: AiAgentGroups,
      }),
    onSuccess: (saved) => {
      qc.setQueryData(agentGroupsKey(agentId), saved);
      void qc.invalidateQueries({ queryKey: [...aiGroupsKey, 'chat'] });
    },
  });
}

/**
 * "Answer direct chats" (design docs/features/ai-direct-chats/design.md): off makes a group-only
 * agent. The team directory follows (`aiNoDirect` leaves the agent out of direct-chat assignment).
 */
export function useSetAnswerDirect(agentId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/ai/agents/${agentId}/direct`, {
        method: 'PUT',
        body: { enabled } satisfies AiAgentDirectBody,
        schema: AiAgentGroups,
      }),
    onSuccess: (saved) => {
      qc.setQueryData(agentGroupsKey(agentId), saved);
      void qc.invalidateQueries({ queryKey: qk.directory });
    },
  });
}

/**
 * Gives groups of the agent's inbox to this agent (with or without "Reads every message") or takes
 * them back. A group another agent holds answers 409 `group_has_agent`.
 */
export function useSetAgentGroupChats(agentId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AiAgentGroupChatsBody) =>
      api(`/ai/agents/${agentId}/group-chats`, {
        method: 'PUT',
        body,
        schema: AiAgentGroups,
      }),
    onSuccess: (saved, body) => {
      qc.setQueryData(agentGroupsKey(agentId), saved);
      // Other agents' lists and each group's Group info follow.
      void qc.invalidateQueries({
        queryKey: [...aiGroupsKey, 'agent'],
        predicate: (q) => q.queryKey[2] !== agentId,
      });
      for (const jid of body.jids) void qc.invalidateQueries({ queryKey: groupChatAiKey(jid) });
    },
  });
}

/** Whether the AI answers tags and quotes in this group (anyone who may open the chat). */
export function useGroupChatAi(jid: string | null) {
  return useQuery({
    queryKey: groupChatAiKey(jid ?? ''),
    queryFn: ({ signal }) =>
      api(`/chats/${encodeURIComponent(jid ?? '')}/ai-group`, { signal, schema: AiGroupChat }),
    enabled: jid !== null,
    retry: false,
  });
}

/** Admins: switch one group on or off, choose its agent and "Reads every message" (Group info). */
export function useSetGroupChatAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jid, enabled, agentId, listen }: AiGroupChatBody & { jid: string }) =>
      api(`/chats/${encodeURIComponent(jid)}/ai-group`, {
        method: 'PUT',
        body: {
          enabled,
          ...(agentId !== undefined && { agentId }),
          ...(listen !== undefined && { listen }),
        } satisfies AiGroupChatBody,
        schema: AiGroupChat,
      }),
    onSuccess: (saved, { jid }) => {
      qc.setQueryData(groupChatAiKey(jid), saved);
      // The agent pages list the groups each agent holds: read them again.
      void qc.invalidateQueries({ queryKey: [...aiGroupsKey, 'agent'] });
    },
  });
}

/**
 * Makes a newly created agent a group agent (a template such as Claims): Answer in groups on, then
 * Answer direct chats off. Only for an agent that holds no chats yet, so nothing is released.
 */
export function useMakeGroupAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: number) => {
      await api(`/ai/agents/${agentId}/groups`, {
        method: 'PUT',
        body: { enabled: true },
        schema: AiAgentGroups,
      });
      return api(`/ai/agents/${agentId}/direct`, {
        method: 'PUT',
        body: { enabled: false } satisfies AiAgentDirectBody,
        schema: AiAgentGroups,
      });
    },
    onSuccess: (saved, agentId) => {
      qc.setQueryData(agentGroupsKey(agentId), saved);
      void qc.invalidateQueries({ queryKey: qk.directory });
    },
  });
}

// Proposed (custom-agents), mock only: the agents as the screens show them. The agent on inbox 1 IS the
// server's AI member (production: agent 1 keeps the existing AI member), so its name and on/off come from
// the server and every change to them goes to the server too. The chats, the Getting started card and
// the setup wizard's AI assistant step (which read the server) then agree with the agent pages.
import { AiMemberBody } from '@ezychat/shared';
import { useAiMember, useAiMemberAction } from '../api/ai';
import { useMockEdition } from './edition';
import { useMockInboxes } from './inboxes';
import { updateAgent, useMockAgents, visibleAgents, type MockAgent } from './agents';

export interface ShownAgents {
  /** Every agent, with the server's name and on/off on the inbox-1 agent. */
  agents: MockAgent[];
  /** The agents of this edition view (Lite: exactly one, bound to inbox 1). */
  shown: MockAgent[];
  firstInboxId: string | null;
  lite: boolean;
}

export function useShownAgents(): ShownAgents {
  const { agents: stored } = useMockAgents();
  const { inboxes } = useMockInboxes();
  const lite = useMockEdition() === 'lite';
  const status = useAiMember().data;
  const firstInboxId = inboxes[0]?.id ?? null;
  const agents = stored.map((agent) =>
    status && firstInboxId && agent.inboxId === firstInboxId
      ? {
          ...agent,
          name: status.settings.displayName,
          enabled: Boolean(status.member && !status.member.disabled),
        }
      : agent,
  );
  return { agents, shown: visibleAgents(agents, lite, firstInboxId), firstInboxId, lite };
}

/**
 * Saves an agent's name and/or on/off. For the agent on inbox 1 the server's AI member is saved first
 * (its own instructions and hand-off rules stay as they are); the mock store follows only on success.
 */
export function useSaveAgentMember() {
  const status = useAiMember().data;
  const action = useAiMemberAction();
  const { inboxes } = useMockInboxes();
  const firstInboxId = inboxes[0]?.id ?? null;
  const save = async (
    agent: MockAgent,
    inboxId: string | null,
    patch: Partial<Omit<MockAgent, 'id' | 'items'>>,
  ): Promise<void> => {
    if (status && firstInboxId && inboxId === firstInboxId) {
      const body = AiMemberBody.parse({
        displayName: patch.name ?? agent.name,
        instructions: status.settings.instructions,
        handoffRules: status.settings.handoffRules,
        enabled: patch.enabled ?? agent.enabled,
      });
      await action.mutateAsync({ kind: 'save', settings: body });
    }
    updateAgent(agent.id, patch);
  };
  return { save, isPending: action.isPending };
}

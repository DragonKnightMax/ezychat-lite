import { describe, expect, it } from 'vitest';
import type { AiAgentSummary } from '@ezychat/shared';
import { aiAgentsPath } from './agent-path';

const agent = (id: number): AiAgentSummary => ({
  id,
  userId: id + 10,
  displayName: `Agent ${id}`,
  enabled: false,
  preset: 'sales',
  inboxId: null,
  documentCount: 0,
  answerDirect: true,
  groupCount: 0,
});

describe('aiAgentsPath', () => {
  it('opens a new agent while there is none', () => {
    expect(aiAgentsPath({ agents: [] })).toBe('/admin/members/ai/new');
  });

  it('opens the only agent', () => {
    expect(aiAgentsPath({ agents: [agent(4)] })).toBe('/admin/members/ai/4');
  });

  it('lists several agents on Members', () => {
    expect(aiAgentsPath({ agents: [agent(1), agent(2)] })).toBe('/admin/members');
  });
});

import { describe, expect, it } from 'vitest';
import {
  AI_AGENT_PRESETS,
  AI_INTERNAL_CHARACTERS,
  AiAgentBody,
  AiAgentPreset,
  AiAgentStatus,
  AiAgentSummary,
  AiContextPatchBody,
  AiContextTextBody,
  AiDocument,
  AiEditBody,
  AiHandoffReason,
  AiStatus,
  AiTryBody,
  DEFAULT_AI_HANDOFF_RULES,
  DEFAULT_AI_INSTRUCTIONS,
  presetTexts,
} from './ai.js';
import { CreateInboxBody, DirectoryUserSchema, InboxSchema, UpdateInboxBody } from './inboxes.js';
import {
  McpGetAiAgentSetupInput,
  McpGetAiContextItemInput,
  McpGetAiSetupHistoryInput,
  McpListAiAgentsInput,
  McpTryAiReplyInput,
  McpUpdateAiSetupInput,
} from './mcp.js';
import { UserSchema } from './models.js';

const summary = {
  id: 1,
  userId: 7,
  displayName: 'Ava',
  enabled: true,
  preset: 'sales' as const,
  inboxId: 1,
  documentCount: 2,
  answerDirect: true,
  groupCount: 0,
};
const doc = {
  id: 3,
  name: 'Prices',
  kind: 'text' as const,
  size: 10,
  characters: 10,
  createdAt: 1,
  updatedAt: 1,
  internal: true,
};
const settings = {
  displayName: 'Ava',
  enabled: true,
  mode: 'api' as const,
  model: '',
  instructions: '',
  handoffRules: '',
};

describe('agent presets', () => {
  it('sales is the existing default texts', () => {
    expect(presetTexts('sales')).toEqual({
      instructions: DEFAULT_AI_INSTRUCTIONS,
      handoffRules: DEFAULT_AI_HANDOFF_RULES,
    });
    expect(AI_AGENT_PRESETS.sales.instructions).toBe(DEFAULT_AI_INSTRUCTIONS);
  });

  it('custom starts blank', () => {
    expect(presetTexts('custom')).toEqual({ instructions: '', handoffRules: '' });
  });

  it('faq is a help desk, not a sales text', () => {
    // The confirmed mock text names sales only to forbid it ("no sales language").
    expect(
      AI_AGENT_PRESETS.faq.instructions.toLowerCase().replace('no sales language', ''),
    ).not.toContain('sales');
    expect(AI_AGENT_PRESETS.faq.instructions).not.toBe(DEFAULT_AI_INSTRUCTIONS);
    expect(AI_AGENT_PRESETS.faq.instructions).toMatch(/^ROLE\n/);
    expect(AI_AGENT_PRESETS.faq.instructions).toContain('You do not sell');
    expect(AI_AGENT_PRESETS.faq.handoffRules).toContain('appointment');
    expect(presetTexts('faq')).toEqual(AI_AGENT_PRESETS.faq);
  });

  it('accepts only known presets', () => {
    expect(AiAgentPreset.options).toEqual(['sales', 'faq', 'custom']);
    expect(AiAgentPreset.safeParse('support').success).toBe(false);
  });
});

describe('agent bodies', () => {
  const body = { displayName: 'Ava', enabled: true, instructions: 'Hi', handoffRules: '' };

  it('keeps the member text limits', () => {
    expect(AiAgentBody.parse(body)).toEqual(body);
    expect(AiAgentBody.safeParse({ ...body, instructions: 'x'.repeat(8001) }).success).toBe(false);
    expect(AiAgentBody.safeParse({ ...body, instructions: 'x'.repeat(8000) }).success).toBe(true);
    expect(AiAgentBody.safeParse({ ...body, handoffRules: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('takes an optional preset and a nullable positive inbox id', () => {
    expect(AiAgentBody.parse({ ...body, preset: 'faq', inboxId: null })).toMatchObject({
      preset: 'faq',
      inboxId: null,
    });
    expect(AiAgentBody.safeParse({ ...body, inboxId: 0 }).success).toBe(false);
    expect(AiAgentBody.safeParse({ ...body, preset: 'other' }).success).toBe(false);
  });

  it('describes an agent and its status', () => {
    expect(AiAgentSummary.parse(summary)).toEqual(summary);
    expect(AiAgentSummary.safeParse({ ...summary, inboxId: undefined }).success).toBe(false);
    // older servers: a direct agent without groups
    const { answerDirect: _direct, groupCount: _groups, ...old } = summary;
    expect(AiAgentSummary.parse(old)).toMatchObject({ answerDirect: true, groupCount: 0 });
    const status = { agent: summary, settings, documents: [doc] };
    expect(AiAgentStatus.parse(status)).toEqual(status);
  });

  it('adds the agent list and limit to the AI status', () => {
    const status = {
      member: null,
      settings,
      hasApiKey: false,
      hasClaudeApiKey: false,
      connection: { state: 'signed_out', loginUrl: null, error: null },
      documents: [],
      agents: [summary],
      maxAgents: 1,
    };
    expect(AiStatus.parse(status)).toEqual(status);
    // An answer from an older server (or a test double) without agents still parses: no agents, limit 1.
    const { agents: _agents, maxAgents: _max, ...old } = status;
    expect(AiStatus.parse(old)).toMatchObject({ agents: [], maxAgents: 1 });
  });
});

describe('internal items', () => {
  it('documents carry internal', () => {
    expect(AiDocument.parse(doc).internal).toBe(true);
    // Without the flag (an older server) an item is customer-facing.
    const { internal: _internal, ...noFlag } = doc;
    expect(AiDocument.parse(noFlag).internal).toBe(false);
  });

  it('text and patch bodies take internal', () => {
    expect(AiContextTextBody.parse({ name: 'n', text: 't', internal: true }).internal).toBe(true);
    expect(AiContextTextBody.parse({ name: 'n', text: 't' }).internal).toBeUndefined();
    expect(AiContextPatchBody.parse({ internal: true })).toEqual({ internal: true });
    expect(AiContextPatchBody.parse({ internal: false })).toEqual({ internal: false });
    expect(AiContextPatchBody.safeParse({}).success).toBe(false);
  });

  it('caps internal items at 10,000 characters', () => {
    expect(AI_INTERNAL_CHARACTERS).toBe(10_000);
  });
});

describe('try, edit and hand-over', () => {
  const knowledge = { displayName: 'Ava', instructions: '', handoffRules: '' };

  it('Try it takes an optional agent id', () => {
    expect(AiTryBody.parse({ question: 'q', knowledge, agentId: 2 }).agentId).toBe(2);
    expect(AiTryBody.parse({ question: 'q', knowledge }).agentId).toBeUndefined();
    expect(AiTryBody.safeParse({ question: 'q', knowledge, agentId: 0 }).success).toBe(false);
  });

  it('Edit with AI takes an optional preset', () => {
    const edit = { field: 'instructions', current: '', request: 'shorter' };
    expect(AiEditBody.parse({ ...edit, preset: 'faq' }).preset).toBe('faq');
    expect(AiEditBody.parse(edit).preset).toBeUndefined();
  });

  it('knows the confidential leak hand-over', () => {
    expect(AiHandoffReason.parse('confidential_leak')).toBe('confidential_leak');
  });
});

describe('inbox and user binding', () => {
  it('inboxes name their agent', () => {
    const inbox = {
      id: 1,
      name: 'Sales',
      tone: 'primary',
      number: null,
      status: { state: 'disconnected', me: null, qr: null, lastError: null },
      removed: false,
    };
    expect(InboxSchema.parse({ ...inbox, aiAgentId: 2 }).aiAgentId).toBe(2);
    expect(InboxSchema.parse({ ...inbox, aiAgentId: null }).aiAgentId).toBeNull();
    // An older server sends no aiAgentId: no AI agent.
    expect(InboxSchema.parse(inbox).aiAgentId).toBeNull();
    expect(UpdateInboxBody.parse({ aiAgentId: null })).toEqual({ aiAgentId: null });
    expect(UpdateInboxBody.parse({ aiAgentId: 3 })).toEqual({ aiAgentId: 3 });
    expect(UpdateInboxBody.safeParse({ aiAgentId: 0 }).success).toBe(false);
    expect(CreateInboxBody.parse({ name: 'B', aiAgentId: 2 }).aiAgentId).toBe(2);
    expect(CreateInboxBody.parse({ name: 'B', aiAgentId: null }).aiAgentId).toBeNull();
    expect(CreateInboxBody.safeParse({ name: 'B', aiAgentId: 0 }).success).toBe(false);
    expect(UpdateInboxBody.safeParse({}).success).toBe(false);
  });

  it('users keep aiRole and gain aiAgentId', () => {
    expect(UserSchema.shape.aiAgentId.parse(4)).toBe(4);
    expect(UserSchema.shape.aiRole.parse('sales')).toBe('sales');
    expect(
      DirectoryUserSchema.parse({
        id: 1,
        displayName: 'Ava',
        role: 'agent',
        disabled: false,
        kind: 'ai',
        aiRole: 'sales',
        aiAgentId: 1,
        inboxIds: 'all',
      }).aiAgentId,
    ).toBe(1);
  });
});

describe('MCP inputs', () => {
  it('Try reply accepts agentId and still rejects unknown keys', () => {
    expect(McpTryAiReplyInput.parse({ message: 'hi', agentId: 2 }).agentId).toBe(2);
    expect(McpTryAiReplyInput.safeParse({ message: 'hi', other: 1 }).success).toBe(false);
    expect(
      McpTryAiReplyInput.safeParse({ message: 'hi', instructions: 'x'.repeat(8001) }).success,
    ).toBe(false);
    expect(
      McpTryAiReplyInput.safeParse({ message: 'hi', handoffRules: 'x'.repeat(4001) }).success,
    ).toBe(false);
  });

  it('every AI-setup input takes an optional agentId', () => {
    expect(McpGetAiAgentSetupInput.parse({ agentId: 2 })).toEqual({ agentId: 2 });
    expect(McpGetAiAgentSetupInput.parse({})).toEqual({});
    expect(McpGetAiContextItemInput.parse({ id: 1, agentId: 2 }).agentId).toBe(2);
    expect(McpGetAiSetupHistoryInput.parse({ target: 'instructions', agentId: 2 }).agentId).toBe(2);
    const update = McpUpdateAiSetupInput.parse({
      target: 'context_text',
      name: 'Costs',
      text: 'x',
      reason: 'add costs',
      agentId: 2,
      internal: true,
    });
    expect(update).toMatchObject({ agentId: 2, internal: true });
    expect(McpGetAiAgentSetupInput.safeParse({ agentId: 0 }).success).toBe(false);
  });

  it('list_ai_agents takes no input', () => {
    expect(McpListAiAgentsInput.parse({})).toEqual({});
    expect(McpListAiAgentsInput.safeParse({ agentId: 1 }).success).toBe(false);
  });
});

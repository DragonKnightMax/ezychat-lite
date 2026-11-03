// Custom AI agents, Task 4: the AI service answers each chat with the agent of the chat's inbox,
// with that agent's own texts and items only, and never sends a reply that quotes an Internal item.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  AI_AGENT_PRESETS,
  DEFAULT_AI_INSTRUCTIONS,
  type AiAgentBody,
  type AiMemberBody,
} from '@ezychat/shared';
import { createAiService, AI_FALLBACK_MS, type AiService } from '../src/ai/service.js';
import { agentById, updateAgentTexts } from '../src/ai/agents.js';
import { HANDOFF_REPLY } from '../src/ai/prompt.js';
import type { AiPrompt, AiProvider } from '../src/ai/provider-types.js';
import { tryAgentReply, type AgentToolsInput, type ServerExtension } from '../src/index.js';
import { createMessageService } from '../src/messages/service.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';

const C = '60123456789@s.whatsapp.net';
const member: AiMemberBody = { displayName: 'Sales Agent', enabled: false, instructions: 'Sell' };
const helpdesk: AiAgentBody = {
  displayName: 'Helpdesk',
  enabled: false,
  preset: 'faq',
  instructions: 'Answer clinic questions',
  inboxId: 2,
};
const INTERNAL =
  'Minimum price we can accept for the deluxe package is RM 1,850 per month, never lower.';

let t: TestApp;
let provider: AiProvider;
let ai: AiService;
let actor: { userId: number; ip: null };
let logLines: string[];
let inputs: AgentToolsInput[];
let lookupInputs: Array<{ agent: string; agentId?: number }>;

const probe: ServerExtension = {
  name: 'probe',
  async agentTools(_ctx, input) {
    inputs.push(input);
    return null;
  },
  hasAgentLookups(_ctx, input) {
    lookupInputs.push(input);
    return false;
  },
};

async function setUp(opts: { maxInboxes?: number; inboxes?: number } = {}) {
  inputs = [];
  lookupInputs = [];
  logLines = [];
  t = await makeTestApp({
    maxInboxes: opts.maxInboxes ?? 3,
    inboxes: opts.inboxes ?? 2,
    extensions: [probe],
  });
  const admin = t.ctx.services.auth!.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  actor = { userId: admin.id, ip: null };
  await t.ctx.services.ai!.shutdown();
  t.ctx.services.messages!.shutdown();
  t.ctx.services.messages = createMessageService(t.ctx, {
    now: () => Date.now(),
    queue: { spacingMs: 0 },
  });
  provider = {
    generate: vi.fn().mockResolvedValue({ reply: 'We open at 8am.', action: 'answer' }),
    rewrite: vi.fn().mockResolvedValue({ text: 'Better text', model: 'gpt-test' }),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  const log = pino({ level: 'info' }, { write: (line: string) => logLines.push(line) });
  ai = createAiService({ ...t.ctx, log }, { provider, isOnline: () => true });
  t.ctx.services.ai = ai;
  ai.saveConnection({ mode: 'api', model: '', apiKey: 'test-api-key-123' }, actor);
}

afterEach(async () => {
  vi.useRealTimers();
  await t?.close();
});

async function incoming(inboxId: number, id: string, text = 'When do you open?') {
  return getMessages(t.ctx).ingest(
    {
      id,
      chatJid: C,
      body: text,
      type: 'text',
      fromMe: false,
      senderJid: C,
      senderName: 'Customer',
      timestamp: Date.now(),
      quotedId: null,
      media: null,
    },
    'live',
    inboxId,
  );
}

const call = (n: number) =>
  vi.mocked(provider.generate).mock.calls[n]![2] as AiPrompt & {
    cacheId: string;
  };
const input = (n: number) => JSON.parse(call(n).input) as Record<string, unknown>;
const key = (inboxId: number) => (inboxId === 1 ? C : `${C}#${inboxId}`);
const auditMetas = (action: string) =>
  (
    t.ctx.db
      .prepare('SELECT meta FROM audit_log WHERE action = ? ORDER BY id')
      .all(action) as Array<{
      meta: string;
    }>
  ).map((row) => JSON.parse(row.meta) as Record<string, unknown>);

/** Agent 1 (inbox 1, sales) and agent 2 (inbox 2, faq), each with its own item, both on. */
function twoAgents() {
  const one = ai.ensureDefaultAgent(member, actor).agent;
  ai.addText(one.id, { name: 'Menu', text: 'Nasi lemak costs RM5 at our cafe.' }, actor);
  const two = ai.createAgent(helpdesk, actor).agent;
  ai.addText(two.id, { name: 'Clinic', text: 'The clinic opens at 8am on weekdays.' }, actor);
  ai.saveAgent(one.id, { ...member, enabled: true }, actor);
  ai.saveAgent(two.id, { ...helpdesk, enabled: true }, actor);
  return { one, two };
}

describe('with three inboxes', { timeout: 30_000 }, () => {
  beforeEach(() => setUp());

  it('answers each inbox with its own agent, texts, items and cache key', async () => {
    const { one, two } = twoAgents();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming(2, 'in-2');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(getChats(t.ctx).get(key(2))!.assignedTo).toBe(two.userId);
    expect(call(0).instructions).toContain('Your name: Helpdesk');
    expect(call(0).instructions).toContain('Answer clinic questions');
    expect(call(0).instructions).toContain('FAQ agent');
    expect(String(input(0).businessKnowledge)).toContain('The clinic opens at 8am');
    expect(call(0).input).not.toContain('Nasi lemak');
    expect(call(0).cacheId).toMatch(new RegExp(`#agent:${two.id}$`));
    expect(t.inboxWa(2).sent.map((s) => s.text)).toEqual(['We open at 8am.']);

    await incoming(1, 'in-1');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(getChats(t.ctx).get(key(1))!.assignedTo).toBe(one.userId);
    expect(call(1).instructions).toContain('Your name: Sales Agent');
    expect(call(1).input).toContain('Nasi lemak');
    expect(call(1).input).not.toContain('clinic');
    expect(call(1).cacheId).toMatch(new RegExp(`#agent:${one.id}$`));
    expect(call(0).cacheId).not.toBe(call(1).cacheId);
    // The extension is told which agent the turn is for.
    expect(inputs.map((i) => ({ agent: i.agent, agentId: i.agentId, chatJid: i.chatJid }))).toEqual(
      [
        { agent: 'sales', agentId: two.id, chatJid: key(2) },
        { agent: 'sales', agentId: one.id, chatJid: key(1) },
      ],
    );
  });

  it('leaves an inbox without an agent to the team', async () => {
    twoAgents();
    await t.addInbox('Third');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming(3, 'in-3');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS * 2);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(getChats(t.ctx).get(key(3))!.assignedTo).toBeNull();
    expect(ai.agentForChat(key(3))).toBeNull();
  });

  it('sends Internal items in internalKnowledge and never a reply that quotes one', async () => {
    const { one } = twoAgents();
    ai.addText(one.id, { name: 'Floor price', text: INTERNAL, internal: true }, actor);
    vi.mocked(provider.generate).mockResolvedValue({
      reply:
        'Sure! The MINIMUM price we can   accept for the deluxe package is rm 1,850 per month.',
      action: 'answer',
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming(1, 'in-1', 'What is your lowest price?');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(String(input(0).internalKnowledge)).toBe(`[Floor price]\n${INTERNAL}`);
    expect(String(input(0).businessKnowledge)).not.toContain('deluxe');
    const sent = t.wa.sent.map((s) => s.text);
    expect(sent).toEqual([HANDOFF_REPLY]);
    expect(getChats(t.ctx).get(key(1))!.assignedTo).not.toBe(one.userId);
    expect(auditMetas('ai.handoff')).toEqual([
      expect.objectContaining({ reason: 'confidential_leak', agentId: one.id }),
    ]);
    const log = logLines.join('\n');
    expect(log).toContain('confidential_leak');
    expect(log.toLowerCase()).not.toContain('deluxe');
  });

  it('catches a leak in Try it too', async () => {
    const { one } = twoAgents();
    ai.addText(one.id, { name: 'Floor price', text: INTERNAL, internal: true }, actor);
    vi.mocked(provider.generate).mockResolvedValue({
      reply: `Between us: ${INTERNAL.toUpperCase()}`,
      action: 'answer',
    });
    const result = await ai.tryAnswer({
      question: 'Lowest price?',
      knowledge: { displayName: 'Sales Agent', instructions: 'Sell', handoffRules: '' },
      agentId: one.id,
    });
    expect(result).toMatchObject({
      ok: true,
      action: 'handoff',
      handoffReason: 'confidential_leak',
      reply: HANDOFF_REPLY,
    });
    expect(call(0).cacheId).toMatch(new RegExp(`#agent:${one.id}$`));
  });

  it('Try it answers from the named agent, else the agent of inbox 1', async () => {
    const { one, two } = twoAgents();
    const knowledge = { displayName: 'Draft', instructions: 'Draft text', handoffRules: '' };
    await ai.tryAnswer({ question: 'When do you open?', knowledge, agentId: two.id });
    expect(call(0).input).toContain('clinic');
    expect(call(0).instructions).toContain('FAQ agent');
    await ai.tryAnswer({ question: 'When do you open?', knowledge });
    expect(call(1).input).toContain('Nasi lemak');
    expect(call(1).cacheId).toMatch(new RegExp(`#agent:${one.id}$`));
    await expect(ai.tryAnswer({ question: 'Hi', knowledge, agentId: 999 })).rejects.toMatchObject({
      status: 404,
      code: 'agent_not_found',
    });
  });

  it('labels every AI agent message in the conversation as AI', async () => {
    const { one, two } = twoAgents();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming(1, 'in-1');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    // The earlier reply came from another AI agent (e.g. before the inbox was re-bound).
    t.ctx.db
      .prepare('UPDATE messages SET sent_by_user_id = ? WHERE sent_by_user_id = ?')
      .run(two.userId, one.userId);
    await vi.advanceTimersByTimeAsync(1000);
    await incoming(1, 'in-1b', 'And on Sunday?');
    await vi.advanceTimersByTimeAsync(2000);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(input(1).conversation).toEqual([
      { speaker: 'customer', text: 'When do you open?' },
      { speaker: 'AI', text: 'We open at 8am.' },
      { speaker: 'customer', text: 'And on Sunday?' },
    ]);
  });

  it('disabling agent 2 releases only agent 2 chats', () => {
    const { one, two } = twoAgents();
    const chats = getChats(t.ctx);
    return (async () => {
      await incoming(1, 'in-1');
      await incoming(2, 'in-2');
      chats.patch(key(1), { assignedTo: one.userId }, actor.userId);
      chats.patch(key(2), { assignedTo: two.userId }, actor.userId);
      ai.saveAgent(two.id, { ...helpdesk, enabled: false }, actor);
      expect(chats.get(key(2))!.assignedTo).toBeNull();
      expect(chats.get(key(1))!.assignedTo).toBe(one.userId);
      expect(ai.agentStatus(two.id).agent.enabled).toBe(false);
      expect(auditMetas('ai.member_update').at(-1)).toMatchObject({
        agentId: two.id,
        enabled: false,
      });
    })();
  });

  it('changes an existing agent type and audits it', () => {
    const { one } = twoAgents();
    const before = ai.agentStatus(one.id);
    ai.saveAgent(
      one.id,
      {
        displayName: before.settings.displayName,
        enabled: before.agent.enabled,
        preset: 'faq',
        instructions: before.settings.instructions,
        handoffRules: before.settings.handoffRules,
      },
      actor,
    );
    const after = ai.agentStatus(one.id);
    expect(after.agent.preset).toBe('faq');
    // Only the type changed: the texts stay as they were.
    expect(after.settings.instructions).toBe(before.settings.instructions);
    expect(auditMetas('ai.member_update').at(-1)).toMatchObject({
      agentId: one.id,
      preset: 'faq',
      presetChanged: true,
      instructionsChanged: false,
    });
  });

  it('deleteAgent releases its chats, hides its user and keeps it for history', async () => {
    const { one, two } = twoAgents();
    const chats = getChats(t.ctx);
    await incoming(2, 'in-2');
    chats.patch(key(2), { assignedTo: two.userId }, actor.userId);
    ai.deleteAgent(two.id, actor);
    expect(chats.get(key(2))!.assignedTo).toBeNull();
    expect(ai.listAgents().map((a) => a.id)).toEqual([one.id]);
    expect(ai.agentForChat(key(2))).toBeNull();
    const auth = t.ctx.services.auth!;
    expect(auth.listUsers().some((u) => u.id === two.userId)).toBe(false);
    expect(auth.getUser(two.userId)).toMatchObject({ kind: 'ai', disabled: true });
    expect(auth.listUsers({ includeDeleted: true }).find((u) => u.id === two.userId)).toMatchObject(
      {
        aiDeleted: true,
      },
    );
    // The directory keeps the deleted agent (disabled, flagged) so its old messages keep a name.
    const sid = auth.createSession(actor.userId, { ip: 'test', userAgent: 'test' });
    const dir = await t.app.inject({
      url: '/api/users/directory',
      headers: { cookie: `sid=${sid}` },
    });
    const users = dir.json().users as { id: number; aiDeleted?: boolean; aiAgentId?: number }[];
    expect(users.find((u) => u.id === two.userId)).toMatchObject({ aiDeleted: true });
    expect(users.find((u) => u.id === one.userId)).toMatchObject({ aiAgentId: one.id });
    expect(users.find((u) => u.id === one.userId)?.aiDeleted).toBeUndefined();
    expect(auditMetas('ai.agent_delete')).toEqual([expect.objectContaining({ agentId: two.id })]);
    expect(() => ai.agentStatus(two.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => ai.deleteAgent(two.id, actor)).toThrow(
      expect.objectContaining({ code: 'agent_not_found' }),
    );
  });

  it('setAgentInbox moves the agent and releases the chats it owned', async () => {
    const { one, two } = twoAgents();
    const third = await t.addInbox('Third');
    const chats = getChats(t.ctx);
    await incoming(2, 'in-2');
    chats.patch(key(2), { assignedTo: two.userId }, actor.userId);
    expect(() => ai.setAgentInbox(two.id, 1, actor)).toThrow(
      expect.objectContaining({ status: 409, code: 'inbox_has_direct_agent' }),
    );
    expect(chats.get(key(2))!.assignedTo).toBe(two.userId);
    ai.setAgentInbox(two.id, third, actor);
    expect(chats.get(key(2))!.assignedTo).toBeNull();
    expect(ai.agentForChat(key(2))).toBeNull();
    expect(ai.agentForChat(key(third))?.id).toBe(two.id);
    expect(ai.agentForChat(key(1))?.id).toBe(one.id);
    expect(auditMetas('ai.agent_inbox_update')).toEqual([
      expect.objectContaining({ agentId: two.id, from: 2, to: third }),
    ]);
    ai.setAgentInbox(two.id, null, actor);
    expect(ai.agentStatus(two.id).agent.inboxId).toBeNull();
    expect(() => ai.setAgentInbox(two.id, 99, actor)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('createAgent stops at maxAgents and lists every agent with its item count', () => {
    const { one, two } = twoAgents();
    const three = ai.createAgent({ ...helpdesk, displayName: 'Spare', inboxId: null }, actor);
    expect(three.agent).toMatchObject({ inboxId: null, preset: 'faq', documentCount: 0 });
    expect(() => ai.createAgent({ ...helpdesk, inboxId: null }, actor)).toThrow(
      expect.objectContaining({ status: 409, code: 'agent_limit' }),
    );
    expect(ai.maxAgents()).toBe(3);
    expect(ai.listAgents()).toEqual([
      expect.objectContaining({ id: one.id, inboxId: 1, documentCount: 1, preset: 'sales' }),
      expect.objectContaining({ id: two.id, inboxId: 2, documentCount: 1, preset: 'faq' }),
      expect.objectContaining({ id: three.agent.id, enabled: false }),
    ]);
    const status = ai.status();
    expect(status.maxAgents).toBe(3);
    expect(status.agents).toHaveLength(3);
    expect(status.member).toMatchObject({ id: one.userId, aiAgentId: one.id });
    expect(auditMetas('ai.agent_create').map((m) => m.agentId)).toEqual([
      one.id,
      two.id,
      three.agent.id,
    ]);
    // A second agent for an inbox that has one starts group-only (several agents per number).
    ai.deleteAgent(three.agent.id, actor);
    const groupOnly = ai.createAgent({ ...helpdesk, inboxId: 2 }, actor);
    expect(groupOnly.agent.inboxId).toBe(2);
    expect(agentById(t.ctx.db, groupOnly.agent.id)!.answerDirect).toBe(false);
    expect(ai.agentForChat(key(2))?.id).toBe(two.id);
  });

  it('a new agent without texts starts from its preset; NULL texts mean the preset defaults', () => {
    const { one } = twoAgents();
    const custom = ai.createAgent(
      { displayName: 'Bot', enabled: false, preset: 'custom', instructions: '', inboxId: null },
      actor,
    );
    expect(custom.settings).toMatchObject({ instructions: '', handoffRules: '' });
    ai.deleteAgent(custom.agent.id, actor);
    const faq = ai.createAgent(
      { displayName: 'FAQ', enabled: false, preset: 'faq', instructions: 'Mine' },
      actor,
    );
    expect(faq.settings).toMatchObject({
      instructions: 'Mine',
      handoffRules: AI_AGENT_PRESETS.faq.handoffRules,
    });
    updateAgentTexts(t.ctx.db, faq.agent.id, { instructions: null, handoffRules: null });
    expect(ai.agentStatus(faq.agent.id).settings.instructions).toBe(
      AI_AGENT_PRESETS.faq.instructions,
    );
    updateAgentTexts(t.ctx.db, one.id, { instructions: null });
    expect(ai.status().settings.instructions).toBe(DEFAULT_AI_INSTRUCTIONS);
  });

  it('keeps every item id inside its own agent', () => {
    const { one, two } = twoAgents();
    const item = ai.agentStatus(one.id).documents[0]!;
    expect(() => ai.document(two.id, item.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => ai.updateText(two.id, item.id, { text: 'Changed' }, actor)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => ai.removeDocument(two.id, item.id, actor)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(ai.document(one.id, item.id).text).toBe('Nasi lemak costs RM5 at our cafe.');
    expect(() => ai.addText(999, { name: 'X', text: 'y' }, actor)).toThrow(
      expect.objectContaining({ status: 404, code: 'agent_not_found' }),
    );
  });

  it('flags Internal items, caps their total and audits the flag', () => {
    const { one } = twoAgents();
    const big = ai.addText(one.id, { name: 'Big', text: 'x'.repeat(9_990) }, actor);
    const bigId = big.documents.find((d) => d.name === 'Big')!.id;
    expect(big.documents.find((d) => d.id === bigId)!.internal).toBe(false);
    ai.updateText(one.id, bigId, { internal: true }, actor);
    expect(ai.agentStatus(one.id).documents.find((d) => d.id === bigId)!.internal).toBe(true);
    expect(() =>
      ai.addText(one.id, { name: 'More', text: 'y'.repeat(20), internal: true }, actor),
    ).toThrow(expect.objectContaining({ status: 409, code: 'internal_too_large' }));
    // A business item is not counted.
    ai.addText(one.id, { name: 'Public', text: 'z'.repeat(20) }, actor);
    const file = ai.addDocument(one.id, 'prices.txt', 10, 'w'.repeat(20), actor, false);
    const fileId = file.documents.find((d) => d.name === 'prices.txt')!.id;
    expect(() => ai.updateText(one.id, fileId, { internal: true }, actor)).toThrow(
      expect.objectContaining({ code: 'internal_too_large' }),
    );
    ai.updateText(one.id, bigId, { internal: false }, actor);
    ai.updateText(one.id, fileId, { internal: true }, actor);
    expect(() => ai.updateText(one.id, fileId, { text: 'new' }, actor)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(auditMetas('ai.document_update').at(-1)).toMatchObject({
      agentId: one.id,
      documentId: fileId,
      internal: true,
    });
    expect(auditMetas('ai.document_add').at(-1)).toMatchObject({
      agentId: one.id,
      internal: false,
    });
  });

  it('ensureDefaultAgent twice keeps one agent on inbox 1', () => {
    const first = ai.ensureDefaultAgent(member, actor);
    const second = ai.ensureDefaultAgent({ ...member, displayName: 'Other' }, actor);
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.agent.displayName).toBe('Sales Agent');
    expect(ai.listAgents()).toHaveLength(1);
    expect(first.agent.inboxId).toBe(1);
    // The old PUT /api/ai saves that same agent.
    ai.saveMember({ ...member, displayName: 'Renamed' }, actor);
    expect(ai.listAgents()).toEqual([
      expect.objectContaining({ id: first.agent.id, displayName: 'Renamed' }),
    ]);
  });
});

describe('per-agent tools and connection', { timeout: 30_000 }, () => {
  beforeEach(() => setUp());

  it('Edit with AI and tryAgentReply use the named agent', async () => {
    const { two } = twoAgents();
    const edit = await ai.editText(
      { field: 'instructions', current: 'Answer', request: 'Make it friendlier' },
      undefined,
      two.id,
    );
    expect(edit).toEqual({ ok: true, text: 'Better text', error: null });
    const [, , editPrompt] = vi.mocked(provider.rewrite!).mock.calls[0]!;
    expect(editPrompt.input).toContain('clinic');
    expect(editPrompt.input).not.toContain('Nasi lemak');
    expect(editPrompt.cacheId).toMatch(new RegExp(`#agent:${two.id}$`));
    await tryAgentReply(t.ctx, { agent: 'sales', question: 'When?', agentId: two.id });
    expect(call(0).instructions).toContain('Your name: Helpdesk');
    expect(call(0).input).toContain('clinic');
    // With no items of its own, the look-up check is asked for that agent.
    const empty = ai.createAgent({ ...helpdesk, displayName: 'Empty', inboxId: null }, actor);
    expect(
      await ai.tryAnswer({
        question: 'When?',
        knowledge: { displayName: 'Empty', instructions: '', handoffRules: '' },
        agentId: empty.agent.id,
      }),
    ).toMatchObject({ action: 'handoff', handoffReason: 'missing_facts' });
    expect(lookupInputs).toContainEqual({ agent: 'sales', agentId: empty.agent.id });
  });

  it('saveAgent can move the agent to another inbox', async () => {
    const { two } = twoAgents();
    const third = await t.addInbox('Third');
    const saved = ai.saveAgent(two.id, { ...helpdesk, enabled: true, inboxId: third }, actor);
    expect(saved.agent.inboxId).toBe(third);
    expect(() => ai.saveAgent(two.id, { ...helpdesk, inboxId: 1 }, actor)).toThrow(
      expect.objectContaining({ code: 'inbox_has_direct_agent' }),
    );
    expect(ai.agentStatus(two.id).agent).toMatchObject({ inboxId: third, enabled: true });
  });

  it('a changed connection releases the chats of every agent', async () => {
    const { one, two } = twoAgents();
    const chats = getChats(t.ctx);
    await incoming(1, 'in-1');
    await incoming(2, 'in-2');
    chats.patch(key(1), { assignedTo: one.userId }, actor.userId);
    chats.patch(key(2), { assignedTo: two.userId }, actor.userId);
    ai.saveConnection({ mode: 'api', model: 'gpt-x', apiKey: 'test-api-key-456' }, actor);
    expect(chats.get(key(1))!.assignedTo).toBeNull();
    expect(chats.get(key(2))!.assignedTo).toBeNull();
  });

  it('an item written before any agent existed belongs to the first agent', () => {
    const now = Date.now();
    t.ctx.db
      .prepare(
        "INSERT INTO ai_documents(agent_id, name, kind, size, text, created_at, updated_at) VALUES (NULL, 'Old', 'text', 3, 'Old', ?, ?)",
      )
      .run(now, now);
    // Another inbox's new agent does not adopt it, so it cannot count toward turning that agent on.
    expect(() => ai.createAgent({ ...helpdesk, enabled: true }, actor)).toThrow(
      'Add business context',
    );
    expect(ai.listAgents()).toEqual([]);
    const status = ai.saveMember({ ...member, enabled: false }, actor);
    expect(status.documents.map((d) => d.name)).toEqual(['Old']);
    expect(status.agents).toEqual([expect.objectContaining({ inboxId: 1, documentCount: 1 })]);
  });

  it('audits a removed item with its agent and Internal flag', () => {
    const { one } = twoAgents();
    const added = ai.addText(one.id, { name: 'Secret', text: INTERNAL, internal: true }, actor);
    const id = added.documents.find((d) => d.name === 'Secret')!.id;
    const after = ai.removeDocument(one.id, id, actor);
    expect(after.documents.map((d) => d.name)).toEqual(['Menu']);
    expect(auditMetas('ai.document_remove')).toEqual([
      expect.objectContaining({ agentId: one.id, documentId: id, internal: true }),
    ]);
  });
});

describe('Lite (one inbox)', { timeout: 30_000 }, () => {
  beforeEach(() => setUp({ maxInboxes: 1, inboxes: 1 }));

  it('allows one agent, always on inbox 1, that cannot be deleted or moved', () => {
    const agent = ai.createAgent({ ...helpdesk, inboxId: null }, actor).agent;
    expect(agent.inboxId).toBe(1);
    expect(() => ai.createAgent(helpdesk, actor)).toThrow(
      expect.objectContaining({ status: 409, code: 'agent_limit' }),
    );
    expect(() => ai.deleteAgent(agent.id, actor)).toThrow(
      expect.objectContaining({ status: 409, code: 'last_agent' }),
    );
    expect(() => ai.setAgentInbox(agent.id, null, actor)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(ai.maxAgents()).toBe(1);
  });
});

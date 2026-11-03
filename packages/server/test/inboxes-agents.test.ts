// Custom AI agents, Task 5: an AI agent may own only chats of its own inbox, Admin → Inboxes binds
// an agent to an inbox, and removing an inbox unbinds its agent and hands back its chats.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxListResponse, InboxSchema, type AiAgentBody } from '@ezychat/shared';
import { createAiService, type AiService } from '../src/ai/service.js';
import { agentById } from '../src/ai/agents.js';
import type { AiProvider } from '../src/ai/provider-types.js';
import { ChatRepo } from '../src/chats/repo.js';
import { getChats } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const C = '60123456789@s.whatsapp.net';
const C2 = '60123456000@s.whatsapp.net';
const enc = encodeURIComponent;

const open: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const t of open.splice(0)) await t.close();
});

const sales: AiAgentBody = {
  displayName: 'Sales Agent',
  enabled: true,
  instructions: 'Sell',
  handoffRules: '',
};
const helpdesk: AiAgentBody = {
  displayName: 'Helpdesk',
  enabled: true,
  preset: 'faq',
  instructions: 'Answer clinic questions',
  handoffRules: '',
  inboxId: 2,
};

/** Never calls a model: the AI never gets to answer in these tests. */
const mockProvider = (): AiProvider => ({
  generate: vi.fn().mockResolvedValue({ reply: 'Hi', action: 'answer' }),
  rewrite: vi.fn(),
  connection: () => ({ state: 'connected', loginUrl: null, error: null }),
  login: vi.fn(),
  logout: vi.fn(),
  shutdown: vi.fn(async () => {}),
});

async function app(opts: { maxInboxes?: number; inboxes?: number } = {}) {
  const t = await makeTestApp({ maxInboxes: opts.maxInboxes ?? 3, inboxes: opts.inboxes ?? 3 });
  open.push(t);
  const admin = await createUserAndLogin(t, { role: 'admin' });
  const actor = { userId: admin.user.id, ip: null };
  await t.ctx.services.ai!.shutdown();
  const ai: AiService = createAiService(t.ctx, {
    provider: mockProvider(),
    isOnline: () => true,
  });
  t.ctx.services.ai = ai;
  ai.saveConnection({ mode: 'api', model: '', apiKey: 'test-api-key-123' }, actor);
  const req = (method: string, url: string, payload?: unknown) =>
    t.app.inject({
      method: method as 'GET',
      url,
      headers: authHeaders(admin.cookie),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  return { t, ai, actor, req };
}

/** Agent 1 on inbox 1, agent 2 on inbox 2, both on (each needs Business context to turn on). */
function twoAgents(t: TestApp, ai: AiService, actor: { userId: number; ip: null }) {
  const one = ai.ensureDefaultAgent({ ...sales, enabled: false }, actor).agent;
  ai.addText(one.id, { name: 'Menu', text: 'Nasi lemak costs RM5.' }, actor);
  ai.saveAgent(one.id, sales, actor);
  const two = ai.createAgent({ ...helpdesk, enabled: false }, actor).agent;
  ai.addText(two.id, { name: 'Clinic', text: 'The clinic opens at 8am.' }, actor);
  ai.saveAgent(two.id, helpdesk, actor);
  return { one: agentById(t.ctx.db, one.id)!, two: agentById(t.ctx.db, two.id)! };
}

async function setUp(opts: { maxInboxes?: number; inboxes?: number } = {}) {
  const env = await app(opts);
  const repo = new ChatRepo(env.t.ctx.db);
  repo.ensure(C, { type: 'dm', name: 'Customer' }, 1);
  repo.ensure(`${C}#2`, { type: 'dm', name: 'Customer' }, 1);
  repo.ensure(`${C2}#2`, { type: 'dm', name: 'Other' }, 1);
  return env;
}

const assignedTo = (t: TestApp, jid: string) =>
  (
    t.ctx.db.prepare('SELECT assigned_to FROM chats WHERE jid = ?').get(jid) as {
      assigned_to: number | null;
    }
  ).assigned_to;

describe('assignment guard', { timeout: 30_000 }, () => {
  it('refuses an AI agent on a chat of another inbox and accepts the inbox agent', async () => {
    const { t, ai, actor, req } = await setUp();
    const { one, two } = twoAgents(t, ai, actor);

    const wrong = await req('PATCH', `/api/chats/${enc(C)}`, { assignedTo: two.userId });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('assignee_not_inbox_agent');
    expect(assignedTo(t, C)).toBeNull();

    const right = await req('PATCH', `/api/chats/${enc(C)}`, { assignedTo: one.userId });
    expect(right.statusCode).toBe(200);
    expect(assignedTo(t, C)).toBe(one.userId);
  });

  it('refuses an AI agent that has no inbox', async () => {
    const { t, ai, actor } = await setUp();
    const { two } = twoAgents(t, ai, actor);
    ai.setAgentInbox(two.id, null, actor);
    expect(() => getChats(t.ctx).patch(`${C}#2`, { assignedTo: two.userId }, null)).toThrow(
      expect.objectContaining({ code: 'assignee_not_inbox_agent' }),
    );
  });
});

describe('Admin → Inboxes binding', { timeout: 30_000 }, () => {
  it('lists aiAgentId for every inbox', async () => {
    const { t, ai, actor, req } = await setUp();
    const { one, two } = twoAgents(t, ai, actor);
    const list = InboxListResponse.parse((await req('GET', '/api/inboxes')).json());
    expect(list.inboxes.map((i) => [i.id, i.aiAgentId])).toEqual([
      [1, one.id],
      [2, two.id],
      [3, null],
    ]);
  });

  it('PATCH moves agent 1 to inbox 3 and releases its inbox-1 chats', async () => {
    const { t, ai, actor, req } = await setUp();
    const { one } = twoAgents(t, ai, actor);
    getChats(t.ctx).patch(C, { assignedTo: one.userId }, null);

    const res = await req('PATCH', '/api/inboxes/3', { aiAgentId: one.id });
    expect(res.statusCode).toBe(200);
    expect(InboxSchema.parse(res.json()).aiAgentId).toBe(one.id);
    expect(agentById(t.ctx.db, one.id)!.inboxId).toBe(3);
    expect(assignedTo(t, C)).toBeNull();
    const list = InboxListResponse.parse((await req('GET', '/api/inboxes')).json());
    expect(list.inboxes.find((i) => i.id === 1)!.aiAgentId).toBeNull();
    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'inbox.update' ORDER BY id DESC")
      .get() as { meta: string };
    expect(JSON.parse(audit.meta)).toMatchObject({ inboxId: 3, fields: ['aiAgentId'] });
  });

  it('PATCH to an inbox that has another agent answers 409 inbox_has_direct_agent and changes nothing', async () => {
    const { t, ai, actor, req } = await setUp();
    const { one, two } = twoAgents(t, ai, actor);
    const res = await req('PATCH', '/api/inboxes/2', { aiAgentId: one.id, name: 'Renamed' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('inbox_has_direct_agent');
    expect(agentById(t.ctx.db, one.id)!.inboxId).toBe(1);
    expect(agentById(t.ctx.db, two.id)!.inboxId).toBe(2);
    expect(t.ctx.inboxes.repo.get(2)!.name).not.toBe('Renamed');
  });

  it('PATCH with a refused member list keeps the agent where it was', async () => {
    const { t, ai, actor, req } = await setUp();
    const { one } = twoAgents(t, ai, actor);
    getChats(t.ctx).patch(C, { assignedTo: one.userId }, null);
    const res = await req('PATCH', '/api/inboxes/3', { aiAgentId: one.id, memberIds: [9999] });
    expect(res.statusCode).toBe(400);
    expect(agentById(t.ctx.db, one.id)!.inboxId).toBe(1);
    expect(assignedTo(t, C)).toBe(one.userId);
  });

  it('without the AI service a binding answers 503 and creates or changes nothing', async () => {
    const { t, ai, actor, req } = await setUp({ maxInboxes: 3, inboxes: 2 });
    const { one } = twoAgents(t, ai, actor);
    t.ctx.services.ai = undefined;
    const create = await req('POST', '/api/inboxes', { name: 'Support', aiAgentId: one.id });
    expect(create.statusCode).toBe(503);
    expect(create.json().error.code).toBe('ai_unavailable');
    expect(t.ctx.inboxes.repo.active()).toHaveLength(2);
    const update = await req('PATCH', '/api/inboxes/2', { aiAgentId: null, name: 'Renamed' });
    expect(update.statusCode).toBe(503);
    expect(t.ctx.inboxes.repo.get(2)!.name).not.toBe('Renamed');
    expect(agentById(t.ctx.db, one.id)!.inboxId).toBe(1);
    t.ctx.services.ai = ai;
  });

  it('PATCH with the same agent changes nothing; null unbinds; an unknown agent is 404', async () => {
    const { t, ai, actor, req } = await setUp();
    const { two } = twoAgents(t, ai, actor);
    getChats(t.ctx).patch(`${C}#2`, { assignedTo: two.userId }, null);

    const same = await req('PATCH', '/api/inboxes/2', { aiAgentId: two.id });
    expect(same.statusCode).toBe(200);
    expect(assignedTo(t, `${C}#2`)).toBe(two.userId);

    const unbind = await req('PATCH', '/api/inboxes/2', { aiAgentId: null });
    expect(unbind.statusCode).toBe(200);
    expect(unbind.json().aiAgentId).toBeNull();
    expect(agentById(t.ctx.db, two.id)!.inboxId).toBeNull();
    expect(assignedTo(t, `${C}#2`)).toBeNull();

    const again = await req('PATCH', '/api/inboxes/2', { aiAgentId: null });
    expect(again.statusCode).toBe(200);

    const unknown = await req('PATCH', '/api/inboxes/2', { aiAgentId: 999 });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('agent_not_found');
  });

  it('POST /inboxes binds an agent that has no inbox; an unknown agent creates nothing', async () => {
    const { t, ai, actor, req } = await setUp({ maxInboxes: 3, inboxes: 2 });
    const { two } = twoAgents(t, ai, actor);
    ai.setAgentInbox(two.id, null, actor);

    const unknown = await req('POST', '/api/inboxes', { name: 'Support', aiAgentId: 999 });
    expect(unknown.statusCode).toBe(404);
    expect(t.ctx.inboxes.repo.active()).toHaveLength(2);

    const res = await req('POST', '/api/inboxes', { name: 'Support', aiAgentId: two.id });
    expect(res.statusCode).toBe(201);
    const inbox = InboxSchema.parse(res.json());
    expect(inbox.aiAgentId).toBe(two.id);
    expect(agentById(t.ctx.db, two.id)!.inboxId).toBe(inbox.id);
  });

  it('removing inbox 2 unbinds agent 2 and hands back its chats', async () => {
    const { t, ai, actor, req } = await setUp();
    const { one, two } = twoAgents(t, ai, actor);
    getChats(t.ctx).patch(`${C}#2`, { assignedTo: two.userId }, null);
    getChats(t.ctx).patch(`${C2}#2`, { assignedTo: two.userId }, null);
    getChats(t.ctx).patch(C, { assignedTo: one.userId }, null);

    const res = await req('DELETE', '/api/inboxes/2');
    expect(res.statusCode).toBe(204);
    expect(agentById(t.ctx.db, two.id)!.inboxId).toBeNull();
    expect(assignedTo(t, `${C}#2`)).toBeNull();
    expect(assignedTo(t, `${C2}#2`)).toBeNull();
    expect(assignedTo(t, C)).toBe(one.userId);
    const list = InboxListResponse.parse((await req('GET', '/api/inboxes')).json());
    expect(list.inboxes.find((i) => i.id === 2)).toMatchObject({ removed: true, aiAgentId: null });
  });
});

describe('removing an inbox when the edition allows one agent', { timeout: 30_000 }, () => {
  it('still unbinds the agent and hands back its chats', async () => {
    const { t, ai, actor, req } = await setUp();
    const { two } = twoAgents(t, ai, actor);
    getChats(t.ctx).patch(`${C}#2`, { assignedTo: two.userId }, null);
    vi.spyOn(ai, 'maxAgents').mockReturnValue(1);
    const res = await req('DELETE', '/api/inboxes/2');
    expect(res.statusCode).toBe(204);
    expect(agentById(t.ctx.db, two.id)!.inboxId).toBeNull();
    expect(assignedTo(t, `${C}#2`)).toBeNull();
    const row = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'ai.agent_inbox_update' ORDER BY id DESC")
      .get() as { meta: string };
    expect(JSON.parse(row.meta)).toEqual({ agentId: two.id, from: 2, to: null });
  });
});

describe('Lite (one inbox)', { timeout: 30_000 }, () => {
  it('keeps the only agent on inbox 1', async () => {
    const { t, ai, actor, req } = await setUp({ maxInboxes: 1, inboxes: 1 });
    const one = ai.ensureDefaultAgent({ ...sales, enabled: false }, actor).agent;
    const list = InboxListResponse.parse((await req('GET', '/api/inboxes')).json());
    expect(list.inboxes[0]!.aiAgentId).toBe(one.id);
    const res = await req('PATCH', '/api/inboxes/1', { aiAgentId: null });
    expect(res.statusCode).toBe(400);
    expect(agentById(t.ctx.db, one.id)!.inboxId).toBe(1);
  });
});

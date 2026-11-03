// Custom AI agents, Task 6: the per-agent HTTP routes under /api/ai/agents and the old /api/ai
// routes as aliases for the inbox-1 agent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentBody } from '@ezychat/shared';
import type { AiProvider } from '../src/ai/provider-types.js';
import { createAiService } from '../src/ai/service.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders } from './auth-helpers.js';

let t: TestApp;
let provider: AiProvider;
let cookie: string;
let agentCookie: string;

const sales: AiAgentBody = {
  displayName: 'Sales Agent',
  enabled: false,
  preset: 'sales',
  instructions: 'Sell cakes',
  inboxId: 1,
};
const helpdesk: AiAgentBody = {
  displayName: 'Helpdesk',
  enabled: false,
  preset: 'faq',
  instructions: 'Answer clinic questions',
  inboxId: 2,
};

async function setUp(opts: { maxInboxes: number; inboxes: number }) {
  provider = {
    generate: vi.fn().mockResolvedValue({ reply: 'We open at 8am.', action: 'answer' }),
    rewrite: vi.fn().mockResolvedValue({ text: 'Better text', model: 'gpt-test' }),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  t = await makeTestApp({
    ...opts,
    beforeBuild: async (ctx) => {
      await ctx.services.ai!.shutdown();
      ctx.services.ai = createAiService(ctx, { provider, isOnline: () => true });
    },
  });
  const auth = t.ctx.services.auth!;
  const admin = auth.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  const agent = auth.createUser({
    username: 'agent',
    displayName: 'Agent',
    role: 'agent',
    password: 'password123',
    mustChangePassword: false,
  });
  cookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 't' })}`;
  agentCookie = `sid=${auth.createSession(agent.id, { ip: '127.0.0.1', userAgent: 't' })}`;
  t.ctx.services.ai!.saveConnection(
    { mode: 'api', model: '', apiKey: 'test-api-key-123' },
    { userId: admin.id, ip: null },
  );
}

afterEach(async () => {
  await t?.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const inject = (method: Method, url: string, payload?: object, as = cookie) =>
  t.app.inject({ method, url, headers: authHeaders(as), ...(payload ? { payload } : {}) });

function multipart(fields: Record<string, string>, file: { name: string; text: string }) {
  const boundary = '----ezychat-test-boundary';
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  const payload = Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    Buffer.from(file.text),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}
const upload = (
  url: string,
  fields: Record<string, string>,
  file = { name: 'a.txt', text: 'x' },
) => {
  const { payload, contentType } = multipart(fields, file);
  return t.app.inject({
    method: 'POST',
    url,
    headers: { ...authHeaders(cookie), 'content-type': contentType },
    payload,
  });
};
const itemRow = (id: number) =>
  t.ctx.db
    .prepare('SELECT agent_id AS agentId, name, text, internal FROM ai_documents WHERE id = ?')
    .get(id) as { agentId: number; name: string; text: string; internal: number } | undefined;

describe('several agents (maxInboxes 3)', { timeout: 30_000 }, () => {
  async function twoAgents() {
    await setUp({ maxInboxes: 3, inboxes: 2 });
    const one = await inject('POST', '/api/ai/agents', sales);
    expect(one.statusCode, one.body).toBe(200);
    const two = await inject('POST', '/api/ai/agents', helpdesk);
    expect(two.statusCode, two.body).toBe(200);
    return { one: one.json().agent.id as number, two: two.json().agent.id as number };
  }

  it('creates, lists, reads, saves and deletes agents', async () => {
    const { one, two } = await twoAgents();
    const list = await inject('GET', '/api/ai/agents');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      maxAgents: 3,
      agents: [
        { id: one, displayName: 'Sales Agent', preset: 'sales', inboxId: 1 },
        { id: two, displayName: 'Helpdesk', preset: 'faq', inboxId: 2 },
      ],
    });

    const read = await inject('GET', `/api/ai/agents/${two}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      agent: { id: two, displayName: 'Helpdesk', inboxId: 2 },
      settings: { instructions: 'Answer clinic questions' },
      documents: [],
    });

    const saved = await inject('PUT', `/api/ai/agents/${two}`, {
      ...helpdesk,
      displayName: 'Clinic desk',
      instructions: 'Answer briefly',
      inboxId: null,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      agent: { id: two, displayName: 'Clinic desk', inboxId: null },
      settings: { instructions: 'Answer briefly' },
    });

    const removed = await inject('DELETE', `/api/ai/agents/${two}`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ maxAgents: 3, agents: [{ id: one }] });
    expect((await inject('GET', `/api/ai/agents/${two}`)).statusCode).toBe(404);
    expect((await inject('GET', '/api/ai/agents')).json().agents).toHaveLength(1);
  });

  it('maps agent errors to 404 and 409 codes', async () => {
    const { one } = await twoAgents();
    const missing = await inject('GET', '/api/ai/agents/99');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('agent_not_found');
    expect((await inject('PUT', '/api/ai/agents/99', helpdesk)).statusCode).toBe(404);
    expect((await inject('DELETE', '/api/ai/agents/99')).statusCode).toBe(404);
    expect(
      (await inject('POST', '/api/ai/agents/99/documents/text', { name: 'a', text: 'b' }))
        .statusCode,
    ).toBe(404);

    const taken = await inject('PUT', `/api/ai/agents/${one}`, { ...sales, inboxId: 2 });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('inbox_has_direct_agent');

    const third = await inject('POST', '/api/ai/agents', {
      ...helpdesk,
      displayName: 'Third',
      inboxId: null,
    });
    expect(third.statusCode, third.body).toBe(200);
    const fourth = await inject('POST', '/api/ai/agents', {
      ...helpdesk,
      displayName: 'Fourth',
      inboxId: null,
    });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.code).toBe('agent_limit');

    const bad = await inject('POST', '/api/ai/agents', {
      displayName: '',
      enabled: false,
      instructions: '',
    });
    expect(bad.statusCode).toBe(400);
    expect((await inject('GET', '/api/ai/agents/abc')).statusCode).toBe(400);
  });

  it('manages each agent’s items and refuses another agent’s item id (404, unchanged)', async () => {
    const { one, two } = await twoAgents();
    const created = await inject('POST', `/api/ai/agents/${one}/documents/text`, {
      name: 'Prices',
      text: 'Cake RM50',
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().agent.id).toBe(one);
    const item = created.json().documents[0];
    expect(item).toMatchObject({ name: 'Prices', kind: 'text', internal: false });

    // Agent B's path with agent A's item: never found, never changed.
    expect((await inject('GET', `/api/ai/agents/${two}/documents/${item.id}`)).statusCode).toBe(
      404,
    );
    const patchOther = await inject('PATCH', `/api/ai/agents/${two}/documents/${item.id}`, {
      text: 'Cake RM1',
      internal: true,
    });
    expect(patchOther.statusCode).toBe(404);
    expect((await inject('DELETE', `/api/ai/agents/${two}/documents/${item.id}`)).statusCode).toBe(
      404,
    );
    expect(itemRow(item.id)).toEqual({
      agentId: one,
      name: 'Prices',
      text: 'Cake RM50',
      internal: 0,
    });
    expect((await inject('GET', `/api/ai/agents/${two}`)).json().documents).toEqual([]);

    const view = await inject('GET', `/api/ai/agents/${one}/documents/${item.id}`);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ id: item.id, text: 'Cake RM50', truncated: false });

    const patched = await inject('PATCH', `/api/ai/agents/${one}/documents/${item.id}`, {
      internal: true,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().documents[0]).toMatchObject({ id: item.id, internal: true });
    expect(itemRow(item.id)?.internal).toBe(1);

    const deleted = await inject('DELETE', `/api/ai/agents/${one}/documents/${item.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().documents).toEqual([]);
    expect(itemRow(item.id)).toBeUndefined();
  });

  it('stores the internal form field of an upload, default false', async () => {
    const { two } = await twoAgents();
    const internal = await upload(
      `/api/ai/agents/${two}/documents`,
      { internal: 'true' },
      { name: 'floor.txt', text: 'Lowest price RM1,850' },
    );
    expect(internal.statusCode, internal.body).toBe(200);
    const [doc] = internal.json().documents;
    expect(doc).toMatchObject({ name: 'floor.txt', kind: 'file', internal: true });
    expect(itemRow(doc.id)).toMatchObject({ agentId: two, internal: 1 });

    const plain = await upload(
      `/api/ai/agents/${two}/documents`,
      {},
      { name: 'hours.txt', text: 'Open 8am' },
    );
    expect(plain.statusCode, plain.body).toBe(200);
    expect(
      plain.json().documents.find((d: { name: string }) => d.name === 'hours.txt'),
    ).toMatchObject({
      internal: false,
    });
    const falsy = await upload(
      `/api/ai/agents/${two}/documents`,
      { internal: 'false' },
      { name: 'b.txt', text: 'b' },
    );
    expect(falsy.json().documents.find((d: { name: string }) => d.name === 'b.txt').internal).toBe(
      false,
    );

    const missingAgent = await upload(
      '/api/ai/agents/99/documents',
      {},
      { name: 'c.txt', text: 'c' },
    );
    expect(missingAgent.statusCode).toBe(404);
  });

  it('answers Try it and Edit with AI with the agent in the path', async () => {
    const { one, two } = await twoAgents();
    await inject('POST', `/api/ai/agents/${one}/documents/text`, {
      name: 'Cakes',
      text: 'ONE-ONLY cake list',
    });
    await inject('POST', `/api/ai/agents/${two}/documents/text`, {
      name: 'Clinic',
      text: 'TWO-ONLY clinic hours',
    });
    const tried = await inject('POST', `/api/ai/agents/${two}/try`, {
      question: 'When do you open?',
      knowledge: { displayName: 'Helpdesk', instructions: 'Answer clinic questions' },
      agentId: one,
    });
    expect(tried.statusCode, tried.body).toBe(200);
    expect(tried.json()).toMatchObject({ reply: 'We open at 8am.' });
    const sent = JSON.stringify(vi.mocked(provider.generate).mock.calls.at(-1));
    expect(sent).toContain('TWO-ONLY');
    expect(sent).not.toContain('ONE-ONLY');
    expect(sent).toContain(`#agent:${two}`);

    const edited = await inject('POST', `/api/ai/agents/${two}/edit`, {
      field: 'instructions',
      current: 'Answer clinic questions',
      request: 'Make it friendlier',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ text: 'Better text' });
    const [, , editPrompt] = vi.mocked(provider.rewrite!).mock.calls.at(-1)!;
    expect((editPrompt as { cacheId: string }).cacheId).toMatch(new RegExp(`#agent:${two}$`));

    expect(
      (
        await inject('POST', '/api/ai/agents/99/try', {
          question: 'q',
          knowledge: { displayName: 'X', instructions: '' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('keeps the old routes on the inbox-1 agent', async () => {
    const { one, two } = await twoAgents();
    const saved = await inject('PUT', '/api/ai', {
      displayName: 'Cake Seller',
      enabled: false,
      instructions: 'Sell more cakes',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const added = await inject('POST', '/api/ai/documents/text', {
      name: 'Old route',
      text: 'Hello',
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().member).toBeDefined();

    const agentOne = (await inject('GET', `/api/ai/agents/${one}`)).json();
    expect(agentOne.agent.displayName).toBe('Cake Seller');
    expect(agentOne.settings.instructions).toBe('Sell more cakes');
    expect(agentOne.documents.map((d: { name: string }) => d.name)).toEqual(['Old route']);
    const agentTwo = (await inject('GET', `/api/ai/agents/${two}`)).json();
    expect(agentTwo.agent.displayName).toBe('Helpdesk');
    expect(agentTwo.documents).toEqual([]);
  });

  it('stores an old-route upload on the inbox-1 agent with its internal field', async () => {
    const { one, two } = await twoAgents();
    const res = await upload(
      '/api/ai/documents',
      { internal: 'true' },
      { name: 'old.txt', text: 'Floor price RM900' },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member).toBeDefined();
    const row = t.ctx.db
      .prepare('SELECT agent_id AS agentId, internal FROM ai_documents WHERE name = ?')
      .get('old.txt');
    expect(row).toEqual({ agentId: one, internal: 1 });
    expect((await inject('GET', `/api/ai/agents/${two}`)).json().documents).toEqual([]);
  });

  it('never reaches another agent’s item through the old item routes (404, unchanged)', async () => {
    const { two } = await twoAgents();
    const created = await inject('POST', `/api/ai/agents/${two}/documents/text`, {
      name: 'Clinic',
      text: 'Open 9am',
    });
    const item = created.json().documents[0];
    expect((await inject('GET', `/api/ai/documents/${item.id}`)).statusCode).toBe(404);
    expect(
      (await inject('PATCH', `/api/ai/documents/${item.id}`, { text: 'Changed', internal: true }))
        .statusCode,
    ).toBe(404);
    expect((await inject('DELETE', `/api/ai/documents/${item.id}`)).statusCode).toBe(404);
    expect(itemRow(item.id)).toEqual({
      agentId: two,
      name: 'Clinic',
      text: 'Open 9am',
      internal: 0,
    });
  });

  it('answers 404 for Edit with AI on an unknown agent and calls no model', async () => {
    await twoAgents();
    const res = await inject('POST', '/api/ai/agents/99/edit', {
      field: 'instructions',
      current: 'x',
      request: 'y',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('agent_not_found');
    expect(provider.rewrite).not.toHaveBeenCalled();
  });

  it('is admin only', async () => {
    const { one } = await twoAgents();
    const calls: Array<[Method, string, object?]> = [
      ['GET', '/api/ai/agents'],
      ['POST', '/api/ai/agents', helpdesk],
      ['GET', `/api/ai/agents/${one}`],
      ['PUT', `/api/ai/agents/${one}`, sales],
      ['DELETE', `/api/ai/agents/${one}`],
      ['POST', `/api/ai/agents/${one}/documents/text`, { name: 'a', text: 'b' }],
      ['GET', `/api/ai/agents/${one}/documents/1`],
      ['PATCH', `/api/ai/agents/${one}/documents/1`, { internal: true }],
      ['DELETE', `/api/ai/agents/${one}/documents/1`],
      [
        'POST',
        `/api/ai/agents/${one}/try`,
        { question: 'q', knowledge: { displayName: 'X', instructions: '' } },
      ],
    ];
    for (const [method, url, body] of calls) {
      const result = await inject(method, url, body, agentCookie);
      expect(result.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await inject('GET', '/api/ai/agents')).json().agents).toHaveLength(2);
  });
});

describe('Lite (one inbox)', { timeout: 30_000 }, () => {
  it('refuses to delete the only agent with 409 last_agent', async () => {
    await setUp({ maxInboxes: 1, inboxes: 1 });
    const created = await inject('POST', '/api/ai/agents', { ...sales, inboxId: undefined });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().agent.id;
    expect(created.json().agent.inboxId).toBe(1);
    const removed = await inject('DELETE', `/api/ai/agents/${id}`);
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error.code).toBe('last_agent');
    const second = await inject('POST', '/api/ai/agents', helpdesk);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('agent_limit');
    expect((await inject('GET', '/api/ai/agents')).json()).toMatchObject({ maxAgents: 1 });
  });
});

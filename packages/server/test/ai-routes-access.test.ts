import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders } from './auth-helpers.js';

/** Every /api/ai route. A new route must be added here. */
const ROUTES = [
  { method: 'GET', url: '/api/ai' },
  { method: 'PUT', url: '/api/ai' },
  { method: 'GET', url: '/api/ai/enrichment' },
  { method: 'PUT', url: '/api/ai/enrichment' },
  { method: 'PATCH', url: '/api/ai/connection' },
  { method: 'POST', url: '/api/ai/connection/test' },
  { method: 'POST', url: '/api/ai/documents' },
  { method: 'POST', url: '/api/ai/documents/text' },
  { method: 'GET', url: '/api/ai/documents/1' },
  { method: 'PATCH', url: '/api/ai/documents/1' },
  { method: 'DELETE', url: '/api/ai/documents/1' },
  { method: 'GET', url: '/api/ai/models' },
  { method: 'POST', url: '/api/ai/chatgpt/test' },
  { method: 'POST', url: '/api/ai/chatgpt/login' },
  { method: 'POST', url: '/api/ai/chatgpt/callback' },
  { method: 'POST', url: '/api/ai/chatgpt/logout' },
  { method: 'POST', url: '/api/ai/try' },
  { method: 'POST', url: '/api/ai/edit' },
  { method: 'GET', url: '/api/ai/agents' },
  { method: 'POST', url: '/api/ai/agents' },
  { method: 'GET', url: '/api/ai/agents/1' },
  { method: 'PUT', url: '/api/ai/agents/1' },
  { method: 'PUT', url: '/api/ai/agents/1/resolution-check' },
  { method: 'DELETE', url: '/api/ai/agents/1' },
  { method: 'POST', url: '/api/ai/agents/1/documents' },
  { method: 'POST', url: '/api/ai/agents/1/documents/text' },
  { method: 'GET', url: '/api/ai/agents/1/documents/1' },
  { method: 'PATCH', url: '/api/ai/agents/1/documents/1' },
  { method: 'DELETE', url: '/api/ai/agents/1/documents/1' },
  { method: 'POST', url: '/api/ai/agents/1/try' },
  { method: 'POST', url: '/api/ai/agents/1/edit' },
  { method: 'GET', url: '/api/ai/agents/1/groups' },
  { method: 'PUT', url: '/api/ai/agents/1/groups' },
  { method: 'PUT', url: '/api/ai/agents/1/group-chats' },
  { method: 'PUT', url: '/api/ai/agents/1/direct' },
  { method: 'GET', url: '/api/ai/voice' },
  { method: 'PATCH', url: '/api/ai/voice' },
  { method: 'POST', url: '/api/ai/voice/download' },
  { method: 'POST', url: '/api/ai/voice/cancel' },
  { method: 'DELETE', url: '/api/ai/voice/model' },
  { method: 'PUT', url: '/api/ai/reply-suggestions' },
  { method: 'GET', url: '/api/ai/reply-suggestions/model' },
  { method: 'PUT', url: '/api/ai/fix-english' },
  { method: 'GET', url: '/api/ai/phrases' },
  { method: 'POST', url: '/api/ai/phrases' },
  { method: 'PUT', url: '/api/ai/phrases/1' },
  { method: 'DELETE', url: '/api/ai/phrases/1' },
  { method: 'POST', url: '/api/ai/phrases/rebuild' },
  { method: 'GET', url: '/api/ai/templates' },
  { method: 'POST', url: '/api/ai/templates/refresh' },
] as const;

let t: TestApp;
let adminCookie: string;
let agentCookie: string;
beforeAll(async () => {
  t = await makeTestApp();
  const auth = t.ctx.services.auth!;
  const create = (username: string, role: 'admin' | 'agent') =>
    auth.createUser({
      username,
      displayName: username,
      role,
      password: 'password123',
      mustChangePassword: false,
    });
  const admin = create('admin', 'admin');
  const agent = create('agent', 'agent');
  adminCookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 't' })}`;
  agentCookie = `sid=${auth.createSession(agent.id, { ip: '127.0.0.1', userAgent: 't' })}`;
});
afterAll(async () => {
  await t.close();
});

it.each(ROUTES)('$method $url is admin-only', async ({ method, url }) => {
  const anonymous = await t.app.inject({
    method,
    url,
    headers: { host: 'localhost', origin: 'http://localhost' },
  });
  expect(anonymous.statusCode).toBe(401);
  const agent = await t.app.inject({ method, url, headers: authHeaders(agentCookie) });
  expect(agent.statusCode).toBe(403);
});

it.each(ROUTES.filter((route) => route.method !== 'GET'))(
  '$method $url rejects a foreign Origin even for an admin',
  async ({ method, url }) => {
    const res = await t.app.inject({
      method,
      url,
      headers: { cookie: adminCookie, host: 'localhost', origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_origin');
  },
);

/** Flattens Fastify's printRoutes() tree into `METHOD path` pairs (HEAD ignored). */
function registeredRoutes(tree: string): string[] {
  const found: string[] = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const m = /^((?:[│ ] {3})*)[├└]── (\S+) \(([^)]*)\)/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    const path = stack.join('');
    for (const method of m[3]!.split(', ')) if (method !== 'HEAD') found.push(`${method} ${path}`);
  }
  return found;
}

it('lists every registered /api/ai route in the table above', () => {
  const normalize = (path: string) =>
    path.replace(/\/agents\/\d+/, '/agents/:agentId').replace(/\/\d+(?=\/|$)/g, '/:id');
  const registered = registeredRoutes(t.app.printRoutes({ commonPrefix: false })).filter((r) =>
    /^\S+ \/api\/ai(\/|$)/.test(r),
  );
  expect(registered.length).toBeGreaterThanOrEqual(ROUTES.length);
  const table = ROUTES.map((r) => `${r.method} ${normalize(r.url)}`);
  expect(registered.filter((r) => !table.includes(r))).toEqual([]);
  expect(table.filter((r) => !registered.includes(r))).toEqual([]);
});

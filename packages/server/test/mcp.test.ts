import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { User } from '@ezychat/shared';
import { setMcpEnabled } from '../src/mcp/settings.js';
import { makeTestApp, type TestApp } from './helpers.js';

const LID = '9001@lid';
const PN = '60123456789@s.whatsapp.net';
const ACCEPT = 'application/json, text/event-stream';

let t: TestApp;
let admin: User;
let secret: string;
let adminCookie: string;

const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };

const initialize = rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
});

function post(
  body: unknown,
  opts: { token?: string | null; headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  const token = opts.token === undefined ? secret : opts.token;
  return t.app.inject({
    method: 'POST',
    url: '/mcp',
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      accept: ACCEPT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    payload: JSON.stringify(body),
  });
}

async function callTool(name: string, args: Record<string, unknown>, token?: string) {
  const res = await post(rpc('tools/call', { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  return res.json().result as { content: Array<{ text: string }>; isError?: boolean };
}
const data = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

async function waitFor(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 3000) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  t = await makeTestApp({ listen: true });
  const auth = t.ctx.services.auth!;
  admin = auth.createUser({
    username: 'owner',
    displayName: 'Owner',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  adminCookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 't' })}`;
  secret = t.ctx.services.apiTokens!.create(
    admin.id,
    { name: 'test', expiresInDays: 90 },
    'ip',
  ).secret;

  t.wa.simulateIncoming({
    chatJid: LID,
    chatJidAlt: PN,
    body: 'Hi, how much is the blue one?',
    senderName: 'Aminah',
  });
  t.wa.simulateIncoming({ chatJid: LID, chatJidAlt: PN, body: 'x'.repeat(5000) });
  await waitFor(
    () => (t.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n === 2,
  );
});
afterAll(async () => {
  await t.close();
});

describe('exposure', () => {
  it('is invisible while Claude access is off, even with a valid token', async () => {
    setMcpEnabled(t.ctx, false);
    const res = await post(initialize);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    setMcpEnabled(t.ctx, true);
  });

  it('checks access before parsing the body (malformed or oversized bodies change nothing)', async () => {
    const raw = (payload: string, token: string | null) =>
      t.app.inject({
        method: 'POST',
        url: '/mcp',
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost',
          'content-type': 'application/json',
          accept: ACCEPT,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload,
      });
    setMcpEnabled(t.ctx, false);
    expect((await raw('{not json', secret)).statusCode).toBe(404);
    expect((await raw('x'.repeat(2 * 1024 * 1024), secret)).statusCode).toBe(404);
    setMcpEnabled(t.ctx, true);
    expect((await raw('{not json', null)).statusCode).toBe(401);
    expect((await raw('{not json', secret)).statusCode).toBe(400);
  });

  it('refuses LAN peers and loopback peers with a forged tunnel header', async () => {
    setMcpEnabled(t.ctx, true);
    expect((await post(initialize, { remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
    const forged = await post(initialize, { headers: { 'cf-connecting-ip': 'not-an-ip' } });
    expect(forged.statusCode).toBe(403);
  });

  it('accepts direct loopback and the tunnel', async () => {
    setMcpEnabled(t.ctx, true);
    expect((await post(initialize)).statusCode).toBe(200);
    const tunnel = await post(initialize, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(tunnel.statusCode).toBe(200);
  });

  it('rejects a cross-site browser Origin', async () => {
    setMcpEnabled(t.ctx, true);
    const res = await post(initialize, { headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('authentication', () => {
  it('requires a bearer token; a session cookie is not enough', async () => {
    setMcpEnabled(t.ctx, true);
    const none = await post(initialize, { token: null });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Bearer /);
    const cookie = await post(initialize, { token: null, headers: { cookie: adminCookie } });
    expect(cookie.statusCode).toBe(401);
    const wrong = await post(initialize, { token: `ezc_pat_${'B'.repeat(43)}` });
    expect(wrong.statusCode).toBe(401);
    const audits = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'api_token.auth_failed'")
      .all() as Array<{ meta: string }>;
    // Throttled to one row per IP and reason per minute.
    expect(audits.map((a) => JSON.parse(a.meta).reason).sort()).toEqual(['malformed', 'unknown']);
  });

  it('stops working as soon as the token is revoked', async () => {
    setMcpEnabled(t.ctx, true);
    const tokens = t.ctx.services.apiTokens!;
    const extra = tokens.create(admin.id, { name: 'short', expiresInDays: 30 }, 'ip');
    expect((await post(initialize, { token: extra.secret })).statusCode).toBe(200);
    tokens.revoke(extra.token.id, admin.id, 'ip');
    expect((await post(initialize, { token: extra.secret })).statusCode).toBe(401);
  });

  it('answers GET and DELETE with 405 instead of the web app', async () => {
    setMcpEnabled(t.ctx, true);
    const res = await t.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { host: 'localhost', accept: ACCEPT, authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('POST');
  });
});

describe('protocol and tools', () => {
  it('works end to end with the official MCP client', async () => {
    setMcpEnabled(t.ctx, true);
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      'get_activity',
      'get_ai_agent_setup',
      'get_ai_context_item',
      'get_ai_setup_history',
      'get_ai_setup_version',
      'get_chat',
      'get_message_file',
      'get_messages',
      'get_stats',
      'list_ai_agents',
      'list_chats',
      'try_ai_reply',
      'update_ai_setup',
    ]);
    // Inbox tools stay read-only; only the AI setup change tool is marked as a write.
    expect(tools.filter((x) => x.annotations?.readOnlyHint !== true).map((x) => x.name)).toEqual([
      'update_ai_setup',
    ]);
    const result = (await client.callTool({ name: 'list_chats', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0]!.text).chats[0].jid).toBe(LID);
    await client.close();
  });

  it('get_chat accepts the phone-number form of a chat', async () => {
    setMcpEnabled(t.ctx, true);
    const chat = data(await callTool('get_chat', { jid: PN }));
    expect(chat.chat.jid).toBe(LID);
    expect(Array.isArray(chat.history)).toBe(true);
    const missing = await callTool('get_chat', { jid: '1@s.whatsapp.net' });
    expect(missing.isError).toBe(true);
  });

  it('get_messages returns text without media links and cuts very long text', async () => {
    setMcpEnabled(t.ctx, true);
    const page = data(await callTool('get_messages', { jid: LID }));
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]).toMatchObject({
      from: 'customer',
      text: 'Hi, how much is the blue one?',
      media: null,
    });
    expect(page.messages[1].truncated).toBe(true);
    expect(page.messages[1].text).toHaveLength(4000);
    expect(JSON.stringify(page)).not.toContain('mediaUrl');
  });

  it('validates tool arguments', async () => {
    setMcpEnabled(t.ctx, true);
    const res = await callTool('list_chats', { limit: 1000 });
    expect(res.isError).toBe(true);
  });

  it('get_stats counts open chats waiting for a reply', async () => {
    setMcpEnabled(t.ctx, true);
    const stats = data(await callTool('get_stats', { days: 3 }));
    expect(stats.timeZone).toBe('Asia/Kuala_Lumpur');
    expect(stats.chats.open).toBe(1);
    expect(stats.waitingForReply.count).toBe(1);
    expect(stats.openByAssignee).toEqual([{ assignee: null, count: 1 }]);
    expect(stats.daily).toHaveLength(3);
    expect(stats.daily[2].inbound).toBe(2);
  });

  it('get_activity reports peak hours and waits by name, never by user id', async () => {
    setMcpEnabled(t.ctx, true);
    const activity = data(await callTool('get_activity', { days: 3 }));
    expect(activity.timeZone).toBe('Asia/Kuala_Lumpur');
    expect(activity.byHour).toHaveLength(24);
    expect(Object.keys(activity.newConversationsHeatmap)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(activity.firstReply.unanswered).toBe(1);
    expect(typeof activity.from).toBe('string');
    for (const r of activity.responders) expect(r).not.toHaveProperty('userId');
  });

  it('a tool call fails when the token is revoked between authentication and the call', async () => {
    setMcpEnabled(t.ctx, true);
    const tokens = t.ctx.services.apiTokens!;
    const extra = tokens.create(admin.id, { name: 'race', expiresInDays: 30 }, 'ip');
    const realStillValid = tokens.stillValid;
    tokens.stillValid = () => false;
    try {
      const res = await callTool('list_chats', {}, extra.secret);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/no longer valid/);
    } finally {
      tokens.stillValid = realStillValid;
    }
  });
});

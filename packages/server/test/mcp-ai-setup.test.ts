import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { User } from '@ezychat/shared';
import type { AiProvider } from '../src/ai/provider-types.js';
import { createAiService } from '../src/ai/service.js';
import { audit } from '../src/db/audit.js';
import { setMcpEnabled } from '../src/mcp/settings.js';
import { makeTestApp, type TestApp } from './helpers.js';

const ACCEPT = 'application/json, text/event-stream';
const API_KEY = 'test-api-key-123456';
let t: TestApp;
let admin: User;
let secret: string;
let tokenId: number;
let provider: AiProvider;
let id = 0;

async function call(name: string, args: Record<string, unknown> = {}, token = secret) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/mcp',
    remoteAddress: '127.0.0.1',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      accept: ACCEPT,
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.statusCode).toBe(200);
  const result = res.json().result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    isError: result.isError === true,
    text: result.content[0]!.text,
    data: () => JSON.parse(result.content[0]!.text),
  };
}

async function listTools(token = secret) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/mcp',
    remoteAddress: '127.0.0.1',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      accept: ACCEPT,
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/list' }),
  });
  return res.json().result.tools as Array<{
    name: string;
    annotations?: { readOnlyHint?: boolean };
  }>;
}

beforeEach(async () => {
  t = await makeTestApp();
  const auth = t.ctx.services.auth!;
  admin = auth.createUser({
    username: 'owner',
    displayName: 'Owner',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  await t.ctx.services.ai!.shutdown();
  provider = {
    generate: vi.fn().mockResolvedValue({ reply: 'We sell ChatGPT Business.', action: 'reply' }),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(),
  };
  const ai = createAiService(t.ctx, { provider });
  t.ctx.services.ai = ai;
  const actor = { userId: admin.id, ip: null };
  ai.saveConnection({ mode: 'api', model: '', apiKey: API_KEY }, actor);
  ai.saveMember(
    {
      displayName: 'Sales Agent',
      enabled: false,
      instructions: 'Be concise.',
      handoffRules: '- The customer wants a bulk or custom order, or a quotation',
    },
    actor,
  );
  ai.addText(
    null,
    { name: 'Prices', text: 'ChatGPT Business costs RM120 per user per month.' },
    actor,
  );
  ai.addDocument(null, 'catalogue.pdf', 1000, 'Catalogue text', actor);
  setMcpEnabled(t.ctx, true);
  const created = t.ctx.services.apiTokens!.create(
    admin.id,
    { name: 'test', expiresInDays: 30 },
    'ip',
  );
  secret = created.secret;
  tokenId = created.token.id;
});
afterEach(async () => {
  await t.close();
});

describe('AI setup over MCP', () => {
  it('lists the setup tools; only update_ai_setup is marked as changing anything', async () => {
    const tools = await listTools();
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
    const writes = tools.filter((x) => x.annotations?.readOnlyHint === false).map((x) => x.name);
    expect(writes).toEqual(['update_ai_setup']);
  });

  it('a token without ai:setup sees only the inbox tools', async () => {
    t.ctx.db.prepare("UPDATE api_tokens SET scopes = 'inbox:read' WHERE id = ?").run(tokenId);
    const names = (await listTools()).map((x) => x.name);
    expect(names).not.toContain('update_ai_setup');
    expect(names).toContain('list_chats');
  });

  it('reads the setup and a context item, never the key', async () => {
    const setup = await call('get_ai_agent_setup');
    expect(setup.isError).toBe(false);
    expect(setup.text).not.toContain(API_KEY);
    const data = setup.data();
    expect(data).toMatchObject({
      name: 'Sales Agent',
      enabled: false,
      instructions: 'Be concise.',
    });
    expect(data.handoffRules).toContain('quotation');
    const prices = data.businessContext.find((d: { name: string }) => d.name === 'Prices');
    expect(prices).toMatchObject({ kind: 'text', editable: true });
    const item = (await call('get_ai_context_item', { id: prices.id })).data();
    expect(item.text).toContain('RM120');
  });

  it('changes the hand-off rules, keeping the old text, the reason and an audit row', async () => {
    const rules = '- The customer explicitly asks for a formal quotation, or confirms an order';
    const res = await call('update_ai_setup', {
      target: 'handoff_rules',
      text: rules,
      reason: 'Only hand off on explicit quotation requests',
    });
    expect(res.isError).toBe(false);
    expect(t.ctx.services.ai!.status().settings.handoffRules).toBe(rules);

    const history = (await call('get_ai_setup_history', { target: 'handoff_rules' })).data();
    // Newest first: this change, the setup's own app save, then the default text it replaced.
    expect(history.versions).toHaveLength(3);
    expect(history.versions[0]).toMatchObject({
      changedIn: 'AI assistant (MCP)',
      by: 'Owner',
      tokenId,
      reason: 'Only hand off on explicit quotation requests',
      preview: rules,
    });
    expect(history.versions[1]).toMatchObject({ changedIn: 'app', by: 'Owner' });
    expect(history.versions[1].preview).toContain('bulk or custom order');
    expect(history.versions[2]).toMatchObject({ changedIn: 'original text' });

    const row = t.ctx.db
      .prepare(
        "SELECT user_id, meta FROM audit_log WHERE action = 'ai.member_update' ORDER BY id DESC",
      )
      .get() as { user_id: number; meta: string };
    expect(row.user_id).toBe(admin.id);
    expect(JSON.parse(row.meta)).toMatchObject({
      via: 'mcp',
      tokenId,
      reason: 'Only hand off on explicit quotation requests',
      handoffRulesChanged: true,
      instructionsChanged: false,
    });
  });

  it('records app saves in the same history', async () => {
    t.ctx.services.ai!.saveMember(
      { displayName: 'Sales Agent', enabled: false, instructions: 'Be warm.', handoffRules: '' },
      { userId: admin.id, ip: null },
    );
    const history = (await call('get_ai_setup_history', { target: 'instructions' })).data();
    // This save, the setup's earlier save, and the default instructions both replaced.
    expect(history.versions.map((v: { changedIn: string }) => v.changedIn)).toEqual([
      'app',
      'app',
      'original text',
    ]);
    expect(history.versions[0].preview).toBe('Be warm.');
  });

  it('adds and edits Business context text, but never uploaded files', async () => {
    const added = await call('update_ai_setup', {
      target: 'context_text',
      name: 'How we sell AI tools',
      text: 'Ask for company name and number of users before offering a quotation.',
      reason: 'Help the agent qualify B2B enquiries',
    });
    expect(added.isError).toBe(false);
    const setup = (await call('get_ai_agent_setup')).data();
    const playbook = setup.businessContext.find(
      (d: { name: string }) => d.name === 'How we sell AI tools',
    );
    expect(playbook).toBeTruthy();
    const edited = await call('update_ai_setup', {
      target: 'context_text',
      itemId: playbook.id,
      text: 'Ask for company name, number of users and plan.',
      reason: 'Also ask for the plan',
    });
    expect(edited.isError).toBe(false);
    const history = (
      await call('get_ai_setup_history', { target: 'context_text', itemId: playbook.id })
    ).data();
    expect(history.versions.map((v: { preview: string }) => v.preview)).toEqual([
      'Ask for company name, number of users and plan.',
      'Ask for company name and number of users before offering a quotation.',
    ]);

    const file = setup.businessContext.find((d: { kind: string }) => d.kind === 'file');
    const refused = await call('update_ai_setup', {
      target: 'context_text',
      itemId: file.id,
      text: 'x',
      reason: 'try to edit a file',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/files cannot be changed/i);
  });

  it('tests a reply with draft rules without saving them', async () => {
    const draft = '- The customer explicitly asks for a formal quotation';
    const res = await call('try_ai_reply', {
      message: 'Do you provide ChatGPT Business?',
      handoffRules: draft,
    });
    expect(res.isError).toBe(false);
    expect(res.data()).toMatchObject({
      reply: 'We sell ChatGPT Business.',
      action: 'reply',
      usedDraft: { handoffRules: true, instructions: false },
    });
    const settingsSent = vi.mocked(provider.generate).mock.calls[0]![0] as { handoffRules: string };
    expect(settingsSent.handoffRules).toBe(draft);
    expect(t.ctx.services.ai!.status().settings.handoffRules).toContain('bulk or custom order');
  });

  it('limits test replies (10 a minute) and changes (20 an hour) per token', async () => {
    for (let i = 0; i < 10; i++)
      expect((await call('try_ai_reply', { message: `price ${i}?` })).isError).toBe(false);
    const tooMany = await call('try_ai_reply', { message: 'one more?' });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toMatch(/Too many test replies/);

    for (let i = 0; i < 20; i++)
      expect(
        (
          await call('update_ai_setup', {
            target: 'instructions',
            text: `v${i}`,
            reason: 'tuning tone',
          })
        ).isError,
      ).toBe(false);
    const blocked = await call('update_ai_setup', {
      target: 'instructions',
      text: 'v21',
      reason: 'tuning tone',
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/Too many setup changes/);
  });

  it('refuses texts the app would refuse (too long, empty context)', async () => {
    const long = await call('update_ai_setup', {
      target: 'instructions',
      text: 'x'.repeat(8001),
      reason: 'too long on purpose',
    });
    expect(long.isError).toBe(true);
    expect(long.text).toMatch(/at most 8,000 characters/);
    const rules = await call('update_ai_setup', {
      target: 'handoff_rules',
      text: 'y'.repeat(4001),
      reason: 'too long on purpose',
    });
    expect(rules.isError).toBe(true);
    const setup = (await call('get_ai_agent_setup')).data();
    const prices = setup.businessContext.find((d: { name: string }) => d.name === 'Prices');
    const empty = await call('update_ai_setup', {
      target: 'context_text',
      itemId: prices.id,
      text: '   ',
      reason: 'empty on purpose',
    });
    expect(empty.isError).toBe(true);
    expect(t.ctx.services.ai!.status().settings.instructions).toBe('Be concise.');
    expect((await call('get_ai_context_item', { id: prices.id })).data().text).toContain('RM120');
  });

  it('pages long context items and versions so the complete text can be kept or restored', async () => {
    // 45,000 characters with a 4-byte emoji at a page boundary: pages must join back exactly.
    const long = 'a'.repeat(19_999) + '😀' + 'b'.repeat(25_000);
    const added = await call('update_ai_setup', {
      target: 'context_text',
      name: 'Catalogue text',
      text: long,
      reason: 'large catalogue',
    });
    expect(added.isError).toBe(false);
    const setup = (await call('get_ai_agent_setup')).data();
    const item = setup.businessContext.find((d: { name: string }) => d.name === 'Catalogue text');
    const read = async (tool: string, args: Record<string, unknown>) => {
      let joined = '';
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const pageData = (await call(tool, { ...args, offset })).data();
        joined += pageData.text;
        // lastPage and nextOffset agree on every page.
        expect(pageData.lastPage).toBe(pageData.nextOffset === null);
        offset = pageData.nextOffset;
        pages++;
      }
      return { joined, pages };
    };
    const itemText = await read('get_ai_context_item', { id: item.id });
    expect(itemText.pages).toBe(3);
    expect(itemText.joined).toBe(long);

    const history = (
      await call('get_ai_setup_history', { target: 'context_text', itemId: item.id })
    ).data();
    expect(history.versions[0]).toMatchObject({ previewOnly: true, totalCharacters: 45_000 });
    const version = await read('get_ai_setup_version', {
      versionId: history.versions[0].versionId,
    });
    expect(version.joined).toBe(long);
  });

  it('get_stats reports AI hand-offs per reason', async () => {
    for (const reason of ['business_rule', 'business_rule', 'missing_facts'])
      audit(t.ctx.db, {
        userId: null,
        action: 'ai.handoff',
        ip: null,
        meta: { chatJid: 'x@s.whatsapp.net', assignedTo: null, reason },
      });
    const stats = (await call('get_stats', { days: 2 })).data();
    expect(stats.ai.handoffsByReason).toEqual({ business_rule: 2, missing_facts: 1 });
    expect(stats.ai.totals.handoffs).toBe(3);
    expect(stats.ai.daily).toHaveLength(2);
  });

  it('get_stats adds new customers and the chats still waiting after an AI hand-off', async () => {
    // Midday in the business time zone: a message 2 hours old is still "today" (missed needs > 1 hour),
    // so the count does not depend on when the suite runs. Only Date is faked; timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00+08:00'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO chats (jid, type, name, unread_count, status, updated_at)
         VALUES ('w@s.whatsapp.net', 'dm', 'W', 0, 'open', 0)`,
      )
      .run();
    t.ctx.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, from_me, type, body, status, timestamp, created_at)
         VALUES ('w1', 'w@s.whatsapp.net', 0, 'text', 'hi', 'sent', ?, ?)`,
      )
      .run(now - 2 * 3_600_000, now - 2 * 3_600_000);
    audit(t.ctx.db, {
      userId: null,
      action: 'ai.handoff',
      ip: null,
      meta: { chatJid: 'w@s.whatsapp.net', assignedTo: null, reason: 'missing_facts' },
    });
    const stats = (await call('get_stats', { days: 1 })).data();
    expect(stats.customers).toMatchObject({
      newCustomers: 1,
      missedNewCustomers: 1,
      waitingAfterAiHandoff: { count: 1 },
    });
    expect(typeof stats.customers.waitingAfterAiHandoff.oldestHandoffAt).toBe('string');
  });
});

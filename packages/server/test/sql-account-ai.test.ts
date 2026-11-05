import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import type { SqlAgentSettings } from '@ezychat/shared';
import { listAgents } from '../src/ai/agents.js';
import { CORE_AGENT_TOOL_NAMES } from '../src/ai/agent/extension-tools.js';
import { agentLookupsAvailable, agentTurnTools } from '../src/ai/agent/turn-tools.js';
import { FAKE_SQL_ACCESS_KEY, FAKE_SQL_SECRET } from '../src/connectors/sql-account/fake.js';
import { mergeSqlAccountRows } from '../src/connectors/sql-account/repo.js';
import { RECHECK_MS, createSqlAccountService } from '../src/connectors/sql-account/service.js';
import {
  QUOTES_PER_CHAT_DAY,
  SQL_TOOL_NAMES,
  sqlLookupsAvailable,
} from '../src/connectors/sql-account/tools.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';

const FARAH = '60123110021@s.whatsapp.net';
const PRIYA = '60128814455@s.whatsapp.net';
const JASON = '60129001234@s.whatsapp.net';
const AHMAD = '60125550142@s.whatsapp.net';

let t: TestApp;
let adminId: number;
let agentId: number;
let aiUserId: number;
let clock = Date.now();
afterEach(async () => {
  await t?.close();
});

async function call(tools: ToolSet, name: string, input: object): Promise<string> {
  const execute = tools[name]?.execute as
    ((input: object, options: object) => Promise<string>) | undefined;
  if (!execute) throw new Error(`tool ${name} not offered`);
  return execute(input, { toolCallId: `call-${name}`, messages: [], abortSignal: undefined });
}

async function setUp(settings: Partial<SqlAgentSettings> = {}, connect = true) {
  t = await makeTestApp({
    beforeBuild: (ctx) => {
      ctx.services.sqlAccount = createSqlAccountService(ctx, { sleep: () => Promise.resolve() });
    },
  });
  adminId = t.ctx.services.auth!.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  }).id;
  t.ctx.services.ai!.saveMember(
    { displayName: 'Aina', enabled: false, instructions: '' },
    { userId: adminId, ip: null },
  );
  const agent = listAgents(t.ctx.db)[0]!;
  agentId = agent.id;
  aiUserId = agent.userId;
  for (const jid of [FARAH, PRIYA, JASON, AHMAD]) await says(jid, 'hello');
  const svc = t.ctx.services.sqlAccount!;
  if (connect) {
    const res = await svc.connect(
      { accessKey: FAKE_SQL_ACCESS_KEY, secretKey: FAKE_SQL_SECRET },
      { userId: adminId, ip: null },
    );
    expect(res.ok).toBe(true);
    await svc.indexReady();
  }
  svc.saveAgentSettings(
    agentId,
    { access: {}, showPrice: true, stockDetail: 'inStock', ...settings },
    { userId: adminId, ip: null },
  );
  return svc;
}

let seq = 0;
async function says(chatJid: string, text: string) {
  clock += 1000;
  await getMessages(t.ctx).ingest(
    {
      id: `in-${++seq}`,
      chatJid,
      body: text,
      type: 'text',
      fromMe: false,
      senderJid: chatJid,
      senderName: 'Customer',
      timestamp: clock,
      quotedId: null,
      media: null,
    },
    'live',
  );
}

/** The AI's own reply in the chat (shows the draft). */
function aiReplies(chatJid: string) {
  clock += 1000;
  t.ctx.db
    .prepare(
      `INSERT INTO messages (id, chat_jid, from_me, sent_by_user_id, type, body, timestamp, created_at)
       VALUES (?, ?, 1, ?, 'text', 'Here is your quotation', ?, ?)`,
    )
    .run(`ai-${++seq}`, chatJid, aiUserId, clock, clock);
}

const turn = (chatJid: string | null, lookupsOnly = false) => {
  const onFailure = vi.fn();
  return agentTurnTools(
    t.ctx,
    t.ctx.log,
    { agent: 'sales', agentId, chatJid, signal: new AbortController().signal },
    { onFailure, lookupsOnly },
  ).then((tools) => ({ ...tools, onFailure }));
};

const activity = () =>
  t.ctx.services.sqlAccount!.activity().map((a) => `${a.tool}:${a.result}:${a.reason ?? ''}`);

describe('SQL Account AI tools', () => {
  it('keeps every SQL Account tool name reserved for the core', () => {
    for (const name of SQL_TOOL_NAMES) expect(CORE_AGENT_TOOL_NAMES).toContain(name);
  });

  it('offers nothing until SQL Account is connected', async () => {
    await setUp({}, false);
    const tools = Object.keys((await turn(FARAH)).tools);
    expect(tools.filter((n) => n.startsWith('sql_'))).toEqual([]);
    expect(sqlLookupsAvailable(t.ctx, agentId)).toBe(false);
    expect(sqlLookupsAvailable(t.ctx, null)).toBe(false);
  });

  it('builds the tools from the object access (defaults: stock, invoices and documents)', async () => {
    await setUp();
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(true);
    expect(
      Object.keys((await turn(FARAH)).tools)
        .filter((n) => n.startsWith('sql_'))
        .sort(),
    ).toEqual(['sql_check_stock', 'sql_document_status', 'sql_my_account']);
    // Group turns and Try it: the stock look-up only.
    expect(
      Object.keys((await turn(FARAH, true)).tools).filter((n) => n.startsWith('sql_')),
    ).toEqual(['sql_check_stock']);
    expect(Object.keys((await turn(null)).tools).filter((n) => n.startsWith('sql_'))).toEqual([
      'sql_check_stock',
    ]);
  });

  it('offers nothing when every object is off', async () => {
    await setUp({
      access: {
        stockitem: 'off',
        salesinvoice: 'off',
        salesquotation: 'off',
        salesorder: 'off',
        deliveryorder: 'off',
      },
    });
    expect(Object.keys((await turn(FARAH)).tools).filter((n) => n.startsWith('sql_'))).toEqual([]);
    expect(sqlLookupsAvailable(t.ctx, agentId)).toBe(false);
  });

  it('checks stock with price and in stock / out of stock, never cost', async () => {
    await setUp();
    const tools = (await turn(FARAH)).tools;
    const out = JSON.parse(await call(tools, 'sql_check_stock', { query: 'kopi' }));
    expect(out.items).toEqual([
      { code: 'KP-L', description: 'Kopi Peng Large', price: '6.50', stock: 'in stock' },
      { code: 'KP-R', description: 'Kopi Peng Regular', price: '4.80', stock: 'out of stock' },
    ]);
    expect(JSON.stringify(out)).not.toContain('2.10');
    const byCode = JSON.parse(await call(tools, 'sql_check_stock', { query: 'NL-01' }));
    expect(byCode.items).toHaveLength(1);
    const none = JSON.parse(await call(tools, 'sql_check_stock', { query: 'durian' }));
    expect(none.items).toEqual([]);
    expect(activity()).toContain('stock:done:');
  });

  it('shows the exact quantity and hides the price when chosen', async () => {
    await setUp({ showPrice: false, stockDetail: 'quantity' });
    const out = JSON.parse(
      await call((await turn(FARAH)).tools, 'sql_check_stock', { query: 'KP-L' }),
    );
    expect(out.items).toEqual([{ code: 'KP-L', description: 'Kopi Peng Large', stock: 42 }]);
  });

  it('shows a customer only their own invoices, and no balance', async () => {
    await setUp({ access: { customer: 'read' } });
    const out = JSON.parse(await call((await turn(FARAH)).tools, 'sql_my_account', {}));
    expect(out.customer).toEqual({
      code: '300-F0001',
      company: 'Farah Catering Co',
      creditTerm: '30 Days',
      stillOwed: '2100.00',
    });
    expect(out.asOf).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(out.note).toMatch(/as recorded in our accounts on/);
    expect(out.invoices.map((i: { number: string }) => i.number)).toEqual(['IV-02305', 'IV-02231']);
    expect(JSON.stringify(out)).not.toContain('IV-02310');
    expect(JSON.stringify(out)).not.toContain('creditlimit');
    expect(JSON.stringify(out)).not.toContain('30000');
  });

  it('tells a customer what they still owe from their own customer invoices only', async () => {
    await setUp({ access: { customerinvoice: 'read', salesinvoice: 'off' } });
    const out = JSON.parse(await call((await turn(FARAH)).tools, 'sql_my_account', {}));
    expect(out.unpaidInvoices).toEqual([
      {
        number: 'IV-02305',
        date: '2026-10-28',
        dueDate: '2026-11-27',
        total: '860.00',
        paid: '0.00',
        stillOwed: '860.00',
      },
      {
        number: 'IV-02231',
        date: '2026-10-12',
        dueDate: '2026-11-11',
        total: '1240.00',
        paid: '0.00',
        stillOwed: '1240.00',
      },
    ]);
    expect(out.customer).toBeUndefined();
    expect(out.invoices).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('IV-02190');
    expect(JSON.stringify(out)).not.toContain('IV-02310');
    const priya = JSON.parse(await call((await turn(PRIYA)).tools, 'sql_my_account', {}));
    expect(priya.unpaidInvoices).toEqual([]);
    const requests = t.ctx.services.sqlAccount!.fake!.requests.filter(
      (r) => r.path === '/customerinvoice',
    );
    expect(requests.every((r) => r.query.code)).toBe(true);
  });

  it('describes the account tool without a balance when no amount object is on', async () => {
    await setUp();
    const tools = (await turn(FARAH)).tools;
    expect(String(tools.sql_my_account?.description)).toMatch(/no unpaid balance/);
    const out = JSON.parse(await call(tools, 'sql_my_account', {}));
    expect(out.note).toMatch(/never work one out/);
  });

  it('hands over when the chat is not matched, or several customers share the number', async () => {
    await setUp();
    const none = JSON.parse(await call((await turn(AHMAD)).tools, 'sql_my_account', {}));
    expect(none.found).toBe(false);
    expect(none.note).toMatch(/hand the chat over/);
    const several = JSON.parse(await call((await turn(JASON)).tools, 'sql_my_account', {}));
    expect(several.found).toBe(false);
    expect(activity()).toEqual(
      expect.arrayContaining(['account:refused:no_customer', 'account:refused:several']),
    );
  });

  it('uses the teammate link over the phone number', async () => {
    const svc = await setUp();
    await svc.link(JASON, '300-J0003', { userId: adminId, ip: null });
    const out = JSON.parse(await call((await turn(JASON)).tools, 'sql_my_account', {}));
    expect(out.invoices).toEqual([]);
    // A link to a code that no longer exists is no match.
    t.ctx.services.sqlAccount!.fake!.data.customer =
      t.ctx.services.sqlAccount!.fake!.data.customer!.filter((c) => c.code !== '300-J0003');
    const gone = JSON.parse(await call((await turn(JASON)).tools, 'sql_my_account', {}));
    expect(gone.found).toBe(false);
  });

  it("finds only the customer's own documents", async () => {
    await setUp();
    const tools = (await turn(FARAH)).tools;
    const own = JSON.parse(
      await call(tools, 'sql_document_status', { type: 'salesorder', docNo: 'so-00412' }),
    );
    expect(own).toEqual({
      found: true,
      type: 'salesorder',
      number: 'SO-00412',
      date: '2026-11-02',
      total: '412.00',
    });
    const other = JSON.parse(
      await call(tools, 'sql_document_status', { type: 'salesorder', docNo: 'SO-00399' }),
    );
    expect(other.found).toBe(false);
    // The request itself carried the customer's code.
    const requests = t.ctx.services.sqlAccount!.fake!.requests.filter(
      (r) => r.path === '/salesorder',
    );
    expect(requests.every((r) => r.query.code === '300-F0001')).toBe(true);
    expect(activity()).toContain('document:refused:not_own');
  });

  it("lists the customer's payments when Customer payments is on", async () => {
    await setUp({ access: { customerpayment: 'read' } });
    const out = JSON.parse(await call((await turn(FARAH)).tools, 'sql_my_payments', {}));
    expect(out.payments).toEqual([{ number: 'OR-00120', date: '2026-10-20', amount: '500.00' }]);
    const none = JSON.parse(await call((await turn(AHMAD)).tools, 'sql_my_payments', {}));
    expect(none.found).toBe(false);
  });

  it('ends the turn and changes the state when SQL Account fails', async () => {
    const svc = await setUp();
    const turned = await turn(FARAH);
    svc.fake!.scenario = 'bad_keys';
    await expect(call(turned.tools, 'sql_check_stock', { query: 'kopi' })).rejects.toMatchObject({
      kind: 'bad_keys',
    });
    expect(turned.failed()).toBe(true);
    expect(turned.onFailure).toHaveBeenCalled();
    expect(svc.status().state).toBe('bad_keys');
    expect(activity()).toContain('stock:failed:bad_keys');
    // Not connected now: no SQL Account tools in the next turn.
    expect(Object.keys((await turn(FARAH)).tools).some((n) => n.startsWith('sql_'))).toBe(false);
  });

  it('checks the connection again when the last check is old', async () => {
    const now = Date.now();
    const svc = await setUp();
    svc.fake!.scenario = 'unreachable';
    // Fresh check: no new request.
    await svc.recheckIfStale();
    expect(svc.status().state).toBe('connected');
    t.ctx.settings.set('sql_account_state', {
      state: 'connected',
      checkedAt: now - RECHECK_MS - 1,
    });
    await svc.recheckIfStale();
    expect(svc.status().state).toBe('unreachable');
  });

  it('reads the phone index in the background, shows building, and stops on disconnect', async () => {
    await setUp({}, false);
    let release: () => void = () => {};
    const gated = createSqlAccountService(t.ctx, {
      sleep: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    gated.fake!.phonesOnBranches = false;
    await gated.connect(
      { accessKey: FAKE_SQL_ACCESS_KEY, secretKey: FAKE_SQL_SECRET },
      { userId: adminId, ip: null },
    );
    await vi.waitFor(() => expect(gated.status().phoneMatch).toBe('building'));
    const running = gated.indexReady();
    gated.disconnect({ userId: adminId, ip: null });
    release();
    await running;
    expect(gated.status().phoneMatch).toBe('unknown');
    expect(gated.customers().every((r) => r.kind === 'none')).toBe(true);
  });

  it('records the chat line for look-ups and moves rows when chats merge', async () => {
    await setUp();
    const turned = await turn(FARAH);
    await call(turned.tools, 'sql_check_stock', { query: 'kopi' });
    await call(turned.tools, 'sql_check_stock', { query: 'nasi' });
    expect(turned.used()).toEqual([{ title: 'stock and prices', sourceLabel: 'SQL Account' }]);
    expect(turned.calls()).toHaveLength(2);
    const lid = '123456789@lid';
    mergeSqlAccountRows(t.ctx.db, FARAH, lid);
    const seen = t.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM sql_account_seen_items WHERE chat_jid = ?')
      .get(lid) as { n: number };
    expect(seen.n).toBe(3);
  });
});

describe('SQL Account quotations', () => {
  it('needs Read + create; never in groups or Try it', async () => {
    await setUp({ access: { salesquotation: 'create' } });
    expect(Object.keys((await turn(FARAH)).tools)).toEqual(
      expect.arrayContaining(['sql_quotation_preview', 'sql_create_quotation']),
    );
    expect(Object.keys((await turn(FARAH, true)).tools)).not.toContain('sql_create_quotation');
    expect(Object.keys((await turn(null)).tools)).not.toContain('sql_create_quotation');
  });

  it('prepares only looked-up items with quantities the customer wrote', async () => {
    await setUp({ access: { salesquotation: 'create' } });
    const tools = (await turn(FARAH)).tools;
    expect(
      await call(tools, 'sql_quotation_preview', { items: [{ code: 'KP-L', qty: 20 }] }),
    ).toMatch(/did not come from a stock look-up/);
    await call(tools, 'sql_check_stock', { query: 'KP-L' });
    expect(
      await call(tools, 'sql_quotation_preview', { items: [{ code: 'KP-L', qty: 20 }] }),
    ).toMatch(/did not write the quantity 20/);
    await says(FARAH, 'Can you quote 20 large kopi peng?');
    const draft = JSON.parse(
      await call(tools, 'sql_quotation_preview', { items: [{ code: 'KP-L', qty: 20 }] }),
    );
    expect(draft).toMatchObject({
      lines: [{ item: 'Kopi Peng Large (KP-L)', qty: 20, unitPrice: '6.50', amount: '130.00' }],
      total: '130.00',
    });
    // An unmatched chat gets no draft.
    const other = JSON.parse(
      await call((await turn(AHMAD)).tools, 'sql_quotation_preview', {
        items: [{ code: 'KP-L', qty: 20 }],
      }),
    );
    expect(other.found).toBe(false);
  });

  it('refuses an item without a selling price', async () => {
    const svc = await setUp({ access: { salesquotation: 'create' } });
    svc.fake!.data.stockitem![2]!.refprice = '';
    const tools = (await turn(FARAH)).tools;
    await call(tools, 'sql_check_stock', { query: 'NL-01' });
    await says(FARAH, 'I want 3 nasi lemak');
    expect(
      await call(tools, 'sql_quotation_preview', { items: [{ code: 'NL-01', qty: 3 }] }),
    ).toMatch(/no selling price/);
  });

  it('creates only after the customer confirmed the shown draft, once, within the limits', async () => {
    const svc = await setUp({ access: { salesquotation: 'create' } });
    let tools = (await turn(FARAH)).tools;
    await call(tools, 'sql_check_stock', { query: 'KP-L' });
    await says(FARAH, 'Can you quote 20 large kopi peng?');
    const { draftId } = JSON.parse(
      await call(tools, 'sql_quotation_preview', { items: [{ code: 'KP-L', qty: 20 }] }),
    );
    // Not shown and confirmed yet.
    expect(await call(tools, 'sql_create_quotation', { draftId })).toMatch(
      /wait for their confirmation/,
    );
    aiReplies(FARAH);
    expect(await call(tools, 'sql_create_quotation', { draftId })).toMatch(
      /wait for their confirmation/,
    );
    await says(FARAH, 'Confirm');
    tools = (await turn(FARAH)).tools;
    const done = await call(tools, 'sql_create_quotation', { draftId });
    expect(done).toMatch(/^Created quotation QT-\d+ in SQL Account/);
    const posted = svc.fake!.data.salesquotation!;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      dockey: expect.any(Number),
      code: '300-F0001',
      sdsdocdetail: [
        { dtlkey: 0, seq: 1, itemcode: 'KP-L', qty: '20.00', uom: 'CUP', unitprice: '6.50' },
      ],
    });
    // A retry does not create a second one.
    expect(await call(tools, 'sql_create_quotation', { draftId })).toMatch(/^Already created/);
    expect(svc.fake!.data.salesquotation).toHaveLength(1);
    expect(activity()[0]).toBe('quotation:done:');
    expect(svc.activity()[0]!.dockey).toBe(posted[0]!.dockey);
    // The chat shows "Created a quotation".
    const line = t.ctx.db
      .prepare("SELECT payload FROM chat_events WHERE chat_jid = ? AND type = 'ai_tool_used'")
      .all(FARAH) as Array<{ payload: string }>;
    expect(line.some((l) => l.payload.includes('Created a quotation'))).toBe(true);
    // Another chat cannot use this draft.
    expect(await call((await turn(PRIYA)).tools, 'sql_create_quotation', { draftId })).toMatch(
      /no such draft/,
    );
  });

  it('stops at the daily limit per chat and releases a draft when SQL Account fails', async () => {
    const svc = await setUp({ access: { salesquotation: 'create' } });
    const make = async () => {
      const tools = (await turn(FARAH)).tools;
      await call(tools, 'sql_check_stock', { query: 'KP-L' });
      await says(FARAH, 'quote 5 please');
      const { draftId } = JSON.parse(
        await call(tools, 'sql_quotation_preview', { items: [{ code: 'KP-L', qty: 5 }] }),
      );
      aiReplies(FARAH);
      await says(FARAH, 'ok confirm');
      return { tools: (await turn(FARAH)).tools, draftId: draftId as number };
    };
    const failing = await make();
    svc.fake!.scenario = 'unreachable';
    await expect(
      call(failing.tools, 'sql_create_quotation', { draftId: failing.draftId }),
    ).rejects.toMatchObject({ kind: 'unreachable' });
    svc.fake!.scenario = 'ok';
    await svc.test();
    const retry = (await turn(FARAH)).tools;
    expect(await call(retry, 'sql_create_quotation', { draftId: failing.draftId })).toMatch(
      /^Created/,
    );
    for (let i = 1; i < QUOTES_PER_CHAT_DAY; i++) {
      const next = await make();
      expect(await call(next.tools, 'sql_create_quotation', { draftId: next.draftId })).toMatch(
        /^Created/,
      );
    }
    const over = await make();
    expect(await call(over.tools, 'sql_create_quotation', { draftId: over.draftId })).toMatch(
      /daily limit for this chat/,
    );
  });

  it('refuses an expired draft', async () => {
    const svc = await setUp({ access: { salesquotation: 'create' } });
    const tools = (await turn(FARAH)).tools;
    await call(tools, 'sql_check_stock', { query: 'KP-L' });
    await says(FARAH, 'quote 5 please');
    const { draftId } = JSON.parse(
      await call(tools, 'sql_quotation_preview', { items: [{ code: 'KP-L', qty: 5 }] }),
    );
    t.ctx.db
      .prepare('UPDATE sql_account_quotes SET created_at = ? WHERE id = ?')
      .run(svc.now() - 25 * 60 * 60_000, draftId);
    expect(await call(tools, 'sql_create_quotation', { draftId })).toMatch(/older than a day/);
  });
});

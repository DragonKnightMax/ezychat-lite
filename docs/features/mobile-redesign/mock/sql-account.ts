import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin } from '../../../../packages/server/src/auth/guards.js';
import { parse } from '../../../../packages/server/src/http/errors.js';

/**
 * Proposed (sql-accounting): stand-in for the built-in SQL Account connector. Nothing calls SQL Account:
 * "Test connection" answers from the scenario chosen in the dashed Mock only box, the customers, stock
 * and documents are canned (production: connectors/sql-account/fake.ts speaks the real paths, envelopes
 * and SigV4). Production routes: /api/connectors/sql-account/* (admins). See ../design.md.
 */
export type MockSqlScenario =
  'ok' | 'no_dns' | 'unreachable' | 'private_ip' | 'bad_keys' | 'old_version';
export type MockSqlState = 'disconnected' | 'connected' | MockSqlScenario;

export const SQL_OBJECTS = [
  { id: 'stockitem', scope: 'everyone', create: false, def: 'read' },
  { id: 'customer', scope: 'own', create: false, def: 'off' },
  { id: 'customerinvoice', scope: 'own', create: false, def: 'off' },
  { id: 'salesinvoice', scope: 'own', create: false, def: 'read' },
  { id: 'salesquotation', scope: 'own', create: true, def: 'read' },
  { id: 'salesorder', scope: 'own', create: false, def: 'read' },
  { id: 'deliveryorder', scope: 'own', create: false, def: 'read' },
  { id: 'customerpayment', scope: 'own', create: false, def: 'off' },
] as const;
type ObjectId = (typeof SQL_OBJECTS)[number]['id'];
type Access = 'off' | 'read' | 'create';

const AgentSettings = z.object({
  access: z.record(z.string(), z.enum(['off', 'read', 'create'])),
  showPrice: z.boolean(),
  stockDetail: z.enum(['inStock', 'quantity']),
});
type MockAgentSql = z.infer<typeof AgentSettings>;

function defaults(): MockAgentSql {
  return {
    access: Object.fromEntries(SQL_OBJECTS.map((o) => [o.id, o.def as Access])),
    showPrice: true,
    stockDetail: 'inStock',
  };
}

interface Debtor {
  code: string;
  name: string;
  phones: string[];
}
const DEBTORS: Debtor[] = [
  { code: '300-F0001', name: 'Farah Catering Co', phones: ['0123110099'] },
  { code: '300-P0007', name: 'Priya Nair Enterprise', phones: ['012-881 4455'] },
  { code: '300-J0003', name: 'JL Trading', phones: ['0129001234'] },
  { code: '300-J0004', name: 'Jason Lim Kopitiam', phones: ['+60 12-900 1234'] },
  { code: '300-N0002', name: 'Nurul Huda Bakery', phones: ['0177778888'] },
];

const digits = (phone: string) => {
  const d = phone.replace(/\D/g, '');
  return d.startsWith('0') ? `6${d}` : d;
};

type MatchKind = 'linked' | 'phone' | 'several' | 'none';
interface Match {
  kind: MatchKind;
  code: string | null;
  sqlName: string | null;
}

interface ActivityRow {
  at: number;
  agent: string;
  chatJid: string;
  customer: string;
  tool: 'stock' | 'account' | 'document' | 'payments' | 'quotation';
  result: 'done' | 'refused' | 'failed';
  reason?: string;
  dockey?: number;
}

interface Store {
  state: MockSqlState;
  scenario: MockSqlScenario;
  host: string | null;
  keyEnd: string | null;
  checkedAt: number | null;
  version: string | null;
  matchByPhone: boolean;
  agents: Record<string, MockAgentSql>;
  links: Record<string, string>;
  activity: ActivityRow[];
  nextDockey: number;
}

const ACCESS_KEY = /^([0-9a-f]{32})\.sql\.my\/([A-Za-z0-9_.-]{1,30})$/;

export function registerSqlAccount(app: FastifyInstance, ctx: AppContext): void {
  const now = Date.now();
  const store: Store = {
    state: 'disconnected',
    scenario: 'ok',
    host: null,
    keyEnd: null,
    checkedAt: null,
    version: null,
    matchByPhone: true,
    agents: {},
    links: { '60123110021@s.whatsapp.net': '300-F0001' },
    activity: [
      {
        at: now - 12 * 60_000,
        agent: 'Aina',
        chatJid: '60128814455@s.whatsapp.net',
        customer: 'Priya Nair',
        tool: 'document',
        result: 'done',
      },
      {
        at: now - 55 * 60_000,
        agent: 'Aina',
        chatJid: '60125550142@s.whatsapp.net',
        customer: 'Ahmad Zulkifli',
        tool: 'account',
        result: 'refused',
        reason: 'no_customer',
      },
      {
        at: now - 3 * 3_600_000,
        agent: 'Aina',
        chatJid: '60129001234@s.whatsapp.net',
        customer: 'Jason Lim',
        tool: 'stock',
        result: 'done',
      },
      {
        at: now - 26 * 3_600_000,
        agent: 'Aina',
        chatJid: '60123110021@s.whatsapp.net',
        customer: 'Farah Aziz',
        tool: 'quotation',
        result: 'done',
        dockey: 1187,
      },
      {
        at: now - 30 * 3_600_000,
        agent: 'Aina',
        chatJid: '60126677889@s.whatsapp.net',
        customer: 'Nurul Huda',
        tool: 'stock',
        result: 'failed',
        reason: 'unreachable',
      },
    ],
    nextDockey: 1188,
  };

  const agentSettings = (id: string) => store.agents[id] ?? defaults();

  const chats = () =>
    ctx.db
      .prepare(
        "SELECT c.jid AS jid, COALESCE(NULLIF(p.name, ''), NULLIF(c.name, ''), '+' || substr(c.jid, 1, instr(c.jid, '@') - 1)) AS name FROM chats c LEFT JOIN customer_profiles p ON p.chat_jid = c.jid WHERE c.jid LIKE '%@s.whatsapp.net' ORDER BY c.last_message_at DESC",
      )
      .all() as { jid: string; name: string }[];

  const match = (jid: string): Match => {
    const linked = store.links[jid];
    if (linked) {
      const d = DEBTORS.find((x) => x.code === linked);
      return d
        ? { kind: 'linked', code: d.code, sqlName: d.name }
        : { kind: 'none', code: null, sqlName: null };
    }
    if (!store.matchByPhone) return { kind: 'none', code: null, sqlName: null };
    const number = jid.split('@')[0]!;
    const hits = DEBTORS.filter((d) => d.phones.some((p) => digits(p) === number));
    if (hits.length === 1) return { kind: 'phone', code: hits[0]!.code, sqlName: hits[0]!.name };
    if (hits.length > 1) return { kind: 'several', code: null, sqlName: null };
    return { kind: 'none', code: null, sqlName: null };
  };

  const view = () => ({
    state: store.state,
    scenario: store.scenario,
    host: store.host,
    keyEnd: store.keyEnd,
    checkedAt: store.checkedAt,
    version: store.version,
    matchByPhone: store.matchByPhone,
    objects: SQL_OBJECTS,
    agents: store.agents,
    defaults: defaults(),
  });

  const check = () => {
    store.checkedAt = Date.now();
    store.state = store.scenario === 'ok' ? 'connected' : store.scenario;
    store.version = store.scenario === 'ok' ? '5.2025.1061.890' : null;
  };

  app.get('/api/mock/sql-account', { preHandler: requireAdmin(ctx) }, async () => view());

  app.post('/api/mock/sql-account/connect', { preHandler: requireAdmin(ctx) }, async (request) => {
    const body = parse(
      z.object({ accessKey: z.string().trim().max(200), secretKey: z.string().min(1).max(200) }),
      request.body ?? {},
    );
    const m = ACCESS_KEY.exec(body.accessKey);
    if (!m) return { ok: false, error: 'key_format' };
    store.host = `https://${m[1]}.sql.my`;
    store.keyEnd = `…${m[1]!.slice(-4)}/${m[2]}`;
    check();
    if (store.state !== 'connected') {
      const failed = store.state;
      store.state = 'disconnected';
      return { ok: false, error: failed, view: view() };
    }
    return { ok: true, view: view() };
  });

  app.post('/api/mock/sql-account/test', { preHandler: requireAdmin(ctx) }, async () => {
    if (store.state !== 'disconnected') check();
    return view();
  });

  app.post('/api/mock/sql-account/disconnect', { preHandler: requireAdmin(ctx) }, async () => {
    Object.assign(store, { state: 'disconnected', host: null, keyEnd: null, checkedAt: null });
    return view();
  });

  app.put('/api/mock/sql-account/scenario', { preHandler: requireAdmin(ctx) }, async (request) => {
    const { scenario } = parse(
      z.object({
        scenario: z.enum(['ok', 'no_dns', 'unreachable', 'private_ip', 'bad_keys', 'old_version']),
      }),
      request.body ?? {},
    );
    store.scenario = scenario;
    // A connected install sees the problem at its next check (the page's Test connection).
    return view();
  });

  app.put('/api/mock/sql-account/match', { preHandler: requireAdmin(ctx) }, async (request) => {
    store.matchByPhone = parse(
      z.object({ matchByPhone: z.boolean() }),
      request.body ?? {},
    ).matchByPhone;
    return view();
  });

  app.put<{ Params: { agentId: string } }>(
    '/api/mock/sql-account/agents/:agentId',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const id = z.string().min(1).max(40).parse(request.params.agentId);
      const next = parse(AgentSettings, request.body ?? {});
      for (const o of SQL_OBJECTS)
        if (next.access[o.id] === 'create' && !o.create) next.access[o.id] = 'read';
      store.agents[id] = next;
      return view();
    },
  );

  app.get('/api/mock/sql-account/customers', { preHandler: requireAdmin(ctx) }, async () =>
    chats().map((c) => ({ ...c, ...match(c.jid) })),
  );

  app.get('/api/mock/sql-account/debtors', { preHandler: requireAdmin(ctx) }, async (request) => {
    const q = z
      .string()
      .max(60)
      .default('')
      .parse((request.query as { q?: string }).q)
      .toLowerCase();
    return DEBTORS.filter(
      (d) => !q || d.code.toLowerCase().includes(q) || d.name.toLowerCase().includes(q),
    ).map(({ code, name }) => ({ code, name }));
  });

  app.put('/api/mock/sql-account/links', { preHandler: requireAdmin(ctx) }, async (request) => {
    const body = parse(
      z.object({ jid: z.string().min(3).max(120), code: z.string().max(30).nullable() }),
      request.body ?? {},
    );
    if (body.code === null) delete store.links[body.jid];
    else {
      if (!DEBTORS.some((d) => d.code === body.code)) return { ok: false, error: 'unknown_code' };
      store.links[body.jid] = body.code;
    }
    return { ok: true };
  });

  app.get('/api/mock/sql-account/activity', { preHandler: requireAdmin(ctx) }, async () =>
    [...store.activity].sort((a, b) => b.at - a.at),
  );

  /**
   * Mock only: what the AI agent would do with one customer question in one chat, so the owner can
   * walk the guard rules (own records only, no match = hand over, object Off = not offered).
   */
  app.post('/api/mock/sql-account/try', { preHandler: requireAdmin(ctx) }, async (request) => {
    const body = parse(
      z.object({
        agentId: z.string().min(1).max(40),
        agentName: z.string().min(1).max(60),
        jid: z.string().min(3).max(120),
        question: z.enum(['stock', 'balance', 'document', 'otherDocument', 'quotation', 'confirm']),
      }),
      request.body ?? {},
    );
    const settings = agentSettings(body.agentId);
    const access = (id: ObjectId): Access =>
      (settings.access[id] as Access | undefined) ??
      (SQL_OBJECTS.find((o) => o.id === id)!.def as Access);
    const chat = chats().find((c) => c.jid === body.jid);
    const m = match(body.jid);
    const log = (row: Omit<ActivityRow, 'at' | 'agent' | 'chatJid' | 'customer'>) =>
      store.activity.push({
        at: Date.now(),
        agent: body.agentName,
        chatJid: body.jid,
        customer: chat?.name ?? body.jid,
        ...row,
      });
    if (store.state !== 'connected')
      return { outcome: 'handover', reason: 'not_connected', tools: [] };
    const toolFor: Record<typeof body.question, ObjectId> = {
      stock: 'stockitem',
      balance: 'salesinvoice',
      document: 'salesorder',
      otherDocument: 'salesorder',
      quotation: 'salesquotation',
      confirm: 'salesquotation',
    };
    const object = toolFor[body.question];
    const needed: Access = body.question === 'confirm' ? 'create' : 'read';
    const have = access(object);
    if (have === 'off' || (needed === 'create' && have !== 'create'))
      return { outcome: 'handover', reason: 'object_off', object, tools: [] };
    if (body.question === 'stock') {
      log({ tool: 'stock', result: 'done' });
      return {
        outcome: 'answer',
        tools: ['sql_check_stock'],
        reply: settings.showPrice
          ? settings.stockDetail === 'quantity'
            ? 'Kopi Peng Large (KP-L) is RM6.50 and we have 42 in stock.'
            : 'Kopi Peng Large (KP-L) is RM6.50 and it is in stock.'
          : 'Kopi Peng Large is in stock.',
      };
    }
    if (m.kind !== 'linked' && m.kind !== 'phone') {
      log({
        tool:
          body.question === 'balance'
            ? 'account'
            : body.question === 'confirm' || body.question === 'quotation'
              ? 'quotation'
              : 'document',
        result: 'refused',
        reason: 'no_customer',
      });
      return {
        outcome: 'handover',
        reason: m.kind === 'several' ? 'several' : 'no_customer',
        tools: [],
      };
    }
    if (body.question === 'balance' && access('customerinvoice') !== 'off') {
      log({ tool: 'account', result: 'done' });
      return {
        outcome: 'answer',
        tools: ['sql_my_account'],
        match: m,
        reply:
          'As recorded in our accounts on 5 Nov, 2:30 pm, you still owe RM1,240.00 on IV-02231 (due 11 Nov) and RM860.00 on IV-02305 (due 27 Nov).',
      };
    }
    if (body.question === 'balance') {
      log({ tool: 'account', result: 'done' });
      return {
        outcome: 'answer',
        tools: ['sql_my_account'],
        match: m,
        reply:
          'Your recent invoices are IV-02305 (28 Oct, RM860.00) and IV-02231 (12 Oct, RM1,240.00). A team member will confirm what is still unpaid.',
      };
    }
    if (body.question === 'document') {
      log({ tool: 'document', result: 'done' });
      return {
        outcome: 'answer',
        tools: ['sql_document_status'],
        match: m,
        reply:
          'Sales order SO-00412 (2 Nov) is confirmed and goes out with delivery order DO-00388 tomorrow.',
      };
    }
    if (body.question === 'otherDocument') {
      log({ tool: 'document', result: 'refused', reason: 'not_own' });
      return {
        outcome: 'answer',
        tools: ['sql_document_status'],
        match: m,
        reply: 'I could not find SO-00399 under your account. A team member can check it for you.',
        note: 'not_own',
      };
    }
    if (body.question === 'quotation')
      return {
        outcome: 'answer',
        tools: ['sql_check_stock'],
        match: m,
        reply:
          'Here is the quotation I can prepare: 20 × Kopi Peng Large (KP-L) at RM6.50 = RM130.00. Reply "confirm" and I will send it to you as a SQL Account quotation.',
      };
    const dockey = store.nextDockey++;
    log({ tool: 'quotation', result: 'done', dockey });
    return {
      outcome: 'answer',
      tools: ['sql_create_quotation'],
      match: m,
      reply: `Done: quotation QT-0${dockey - 700} for RM130.00 is in our system. Our team will follow up.`,
    };
  });
}

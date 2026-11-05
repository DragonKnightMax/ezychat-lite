import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';
import { HttpError, parse } from '../../../../packages/server/src/http/errors.js';

/**
 * Proposed (connector-list): stand-in for the signed connector list (`list-v1.json` from
 * `anchorsprint/ezychat-connectors`, published on dl.ezychat.ai) and for partner MCP servers. Nothing
 * is downloaded and no partner is called: the list below is what the published file would hold, the
 * partner sign-in is a local stand-in page, and API keys are checked by a fixed rule. Production plan
 * and field meanings: ../design.md. Mirrors src/mock/connectorList.ts (types for the page).
 */
type Lang = 'en' | 'ms' | 'zh-CN';
type Texts = { en: string } & Partial<Record<Exclude<Lang, 'en'>, string>>;

interface Guards {
  confirmFirst?: boolean;
  /** Argument → the read tool whose results it must come from (in this chat, last 24 hours). */
  valueFrom?: Record<string, string>;
  /** Arguments that must come from the saved contact or the customer's own messages. */
  fromCustomer?: string[];
  /** Argument → the agent setting it must fit. */
  within?: Record<string, string>;
  limits?: { perChat?: number; perDay?: number };
}

interface ListTool {
  name: string;
  title: Texts;
  description: Texts;
  access: 'read' | 'write';
  guards?: Guards;
}

interface ListSetting {
  id: string;
  type: 'text' | 'select' | 'toggle' | 'days' | 'timeRange' | 'calendarPicker';
  label: Texts;
  hint?: Texts;
  options?: Array<{ value: string; label: Texts }>;
  default?: unknown;
  /** calendarPicker: the read tool that lists the choices. */
  from?: string;
}

export interface ListEntry {
  id: string;
  schemaVersion: number;
  minAppVersion: string;
  kind: 'mcp' | 'builtin' | 'coming_soon';
  editions: Array<'lite' | 'enterprise'>;
  builtinId?: string;
  name: string;
  summary: Texts;
  description: Texts;
  category: string;
  icon: string;
  publisher?: string;
  homepage?: string;
  privacy?: Texts;
  mcp?: { url: string };
  auth?:
    | { type: 'oauth'; clientId?: string; scopes: string[] }
    | { type: 'api_key'; label: Texts; help: string }
    | { type: 'none' };
  tools?: ListTool[];
  skill?: Texts;
  settings?: ListSetting[];
  vote?: Texts;
}

export interface ListFile {
  format: 1;
  generatedAt: string;
  sequence: number;
  entries: ListEntry[];
}

type ActivityKind = 'checked' | 'done' | 'refused' | 'failed';
type Reason =
  | 'confirm_first'
  | 'value_from'
  | 'from_customer'
  | 'within'
  | 'limit'
  | 'unreachable'
  | 'partner_error';

interface PartnerActivity {
  at: number;
  kind: ActivityKind;
  agent: string;
  customer: string;
  tool: string;
  reason?: Reason;
}

interface AgentChoice {
  settings: Record<string, unknown>;
  tools: Record<string, boolean>;
}

interface Connection {
  state: 'waiting' | 'connected' | 'failed';
  error?: 'cancelled' | 'unreachable';
  /** OAuth: the partner account; API key: the last 4 characters. */
  account?: string;
  keyEnd?: string;
  connectedAt?: number;
  /** The entry as it was when connected: a connector removed from the list keeps working. */
  entry: ListEntry;
  agents: Record<string, AgentChoice>;
  activity: PartnerActivity[];
}

/** The app version of this proposal (an entry with a higher `minAppVersion` asks for an update). */
const APP_VERSION = '0.1.62';
const SCHEMA_VERSIONS = [1];
const HOUR = 3_600_000;
const here = dirname(fileURLToPath(import.meta.url));

/** Accounts the stand-in partner sign-in pages report. */
const ACCOUNTS: Record<string, string> = {
  'lejar-accounting': 'kopiapong@lejar.example',
  'google-calendar-mcp': 'kopiapong.penang@gmail.com',
};

/**
 * The coming-soon entries the app lists today, moved into the list unchanged: their texts are copied
 * from the current app catalogs (en, ms, zh-CN), as the first published list would carry them.
 */
const COMING_SOON: Array<[id: string, category: string, icon: string]> = [
  ['google-sheets', 'data', 'table'],
  ['hitpay', 'payments', 'card'],
  ['shopify', 'commerce', 'bag'],
  ['autocount', 'accounting', 'calculator'],
  ['sql-account', 'accounting', 'receipt'],
  ['bukku', 'accounting', 'book'],
  ['xero', 'accounting', 'wallet'],
  ['zoho-books', 'accounting', 'receipt'],
  ['zoho-crm', 'crm', 'contact'],
  ['hubspot', 'crm', 'users'],
  ['woocommerce', 'commerce', 'cart'],
  ['easystore', 'commerce', 'store'],
  ['storehub', 'commerce', 'store'],
  ['billplz', 'payments', 'card'],
];

/** Tools of the coming-soon entries that change data (the others are look-ups). */
const WRITE_TOOLS = new Set(['addLead', 'paymentLink', 'quotation', 'contact']);

function comingSoonEntries(): ListEntry[] {
  type Item = {
    name: string;
    short: string;
    long: string;
    privacy?: string;
    tools?: Record<string, string>;
  };
  const catalogs = (['en', 'ms', 'zh-CN'] as const).map((lang) => {
    const json = JSON.parse(
      readFileSync(join(here, 'src/i18n/locales', lang, 'admin.json'), 'utf8'),
    ) as { mockConnectors: { items: Record<string, Item> } };
    return [lang, json.mockConnectors.items] as const;
  });
  const texts = (id: string, read: (item: Item) => string | undefined): Texts => {
    const out: Record<string, string> = {};
    for (const [lang, items] of catalogs) {
      const item = items[id];
      const value = item && read(item);
      if (value) out[lang] = value;
    }
    return out as Texts;
  };
  const en = catalogs[0]![1];
  return COMING_SOON.map(([id, category, icon]): ListEntry => {
    const toolKeys = Object.keys(en[id]?.tools ?? {}).filter((key) => !key.endsWith('Hint'));
    const privacy = texts(id, (item) => item.privacy);
    return {
      id,
      schemaVersion: 1,
      minAppVersion: '0.1.62',
      kind: 'coming_soon',
      editions: ['lite', 'enterprise'],
      name: texts(id, (item) => item.name).en,
      summary: texts(id, (item) => item.short),
      description: texts(id, (item) => item.long),
      category,
      icon,
      privacy: privacy.en ? privacy : undefined,
      tools: toolKeys.map((key) => ({
        name: key,
        title: texts(id, (item) => item.tools?.[key]),
        description: texts(id, (item) => item.tools?.[`${key}Hint`]),
        access: WRITE_TOOLS.has(key) ? 'write' : 'read',
      })),
    };
  });
}

/** What `list-v1.json` would hold (sequence 42, published two hours before the mock starts). */
function publishedList(publishedAt: number): ListFile {
  return {
    format: 1,
    generatedAt: new Date(publishedAt).toISOString(),
    sequence: 42,
    entries: [
      {
        id: 'google-calendar',
        schemaVersion: 1,
        minAppVersion: '0.1.62',
        kind: 'builtin',
        builtinId: 'google-calendar',
        editions: ['lite', 'enterprise'],
        name: 'Google Calendar',
        summary: { en: 'Free times and bookings in your Google Calendar.' },
        description: { en: 'Built into EzyChat.' },
        category: 'booking',
        icon: 'calendar',
        publisher: 'EzyChat',
      },
      {
        id: 'google-calendar-mcp',
        schemaVersion: 1,
        minAppVersion: '0.1.62',
        kind: 'mcp',
        editions: ['lite', 'enterprise'],
        name: 'Google Calendar (MCP)',
        summary: { en: 'Free times and bookings through Google’s own MCP server.' },
        description: {
          en: 'The AI checks free times in the calendar you choose and books a time the customer confirms. EzyChat connects straight from this computer to Google’s MCP server.',
        },
        category: 'booking',
        icon: 'calendar',
        publisher: 'Google',
        homepage: 'https://workspace.google.com/products/calendar/',
        privacy: {
          en: 'Your calendar data goes between your computer and Google. No chat text goes to Google.',
        },
        mcp: { url: 'https://calendarmcp.googleapis.com/mcp/v1' },
        auth: {
          type: 'oauth',
          clientId: 'ezychat-desktop.apps.googleusercontent.com',
          scopes: ['calendar.calendarlist.readonly', 'calendar.freebusy', 'calendar.events.owned'],
        },
        settings: [
          {
            id: 'calendar',
            type: 'calendarPicker',
            from: 'list_calendars',
            label: { en: 'Calendar' },
            hint: { en: 'The AI checks and books only in this calendar.' },
          },
          {
            id: 'hours',
            type: 'timeRange',
            label: { en: 'Booking hours' },
            default: ['10:00', '18:00'],
          },
          {
            id: 'days',
            type: 'days',
            label: { en: 'Booking days' },
            default: [1, 2, 3, 4, 5, 6],
          },
          {
            id: 'length',
            type: 'select',
            label: { en: 'Length of a booking' },
            default: '60',
            options: [
              { value: '30', label: { en: '30 minutes' } },
              { value: '60', label: { en: '1 hour' } },
              { value: '90', label: { en: '1 hour 30 minutes' } },
            ],
          },
        ],
        tools: [
          {
            name: 'freebusy',
            title: { en: 'Check free times' },
            description: { en: 'Reads the busy times of the chosen calendar.' },
            access: 'read',
          },
          {
            name: 'create_event',
            title: { en: 'Book appointments' },
            description: { en: 'Adds an event after the customer confirms a time.' },
            access: 'write',
            guards: {
              confirmFirst: true,
              valueFrom: { start: 'freebusy' },
              fromCustomer: ['attendee.name', 'attendee.email', 'attendee.phone'],
              within: { start: 'settings.hours', day: 'settings.days' },
              limits: { perChat: 3, perDay: 50 },
            },
          },
        ],
        skill: {
          en: 'Offer only free times from Check free times. Ask for the name, email and phone that are missing before booking. Never cancel or move an event: hand over.',
        },
      },
      {
        id: 'lejar-accounting',
        schemaVersion: 1,
        minAppVersion: '0.1.62',
        kind: 'mcp',
        editions: ['lite', 'enterprise'],
        name: 'Lejar Accounting',
        summary: {
          en: 'Invoices, stock and quotations from Lejar.',
          ms: 'Invois, stok dan sebut harga daripada Lejar.',
          'zh-CN': '来自 Lejar 的发票、库存和报价单。',
        },
        description: {
          en: 'The AI tells customers whether an invoice is paid, checks stock, and creates a draft quotation in Lejar that your team sends.',
          ms: 'AI memberitahu pelanggan sama ada invois sudah dibayar, menyemak stok, dan membuat draf sebut harga dalam Lejar yang dihantar oleh pasukan anda.',
          'zh-CN':
            'AI 告诉客户发票是否已付款、查询库存，并在 Lejar 中创建报价单草稿，由您的团队发送。',
        },
        category: 'accounting',
        icon: 'book',
        publisher: 'Lejar Software Sdn Bhd',
        homepage: 'https://lejar.example/ezychat',
        privacy: {
          en: 'Your data goes between your computer and Lejar Software Sdn Bhd: only what a look-up or a quotation needs in one chat. No chat text goes to Lejar.',
        },
        mcp: { url: 'https://mcp.lejar.example/v1' },
        auth: { type: 'oauth', scopes: ['invoices.read', 'stock.read', 'quotations.write'] },
        settings: [
          {
            id: 'priceList',
            type: 'select',
            label: { en: 'Price list for quotations' },
            default: 'retail',
            options: [
              { value: 'retail', label: { en: 'Retail' } },
              { value: 'wholesale', label: { en: 'Wholesale' } },
            ],
          },
          {
            id: 'includeTax',
            type: 'toggle',
            label: { en: 'Show prices with SST' },
            hint: { en: 'The AI quotes prices that include 8% SST.' },
            default: true,
          },
          {
            id: 'quoteNote',
            type: 'text',
            label: { en: 'Note on every quotation' },
            hint: { en: 'Up to 120 characters.' },
            default: 'Valid for 14 days. Prices in RM.',
          },
        ],
        tools: [
          {
            name: 'find_invoice',
            title: { en: 'Invoice status', ms: 'Status invois', 'zh-CN': '发票状态' },
            description: { en: 'Finds an invoice of this customer and whether it is paid.' },
            access: 'read',
          },
          {
            name: 'check_stock',
            title: { en: 'Check stock', ms: 'Semak stok', 'zh-CN': '查询库存' },
            description: { en: 'Tells how many of an item are in stock.' },
            access: 'read',
          },
          {
            name: 'create_quotation',
            title: { en: 'Create a quotation', ms: 'Buat sebut harga', 'zh-CN': '创建报价单' },
            description: { en: 'Creates a draft quotation in Lejar; your team sends it.' },
            access: 'write',
            guards: {
              confirmFirst: true,
              valueFrom: { items: 'check_stock' },
              fromCustomer: ['customer.name', 'customer.email'],
              limits: { perChat: 2, perDay: 30 },
            },
          },
        ],
        skill: {
          en: 'Quote only items Check stock returned. Ask for the customer’s name and email before a quotation. Never change or cancel an invoice: hand over.',
        },
      },
      {
        id: 'kedai-crm',
        schemaVersion: 1,
        minAppVersion: '0.1.62',
        kind: 'mcp',
        editions: ['lite', 'enterprise'],
        name: 'Kedai CRM',
        summary: { en: 'Find customers and add new leads in Kedai CRM.' },
        description: {
          en: 'The AI looks up whether a customer is already in Kedai CRM and adds a new lead with the name and phone the customer gave, so your sales team follows up.',
        },
        category: 'crm',
        icon: 'contact',
        publisher: 'Kedai Digital Sdn Bhd',
        homepage: 'https://kedaicrm.example',
        privacy: {
          en: 'Your data goes between your computer and Kedai Digital Sdn Bhd: the customer’s name and phone for a lead. No chat text goes to Kedai CRM.',
        },
        mcp: { url: 'https://api.kedaicrm.example/mcp' },
        auth: {
          type: 'api_key',
          label: { en: 'Kedai CRM API key' },
          help: 'https://kedaicrm.example/help/api-keys',
        },
        settings: [
          {
            id: 'days',
            type: 'days',
            label: { en: 'Days the AI may add leads' },
            default: [1, 2, 3, 4, 5],
          },
          {
            id: 'hours',
            type: 'timeRange',
            label: { en: 'Hours the AI may add leads' },
            hint: { en: 'Outside these hours the AI notes the request and hands over.' },
            default: ['09:00', '18:00'],
          },
          {
            id: 'owner',
            type: 'select',
            label: { en: 'Lead owner' },
            default: 'sales',
            options: [
              { value: 'sales', label: { en: 'Sales team' } },
              { value: 'daniel', label: { en: 'Daniel' } },
              { value: 'meiling', label: { en: 'Mei Ling' } },
            ],
          },
          {
            id: 'tag',
            type: 'toggle',
            label: { en: 'Tag new leads “WhatsApp”' },
            default: true,
          },
        ],
        tools: [
          {
            name: 'find_customer',
            title: { en: 'Find a customer' },
            description: { en: 'Checks whether this phone number is already a customer.' },
            access: 'read',
          },
          {
            name: 'add_lead',
            title: { en: 'Add a lead' },
            description: { en: 'Adds the customer as a new lead for your sales team.' },
            access: 'write',
            guards: {
              confirmFirst: true,
              fromCustomer: ['lead.name', 'lead.phone'],
              within: { at: 'settings.hours', day: 'settings.days' },
              limits: { perChat: 1, perDay: 50 },
            },
          },
        ],
        skill: {
          en: 'Add a lead only once per chat and only with the name the customer gave. Never delete or merge customers: hand over.',
        },
      },
      {
        id: 'gudang-stock',
        schemaVersion: 1,
        minAppVersion: '0.1.62',
        kind: 'mcp',
        editions: ['enterprise'],
        name: 'Gudang Stock',
        summary: { en: 'Stock in every warehouse and branch, from Gudang.' },
        description: {
          en: 'The AI tells customers which branch has an item in stock and when the next delivery arrives.',
        },
        category: 'commerce',
        icon: 'warehouse',
        publisher: 'Gudang Systems Sdn Bhd',
        homepage: 'https://gudang.example',
        privacy: {
          en: 'Your data goes between your computer and Gudang Systems Sdn Bhd: only the items a customer asks about.',
        },
        mcp: { url: 'https://mcp.gudang.example' },
        auth: {
          type: 'api_key',
          label: { en: 'Gudang API key' },
          help: 'https://gudang.example/keys',
        },
        tools: [
          {
            name: 'branch_stock',
            title: { en: 'Stock per branch' },
            description: { en: 'Which branch has the item and how many.' },
            access: 'read',
          },
        ],
      },
      {
        id: 'bayar-invoices',
        schemaVersion: 1,
        minAppVersion: '0.2.0',
        kind: 'mcp',
        editions: ['lite', 'enterprise'],
        name: 'Bayar Payments',
        summary: { en: 'Payment links and payment status from Bayar.' },
        description: {
          en: 'The AI sends a payment link for a confirmed order and tells the customer when the payment arrives.',
        },
        category: 'payments',
        icon: 'card',
        publisher: 'Bayar Sdn Bhd',
        homepage: 'https://bayar.example',
        privacy: { en: 'Your data goes between your computer and Bayar Sdn Bhd.' },
        mcp: { url: 'https://mcp.bayar.example' },
        auth: { type: 'oauth', scopes: ['links.write', 'payments.read'] },
        tools: [
          {
            name: 'payment_link',
            title: { en: 'Send a payment link' },
            description: { en: 'Creates a payment link for a confirmed amount.' },
            access: 'write',
            guards: { confirmFirst: true, limits: { perChat: 1, perDay: 100 } },
          },
        ],
      },
      {
        // A newer list schema this app cannot read: never shown (owner, 2026-10-27).
        id: 'future-connector',
        schemaVersion: 2,
        minAppVersion: '0.3.0',
        kind: 'mcp',
        editions: ['lite', 'enterprise'],
        name: 'Future connector',
        summary: { en: 'Uses connector schema 2.' },
        description: { en: 'Not shown by this app.' },
        category: 'data',
        icon: 'plug',
      },
      ...comingSoonEntries(),
    ],
  };
}

const AgentChoiceBody = z.object({
  settings: z.record(z.string().max(40), z.unknown()),
  tools: z.record(z.string().max(60), z.boolean()),
});

export function registerConnectorList(app: FastifyInstance, ctx: AppContext) {
  const startedAt = Date.now();
  const store = {
    listState: 'loaded' as 'loaded' | 'offline' | 'rejected',
    lastGoodAt: startedAt - 2 * HOUR,
    showGoogleMcp: false,
    delisted: [] as string[],
    partnerReachable: true,
    connections: {} as Record<string, Connection>,
  };
  // Settings per agent of a disconnected connector, back when it is connected again.
  const disconnectedChoices: Record<string, Record<string, AgentChoice>> = {};
  const list = publishedList(store.lastGoodAt);
  const entry = (id: string) => list.entries.find((e) => e.id === id);
  // The seeded demo: Lejar Accounting is connected (with activity); Kedai CRM is not.
  store.connections['lejar-accounting'] = {
    state: 'connected',
    account: ACCOUNTS['lejar-accounting'],
    connectedAt: startedAt - 6 * 24 * HOUR,
    entry: entry('lejar-accounting')!,
    agents: {
      a1: {
        settings: {
          priceList: 'retail',
          includeTax: true,
          quoteNote: 'Valid for 14 days. Prices in RM.',
        },
        tools: { find_invoice: true, check_stock: true, create_quotation: true },
      },
    },
    activity: demoActivity(startedAt),
  };

  const view = () => {
    const listed = list.entries.filter(
      (e) =>
        !store.delisted.includes(e.id) && (e.id !== 'google-calendar-mcp' || store.showGoogleMcp),
    );
    return {
      appVersion: APP_VERSION,
      schemaVersions: SCHEMA_VERSIONS,
      list: { ...list, entries: listed },
      status: { state: store.listState, lastGoodAt: store.lastGoodAt },
      mock: {
        showGoogleMcp: store.showGoogleMcp,
        delisted: store.delisted,
        partnerReachable: store.partnerReachable,
      },
      connections: Object.fromEntries(
        Object.entries(store.connections).map(([id, c]) => [
          id,
          {
            ...c,
            signInUrl:
              c.state === 'waiting' ? `/api/mock/connector-list/partner/sign-in?id=${id}` : null,
            // calendarPicker choices come from the connector's list tool (here: canned).
            choices:
              id === 'google-calendar-mcp' && c.state === 'connected'
                ? {
                    calendar: [
                      { value: 'bookings', label: 'Kopi Apong bookings' },
                      { value: 'primary', label: ACCOUNTS['google-calendar-mcp'] },
                    ],
                  }
                : {},
          },
        ]),
      ),
    };
  };
  const listedEntry = (id: string) => {
    const e = view().list.entries.find((x) => x.id === id && x.kind === 'mcp');
    if (!e) throw new HttpError(404, 'not_found', 'This connector is not in the list.');
    return e;
  };

  app.get('/api/mock/connector-list', { preHandler: requireUser(ctx) }, async () => view());

  // "Check for new connectors": loaded → the newest copy; offline and rejected keep the last good copy.
  app.post('/api/mock/connector-list/check', { preHandler: requireAdmin(ctx) }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (store.listState === 'loaded') store.lastGoodAt = Date.now();
    return { ...view(), result: store.listState === 'loaded' ? 'upToDate' : store.listState };
  });

  // Mock only: list state, the Google Calendar (MCP) entry, Lejar removed from the list, partner down.
  app.put(
    '/api/mock/connector-list/scenario',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const body = parse(
        z.object({
          listState: z.enum(['loaded', 'offline', 'rejected']).optional(),
          showGoogleMcp: z.boolean().optional(),
          lejarListed: z.boolean().optional(),
          partnerReachable: z.boolean().optional(),
          reset: z.boolean().optional(),
        }),
        request.body ?? {},
      );
      if (body.reset) {
        store.listState = 'loaded';
        store.lastGoodAt = startedAt - 2 * HOUR;
        store.showGoogleMcp = false;
        store.delisted = [];
        store.partnerReachable = true;
        for (const id of Object.keys(store.connections))
          if (id !== 'lejar-accounting') delete store.connections[id];
        store.connections['lejar-accounting']!.state = 'connected';
        store.connections['lejar-accounting']!.error = undefined;
      }
      if (body.listState) store.listState = body.listState;
      if (body.showGoogleMcp !== undefined) store.showGoogleMcp = body.showGoogleMcp;
      if (body.lejarListed !== undefined)
        store.delisted = body.lejarListed ? [] : ['lejar-accounting'];
      if (body.partnerReachable !== undefined) store.partnerReachable = body.partnerReachable;
      return view();
    },
  );

  // Connect with OAuth: EzyChat finds the partner's sign-in and opens it in the browser.
  app.post<{ Params: { id: string } }>(
    '/api/mock/connector-list/connectors/:id/connect',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const e = listedEntry(request.params.id);
      if (e.auth?.type !== 'oauth')
        throw new HttpError(400, 'not_oauth', 'This connector uses an API key.');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const before = store.connections[e.id];
      store.connections[e.id] = {
        state: store.partnerReachable ? 'waiting' : 'failed',
        error: store.partnerReachable ? undefined : 'unreachable',
        entry: e,
        agents: before?.agents ?? {},
        activity: before?.activity ?? [],
      };
      return view();
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/mock/connector-list/connectors/:id/cancel',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const c = store.connections[request.params.id];
      if (c && c.state !== 'connected') delete store.connections[request.params.id];
      return view();
    },
  );

  // The API key dialog: Test (save=false) or Save (tests first). A key that starts with "kd_" and
  // has 12+ characters passes; anything else is refused; an unreachable partner cannot check it.
  app.post<{ Params: { id: string } }>(
    '/api/mock/connector-list/connectors/:id/api-key',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const e = listedEntry(request.params.id);
      const { key, save } = parse(
        z.object({ key: z.string().trim().min(1).max(512), save: z.boolean() }),
        request.body ?? {},
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      const result = !store.partnerReachable
        ? ('unreachable' as const)
        : /^(kd|gd)_[A-Za-z0-9]{9,}$/.test(key)
          ? ('ok' as const)
          : ('refused' as const);
      if (result === 'ok' && save) {
        const before = store.connections[e.id];
        store.connections[e.id] = {
          state: 'connected',
          keyEnd: key.slice(-4),
          connectedAt: Date.now(),
          entry: e,
          agents: before?.agents ?? {},
          activity: before?.activity ?? [],
        };
      }
      return { result, view: view() };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/mock/connector-list/connectors/:id/disconnect',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      // Settings per agent stay (as for Google Calendar); the AI stops using the tools.
      const c = store.connections[request.params.id];
      if (c) {
        delete store.connections[request.params.id];
        if (Object.keys(c.agents).length) disconnectedChoices[request.params.id] = c.agents;
      }
      return view();
    },
  );

  app.put<{ Params: { id: string; agentId: string } }>(
    '/api/mock/connector-list/connectors/:id/agents/:agentId',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const c = store.connections[request.params.id];
      if (!c || c.state !== 'connected')
        throw new HttpError(409, 'not_connected', 'Connect this connector first.');
      const agentId = z.string().min(1).max(40).parse(request.params.agentId);
      c.agents[agentId] = parse(AgentChoiceBody, request.body ?? {});
      return view();
    },
  );

  // Stand-in for the partner's own sign-in page (opened in a new tab). Mock only, English only.
  app.get<{ Querystring: { id?: string } }>(
    '/api/mock/connector-list/partner/sign-in',
    async (request, reply) => {
      const id = String(request.query.id ?? '');
      const e = entry(id);
      const c = store.connections[id];
      const page = (body: string) =>
        reply
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
          .send(standInPage(e?.publisher ?? 'Partner', body));
      if (!e || !c || c.state !== 'waiting')
        return page(
          '<p>This sign-in link is no longer valid. Go back to EzyChat and connect again.</p>',
        );
      const tools = (e.tools ?? []).map((tool) => `<li>${escapeHtml(tool.title.en)}</li>`).join('');
      const back = `/api/mock/connector-list/partner/callback?id=${encodeURIComponent(id)}`;
      return page(
        `<p class="muted">Stand-in sign-in page (mock only). In the app this is ${escapeHtml(
          e.publisher ?? '',
        )}'s own page.</p>
        <h1>Sign in to ${escapeHtml(e.name)}</h1>
        <p>Signed in as <strong>${escapeHtml(ACCOUNTS[id] ?? 'owner@kopiapong.example')}</strong></p>
        <p><strong>EzyChat on your computer</strong> wants to:</p>
        <ul>${tools}</ul>
        <p class="actions"><a class="primary" href="${back}&code=demo">Allow</a>
        <a href="${back}&error=access_denied">Cancel</a></p>`,
      );
    },
  );
  // The partner sends the browser back to EzyChat (loopback redirect in the app).
  app.get<{ Querystring: { id?: string; code?: string; error?: string } }>(
    '/api/mock/connector-list/partner/callback',
    async (request, reply) => {
      const id = String(request.query.id ?? '');
      const c = store.connections[id];
      const e = entry(id);
      let body = '<p>This sign-in is no longer waiting. Go back to EzyChat.</p>';
      if (c && e && c.state === 'waiting') {
        if (request.query.code) {
          c.state = 'connected';
          c.account = ACCOUNTS[id] ?? 'owner@kopiapong.example';
          c.connectedAt = Date.now();
          c.agents = Object.keys(c.agents).length ? c.agents : (disconnectedChoices[id] ?? {});
          body = `<h1>${escapeHtml(e.name)} is connected</h1><p>Go back to EzyChat. You can close this tab.</p>`;
        } else {
          c.state = 'failed';
          c.error = 'cancelled';
          body = '<h1>Sign-in cancelled</h1><p>Nothing was connected. You can close this tab.</p>';
        }
      }
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
        .send(standInPage(e?.publisher ?? 'Partner', body));
    },
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function standInPage(publisher: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(publisher)} sign-in (stand-in)</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px 16px;background:#f4f4f5;color:#18181b}
main{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:20px}
h1{font-size:20px;margin:8px 0 12px}.muted{color:#71717a;font-size:13px;border:1px dashed #a1a1aa;padding:6px 8px;border-radius:6px}
ul{padding-left:20px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
.actions a{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:8px;border:1px solid #d4d4d8;color:#18181b;text-decoration:none}
.actions a.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#3f3f46}.actions a{color:#fafafa;border-color:#52525b}}
</style></head><body><main><p><strong>${escapeHtml(publisher)}</strong></p>${body}</main></body></html>`;
}

/** Demo activity of the connected Lejar Accounting: one line per kind (never the chat text). */
function demoActivity(now: number): PartnerActivity[] {
  const min = 60_000;
  return [
    {
      at: now - 20 * min,
      kind: 'done',
      agent: 'Aina',
      customer: 'Farah Aziz',
      tool: 'create_quotation',
    },
    {
      at: now - 24 * min,
      kind: 'checked',
      agent: 'Aina',
      customer: 'Farah Aziz',
      tool: 'check_stock',
    },
    {
      at: now - 3 * HOUR,
      kind: 'refused',
      agent: 'Aina',
      customer: 'Tan Wei Jie',
      tool: 'create_quotation',
      reason: 'confirm_first',
    },
    {
      at: now - 5 * HOUR,
      kind: 'refused',
      agent: 'Aina',
      customer: 'Jason Lim',
      tool: 'create_quotation',
      reason: 'from_customer',
    },
    {
      at: now - 6 * HOUR,
      kind: 'checked',
      agent: 'Aina',
      customer: 'Priya Nair',
      tool: 'find_invoice',
    },
    {
      at: now - 26 * HOUR,
      kind: 'failed',
      agent: 'Aina',
      customer: 'Ahmad Zulkifli',
      tool: 'find_invoice',
      reason: 'unreachable',
    },
    {
      at: now - 50 * HOUR,
      kind: 'refused',
      agent: 'Aina',
      customer: 'Nurul Huda',
      tool: 'create_quotation',
      reason: 'value_from',
    },
  ];
}

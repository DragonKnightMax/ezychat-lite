import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import {
  DEFAULT_SQL_AGENT_SETTINGS,
  SQL_ACCESS_KEY,
  sqlHostFromKey,
  sqlKeyEnd,
  type SqlAccountState,
  type SqlAccountStatus,
  type SqlActivity,
  type SqlAgentSettings,
  type SqlConnectResult,
  type SqlCustomerRow,
  type SqlDebtor,
} from '@ezychat/shared';
import { AgentConnectorsCard } from './AgentConnectorsCard';
import { ConnectorDetailPage } from './ConnectorDetailPage';
import { ConnectorsGalleryPage } from './ConnectorsGalleryPage';
import { agent, json, renderAt, stubServer, world, writes } from './connectors.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const KEY = '13fcdacdc0429dc2f8fa47dddf97c393.sql.my/APIUSER';
const PAGE = '/admin/connectors/sql-account';
const MIN = 60_000;

const sqlStatus = (
  state: SqlAccountState,
  patch: Partial<SqlAccountStatus> = {},
): SqlAccountStatus => ({
  state,
  host: state === 'disconnected' ? null : `https://${sqlHostFromKey(KEY)}`,
  keyEnd: state === 'disconnected' ? null : sqlKeyEnd(KEY),
  checkedAt: state === 'disconnected' ? null : Date.now() - 5 * MIN,
  matchByPhone: true,
  phoneMatch: 'available',
  ...patch,
});

/** SQL Account as the page sees it through the server; every write is recorded by the fetch mock. */
interface SqlWorld {
  status: SqlAccountStatus;
  /** What Test connection answers next (default: connected). */
  test?: SqlAccountState;
  /** What Connect answers when the key has the right form (default: connected). */
  connect?: SqlAccountState;
  agents: Record<number, SqlAgentSettings>;
  customers: SqlCustomerRow[];
  debtors: SqlDebtor[];
  activity: SqlActivity[];
}

const sqlWorld = (patch: Partial<SqlWorld> = {}): SqlWorld => ({
  status: sqlStatus('connected'),
  agents: {},
  customers: [],
  debtors: [
    { code: '300-A0001', name: 'Ah Seng Hardware Sdn Bhd' },
    { code: '300-B0002', name: 'Bintang Trading' },
  ],
  activity: [],
  ...patch,
});

function sqlRoute(s: SqlWorld, method: string, url: string, init?: RequestInit): Response | null {
  const [path, search = ''] = url.replace(/^\/api/, '').split('?') as [string, string?];
  if (!path.startsWith('/connectors/sql-account')) return null;
  const rest = path.slice('/connectors/sql-account'.length);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  if (rest === '') return json(s.status);
  if (rest === '/connect' && method === 'POST') {
    const key = String(body.accessKey);
    if (!SQL_ACCESS_KEY.test(key))
      return json({ ok: false, error: 'key_format', status: s.status } satisfies SqlConnectResult);
    const state = s.connect ?? 'connected';
    if (state !== 'connected')
      return json({ ok: false, error: state, status: s.status } satisfies SqlConnectResult);
    s.status = sqlStatus('connected');
    return json({ ok: true, error: null, status: s.status } satisfies SqlConnectResult);
  }
  if (rest === '/test' && method === 'POST') {
    s.status = sqlStatus(s.test ?? 'connected');
    return json(s.status);
  }
  if (rest === '/disconnect' && method === 'POST') {
    s.status = sqlStatus('disconnected');
    return json(s.status);
  }
  if (rest === '/match' && method === 'PUT') {
    s.status = { ...s.status, matchByPhone: Boolean(body.matchByPhone) };
    return json(s.status);
  }
  const agentMatch = /^\/agents\/(\d+)$/.exec(rest);
  if (agentMatch) {
    const id = Number(agentMatch[1]);
    if (method === 'PUT') s.agents[id] = body as SqlAgentSettings;
    return json(s.agents[id] ?? DEFAULT_SQL_AGENT_SETTINGS);
  }
  if (rest === '/customers') return json(s.customers);
  if (rest === '/debtors') {
    if (s.status.state === 'disconnected')
      return json(
        { error: { code: 'sql_unavailable', message: 'SQL Account is not connected' } },
        503,
      );
    const q = (new URLSearchParams(search).get('q') ?? '').toLowerCase();
    return json(s.debtors.filter((d) => !q || `${d.code} ${d.name}`.toLowerCase().includes(q)));
  }
  if (rest === '/links' && method === 'PUT') {
    const code = body.code as string | null;
    if (code !== null && !s.debtors.some((d) => d.code === code))
      return json(
        { error: { code: 'unknown_code', message: 'SQL Account has no customer with this code' } },
        400,
      );
    s.customers = s.customers.map((c) =>
      c.jid === body.jid
        ? {
            ...c,
            kind: code ? 'linked' : 'none',
            code,
            sqlName: s.debtors.find((d) => d.code === code)?.name ?? null,
          }
        : c,
    );
    return json({ ok: true });
  }
  if (rest === '/activity') return json(s.activity);
  return null;
}

/** The connector pages' fake server (connectors.test.helpers) plus SQL Account's routes. */
function stubSql(s: SqlWorld, w = world()) {
  const base = stubServer(w);
  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit) =>
      sqlRoute(s, init?.method ?? 'GET', url, init) ?? base(url, init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as typeof base;
}

const bodies = (fetchMock: ReturnType<typeof stubSql>, call: string) =>
  fetchMock.mock.calls
    .filter((c) => `${c[1]?.method ?? 'GET'} ${c[0]}` === call)
    .map((c) => JSON.parse(String(c[1]!.body)) as unknown);

const page = (path = PAGE) => renderAt(path, <ConnectorDetailPage />);
const location = () => screen.getByTestId('location').textContent;

describe('SQL Account: gallery', () => {
  it.each([
    ['disconnected', 'Not connected'],
    ['connected', 'Connected'],
    ['bad_keys', 'Needs attention'],
  ] as const)('shows the built-in card with its state (%s)', async (state, label) => {
    stubSql(sqlWorld({ status: sqlStatus(state) }));
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    await waitFor(() =>
      expect(
        within(screen.getByTestId('connector-card-sql-account')).getByText(label),
      ).toBeTruthy(),
    );
    const card = screen.getByTestId('connector-card-sql-account');
    expect(within(card).getByText('SQL Account')).toBeTruthy();
    expect(within(card).getByText('Accounting')).toBeTruthy();
    expect(card.querySelector('a')!.getAttribute('href')).toBe(PAGE);
  });
});

describe('SQL Account: Overview and Connection', () => {
  it('explains what it needs and opens the connect form', async () => {
    stubSql(sqlWorld({ status: sqlStatus('disconnected') }));
    page();
    expect(await screen.findByRole('heading', { name: 'SQL Account' })).toBeTruthy();
    expect(await screen.findAllByRole('tab')).toHaveLength(5);
    expect(screen.getByTestId('connector-status-notConnected')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview',
      'Connection',
      'Settings',
      'Customers',
      'Activity',
    ]);
    const req = screen.getByTestId('sql-requirements');
    expect(req.textContent).toContain(
      "needs SQL Account's API module (a paid add-on from your SQL dealer)",
    );
    expect(req.textContent).toContain(
      'SQL Cloud: ask your dealer whether the API module is available.',
    );
    expect(
      screen.getByText('Tells a customer their own invoices and, if you turn it on, what they still owe.'),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect SQL Account' }));
    expect(location()).toBe(`${PAGE}?tab=connection`);
    expect(await screen.findByTestId('sql-connect-form')).toBeTruthy();
  });

  it('connects: a wrong key form, a problem, then success', async () => {
    const s = sqlWorld({ status: sqlStatus('disconnected'), connect: 'no_dns' });
    const fetchMock = stubSql(s);
    page(`${PAGE}?tab=connection`);
    const user = userEvent.setup();
    const access = await screen.findByLabelText('Access key');
    const secret = screen.getByLabelText('Secret key');
    const submit = screen.getByRole('button', { name: 'Test and connect' });
    expect(screen.getByTestId('sql-host').textContent).toContain('filled in from the access key');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(access, 'not-a-key');
    await user.type(secret, 's3cret');
    await user.click(submit);
    expect(
      await screen.findByText(
        'This is not a SQL Account access key. It ends with .sql.my/ and the user name.',
      ),
    ).toBeTruthy();
    expect(access.getAttribute('aria-invalid')).toBe('true');

    await user.clear(access);
    await user.type(access, KEY);
    expect(screen.getByTestId('sql-host').textContent).toContain(
      'https://api.sql.my',
    );
    await user.click(submit);
    expect(await screen.findByText('API service not set up')).toBeTruthy();
    expect(screen.getByTestId('sql-problem-no_dns')).toBeTruthy();

    s.connect = 'connected';
    await user.click(submit);
    expect(await screen.findByTestId('sql-connection')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('SQL Account connected');
    expect(screen.getByText('Connected', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('https://api.sql.my')).toBeTruthy();
    expect(screen.getByText('…c393/APIUSER')).toBeTruthy();
    expect(screen.queryByText('SQL Account version')).toBeNull();
    expect(writes(fetchMock)).toEqual([
      'POST /api/connectors/sql-account/connect',
      'POST /api/connectors/sql-account/connect',
      'POST /api/connectors/sql-account/connect',
    ]);
    expect(bodies(fetchMock, 'POST /api/connectors/sql-account/connect').at(-1)).toEqual({
      accessKey: KEY,
      secretKey: 's3cret',
    });
  });

  it('shows an answer it cannot use as a problem', async () => {
    stubSql(sqlWorld({ status: sqlStatus('disconnected'), connect: 'unexpected' }));
    page(`${PAGE}?tab=connection`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Access key'), KEY);
    await user.type(screen.getByLabelText('Secret key'), 'x');
    await user.click(screen.getByRole('button', { name: 'Test and connect' }));
    expect(
      await screen.findByText(
        'SQL Account answered in a way EzyChat Lite cannot use. Try again later or ask your dealer.',
      ),
    ).toBeTruthy();
  });

  it('tests the connection, shows a problem state, and disconnects', async () => {
    const s = sqlWorld();
    const fetchMock = stubSql(s);
    page(`${PAGE}?tab=connection`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('SQL Account answered.'));

    s.test = 'bad_keys';
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Keys not accepted')).toBeTruthy();
    expect(screen.getByTestId('connector-status-attention')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Nothing changes in SQL Account/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByTestId('sql-connect-form')).toBeTruthy();
    expect(writes(fetchMock)).toEqual([
      'POST /api/connectors/sql-account/test',
      'POST /api/connectors/sql-account/test',
      'POST /api/connectors/sql-account/disconnect',
    ]);
  });

  it.each([
    ['unreachable', "Can't reach your SQL server"],
    ['private_ip', "Can't reach your SQL server"],
    ['old_version', 'SQL Account too old or API not enabled'],
    ['unexpected', "Can't use SQL Account's answer"],
  ] as const)('shows the %s state on the Connection tab', async (state, text) => {
    stubSql(sqlWorld({ status: sqlStatus(state) }));
    page(`${PAGE}?tab=connection`);
    expect(await screen.findByTestId(`sql-problem-${state}`)).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('shows a retry when the status cannot load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'internal', message: 'Boom' } }, 500)),
    );
    page();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('SQL Account: Settings', () => {
  const object = (id: string) => screen.getByTestId(`sql-object-${id}`);
  const choice = (id: string, name: string) =>
    within(object(id)).getByRole('radio', { name }) as HTMLButtonElement;

  it('chooses the access per object and saves it', async () => {
    const s = sqlWorld({ status: sqlStatus('disconnected') });
    const fetchMock = stubSql(s);
    page(`${PAGE}?tab=settings`);
    expect(
      await screen.findByText(
        'Connect SQL Account first. You can choose the settings now; the AI uses them once it is connected.',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('What Aina may use')).toBeTruthy();
    // Defaults: stock, invoices, quotations, orders, deliveries on Read; customer and payments Off.
    expect(choice('stockitem', 'Read').getAttribute('aria-checked')).toBe('true');
    expect(choice('customer', 'Off').getAttribute('aria-checked')).toBe('true');
    expect(choice('customerpayment', 'Off').getAttribute('aria-checked')).toBe('true');
    // The amount owed (accounts-receivable invoices) is money: Off until the admin turns it on.
    expect(choice('customerinvoice', 'Off').getAttribute('aria-checked')).toBe('true');
    expect(
      within(object('customerinvoice')).getByText('Customer invoices (amount owed)'),
    ).toBeTruthy();
    expect(
      within(object('customerinvoice')).queryByRole('radio', { name: 'Read + create' }),
    ).toBeNull();
    expect(within(object('stockitem')).getByText('All customers')).toBeTruthy();
    expect(within(object('salesinvoice')).getByText("Customer's own only")).toBeTruthy();
    // Create only for quotations.
    expect(within(object('salesorder')).queryByRole('radio', { name: 'Read + create' })).toBeNull();
    expect(within(object('customer')).queryByRole('radio', { name: 'Read + create' })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const user = userEvent.setup();
    expect(screen.queryByTestId('sql-quotation-guard')).toBeNull();
    await user.click(choice('salesquotation', 'Read + create'));
    expect(screen.getByTestId('sql-quotation-guard').textContent).toContain(
      'At most 2 quotations per chat a day',
    );
    await user.click(choice('customer', 'Read'));
    await user.click(screen.getByRole('switch', { name: 'Show selling price' }));
    await user.click(screen.getByRole('radio', { name: 'Exact quantity' }));
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved'));
    expect(bodies(fetchMock, 'PUT /api/connectors/sql-account/agents/1')).toEqual([
      {
        access: { salesquotation: 'create', customer: 'read' },
        showPrice: false,
        stockDetail: 'quantity',
      },
    ]);
    await waitFor(() => expect(save.disabled).toBe(true));

    // Stock off hides how stock is shown; Discard goes back to the saved choices.
    await user.click(choice('stockitem', 'Off'));
    expect(screen.queryByRole('switch', { name: 'Show selling price' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(choice('stockitem', 'Read').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('switches matching by phone and says when SQL Account sends no phone numbers', async () => {
    const s = sqlWorld({ status: sqlStatus('connected', { phoneMatch: 'unavailable' }) });
    const fetchMock = stubSql(s, world({ agents: [agent(1, 'Aina'), agent(2, 'Ben')] }));
    page(`${PAGE}?tab=settings&agent=2`);
    expect(await screen.findByText('What Ben may use')).toBeTruthy();
    expect(screen.getByTestId('sql-phone-unavailable').textContent).toBe(
      'Your SQL Account does not send phone numbers to EzyChat Lite: link customers by hand.',
    );
    const sw = screen.getByRole('switch', { name: 'Match by phone number' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    const user = userEvent.setup();
    await user.click(sw);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Match by phone number' }).getAttribute('aria-checked'),
      ).toBe('false'),
    );
    expect(bodies(fetchMock, 'PUT /api/connectors/sql-account/match')).toEqual([
      { matchByPhone: false },
    ]);
  });

  it('hides the phone note while phone numbers are available', async () => {
    stubSql(sqlWorld());
    page(`${PAGE}?tab=settings`);
    expect(await screen.findByText('Who is this customer in SQL Account?')).toBeTruthy();
    expect(screen.queryByTestId('sql-phone-unavailable')).toBeNull();
  });

  it('says while phone numbers are still being read', async () => {
    stubSql(sqlWorld({ status: sqlStatus('connected', { phoneMatch: 'building' }) }));
    page(`${PAGE}?tab=settings`);
    expect((await screen.findByTestId('sql-phone-building')).textContent).toBe(
      'Reading phone numbers from SQL Account… Chats are matched as soon as their customer is read.',
    );
    expect(screen.queryByTestId('sql-phone-unavailable')).toBeNull();
  });
});

const CUSTOMERS: SqlCustomerRow[] = [
  {
    jid: '60123110021@s.whatsapp.net',
    name: 'Mei Ling',
    kind: 'linked',
    code: '300-A0001',
    sqlName: 'Ah Seng Hardware Sdn Bhd',
  },
  {
    jid: '60123110022@s.whatsapp.net',
    name: 'Rahman',
    kind: 'phone',
    code: '300-B0002',
    sqlName: 'Bintang Trading',
  },
  { jid: '60123110023@s.whatsapp.net', name: 'Kumar', kind: 'several', code: null, sqlName: null },
  { jid: '60123110024@s.whatsapp.net', name: 'Siti', kind: 'none', code: null, sqlName: null },
];

describe('SQL Account: Customers', () => {
  const row = (jid: string) => screen.getByTestId(`sql-customer-${jid}`);

  it('lists chats with their match and links one through the dialog', async () => {
    const s = sqlWorld({ customers: CUSTOMERS });
    const fetchMock = stubSql(s);
    page(`${PAGE}?tab=customers`);
    await screen.findByTestId('sql-customers');
    const linked = row(CUSTOMERS[0]!.jid);
    expect(within(linked).getByText('Linked')).toBeTruthy();
    expect(within(linked).getByText('300-A0001 · Ah Seng Hardware Sdn Bhd')).toBeTruthy();
    expect(within(linked).getByRole('link', { name: 'Mei Ling' }).getAttribute('href')).toBe(
      '/chats/60123110021%40s.whatsapp.net',
    );
    expect(within(row(CUSTOMERS[1]!.jid)).getByText('Matched by phone')).toBeTruthy();
    expect(within(row(CUSTOMERS[2]!.jid)).getByText('Several customers')).toBeTruthy();
    expect(within(row(CUSTOMERS[2]!.jid)).getByText(/More than one SQL Account/)).toBeTruthy();
    const siti = row(CUSTOMERS[3]!.jid);
    expect(within(siti).getByText('Not matched')).toBeTruthy();
    expect(within(row(CUSTOMERS[1]!.jid)).queryByRole('button', { name: 'Unlink' })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(siti).getByRole('button', { name: 'Link' }));
    const dialog = await screen.findByTestId('sql-link-dialog');
    expect(await within(dialog).findByText('Ah Seng Hardware Sdn Bhd')).toBeTruthy();
    await user.type(within(dialog).getByRole('searchbox'), 'bintang');
    await waitFor(() => expect(within(dialog).queryByText('Ah Seng Hardware Sdn Bhd')).toBeNull());
    await user.click(within(dialog).getByRole('button', { name: 'Link 300-B0002' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Linked to 300-B0002'));
    await waitFor(() => expect(within(row(CUSTOMERS[3]!.jid)).getByText('Linked')).toBeTruthy());
    expect(bodies(fetchMock, 'PUT /api/connectors/sql-account/links')).toEqual([
      { jid: CUSTOMERS[3]!.jid, code: '300-B0002' },
    ]);
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/connectors/sql-account/debtors?q=bintang'),
    ).toBe(true);
  });

  it('says when SQL Account has no such customer, and unlinks', async () => {
    const s = sqlWorld({ customers: CUSTOMERS });
    const fetchMock = stubSql(s);
    page(`${PAGE}?tab=customers`);
    await screen.findByTestId('sql-customers');
    const user = userEvent.setup();
    await user.click(within(row(CUSTOMERS[0]!.jid)).getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByTestId('sql-link-dialog');
    await within(dialog).findByText('Bintang Trading');
    // SQL Account lost the customer meanwhile: the server refuses the code.
    s.debtors = [];
    await user.click(within(dialog).getByRole('button', { name: 'Link 300-B0002' }));
    expect(
      await within(dialog).findByText('SQL Account has no customer with this code.'),
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('sql-link-dialog')).toBeNull());

    await user.click(within(row(CUSTOMERS[0]!.jid)).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Link removed'));
    await waitFor(() =>
      expect(within(row(CUSTOMERS[0]!.jid)).getByText('Not matched')).toBeTruthy(),
    );
    expect(bodies(fetchMock, 'PUT /api/connectors/sql-account/links')).toEqual([
      { jid: CUSTOMERS[0]!.jid, code: '300-B0002' },
      { jid: CUSTOMERS[0]!.jid, code: null },
    ]);
  });

  it('asks to connect before searching, and shows an empty list', async () => {
    stubSql(sqlWorld({ status: sqlStatus('disconnected'), customers: CUSTOMERS }));
    page(`${PAGE}?tab=customers`);
    await screen.findByTestId('sql-customers');
    const user = userEvent.setup();
    await user.click(within(row(CUSTOMERS[3]!.jid)).getByRole('button', { name: 'Link' }));
    expect(
      await screen.findByText('Connect SQL Account first to search its customers.'),
    ).toBeTruthy();
    cleanup();
    stubSql(sqlWorld());
    page(`${PAGE}?tab=customers`);
    expect(await screen.findByText('No chats yet.')).toBeTruthy();
  });

  it('says when no SQL Account customer is found', async () => {
    stubSql(sqlWorld({ customers: CUSTOMERS, debtors: [] }));
    page(`${PAGE}?tab=customers`);
    await screen.findByTestId('sql-customers');
    const user = userEvent.setup();
    await user.click(within(row(CUSTOMERS[3]!.jid)).getByRole('button', { name: 'Link' }));
    expect(await screen.findByText('No SQL Account customer found.')).toBeTruthy();
  });
});

describe('SQL Account: Activity', () => {
  it('lists what the AI did: agent, chat link, result, reason and quotation id', async () => {
    const at = Date.now() - 3 * MIN;
    stubSql(
      sqlWorld({
        activity: [
          {
            id: 3,
            at,
            agentId: 1,
            agentName: 'Aina',
            chatJid: '60123110021@s.whatsapp.net',
            chatName: 'Mei Ling',
            tool: 'quotation',
            result: 'done',
            reason: null,
            dockey: 4182,
          },
          {
            id: 2,
            at,
            agentId: 1,
            agentName: 'Aina',
            chatJid: '60123110024@s.whatsapp.net',
            chatName: 'Siti',
            tool: 'account',
            result: 'refused',
            reason: 'no_customer',
            dockey: null,
          },
          {
            id: 1,
            at,
            agentId: null,
            agentName: null,
            chatJid: null,
            chatName: null,
            tool: 'stock',
            result: 'failed',
            reason: 'bad_keys',
            dockey: null,
          },
        ],
      }),
    );
    page(`${PAGE}?tab=activity`);
    const list = await screen.findByTestId('sql-activity');
    const items = within(list).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Aina created a quotation for Mei Ling');
    expect(items[0]!.textContent).toContain('SQL Account ID 4182');
    expect(items[0]!.textContent).toContain('Done');
    expect(within(items[0]!).getByRole('link', { name: 'Mei Ling' }).getAttribute('href')).toBe(
      '/chats/60123110021%40s.whatsapp.net',
    );
    expect(items[1]!.textContent).toContain('Aina checked the invoices of Siti');
    expect(items[1]!.textContent).toContain(
      'Not allowed · no matched customer, handed to the team',
    );
    expect(items[2]!.textContent).toContain('AI agent checked stock for a chat');
    expect(items[2]!.textContent).toContain('Failed · keys not accepted');
    expect(within(items[2]!).queryByRole('link')).toBeNull();
  });

  it('says when nothing happened yet', async () => {
    stubSql(sqlWorld());
    page(`${PAGE}?tab=activity`);
    expect(await screen.findByText('Nothing yet.')).toBeTruthy();
  });
});

describe('SQL Account: agent page', () => {
  it("summarises the agent's access and opens its settings", async () => {
    stubSql(
      sqlWorld({
        agents: { 1: { access: { stockitem: 'off' }, showPrice: true, stockDetail: 'inStock' } },
      }),
      world({ google: { ...world().google, state: 'disconnected' } }),
    );
    renderAt('/admin/members/ai/1', <AgentConnectorsCard agentId={1} name="Aina" />, {
      route: '/admin/members/ai/:id',
    });
    const row = await screen.findByTestId('agent-connector-sql-account');
    expect(row.getAttribute('href')).toBe(`${PAGE}?tab=settings&agent=1`);
    expect(await within(row).findByText('4 of 8 kinds of records on')).toBeTruthy();
  });

  it('marks a SQL Account that needs attention and says Off when nothing is on', async () => {
    const off = Object.fromEntries(
      ['stockitem', 'salesinvoice', 'salesquotation', 'salesorder', 'deliveryorder'].map((k) => [
        k,
        'off',
      ]),
    );
    stubSql(
      sqlWorld({
        status: sqlStatus('unreachable'),
        agents: { 1: { access: off, showPrice: true, stockDetail: 'inStock' } },
      }),
      world({ google: { ...world().google, state: 'disconnected' } }),
    );
    renderAt('/admin/members/ai/1', <AgentConnectorsCard agentId={1} name="Aina" />, {
      route: '/admin/members/ai/:id',
    });
    const row = await screen.findByTestId('agent-connector-sql-account');
    expect(within(row).getByText('Needs attention')).toBeTruthy();
    expect(await within(row).findByText('Off for this agent')).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { ConnectorsGalleryPage } from './ConnectorsGalleryPage';
import {
  DEFAULT_LIST,
  connection,
  entry,
  gallery as list,
  listStatus,
  listed,
  renderAt,
  status,
  stubServer,
  world,
  writes,
} from './connectors.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const gallery = (opts: Parameters<typeof renderAt>[2] = {}) =>
  renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors', ...opts });
const card = (id: string) => screen.getByTestId(`connector-card-${id}`);
const section = (name: string) =>
  screen.getByRole('heading', { name }).parentElement as HTMLElement;

describe('Connectors gallery', () => {
  it('lists a connected Google Calendar first and every other connector below', async () => {
    stubServer(world());
    gallery();
    await screen.findByRole('heading', { name: 'Your connectors' });
    expect(within(section('Your connectors')).getByText('Google Calendar')).toBeTruthy();
    expect(within(card('google-calendar')).getByText('Connected')).toBeTruthy();
    expect(card('google-calendar').querySelector('a')!.getAttribute('href')).toBe(
      '/admin/connectors/google-calendar',
    );
    await screen.findByTestId('connector-card-xero');
    const more = section('More connectors');
    expect(within(more).getByText('Xero')).toBeTruthy();
    expect(within(more).queryByText('Google Calendar')).toBeNull();
    expect(within(card('shopify')).getByText('Coming soon')).toBeTruthy();
  });

  it('shows Needs attention for an expired sign-in and Not connected before sign-in', async () => {
    stubServer(world({ google: status('expired') }));
    gallery();
    await screen.findByRole('heading', { name: 'Your connectors' });
    expect(within(card('google-calendar')).getByText('Needs attention')).toBeTruthy();
    cleanup();
    stubServer(world({ google: status('disconnected') }));
    gallery();
    await screen.findAllByText('Not connected');
    expect(within(card('google-calendar')).getByText('Not connected')).toBeTruthy();
    expect(within(card('google-sheets')).getByText('Not connected')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your connectors' })).toBeNull();
  });

  it('greys out the custom MCP connector as Enterprise only in Lite', async () => {
    stubServer(world());
    gallery();
    const custom = await screen.findByTestId('connector-card-custom-mcp');
    expect(custom.className).toContain('border-dashed');
    expect(within(custom).getByText('Enterprise only')).toBeTruthy();
    expect(within(custom).queryByTestId('vote-connector')).toBeNull();
    expect(custom.querySelector('a')!.getAttribute('href')).toBe('/admin/connectors/custom-mcp');
  });

  it("opens an extension's own page for the custom connector, without the Enterprise badge", async () => {
    stubServer(world());
    gallery({
      extensions: [{ name: 'ent', connectorLinks: { 'custom-mcp': '/admin/ext/ent/c' } }],
    });
    const custom = await screen.findByTestId('connector-card-custom-mcp');
    expect(custom.className).not.toContain('border-dashed');
    expect(within(custom).queryByText('Enterprise only')).toBeNull();
    expect(custom.querySelector('a')!.getAttribute('href')).toBe('/admin/ext/ent/c');
  });

  it('filters by category and by search, and says when nothing matches', async () => {
    stubServer(world());
    gallery();
    const user = userEvent.setup();
    await screen.findByTestId('connector-card-autocount');
    await user.click(screen.getByRole('button', { name: 'Accounting' }));
    expect(screen.getByRole('button', { name: 'Accounting' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('AutoCount')).toBeTruthy();
    expect(screen.queryByText('Shopify')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search connectors' }), 'payment link');
    expect(screen.getByText('HitPay')).toBeTruthy();
    expect(screen.getByText('Billplz')).toBeTruthy();
    expect(screen.queryByText('Xero')).toBeNull();
    await user.clear(screen.getByRole('searchbox', { name: 'Search connectors' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search connectors' }), 'zzz');
    expect(screen.getByText('No connector matches')).toBeTruthy();
  });

  it('votes and asks through WhatsApp with a ready message naming the connector', async () => {
    stubServer(world());
    gallery();
    const vote = within(await screen.findByTestId('connector-card-xero')).getByTestId(
      'vote-connector',
    );
    const href = vote.getAttribute('href')!;
    expect(href.startsWith('https://wa.me/601159246128?text=')).toBe(true);
    expect(decodeURIComponent(href.split('text=')[1]!)).toContain('add the Xero connector');
    expect(vote.getAttribute('target')).toBe('_blank');
    expect(vote.getAttribute('rel')).toContain('noopener');
    const ask = screen.getByTestId('request-connector').getAttribute('href')!;
    expect(decodeURIComponent(ask)).toContain('we would like a connector for');
    expect(within(card('google-calendar')).queryByTestId('vote-connector')).toBeNull();
  });

  it('hides Vote and Ask when the product has no connector request link', async () => {
    stubServer(world());
    gallery({ links: { connectorRequest: null } });
    await screen.findByTestId('connector-card-xero');
    expect(screen.queryByTestId('vote-connector')).toBeNull();
    expect(screen.queryByTestId('request-connector')).toBeNull();
  });
});

const LEJAR = entry('lejar', {
  name: 'Lejar Accounting',
  publisher: 'Lejar Sdn Bhd',
  category: 'accounting',
  summary: { en: 'Invoices and quotations.', ms: 'Invois dan sebut harga.' },
});

describe('Connectors gallery: the connector list', () => {
  it('asks the server for the newest list once when it opens and shows when it was updated', async () => {
    const fetchMock = stubServer(world());
    gallery();
    const line = await screen.findByTestId('connector-list-status');
    expect(line.textContent).toMatch(/Connector list updated 2 hours ago/);
    await waitFor(() => expect(writes(fetchMock)).toEqual(['POST /api/connectors/list/refresh']));
    expect(screen.queryByTestId('connector-list-offline')).toBeNull();
    expect(screen.queryByTestId('connector-list-rejected')).toBeNull();
  });

  it('checks for new connectors on request and says what came back', async () => {
    const w = world();
    const fetchMock = stubServer(w);
    gallery();
    const user = userEvent.setup();
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    const check = await screen.findByTestId('check-connector-list');
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    await user.click(check);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('You have the newest connector list.'),
    );
    w.refreshed = list([...DEFAULT_LIST, listed(LEJAR)], listStatus('loaded', { sequence: 43 }));
    await user.click(screen.getByTestId('check-connector-list'));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('The connector list is updated.'),
    );
    expect(await screen.findByTestId('connector-card-lejar')).toBeTruthy();
    w.refreshed = list(DEFAULT_LIST, listStatus('offline'));
    await user.click(screen.getByTestId('check-connector-list'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not reach the connector list. Try again later.',
      ),
    );
    expect(await screen.findByTestId('connector-list-offline')).toBeTruthy();
    w.refreshed = list(DEFAULT_LIST, listStatus('rejected'));
    await user.click(screen.getByTestId('check-connector-list'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'The new connector list did not pass its safety check. The last good copy stays.',
      ),
    );
    expect(writes(fetchMock)).toHaveLength(5);
  });

  it('says when it shows the last copy because the list could not be reached', async () => {
    stubServer(world({ gallery: list(DEFAULT_LIST, listStatus('offline')) }));
    gallery();
    expect(await screen.findByTestId('connector-list-offline')).toBeTruthy();
    expect(screen.getByText('Could not check for new connectors')).toBeTruthy();
    expect(screen.getByTestId('connector-list-status').textContent).toMatch(
      /Connector list from 5 hours ago/,
    );
  });

  it('warns admins when a new list failed its checks', async () => {
    stubServer(world({ gallery: list(DEFAULT_LIST, listStatus('rejected')) }));
    gallery();
    expect(await screen.findByTestId('connector-list-rejected')).toBeTruthy();
    expect(screen.getByText('The new connector list was not used')).toBeTruthy();
  });

  it('stays quiet with the list that came with EzyChat', async () => {
    stubServer(
      world({
        gallery: list(
          DEFAULT_LIST,
          listStatus('builtin', { generatedAt: null, checkedAt: null, sequence: null }),
        ),
      }),
    );
    gallery();
    expect(await screen.findByText('Connector list that came with EzyChat')).toBeTruthy();
    expect(screen.queryByTestId('connector-list-offline')).toBeNull();
    expect(screen.queryByTestId('connector-list-rejected')).toBeNull();
  });

  it('shows partner connectors with their publisher, state and own icon', async () => {
    stubServer(
      world({
        gallery: list([
          ...DEFAULT_LIST,
          listed(
            { ...LEJAR, icon: { file: 'lejar.svg', sha256: 'a'.repeat(64), size: 100 } },
            { connection: connection('connected', { account: 'owner@kopiapong.my' }) },
          ),
          listed(entry('kedai', { name: 'Kedai CRM', category: 'crm' })),
          listed(entry('stok', { name: 'Stok Awan' }), { connection: connection('needs_sign_in') }),
        ]),
      }),
    );
    gallery();
    await screen.findByTestId('connector-card-lejar');
    const mine = section('Your connectors');
    expect(within(mine).getByText('Lejar Accounting')).toBeTruthy();
    expect(within(card('lejar')).getByText('Connected')).toBeTruthy();
    expect(within(card('lejar')).getByText('By Lejar Sdn Bhd · Accounting')).toBeTruthy();
    expect(card('lejar').querySelector('img')!.getAttribute('src')).toBe(
      '/api/connectors/icons/lejar.svg',
    );
    expect(card('lejar').querySelector('a')!.getAttribute('href')).toBe('/admin/connectors/lejar');
    expect(within(mine).getByText('Stok Awan')).toBeTruthy();
    expect(within(card('stok')).getByText('Needs attention')).toBeTruthy();
    expect(within(section('More connectors')).getByText('Kedai CRM')).toBeTruthy();
    expect(within(card('kedai')).getByText('Not connected')).toBeTruthy();
    expect(card('kedai').querySelector('img')).toBeNull();
    // The built-in Google Calendar shows once, with the app's own page.
    expect(screen.getAllByTestId('connector-card-google-calendar')).toHaveLength(1);
  });

  it('greys out entries for a newer EzyChat and Enterprise-only entries in Lite', async () => {
    stubServer(
      world({
        gallery: list([
          ...DEFAULT_LIST,
          listed(entry('bayar', { name: 'Bayar Payments', category: 'payments' }), {
            fit: 'needsUpdate',
          }),
          listed(entry('gudang', { name: 'Gudang Stock' }), { fit: 'enterprise' }),
        ]),
      }),
    );
    gallery();
    const bayar = await screen.findByTestId('connector-card-bayar');
    expect(bayar.className).toContain('border-dashed');
    expect(within(bayar).getByText('Needs a newer EzyChat')).toBeTruthy();
    expect(within(bayar).getByText('Update EzyChat to use this connector.')).toBeTruthy();
    const gudang = card('gudang');
    expect(gudang.className).toContain('border-dashed');
    expect(within(gudang).getByText('Enterprise only')).toBeTruthy();
  });

  it('keeps a connected connector that left the list under Your connectors, flagged', async () => {
    stubServer(
      world({
        gallery: list([
          ...DEFAULT_LIST,
          listed(LEJAR, { delisted: true, connection: connection('connected') }),
          listed(entry('old'), { delisted: true, connection: connection('disconnected') }),
        ]),
      }),
    );
    gallery();
    const lejar = await screen.findByTestId('connector-card-lejar');
    expect(within(lejar).getByText('No longer available')).toBeTruthy();
    expect(within(section('Your connectors')).getByText('Lejar Accounting')).toBeTruthy();
    expect(screen.queryByTestId('connector-card-old')).toBeNull();
  });

  it('finds connectors by publisher and shows only the categories in use', async () => {
    stubServer(world({ gallery: list([...DEFAULT_LIST, listed(LEJAR)]) }));
    gallery();
    const user = userEvent.setup();
    await screen.findByTestId('connector-card-lejar');
    expect(screen.queryByRole('button', { name: 'CRM' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Online shop' })).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search connectors' }), 'lejar sdn');
    expect(screen.getByTestId('connector-card-lejar')).toBeTruthy();
    expect(screen.queryByTestId('connector-card-xero')).toBeNull();
  });

  it('still shows the app connectors and a retry when the list cannot load', async () => {
    stubServer(
      world({ fail: { 'GET /connectors/list': 500, 'POST /connectors/list/refresh': 500 } }),
    );
    gallery();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByTestId('connector-card-google-calendar')).toBeTruthy();
    expect(screen.getByTestId('connector-card-custom-mcp')).toBeTruthy();
  });
});

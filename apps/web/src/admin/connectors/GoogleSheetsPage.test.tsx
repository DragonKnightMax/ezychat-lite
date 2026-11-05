import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { DEFAULT_SHEETS_SETTINGS, type SheetsAgentSettings } from '@ezychat/shared';
import { AgentConnectorsCard } from './AgentConnectorsCard';
import { ConnectorDetailPage } from './ConnectorDetailPage';
import { ConnectorsGalleryPage } from './ConnectorsGalleryPage';
import {
  SHEET,
  SHEET_ID,
  agent,
  renderAt,
  sheetsStatus,
  stubServer,
  world,
  writes,
} from './connectors.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

beforeAll(() => {
  // Radix Select uses pointer capture and scrollIntoView, which jsdom lacks.
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

const GS = '/admin/connectors/google-sheets';
const page = (path: string) => renderAt(path, <ConnectorDetailPage />);
const location = () => screen.getByTestId('location').textContent;
const connected = (patch: Parameters<typeof world>[0] = {}) =>
  world({ sheets: sheetsStatus('connected'), ...patch });

describe('Google Sheets: gallery and Overview', () => {
  it('shows the built-in card in the gallery with its own sign-in state', async () => {
    stubServer(connected());
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    // Connected cards move to "Your connectors": query the card again once the state is in.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('connector-card-google-sheets')).getByText('Connected'),
      ).toBeTruthy(),
    );
    const card = screen.getByTestId('connector-card-google-sheets');
    expect(within(card).getByText('Google Sheets')).toBeTruthy();
    expect(card.querySelector('a')!.getAttribute('href')).toBe(GS);
  });

  it('connects with Google in a new window and shows the account', async () => {
    const fetchMock = stubServer(world());
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    page(GS);
    expect(await screen.findByRole('heading', { name: 'Google Sheets' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview',
      'Settings',
      'Activity',
    ]);
    expect(screen.getByText('Answer questions from the sheet')).toBeTruthy();
    expect(screen.getByText('Save interested customers (leads)')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Connect Google Sheets' }));
    await waitFor(() =>
      expect(tab.location.href).toBe('https://accounts.google.com/o/oauth2/v2/auth?s=1'),
    );
    expect(await screen.findByText('Working')).toBeTruthy();
    expect(screen.getByText('kopiapong@gmail.com')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Google Sheets connected');
    expect(writes(fetchMock)).toEqual(['POST /api/connectors/google-sheets/connect']);
  });

  it('warns about an expired sign-in or an unreachable Google, and disconnects', async () => {
    stubServer(world({ sheets: sheetsStatus('expired') }));
    page(GS);
    expect(await screen.findByText('Google sign-in expired')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    cleanup();
    stubServer(world({ sheets: sheetsStatus('unavailable') }));
    page(GS);
    expect(await screen.findByText("Can't reach Google Sheets")).toBeTruthy();
    cleanup();
    const fetchMock = stubServer(connected());
    page(GS);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Rows already in your sheet stay/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect Google Sheets' })).toBeTruthy();
    expect(writes(fetchMock)).toEqual(['POST /api/connectors/google-sheets/disconnect']);
    cleanup();
    stubServer(world({ sheets: sheetsStatus('not_configured') }));
    page(GS);
    expect(
      await screen.findByText('Google sign-in is not set up in this build of EzyChat Lite.'),
    ).toBeTruthy();
  });
});

describe('Google Sheets: Settings', () => {
  it('asks to connect first', async () => {
    stubServer(world());
    page(`${GS}?tab=settings`);
    expect(
      await screen.findByText('Connect a Google account on the Overview tab first.'),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect Google Sheets' }));
    expect(location()).toBe(`${GS}?tab=overview`);
  });

  it("chooses a sheet in Google's file picker, sets each tab's access and saves the tabs", async () => {
    const w = connected({
      pickerProgress: [
        { status: 'pending', sheet: null },
        { status: 'done', sheet: SHEET },
      ],
    });
    const fetchMock = stubServer(w);
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    page(`${GS}?tab=settings`);
    const user = userEvent.setup();
    // No sheet yet: no tab list.
    await user.click(await screen.findByTestId('sheets-choose'));
    expect(screen.queryByTestId('sheets-tabs')).toBeNull();
    await waitFor(() =>
      expect(tab.location.href).toBe(
        'http://127.0.0.1:7420/api/connectors/google-sheets/picker-page?token=t',
      ),
    );
    expect(tab.opener).toBeNull();
    const chosen = await screen.findByTestId('sheets-chosen', {}, { timeout: 4000 });
    expect(within(chosen).getByText('Kopi Apong prices')).toBeTruthy();
    expect(
      within(chosen)
        .getByRole('link', { name: /Open in Google Sheets/ })
        .getAttribute('href'),
    ).toBe(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
    expect(screen.getByTestId('sheets-choose').textContent).toContain('Choose another sheet');

    // Every tab starts Off, with its column names; EzyChat's own columns are tinted.
    const menu = screen.getByRole('radiogroup', { name: 'Menu' });
    expect(within(menu).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    const leadColumns = screen.getByRole('list', { name: 'Columns of Leads' });
    const auto = [...leadColumns.querySelectorAll('[data-auto]')].map((c) => c.textContent);
    expect(auto).toEqual(['Date', 'Name', 'WhatsApp']);
    expect(within(leadColumns).getByText('Email').hasAttribute('data-auto')).toBe(false);
    // A tab with an empty first row can only stay Off.
    const notes = screen.getByRole('radiogroup', { name: 'Notes' });
    expect(within(notes).getAllByRole('radio')).toHaveLength(1);
    expect(within(notes).getByRole('radio', { name: 'Off' })).toBeTruthy();
    expect(
      screen.getByText('Add column names in the first row of this tab before the AI can use it.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Filled in by EzyChat Lite when the tab has these columns: Date, Name, WhatsApp, Group, AI agent, Source\./,
      ),
    ).toBeTruthy();

    await user.click(within(menu).getByRole('radio', { name: 'Read' }));
    const leads = screen.getByRole('radiogroup', { name: 'Leads' });
    await user.click(within(leads).getByRole('radio', { name: 'Add rows' }));
    // Back to Off and on again: an Off tab is not listed.
    await user.click(within(menu).getByRole('radio', { name: 'Off' }));
    await user.click(within(menu).getByRole('radio', { name: 'Read' }));

    // Refresh of a sheet that is not saved yet reads it with the plain look-up.
    await user.click(screen.getByTestId('sheets-refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('sheets-checked').textContent).toBe('no changes'),
    );
    expect(writes(fetchMock)).toContain('POST /api/connectors/google-sheets/spreadsheet');
    expect(writes(fetchMock)).not.toContain('POST /api/connectors/google-sheets/agents/1/refresh');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(writes(fetchMock)).toContain('PUT /api/connectors/google-sheets/agents/1'),
    );
    expect(w.sheetSettings[1]).toEqual({
      ...DEFAULT_SHEETS_SETTINGS,
      spreadsheetId: SHEET_ID,
      spreadsheetName: 'Kopi Apong prices',
      tabs: [
        { title: 'Leads', access: 'add' },
        { title: 'Menu', access: 'read' },
      ],
    });
    expect(toast.success).toHaveBeenCalledWith('Google Sheets settings saved');
  });

  it('marks a new tab, changed columns and added columns after Refresh', async () => {
    const before = { ...SHEET, checkedAt: Date.now() - 5 * 60_000 };
    const after = {
      ...SHEET,
      checkedAt: Date.now(),
      tabs: [
        { title: 'Menu', rows: 1000, columns: ['Item', 'Price', 'Stock'] },
        {
          title: 'Leads',
          rows: 1000,
          columns: ['Date', 'Name', 'WhatsApp', 'Email', 'Request', 'Product'],
        },
        { title: 'Notes', rows: 1000, columns: ['Date', 'Note'] },
        { title: 'Repairs', rows: 1000, columns: ['Date', 'Policy no'] },
      ],
    };
    const fetchMock = stubServer(
      connected({
        sheetSettings: {
          1: {
            ...DEFAULT_SHEETS_SETTINGS,
            spreadsheetId: SHEET_ID,
            spreadsheetName: 'Kopi Apong prices',
            tabs: [{ title: 'Leads', access: 'add' }],
          },
        },
        sheetRefresh: [before, after],
      }),
    );
    page(`${GS}?tab=settings`);
    // Opening Settings reads the tabs once with Refresh.
    expect((await screen.findByTestId('sheets-checked')).textContent).toBe('Checked 5 minutes ago');
    expect(screen.queryByText('New tab')).toBeNull();
    // Nothing changed yet: Save stays off.
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('sheets-refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('sheets-checked').textContent).toBe(
        'Checked just now · 1 new tab, 2 tabs changed',
      ),
    );
    const row = (title: string) => screen.getByRole('radiogroup', { name: title }).closest('li')!;
    expect(within(row('Repairs')).getByText('New tab')).toBeTruthy();
    expect(within(row('Leads')).getByText('Columns changed')).toBeTruthy();
    expect(within(row('Notes')).getByText('Columns changed')).toBeTruthy();
    expect(within(row('Menu')).queryByText('Columns changed')).toBeNull();
    const added = [...row('Leads').querySelectorAll('[data-added]')].map((c) => c.textContent);
    expect(added).toEqual(['Product (new column)']);
    // A new tab starts Off; Notes has column names now, so it can be read.
    expect(
      within(row('Repairs')).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(within(row('Notes')).getByRole('radio', { name: 'Read' })).toBeTruthy();
    // Refresh again with nothing new.
    await user.click(screen.getByTestId('sheets-refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('sheets-checked').textContent).toBe(
        'Checked just now · no changes',
      ),
    );
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/agents/1/refresh')),
    ).toHaveLength(3);
  });

  it('falls back to the plain look-up when Refresh is busy on open, and says so on a press', async () => {
    const fetchMock = stubServer(
      connected({
        sheetSettings: {
          1: {
            ...DEFAULT_SHEETS_SETTINGS,
            spreadsheetId: SHEET_ID,
            spreadsheetName: 'Kopi Apong prices',
            tabs: [],
          },
        },
        sheetRefresh: ['busy'],
      }),
    );
    page(`${GS}?tab=settings`);
    expect(await screen.findByRole('radiogroup', { name: 'Menu' })).toBeTruthy();
    expect(writes(fetchMock)).toContain('POST /api/connectors/google-sheets/spreadsheet');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.setup().click(screen.getByTestId('sheets-refresh'));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it.each([
    ['cancelled', 'No sheet was chosen.'],
    ['expired', 'The file picker took too long. Try again.'],
  ] as const)('says when the picker ended %s', async (status, text) => {
    stubServer(connected({ pickerProgress: [{ status, sheet: null }] }));
    vi.spyOn(window, 'open').mockReturnValue(null);
    page(`${GS}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('sheets-choose'));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByTestId('sheets-chosen')).toBeNull();
  });

  it('offers the picker link when the window was blocked, and can cancel', async () => {
    stubServer(connected({ pickerProgress: [{ status: 'pending', sheet: null }] }));
    vi.spyOn(window, 'open').mockReturnValue(null);
    page(`${GS}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('sheets-choose'));
    const waiting = await screen.findByTestId('sheets-picking');
    expect(within(waiting).getByText(/blocked the window/)).toBeTruthy();
    expect(
      within(waiting)
        .getByRole('link', { name: /Open the file picker/ })
        .getAttribute('href'),
    ).toContain('/api/connectors/google-sheets/picker-page');
    await user.click(within(waiting).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('sheets-picking')).toBeNull();
    expect(screen.getByTestId('sheets-choose')).toBeTruthy();
  });

  it('loads the saved sheet, flags a tab Google no longer lists and drops it on Save', async () => {
    const saved = {
      ...DEFAULT_SHEETS_SETTINGS,
      spreadsheetId: SHEET_ID,
      spreadsheetName: 'Kopi Apong prices',
      tabs: [
        { title: 'Menu', access: 'read' as const },
        { title: 'Old tab', access: 'add' as const },
      ],
    };
    const w = world({
      sheets: sheetsStatus('expired'),
      sheetSettings: { 2: saved },
      agents: [agent(1, 'Aina'), agent(2, 'Ben')],
    });
    const fetchMock = stubServer(w);
    page(`${GS}?tab=settings&agent=2`);
    expect(await screen.findByText('Paused: sign in to Google again')).toBeTruthy();
    expect(screen.getByText('Ben does not use the sheet until it works again.')).toBeTruthy();
    expect(within(screen.getByTestId('sheets-chosen')).getByText('Kopi Apong prices')).toBeTruthy();
    const gone = await screen.findByTestId('sheets-tab-gone');
    expect(within(gone).getByText('Old tab')).toBeTruthy();
    expect(within(gone).getByText('No longer in the sheet')).toBeTruthy();
    expect(writes(fetchMock)).toContain('POST /api/connectors/google-sheets/agents/2/refresh');
    const menu = screen.getByRole('radiogroup', { name: 'Menu' });
    expect(within(menu).getByRole('radio', { name: 'Read' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    // Dropping the tab is a change the admin saves (never silently).
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(writes(fetchMock)).toContain('PUT /api/connectors/google-sheets/agents/2'),
    );
    expect(w.sheetSettings[2]!.tabs).toEqual([{ title: 'Menu', access: 'read' }]);
  });

  it('shows the two write switches only on Add rows, off by default, and saves them per tab', async () => {
    const saved = {
      ...DEFAULT_SHEETS_SETTINGS,
      spreadsheetId: SHEET_ID,
      spreadsheetName: 'Kopi Apong prices',
      tabs: [
        { title: 'Menu', access: 'read' as const },
        { title: 'Leads', access: 'add' as const },
      ],
    };
    const w = connected({ sheetSettings: { 1: saved } });
    const fetchMock = stubServer(w);
    page(`${GS}?tab=settings`);
    const box = await screen.findByTestId('sheets-tab-permissions');
    // Only the Add rows tab has them; the Read tab has none.
    expect(screen.getAllByTestId('sheets-tab-permissions')).toHaveLength(1);
    expect(box.getAttribute('aria-label')).toBe('What the AI may write in Leads');
    const aiValues = within(box).getByRole('switch', {
      name: 'Let the AI fill values it looked up or calculated',
    });
    const formulas = within(box).getByRole('switch', { name: 'Allow formulas' });
    expect(aiValues.getAttribute('aria-checked')).toBe('false');
    expect(formulas.getAttribute('aria-checked')).toBe('false');
    expect(within(box).getByText(/It never makes one up\./)).toBeTruthy();
    const user = userEvent.setup();
    // The tip explains the risk in plain words.
    await user.click(within(box).getByRole('button', { name: 'What can a formula do?' }));
    expect(
      await screen.findByText(/A formula can change your numbers\. EzyChat blocks formulas/),
    ).toBeTruthy();
    await user.keyboard('{Escape}');

    await user.click(aiValues);
    await user.click(formulas);
    expect(formulas.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(writes(fetchMock)).toContain('PUT /api/connectors/google-sheets/agents/1'),
    );
    expect(w.sheetSettings[1]!.tabs).toEqual([
      { title: 'Leads', access: 'add', aiValues: true, formulas: true },
      { title: 'Menu', access: 'read' },
    ]);

    // Read hides them and saves them off; back on Add rows they come back as they were.
    const leads = screen.getByRole('radiogroup', { name: 'Leads' });
    await user.click(within(leads).getByRole('radio', { name: 'Read' }));
    expect(screen.queryByTestId('sheets-tab-permissions')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(w.sheetSettings[1]!.tabs).toEqual([
        { title: 'Leads', access: 'read' },
        { title: 'Menu', access: 'read' },
      ]),
    );
  });

  it('creates a new blank sheet with its tabs, columns and access, then uses it', async () => {
    const w = connected();
    const fetchMock = stubServer(w);
    page(`${GS}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('sheets-create-open'));
    const dialog = await screen.findByTestId('sheets-create');
    expect(
      within(dialog).getByText('EzyChat creates it in your Google account and uses it for Aina.'),
    ).toBeTruthy();
    // Nothing filled in: it says what is missing and sends nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Create sheet' }));
    expect(
      within(dialog).getByText(
        'Give the sheet a name, and each tab its own name and at least one column.',
      ),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Sheet name'), 'Orders 2026');
    const [first] = within(dialog).getAllByTestId('sheets-create-tab');
    await user.type(within(first!).getByLabelText('Tab name'), 'Orders');
    await user.type(within(first!).getByLabelText('Column names'), 'Date, Name, , Item, Qty');
    // A second tab, then removed again; a third one on Read.
    await user.click(within(dialog).getByRole('button', { name: 'Add a tab' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove Tab 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add a tab' }));
    const second = within(dialog).getAllByTestId('sheets-create-tab')[1]!;
    await user.type(within(second).getByLabelText('Tab name'), 'Menu');
    await user.type(within(second).getByLabelText('Column names'), 'Item, Price');
    const access = within(second).getByRole('radiogroup', {
      name: 'What the agent may do with Menu',
    });
    await user.click(within(access).getByRole('radio', { name: 'Read' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create sheet' }));
    await waitFor(() =>
      expect(writes(fetchMock)).toContain('POST /api/connectors/google-sheets/agents/1/create'),
    );
    expect(w.sheetCreated).toEqual([
      {
        name: 'Orders 2026',
        tabs: [
          { title: 'Orders', columns: ['Date', 'Name', 'Item', 'Qty'], access: 'add' },
          { title: 'Menu', columns: ['Item', 'Price'], access: 'read' },
        ],
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Sheet created in your Google account');
    await waitFor(() => expect(screen.queryByTestId('sheets-create')).toBeNull());
    expect(
      await within(screen.getByTestId('sheets-chosen')).findByText('Orders 2026'),
    ).toBeTruthy();
    const menu = await screen.findByRole('radiogroup', { name: 'Menu' });
    expect(within(menu).getByRole('radio', { name: 'Read' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('creates a sheet from the Claims template layout, and shows a refusal', async () => {
    const w = connected({
      fail: { 'POST /connectors/google-sheets/agents/1/create': 400 },
    });
    stubServer(w);
    page(`${GS}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('sheets-create-open'));
    const dialog = await screen.findByTestId('sheets-create');
    await user.click(within(dialog).getByTestId('sheets-create-start'));
    await user.click(await screen.findByRole('option', { name: 'Claims agent layout' }));
    expect((within(dialog).getByLabelText('Sheet name') as HTMLInputElement).value).toBe('Claims');
    const tab = within(dialog).getByTestId('sheets-create-tab');
    expect((within(tab).getByLabelText('Column names') as HTMLInputElement).value).toBe(
      'Date, Name, WhatsApp, Group, Policy no, Amount, What happened, Source',
    );
    expect(
      within(within(tab).getByRole('radiogroup'))
        .getByRole('radio', { name: 'Add rows' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(dialog).getByRole('button', { name: 'Create sheet' }));
    expect(await within(dialog).findByText('Boom')).toBeTruthy();
    // Back to blank empties the boxes; Cancel closes without creating.
    await user.click(within(dialog).getByTestId('sheets-create-start'));
    await user.click(await screen.findByRole('option', { name: 'Blank sheet' }));
    expect((within(dialog).getByLabelText('Sheet name') as HTMLInputElement).value).toBe('');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('sheets-create')).toBeNull());
  });

  it('keeps the saved tabs when Google cannot be read', async () => {
    const saved = {
      ...DEFAULT_SHEETS_SETTINGS,
      spreadsheetId: 'unknown-sheet-0000000000000000',
      spreadsheetName: 'Gone',
      tabs: [{ title: 'Menu', access: 'read' as const }],
    };
    stubServer(connected({ sheetSettings: { 1: saved } }));
    page(`${GS}?tab=settings`);
    expect(
      await screen.findByText('Could not read the tabs from Google. Press Refresh to try again.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Google Sheets: Activity and the agent page', () => {
  it('lists what the AI looked up and added, never the values', async () => {
    stubServer(
      connected({
        sheetsActivity: [
          {
            id: 2,
            at: Date.now(),
            kind: 'lead_added',
            agentId: 1,
            agentName: 'Aina',
            chatJid: 'a',
            customer: 'Mei Ying',
            tab: null,
            group: null,
          },
          {
            id: 4,
            at: Date.now(),
            kind: 'row_added',
            agentId: 2,
            agentName: 'Claims agent',
            chatJid: 'g',
            customer: 'Hafiz',
            tab: 'Claims',
            group: 'Claims KL',
          },
          {
            id: 3,
            at: Date.now(),
            kind: 'row_added',
            agentId: 1,
            agentName: 'Aina',
            chatJid: 'a',
            customer: 'Ali',
            tab: 'Leads',
            group: null,
          },
          {
            id: 1,
            at: Date.now(),
            kind: 'looked_up',
            agentId: 1,
            agentName: 'Aina',
            chatJid: 'a',
            customer: 'Mei Ying',
            tab: 'Menu',
            group: null,
          },
          {
            id: 0,
            at: Date.now(),
            kind: 'failed',
            agentId: 1,
            agentName: 'Aina',
            chatJid: 'a',
            customer: 'Ali',
            tab: null,
            group: null,
          },
        ],
      }),
    );
    page(`${GS}?tab=activity`);
    const list = await screen.findByTestId('sheets-activity');
    expect(within(list).getByText('Aina added Mei Ying as a lead')).toBeTruthy();
    expect(within(list).getByText('Aina looked up Menu for Mei Ying')).toBeTruthy();
    expect(
      within(list).getByText('Claims agent added a row to Claims for Hafiz in Claims KL'),
    ).toBeTruthy();
    expect(within(list).getByText('Aina added a row to Leads for Ali')).toBeTruthy();
    expect(within(list).getByText('Aina could not reach Google Sheets for Ali')).toBeTruthy();
    cleanup();
    stubServer(connected());
    page(`${GS}?tab=activity`);
    expect(await screen.findByText('Nothing yet.')).toBeTruthy();
  });

  it.each([
    [[{ title: 'Menu', access: 'read' }], 'Reads Menu'],
    [
      [
        { title: 'Menu', access: 'read' },
        { title: 'Leads', access: 'add' },
        { title: 'Claims', access: 'add' },
      ],
      'Reads Menu · Adds rows to Leads, Claims',
    ],
    [[{ title: 'Leads', access: 'add' }], 'Adds rows to Leads'],
    [[], 'Off for this agent'],
  ])('sums up the agent’s Google Sheets on the agent page', async (patch, summary) => {
    stubServer(
      connected({
        sheetSettings: {
          3: {
            ...DEFAULT_SHEETS_SETTINGS,
            spreadsheetId: SHEET_ID,
            tabs: patch as SheetsAgentSettings['tabs'],
          },
        },
      }),
    );
    renderAt('/admin/members/ai/3', <AgentConnectorsCard agentId={3} name="Aina" />, {
      route: '/admin/members/ai/:agentId',
    });
    const row = await screen.findByTestId('agent-connector-google-sheets');
    expect(row.getAttribute('href')).toBe(`${GS}?tab=settings&agent=3`);
    expect(await within(row).findByText(summary)).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import {
  DEFAULT_DRIVE_SETTINGS,
  DRIVE_MAX_FILES,
  type DriveAgentSettings,
  type DriveFile,
} from '@ezychat/shared';
import { AgentConnectorsCard } from './AgentConnectorsCard';
import { ConnectorDetailPage } from './ConnectorDetailPage';
import { ConnectorsGalleryPage } from './ConnectorsGalleryPage';
import {
  DRIVE_FOLDER,
  agent,
  driveStatus,
  renderAt,
  status,
  stubServer,
  world,
  writes,
} from './connectors.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(toast.success).mockClear();
});

const GD = '/admin/connectors/google-drive';
const page = (path: string) => renderAt(path, <ConnectorDetailPage />);
const location = () => screen.getByTestId('location').textContent;
const connected = (patch: Parameters<typeof world>[0] = {}) =>
  world({ drive: driveStatus('connected'), ...patch });
const openWindow = () => {
  const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  return tab;
};
const file = (id: string, name: string, kind: DriveFile['kind'] = 'doc'): DriveFile => ({
  id: `file-${id}-000000000`,
  name,
  mimeType: 'application/vnd.google-apps.document',
  kind,
});
const PRICES = file('prices', 'Price list 2026');
const SCAN = file('scan', 'Old brochure scan', 'other');
const FAQ = file('faq', 'Catering FAQ', 'pdf');
const withFolder = (patch: Partial<DriveAgentSettings> = {}): DriveAgentSettings => ({
  ...DEFAULT_DRIVE_SETTINGS,
  folder: DRIVE_FOLDER,
  ...patch,
});
const putBodies = (fetchMock: ReturnType<typeof stubServer>) =>
  fetchMock.mock.calls
    .filter((c) => c[1]?.method === 'PUT')
    .map((c) => JSON.parse(String(c[1]!.body)) as DriveAgentSettings);

describe('Google Drive: gallery and Overview', () => {
  it('shows the built-in card in the gallery with its own sign-in state', async () => {
    stubServer(connected());
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    await waitFor(() =>
      expect(
        within(screen.getByTestId('connector-card-google-drive')).getByText('Connected'),
      ).toBeTruthy(),
    );
    const card = screen.getByTestId('connector-card-google-drive');
    expect(within(card).getByText('Google Drive')).toBeTruthy();
    expect(card.querySelector('a')!.getAttribute('href')).toBe(GD);
    cleanup();
    stubServer(world({ drive: driveStatus('expired') }));
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    await waitFor(() =>
      expect(
        within(screen.getByTestId('connector-card-google-drive')).getByText('Needs attention'),
      ).toBeTruthy(),
    );
  });

  it('connects with Google in a new window and shows the account and privacy lines', async () => {
    const fetchMock = stubServer(world());
    const tab = openWindow();
    page(GD);
    expect(await screen.findByRole('heading', { name: 'Google Drive' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview',
      'Settings',
      'Activity',
    ]);
    expect(screen.getByText('Save a file')).toBeTruthy();
    expect(screen.getByText('Find a file')).toBeTruthy();
    expect(screen.getByText('Read a file')).toBeTruthy();
    expect(screen.getByText(/Activity keeps who and when only/)).toBeTruthy();
    expect(screen.getByText(/never a file WhatsApp Safety locked/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    await waitFor(() =>
      expect(tab.location.href).toBe('https://accounts.google.com/o/oauth2/v2/auth?d=1'),
    );
    expect(await screen.findByText('Working')).toBeTruthy();
    expect(screen.getByText('kopiapong@gmail.com')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Google Drive connected');
    expect(writes(fetchMock)).toEqual(['POST /api/connectors/google-drive/connect']);
    // "Settings" next to the account opens the Settings tab.
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(location()).toBe(`${GD}?tab=settings`);
  });

  it('warns about an expired sign-in or an unreachable Google, and disconnects', async () => {
    stubServer(world({ drive: driveStatus('expired') }));
    page(GD);
    expect(await screen.findByText('Google sign-in expired')).toBeTruthy();
    expect(screen.getByText(/the AI does not save or read files/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    cleanup();
    stubServer(world({ drive: driveStatus('unavailable') }));
    page(GD);
    expect(await screen.findByText("Can't reach Google Drive")).toBeTruthy();
    cleanup();
    const fetchMock = stubServer(connected());
    page(GD);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Files already saved stay in your Drive/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect Google Drive' })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Google Drive disconnected');
    expect(writes(fetchMock)).toEqual(['POST /api/connectors/google-drive/disconnect']);
  });
});

describe('Google Drive: Settings', () => {
  it('asks to connect first, or says sign-in is not set up', async () => {
    stubServer(world());
    page(`${GD}?tab=settings`);
    expect(await screen.findByText('Connect Google Drive first')).toBeTruthy();
    expect(screen.getByText('Then choose a folder for each AI agent.')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    expect(location()).toBe(`${GD}?tab=overview`);
    cleanup();
    stubServer(world({ drive: driveStatus('not_configured') }));
    page(`${GD}?tab=settings`);
    expect(
      await screen.findByText('Google sign-in is not set up in this build of EzyChat Lite.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Google Drive' })).toBeNull();
  });

  it('keeps both switches off without a folder, picks one in Google and saves it', async () => {
    const w = connected();
    const fetchMock = stubServer(w);
    const tab = openWindow();
    page(`${GD}?tab=settings`);
    expect(await screen.findByText('No folder chosen yet.')).toBeTruthy();
    const saveSwitch = screen.getByRole('switch', { name: 'Save files' });
    const readSwitch = screen.getByRole('switch', { name: 'Read files' });
    expect(saveSwitch.hasAttribute('disabled')).toBe(true);
    expect(readSwitch.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText('Choose a folder first.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    // The line pointing at the agent's instructions.
    expect(
      screen.getByRole('link', { name: "Edit Aina's instructions" }).getAttribute('href'),
    ).toBe('/admin/members/ai/1');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose a folder' }));
    await waitFor(() =>
      expect(tab.location.href).toBe(
        'http://127.0.0.1:7420/api/connectors/google-drive/picker-page?token=t',
      ),
    );
    expect(w.drivePickerBodies).toEqual([{ kind: 'folder' }]);
    const chosen = await screen.findByTestId('drive-folder-chosen');
    expect(within(chosen).getByText('Customer claims')).toBeTruthy();
    expect(
      within(chosen).getByRole('link', { name: 'Open in Google Drive' }).getAttribute('href'),
    ).toBe(`https://drive.google.com/drive/folders/${DRIVE_FOLDER.id}`);
    expect(saveSwitch.hasAttribute('disabled')).toBe(false);
    expect(readSwitch.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('No files yet. Add the files Aina may read.')).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();

    // Save files on shows the safety rules.
    expect(screen.queryByTestId('drive-save-rules')).toBeNull();
    await user.click(saveSwitch);
    const rules = screen.getByTestId('drive-save-rules');
    expect(within(rules).getAllByRole('listitem')).toHaveLength(4);
    expect(within(rules).getByText('Up to 25 MB a file. Each file is saved once.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Google Drive settings saved'));
    expect(putBodies(fetchMock)).toEqual([
      { folder: DRIVE_FOLDER, save: true, read: true, files: [] },
    ]);
    expect(writes(fetchMock)).toEqual([
      'POST /api/connectors/google-drive/picker',
      'PUT /api/connectors/google-drive/agents/1',
    ]);
    await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull());
  });

  it("adds files in Google's picker opened in the folder, removes one and discards", async () => {
    const w = connected({
      driveSettings: { 1: withFolder({ files: [PRICES] }) },
      drivePicker: [{ status: 'done', folder: null, files: [PRICES, SCAN, FAQ] }],
    });
    const fetchMock = stubServer(w);
    openWindow();
    page(`${GD}?tab=settings`);
    const list = await screen.findByTestId('drive-files');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Google Doc')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('drive-files')).getAllByRole('listitem')).toHaveLength(3),
    );
    expect(w.drivePickerBodies).toEqual([{ kind: 'files', folderId: DRIVE_FOLDER.id }]);
    const files = screen.getByTestId('drive-files');
    expect(within(files).getByText('PDF')).toBeTruthy();
    expect(within(files).getByText("The AI can't read this kind of file.")).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove Old brochure scan' }));
    expect(within(files).queryByText('Old brochure scan')).toBeNull();
    expect(screen.getByText('Unsaved')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(within(screen.getByTestId('drive-files')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Unsaved')).toBeNull();
    expect(putBodies(fetchMock)).toEqual([]);

    // Read files off hides the list.
    await user.click(screen.getByRole('switch', { name: 'Read files' }));
    expect(screen.queryByTestId('drive-files')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    expect(putBodies(fetchMock)[0]).toMatchObject({ read: false, files: [PRICES] });
  });

  it('clears the picked files when another folder is chosen', async () => {
    const other = { id: 'folder-receipts-00000002', name: 'Receipts' };
    stubServer(
      connected({
        driveSettings: { 1: withFolder({ files: [PRICES] }) },
        drivePicker: [{ status: 'done', folder: other, files: [] }],
      }),
    );
    openWindow();
    page(`${GD}?tab=settings`);
    expect(await screen.findByTestId('drive-files')).toBeTruthy();
    expect(screen.getByText('Choosing another folder removes the picked files.')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose another folder' }));
    expect(await screen.findByText('Receipts')).toBeTruthy();
    expect(screen.queryByTestId('drive-files')).toBeNull();
    expect(screen.getByText('No files yet. Add the files Aina may read.')).toBeTruthy();
  });

  it('stops adding files at the limit', async () => {
    const many = Array.from({ length: DRIVE_MAX_FILES }, (_, i) =>
      file(String(i).padStart(3, '0'), `File ${i}`),
    );
    stubServer(connected({ driveSettings: { 1: withFolder({ files: many }) } }));
    page(`${GD}?tab=settings`);
    const add = await screen.findByRole('button', { name: 'Add files' });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('That is the most: 50 files. Remove one to add another.')).toBeTruthy();
  });

  it('waits for the picker, says when the window was blocked and when nothing was chosen', async () => {
    stubServer(
      connected({
        drivePicker: [
          { status: 'pending', folder: null, files: [] },
          { status: 'cancelled', folder: null, files: [] },
        ],
      }),
    );
    vi.spyOn(window, 'open').mockReturnValue(null);
    page(`${GD}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Choose a folder' }));
    const picking = await screen.findByTestId('drive-picking');
    expect(
      within(picking).getByText(
        'Your browser blocked the window. Open the file picker to continue.',
      ),
    ).toBeTruthy();
    expect(
      within(picking).getByRole('link', { name: 'Open the file picker' }).getAttribute('href'),
    ).toBe('http://127.0.0.1:7420/api/connectors/google-drive/picker-page?token=t');
    expect(await screen.findByText('Nothing was chosen.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId('drive-picking')).toBeNull();
  });

  it('cancels a picker the admin no longer waits for', async () => {
    stubServer(connected({ drivePicker: [{ status: 'pending', folder: null, files: [] }] }));
    openWindow();
    page(`${GD}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Choose a folder' }));
    const picking = await screen.findByTestId('drive-picking');
    expect(
      within(picking).getByText(
        'Choose the folder in the window that opened. This page updates by itself.',
      ),
    ).toBeTruthy();
    await user.click(within(picking).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('drive-picking')).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose a folder' })).toBeTruthy();
  });

  it.each([
    ['expired', 'Paused: sign in to Google again'],
    ['unavailable', "Paused: can't reach Google Drive"],
  ] as const)('shows a paused banner while Google is %s', async (state, title) => {
    stubServer(world({ drive: driveStatus(state), driveSettings: { 1: withFolder() } }));
    page(`${GD}?tab=settings`);
    expect(await screen.findByText(title)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open the Google account' }));
    expect(location()).toBe(`${GD}?tab=overview`);
  });

  it('shows a save error', async () => {
    stubServer(
      connected({
        driveSettings: { 1: withFolder() },
        fail: { 'PUT /connectors/google-drive/agents/1': 500 },
      }),
    );
    page(`${GD}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Save files' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Boom')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('closes the window and shows why when the picker cannot start', async () => {
    stubServer(connected({ fail: { 'POST /connectors/google-drive/picker': 500 } }));
    const tab = openWindow();
    page(`${GD}?tab=settings`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Choose a folder' }));
    expect(await screen.findByText('Boom')).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
    expect(screen.queryByTestId('drive-picking')).toBeNull();
  });

  it('picks the agent from the address with 2+ agents', async () => {
    stubServer(
      connected({
        agents: [agent(1, 'Aina'), agent(2, 'Budi')],
        driveSettings: { 2: withFolder() },
      }),
    );
    page(`${GD}?tab=settings&agent=2`);
    expect(await screen.findByText('Customer claims')).toBeTruthy();
    expect(
      screen.getByText('Where Budi saves files and where you pick files for it to read.'),
    ).toBeTruthy();
  });
});

describe('Google Drive: Activity', () => {
  it('lists who saved, read or skipped a file, and when', async () => {
    const at = Date.now() - 60_000;
    const row = (id: number, patch: object) => ({
      id,
      at,
      agentId: 1,
      agentName: 'Aina',
      chatJid: '60123@s.whatsapp.net',
      customer: 'Jay Low',
      group: null,
      reason: null,
      kind: 'saved',
      ...patch,
    });
    stubServer(
      connected({
        driveActivity: [
          row(1, { kind: 'saved' }),
          row(2, { kind: 'read' }),
          row(3, { kind: 'skipped', reason: 'safety' }),
          row(4, { kind: 'skipped', reason: 'size' }),
          row(5, { kind: 'failed' }),
          row(6, { kind: 'saved', group: 'Claims team' }),
        ] as never,
      }),
    );
    page(`${GD}?tab=activity`);
    const list = await screen.findByTestId('drive-activity');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    for (const line of [
      'Aina saved a file from Jay Low',
      'Aina read a file for Jay Low',
      'Aina did not save a locked file from Jay Low',
      'Aina did not save a file from Jay Low: too large',
      'Aina could not reach Google Drive for Jay Low and handed over',
      'Aina saved a file from Jay Low in Claims team',
    ])
      expect(within(list).getByText(line)).toBeTruthy();
    expect(
      screen.getByText('Who and when. File names and contents stay in your Drive.'),
    ).toBeTruthy();
  });

  it('says when nothing happened yet', async () => {
    stubServer(connected());
    page(`${GD}?tab=activity`);
    expect(await screen.findByText('Saves and reads show here.')).toBeTruthy();
  });
});

describe('Agent page → Connectors: Google Drive', () => {
  const card = () =>
    renderAt('/admin/members/ai/3', <AgentConnectorsCard agentId={3} name="Aina" />, {
      route: '/admin/members/ai/:agentId',
    });

  it.each([
    [DEFAULT_DRIVE_SETTINGS, 'No folder chosen'],
    [withFolder({ save: true }), 'Saves files'],
    [withFolder({ files: [PRICES, FAQ] }), 'Reads 2 files'],
    [withFolder({ save: true, files: [PRICES] }), 'Saves files and reads 1 file'],
    [withFolder({ read: false }), 'Off for this agent'],
  ])('sums up what the agent may do in Google Drive (%#)', async (settings, summary) => {
    stubServer(connected({ google: status('disconnected'), driveSettings: { 3: settings } }));
    card();
    const row = await screen.findByTestId('agent-connector-google-drive');
    await waitFor(() => expect(row.textContent).toContain(summary));
    expect(row.getAttribute('href')).toBe('/admin/connectors/google-drive?tab=settings&agent=3');
    expect(row.textContent).not.toContain('Needs attention');
    expect(screen.queryByText('No connector yet.')).toBeNull();
  });

  it('marks Google Drive when it needs attention, and hides it when not connected', async () => {
    stubServer(world({ google: status('disconnected'), drive: driveStatus('expired') }));
    card();
    const row = await screen.findByTestId('agent-connector-google-drive');
    expect(row.textContent).toContain('Needs attention');
    cleanup();
    stubServer(world({ google: status('disconnected') }));
    card();
    expect(await screen.findByText('No connector yet.')).toBeTruthy();
    expect(screen.queryByTestId('agent-connector-google-drive')).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import {
  GITHUB_APP_INSTALL_URL,
  GITHUB_NEW_TOKEN_URL,
  type GitHubAgentSettings,
  type GitHubAgentView,
} from '@ezychat/shared';
import { formatDate } from '@/lib/format';
import { AgentConnectorsCard } from './AgentConnectorsCard';
import { ConnectorDetailPage } from './ConnectorDetailPage';
import { ConnectorsGalleryPage } from './ConnectorsGalleryPage';
import {
  GITHUB_REPOS,
  agent,
  githubStatus,
  renderAt,
  status,
  stubServer,
  world,
  writes,
} from './connectors.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

beforeEach(() => {
  // A desktop window: dialogs open as dialogs (phones get the bottom drawer).
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(toast.success).mockClear();
});

const GH = '/admin/connectors/github';
const DAY = 86_400_000;
const page = (path: string) => renderAt(path, <ConnectorDetailPage />);
const location = () => screen.getByTestId('location').textContent;
const lite = (patch: Parameters<typeof world>[0] = {}) =>
  world({ edition: 'lite', google: status('disconnected'), ...patch });
const connected = (patch: Parameters<typeof world>[0] = {}) =>
  lite({ github: githubStatus('connected'), ...patch });
const [POS, WEBSITE, PAYROLL] = GITHUB_REPOS as [
  (typeof GITHUB_REPOS)[0],
  (typeof GITHUB_REPOS)[0],
  (typeof GITHUB_REPOS)[0],
];
const view = (
  settings: Partial<GitHubAgentSettings>,
  unavailableRepoIds: number[] = [],
): GitHubAgentView => ({
  settings: { repos: [], issues: true, pulls: true, ...settings },
  unavailableRepoIds,
});
const putBodies = (fetchMock: ReturnType<typeof stubServer>) =>
  fetchMock.mock.calls
    .filter((c) => c[1]?.method === 'PUT')
    .map((c) => JSON.parse(String(c[1]!.body)) as GitHubAgentSettings);

describe('GitHub: Lite only', () => {
  it('shows the card under Other in Lite with its own sign-in state', async () => {
    stubServer(connected());
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    const card = () => screen.getByTestId('connector-card-github');
    // Connected cards move to "Your connectors" once the state is known.
    await waitFor(() => expect(within(card()).getByText('Connected')).toBeTruthy());
    expect(within(card()).getByText('GitHub')).toBeTruthy();
    expect(within(card()).getByText('Other')).toBeTruthy();
    expect(card().querySelector('a')!.getAttribute('href')).toBe(GH);
    cleanup();
    stubServer(lite({ github: githubStatus('expired') }));
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    await waitFor(() => expect(within(card()).getByText('Needs attention')).toBeTruthy());
  });

  it('hides the card and the page in another edition, and while the edition is unknown', async () => {
    const fetchMock = stubServer(
      world({ edition: 'enterprise', github: githubStatus('connected') }),
    );
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    await screen.findByTestId('connector-card-google-drive');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === '/api/health')).toBe(true),
    );
    expect(screen.queryByTestId('connector-card-github')).toBeNull();
    cleanup();
    stubServer(world({ edition: 'enterprise' }));
    page(GH);
    await waitFor(() => expect(location()).toBe('/admin/connectors'));
    cleanup();
    // No health answer: the card stays hidden and GitHub is not asked.
    const unknown = stubServer(world({ github: githubStatus('connected') }));
    renderAt('/admin/connectors', <ConnectorsGalleryPage />, { route: '/admin/connectors' });
    await screen.findByTestId('connector-card-google-drive');
    expect(screen.queryByTestId('connector-card-github')).toBeNull();
    expect(unknown.mock.calls.some((c) => String(c[0]).startsWith('/api/connectors/github'))).toBe(
      false,
    );
  });
});

describe('GitHub: Overview and sign-in', () => {
  it('signs in with the device code: shows it, opens GitHub, and finishes when approved', async () => {
    const w = lite();
    const fetchMock = stubServer(w);
    page(GH);
    expect(await screen.findByRole('heading', { name: 'GitHub' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview',
      'Settings',
      'Activity',
    ]);
    for (const tool of [
      'Search issues',
      'List issues',
      'Read an issue or pull request',
      'Search pull requests',
    ])
      expect(screen.getByText(tool)).toBeTruthy();
    expect(screen.getByText(/never changes anything on GitHub and never reads code/)).toBeTruthy();
    expect(screen.getByText(/Activity keeps who and when only/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('github-device-code').textContent).toBe('WDJB-MJHT');
    expect(within(dialog).getByRole('link', { name: 'Open GitHub' }).getAttribute('href')).toBe(
      'https://github.com/login/device',
    );
    expect(within(dialog).getByText(/The code works for 15 minutes/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Code copied'));
    // The admin approves on GitHub: the next poll answers done.
    w.githubDevice = [{ status: 'done', github: githubStatus('connected') }];
    expect(await screen.findByText('Working', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('kopiapong-dev')).toBeTruthy();
    expect(screen.getByText('Signed in with the GitHub App “EzyChat by Anchor Sprint”')).toBeTruthy();
    expect(await screen.findByText(/GitHub shares 4 repositories with EzyChat Lite/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change on GitHub' }).getAttribute('href')).toBe(
      'https://github.com/apps/ezychat-by-anchor-sprint/installations/new',
    );
    expect(toast.success).toHaveBeenCalledWith('Signed in to GitHub as kopiapong-dev');
    expect(writes(fetchMock)).toEqual(['POST /api/connectors/github/device']);
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(location()).toBe(`${GH}?tab=settings`);
  }, 15_000);

  it('offers a new code after a cancel or an expiry on GitHub, and cancels on close', async () => {
    const w = lite({ githubDevice: [{ status: 'denied', github: null }] });
    const fetchMock = stubServer(w);
    page(GH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByText('You cancelled on GitHub')).toBeTruthy();
    w.githubDevice = [{ status: 'expired', github: null }];
    await user.click(screen.getByRole('button', { name: 'Get a new code' }));
    expect(await screen.findByText('The code expired')).toBeTruthy();
    w.githubDevice = [{ status: 'failed', github: null }];
    await user.click(screen.getByRole('button', { name: 'Get a new code' }));
    expect(await screen.findByText('Sign-in did not finish')).toBeTruthy();
    w.githubDevice = [{ status: 'pending', github: null }];
    await user.click(screen.getByRole('button', { name: 'Get a new code' }));
    expect(await screen.findByTestId('github-device-code')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(fetchMock)).toEqual([
      'POST /api/connectors/github/device',
      'POST /api/connectors/github/device',
      'POST /api/connectors/github/device',
      'POST /api/connectors/github/device',
      'POST /api/connectors/github/device/dev-4/cancel',
    ]);
  });

  it.each([
    ['classic', 'This is a classic token. Use a fine-grained token (starts with github_pat_).'],
    ['invalid', 'GitHub didn’t accept this token. Check it was copied in full and hasn’t expired.'],
    ['no_repos', 'This token can’t see any repositories. Edit it on GitHub and add some.'],
  ] as const)('shows why a token was refused (%s) under the field', async (code, text) => {
    stubServer(lite({ githubTokenError: code }));
    page(GH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Use a token instead' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('github_pat_…'), 'ghp_abc');
    await user.click(within(dialog).getByRole('button', { name: 'Check and save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(text);
    // Typing again clears the error.
    await user.type(within(dialog).getByPlaceholderText('github_pat_…'), 'x');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('signs in with a fine-grained token: the steps, the link and the expiry', async () => {
    const fetchMock = stubServer(lite());
    page(GH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Use a token instead' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog)
        .getByRole('link', { name: /Fine-grained personal access tokens/ })
        .getAttribute('href'),
    ).toBe(GITHUB_NEW_TOKEN_URL);
    expect(within(dialog).getByText(/Issues → Read-only, Pull requests → Read-only/)).toBeTruthy();
    expect(within(dialog).getByPlaceholderText('github_pat_…').getAttribute('type')).toBe(
      'password',
    );
    await user.type(within(dialog).getByPlaceholderText('github_pat_…'), ' github_pat_ok ');
    await user.click(within(dialog).getByRole('button', { name: 'Check and save' }));
    expect(await screen.findByText('Signed in with a token')).toBeTruthy();
    expect(screen.getByText(/^Token expires /)).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Signed in to GitHub as kopiapong-dev');
    const body = fetchMock.mock.calls.find((c) => c[0] === '/api/connectors/github/token')![1]!;
    expect(JSON.parse(String(body.body))).toEqual({ token: 'github_pat_ok' });
  });

  it('asks to install the app on GitHub, then checks again', async () => {
    const fetchMock = stubServer(lite({ github: githubStatus('no_installation') }));
    page(GH);
    expect(await screen.findByText('Install “EzyChat by Anchor Sprint” on GitHub')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Install on GitHub' }).getAttribute('href')).toBe(
      GITHUB_APP_INSTALL_URL,
    );
    expect(screen.queryByText(/GitHub shares/)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Working')).toBeTruthy();
    expect(screen.queryByText('Install “EzyChat by Anchor Sprint” on GitHub')).toBeNull();
    expect(writes(fetchMock)).toEqual(['POST /api/connectors/github/check']);
    // Settings waits for the install too.
    cleanup();
    stubServer(lite({ github: githubStatus('no_installation') }));
    page(`${GH}?tab=settings`);
    expect(await screen.findByText('Sign in to GitHub first')).toBeTruthy();
  });

  it('warns before a token expires and after it expired', async () => {
    const soon = Date.now() + 5 * DAY;
    stubServer(
      lite({
        github: githubStatus('expiring', { method: 'token', tokenExpiresAt: soon }),
      }),
    );
    page(GH);
    expect(await screen.findByText(`Your token expires ${formatDate(soon)}`)).toBeTruthy();
    expect(screen.getByText('Token expires soon')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Paste a new token' }));
    expect(await screen.findByRole('dialog', { name: 'Use a token' })).toBeTruthy();
    cleanup();
    const gone = Date.now() - DAY;
    stubServer(
      lite({ github: githubStatus('expired', { method: 'token', tokenExpiresAt: gone }) }),
    );
    page(GH);
    expect(await screen.findByText('Your token expired')).toBeTruthy();
    expect(screen.getByText(`Token expired ${formatDate(gone)}`)).toBeTruthy();
  });

  it('asks the App sign-in to sign in again, says when GitHub is down, and disconnects', async () => {
    stubServer(lite({ github: githubStatus('expired') }));
    page(GH);
    expect(await screen.findByText('Sign in to GitHub again')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByTestId('github-device-code')).toBeTruthy();
    cleanup();
    stubServer(lite({ github: githubStatus('unavailable') }));
    page(GH);
    expect(await screen.findByText('GitHub can’t be reached')).toBeTruthy();
    cleanup();
    const fetchMock = stubServer(connected());
    page(GH);
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/uninstall “EzyChat by Anchor Sprint” in your GitHub settings/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('GitHub disconnected');
    expect(writes(fetchMock)).toEqual(['POST /api/connectors/github/disconnect']);
  });
});

describe('GitHub: Settings', () => {
  it('asks to sign in first', async () => {
    stubServer(lite());
    page(`${GH}?tab=settings`);
    expect(await screen.findByText('Sign in to GitHub first')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    expect(location()).toBe(`${GH}?tab=overview`);
  });

  it('chooses repositories grouped by owner, refreshes the list and saves', async () => {
    const w = connected();
    const fetchMock = stubServer(w);
    page(`${GH}?tab=settings`);
    expect(
      await screen.findByText('No repositories yet. Choose the ones Aina may look in.'),
    ).toBeTruthy();
    expect(screen.getByText('Choose a repository first.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Issues' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Who can be told')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Edit Aina’s instructions' }).getAttribute('href'),
    ).toBe('/admin/members/ai/1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose repositories' }));
    const picker = await screen.findByTestId('github-picker');
    expect(await within(picker).findByText('kopiapong')).toBeTruthy();
    expect(within(picker).getByText('kopiapong-dev')).toBeTruthy();
    expect(within(picker).getAllByText('Private')).toHaveLength(2);
    expect(within(picker).getAllByText('Public')).toHaveLength(2);
    expect(
      within(picker).getByRole('link', { name: 'Share it with “EzyChat by Anchor Sprint” on GitHub' }),
    ).toBeTruthy();
    // Refresh reads the list again from GitHub.
    w.githubRepos = [...GITHUB_REPOS, { id: 31, fullName: 'kopiapong/kitchen', private: true }];
    await user.click(within(picker).getByRole('button', { name: 'Refresh the list from GitHub' }));
    expect(await within(picker).findByText('kitchen')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/connectors/github/repos?refresh=1'),
    ).toBe(true);
    await user.type(within(picker).getByRole('searchbox'), 'pos');
    expect(within(picker).queryByText('website')).toBeNull();
    await user.click(within(picker).getByRole('checkbox'));
    await user.clear(within(picker).getByRole('searchbox'));
    await user.click(within(picker).getAllByRole('checkbox')[1]!);
    await user.click(screen.getByRole('button', { name: 'Add 2 repositories' }));
    const list = await screen.findByTestId('github-repo-list');
    expect(within(list).getByText('kopiapong/pos-app')).toBeTruthy();
    expect(within(list).getByText('kopiapong/website')).toBeTruthy();
    expect(screen.getByText('Who can be told')).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Pull requests' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('GitHub settings saved'));
    expect(putBodies(fetchMock)).toEqual([{ repos: [POS, WEBSITE], issues: true, pulls: false }]);
    expect(writes(fetchMock)).toEqual(['PUT /api/connectors/github/agents/1']);
  });

  it('marks a repository GitHub no longer shares, removes it, and explains a refused save', async () => {
    const w = connected({
      github: githubStatus('expired'),
      githubAgents: { 1: view({ repos: [POS, PAYROLL] }, [PAYROLL.id]) },
    });
    stubServer(w);
    page(`${GH}?tab=settings`);
    const list = await screen.findByTestId('github-repo-list');
    expect(within(list).getByText('No longer shared on GitHub. Aina skips it.')).toBeTruthy();
    expect(screen.getByText('GitHub is paused')).toBeTruthy();
    expect(screen.getByText(/Aina hands GitHub questions to your team/)).toBeTruthy();
    const user = userEvent.setup();
    w.problems = { 'PUT /connectors/github/agents/1': 'repo_not_accessible' as never };
    await user.click(screen.getByRole('switch', { name: 'Issues' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'A repository you chose is no longer shared on GitHub. Remove it, then save again.',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove kopiapong/payroll' }));
    expect(within(list).queryByText('kopiapong/payroll')).toBeNull();
  });

  it('picks the agent from the address with 2+ agents', async () => {
    stubServer(connected({ agents: [agent(1, 'Aina'), agent(2, 'Ben')] }));
    page(`${GH}?tab=settings&agent=2`);
    expect(
      await screen.findByText('No repositories yet. Choose the ones Ben may look in.'),
    ).toBeTruthy();
  });
});

describe('GitHub: Activity', () => {
  it('lists who looked up GitHub, and when', async () => {
    const at = Date.now() - 60_000;
    const row = (id: number, patch: object) => ({
      id,
      at,
      agentId: 1,
      agentName: 'Aina',
      chatJid: '60123@s.whatsapp.net',
      customer: 'Jay Low',
      group: null,
      kind: 'searched',
      ...patch,
    });
    stubServer(
      connected({
        githubActivity: [
          row(1, { kind: 'searched' }),
          row(2, { kind: 'read' }),
          row(3, { kind: 'refused' }),
          row(4, { kind: 'failed' }),
          row(5, { kind: 'read', group: 'Support team' }),
        ] as never,
      }),
    );
    page(`${GH}?tab=activity`);
    const list = await screen.findByTestId('github-activity');
    for (const line of [
      'Aina searched GitHub for Jay Low',
      'Aina read an issue or pull request for Jay Low',
      'Aina was refused a repository it wasn’t given, for Jay Low',
      'Aina could not reach GitHub for Jay Low and handed over',
      'Aina read an issue or pull request for Jay Low in Support team',
    ])
      expect(within(list).getByText(line)).toBeTruthy();
    cleanup();
    stubServer(connected());
    page(`${GH}?tab=activity`);
    expect(await screen.findByText('Look-ups show here.')).toBeTruthy();
  });
});

describe('Agent page → Connectors: GitHub', () => {
  const card = () =>
    renderAt('/admin/members/ai/3', <AgentConnectorsCard agentId={3} name="Aina" />, {
      route: '/admin/members/ai/:agentId',
    });

  it.each([
    [view({}), 'No repositories chosen'],
    [view({ repos: [POS, PAYROLL] }, [PAYROLL.id]), 'Issues and pull requests in 1 repository'],
    [view({ repos: [POS, WEBSITE], pulls: false }), 'Issues in 2 repositories'],
    [view({ repos: [POS], issues: false }), 'Pull requests in 1 repository'],
    [view({ repos: [POS], issues: false, pulls: false }), 'Off for this agent'],
  ])('sums up what the agent may look up (%#)', async (settings, summary) => {
    stubServer(connected({ githubAgents: { 3: settings } }));
    card();
    const row = await screen.findByTestId('agent-connector-github');
    await waitFor(() => expect(row.textContent).toContain(summary));
    expect(row.getAttribute('href')).toBe('/admin/connectors/github?tab=settings&agent=3');
    expect(row.textContent).not.toContain('Needs attention');
  });

  it('marks GitHub when it needs attention; hides it outside Lite or when not signed in', async () => {
    stubServer(lite({ github: githubStatus('unavailable') }));
    card();
    expect((await screen.findByTestId('agent-connector-github')).textContent).toContain(
      'Needs attention',
    );
    cleanup();
    stubServer(
      world({
        edition: 'enterprise',
        google: status('disconnected'),
        github: githubStatus('connected'),
      }),
    );
    card();
    expect(await screen.findByText('No connector yet.')).toBeTruthy();
    expect(screen.queryByTestId('agent-connector-github')).toBeNull();
    cleanup();
    stubServer(lite({ github: githubStatus('no_installation') }));
    card();
    expect(await screen.findByText('No connector yet.')).toBeTruthy();
    expect(screen.queryByTestId('agent-connector-github')).toBeNull();
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import type { LiteImportNotice, User } from '@ezychat/shared';
import { LiteImportPage } from './LiteImportPage';
import { defaultTeam, rescan } from './steps';
import { stepsPercent } from './ui';
import { LITE, STEPS, fakeBridge, liteState } from './fake-bridge.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const user = (
  id: number,
  username: string,
  displayName: string,
  extra: Partial<User> = {},
): User => ({
  id,
  username,
  displayName,
  role: 'agent',
  mustChangePassword: false,
  disabled: false,
  createdAt: 1_700_000_000_000,
  locale: null,
  ...extra,
});
const USERS: User[] = [
  user(10, 'Aisyah', 'Aisyah', { role: 'admin' }),
  user(11, 'farid', 'Farid'),
  user(12, 'bot', 'Business AI', { kind: 'ai' }),
];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage(notice: LiteImportNotice | null = null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/users') return json({ users: USERS });
      if (url === '/api/lite-import/notice' && notice) return json(notice);
      return json({ error: { code: 'not_found', message: 'nope' } }, 404);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LiteImportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.watiLiteImport;
  delete window.watiUpdates;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('LiteImportPage', () => {
  it('a phone or remote browser sees "Only on the EzyChat computer"', () => {
    renderPage();
    expect(screen.getByTestId('lite-desktop-only').textContent).toContain(
      'Only on the EzyChat computer',
    );
    expect(screen.queryByTestId('lite-wizard')).toBeNull();
  });

  it('scans first, then shows what was found with the figure and tiles', async () => {
    const { bridge } = fakeBridge(liteState());
    bridge.getState.mockResolvedValueOnce(liteState({ phase: 'idle', lite: null }));
    window.watiLiteImport = bridge;
    renderPage();
    const found = await screen.findByTestId('lite-found');
    expect(bridge.scan).toHaveBeenCalledOnce();
    expect(found.textContent).toContain('EzyChat Lite found');
    expect(within(found).getByTestId('lite-figure').textContent).toContain('+60 12-345 6789');
    expect(within(found).getByTestId('lite-figure').textContent).toContain('New inbox');
    expect(found.textContent).toContain('214');
    expect(found.textContent).toContain('Kopi Sales');
    expect(found.textContent).toContain('chat.kopiapong.my');
    expect(found.textContent).toContain('No new QR scan');
    expect(within(found).getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe(
      '/admin/inboxes',
    );
  });

  it('merge: checks, review with team defaults, and starts with the chosen plan', async () => {
    const { bridge } = fakeBridge(liteState());
    window.watiLiteImport = bridge;
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add this number' }));
    const checks = screen.getByTestId('lite-checks');
    expect(checks.textContent).toContain('Lite is stopped');
    expect(checks.textContent).toContain('2 of 10 inboxes used');
    expect(checks.textContent).toContain('New number');
    await u.click(screen.getByRole('button', { name: 'Continue' }));

    const rows = await screen.findAllByTestId('lite-team-row');
    expect(rows).toHaveLength(3);
    // Same username (any case) → same person; others are added with Lite's role.
    expect(
      within(rows[0]!).getByRole('combobox', { name: 'What to do with Aisyah' }).textContent,
    ).toBe('Same person as');
    expect(
      within(rows[0]!).getByRole('combobox', { name: 'Same person as for Aisyah' }).textContent,
    ).toBe('Aisyah');
    expect(within(rows[1]!).getByRole('combobox', { name: 'Role for Mei Ling' }).textContent).toBe(
      'Team member',
    );
    // An AI member is never offered as the same person.
    await u.click(within(rows[0]!).getByRole('combobox', { name: 'Same person as for Aisyah' }));
    expect(screen.queryByRole('option', { name: 'Business AI' })).toBeNull();
    await u.click(screen.getByRole('option', { name: 'Farid' }));

    // Mei Ling becomes an admin: flagged.
    await u.click(within(rows[1]!).getByRole('combobox', { name: 'Role for Mei Ling' }));
    await u.click(screen.getByRole('option', { name: 'Admin' }));
    expect(within(rows[1]!).getByText('Sees every inbox')).toBeTruthy();
    // Jun Hao is not brought.
    await u.click(within(rows[2]!).getByRole('combobox', { name: 'What to do with Jun Hao' }));
    await u.click(screen.getByRole('option', { name: 'Don’t bring' }));

    const redo = screen.getByTestId('lite-redo');
    expect(redo.textContent).toContain('Claude Desktop');
    expect(redo.textContent).toContain('ChatGPT');

    await u.click(screen.getByRole('button', { name: 'Merge now' }));
    expect(bridge.start).toHaveBeenCalledWith({
      team: [
        { liteUserId: 1, action: 'match', matchUserId: 11, role: 'admin' },
        { liteUserId: 2, action: 'add', matchUserId: null, role: 'admin' },
        { liteUserId: 3, action: 'skip', matchUserId: null, role: 'agent' },
      ],
    });
    expect(await screen.findByTestId('lite-running')).toBeTruthy();
    expect(screen.getByTestId('lite-steps').textContent).toContain('Copy data 50%');
  });

  it('switching back to "Same person as" picks the first Enterprise user', async () => {
    const { bridge } = fakeBridge(liteState());
    window.watiLiteImport = bridge;
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add this number' }));
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    const rows = await screen.findAllByTestId('lite-team-row');
    await u.click(within(rows[2]!).getByRole('combobox', { name: 'What to do with Jun Hao' }));
    await u.click(screen.getByRole('option', { name: 'Same person as' }));
    expect(
      within(rows[2]!).getByRole('combobox', { name: 'Same person as for Jun Hao' }).textContent,
    ).toBe('Aisyah');
  });

  it('blocked checks: each has one action and Continue stays off', async () => {
    const { bridge } = fakeBridge(
      liteState({ phase: 'blocked', issues: ['lite_running', 'disk', 'no_slot', 'same_number'] }),
    );
    window.watiLiteImport = bridge;
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add this number' }));
    const checks = screen.getByTestId('lite-checks');
    expect(checks.textContent).toContain('Close EzyChat Lite first');
    expect(checks.textContent).toContain('Need 2.2 GB free disk');
    expect(checks.textContent).toContain('No free inbox. Remove one first.');
    expect(checks.textContent).toContain('This number is already here');
    expect(within(checks).getByRole('link', { name: 'Inboxes' }).getAttribute('href')).toBe(
      '/admin/inboxes',
    );
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await u.click(within(checks).getAllByRole('button', { name: 'Check again' })[0]!);
    expect(bridge.scan).toHaveBeenCalledOnce();
  });

  it('Lite newer: Update runs the desktop updater; a service shows its own row', async () => {
    const { bridge } = fakeBridge(
      liteState({ phase: 'blocked', liteService: true, issues: ['lite_newer', 'lite_service'] }),
    );
    const check = vi.fn().mockRejectedValue(new Error('offline'));
    window.watiUpdates = { check } as unknown as NonNullable<Window['watiUpdates']>;
    window.watiLiteImport = bridge;
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Add this number' }));
    expect(screen.getByTestId('lite-checks').textContent).toContain(
      'Lite runs as a service. Stop it first (needs admin).',
    );
    await u.click(screen.getByRole('button', { name: 'Update' }));
    expect(check).toHaveBeenCalledOnce();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('copy mode on an empty install starts without a review', async () => {
    const { bridge } = fakeBridge(liteState({ mode: 'copy' }));
    window.watiLiteImport = bridge;
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Bring my data' }));
    expect(screen.getByTestId('lite-checks').textContent).not.toContain('inboxes used');
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(bridge.start).toHaveBeenCalledWith({ team: [] });
  });

  it('follows the desktop while it runs and shows the merge result', async () => {
    const { bridge, emit } = fakeBridge(liteState({ phase: 'running', steps: STEPS }));
    window.watiLiteImport = bridge;
    renderPage({
      checklist: {
        inboxId: 3,
        inboxName: 'Lite – +60 12-345 6789',
        liteUsers: 3,
        tokens: [],
        items: { share: false, signin: false, notifications: false, mcp: false },
      },
      mcp: null,
    });
    expect(await screen.findByTestId('lite-running')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('38');
    act(() =>
      emit(
        liteState({
          phase: 'done',
          steps: STEPS.map((s) => ({ ...s, state: 'done' as const })),
          result: {
            mode: 'merge',
            inboxId: 3,
            inboxName: 'Lite – +60 12-345 6789',
            chats: 214,
            usersAdded: 1,
            usersMatched: 2,
            agentImported: true,
            agentOff: true,
            renamedShortcuts: ['hi-lite'],
          },
        }),
      ),
    );
    const done = await screen.findByTestId('lite-done');
    expect(done.textContent).toContain('Number added');
    expect(done.textContent).toContain('Lite – +60 12-345 6789');
    expect(done.textContent).toContain('turned off');
    expect(done.textContent).toContain('hi-lite');
    expect(within(done).getByRole('link', { name: 'Open inbox' }).getAttribute('href')).toBe('/');
    expect(await screen.findByTestId('lite-checklist')).toBeTruthy();
  });

  it('copy result: sign in with the Lite password', async () => {
    const { bridge } = fakeBridge(
      liteState({
        mode: 'copy',
        phase: 'done',
        result: {
          mode: 'copy',
          inboxId: 1,
          inboxName: 'WhatsApp',
          chats: 214,
          usersAdded: 3,
          usersMatched: 0,
          agentImported: true,
          agentOff: false,
          renamedShortcuts: [],
        },
      }),
    );
    window.watiLiteImport = bridge;
    renderPage();
    const signIn = await screen.findByTestId('lite-sign-in');
    expect(signIn.textContent).toContain('Sign in with your EzyChat Lite password');
  });

  it('failed: a known code is explained in plain words', async () => {
    const { bridge } = fakeBridge(liteState({ phase: 'failed', failure: 'no_lite_data' }));
    window.watiLiteImport = bridge;
    renderPage();
    const failed = await screen.findByTestId('lite-failed');
    expect(failed.textContent).toContain("EzyChat Lite's data is no longer on this computer.");
  });

  it('failed: nothing changed, Try again rescans, the support file is saved', async () => {
    const { bridge } = fakeBridge(
      liteState({
        phase: 'failed',
        failure: 'verify_failed',
        steps: [{ id: 'copy', state: 'failed', progress: null }],
      }),
    );
    window.watiLiteImport = bridge;
    renderPage();
    const failed = await screen.findByTestId('lite-failed');
    expect(failed.textContent).toContain('Nothing changed. Lite is running again.');
    // an unknown code shows plain words, never the code itself
    expect(failed.textContent).toContain('Something went wrong while moving.');
    expect(failed.textContent).not.toContain('verify_failed');
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Save support file' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    bridge.scan.mockResolvedValueOnce(liteState());
    await u.click(screen.getByRole('button', { name: 'Try again' }));
    expect(bridge.reset).toHaveBeenCalledOnce();
    expect(bridge.scan).toHaveBeenCalledOnce();
    expect(await screen.findByTestId('lite-found')).toBeTruthy();
  });

  it('a failed bridge call shows a toast and keeps the page', async () => {
    const { bridge } = fakeBridge(liteState({ mode: 'copy' }));
    bridge.start.mockRejectedValueOnce(new Error('ipc'));
    window.watiLiteImport = bridge;
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Bring my data' }));
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That did not work. Try again.'));
    expect(screen.getByTestId('lite-checks')).toBeTruthy();
  });

  it('no Lite on this PC, and an unreadable state', async () => {
    const { bridge } = fakeBridge(liteState({ phase: 'none', lite: null }));
    window.watiLiteImport = bridge;
    const { unmount } = renderPage();
    expect((await screen.findByTestId('lite-none')).textContent).toContain(
      'No EzyChat Lite data on this PC',
    );
    unmount();
    bridge.getState.mockRejectedValueOnce(new Error('ipc'));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read');
  });

  it('Lite as a background service: Allow asks Windows once, then the normal flow', async () => {
    const { bridge } = fakeBridge(liteState({ phase: 'protected', lite: null, liteService: true }));
    // Windows said Yes: the controller scans the freed folder and answers with the summary.
    bridge.unlock.mockResolvedValueOnce(liteState({ phase: 'found' }));
    window.watiLiteImport = bridge;
    renderPage();
    const card = await screen.findByTestId('lite-protected');
    expect(card.dataset.unlock).toBe('idle');
    expect(card.textContent).toContain('EzyChat Lite runs as a background service');
    expect(card.textContent).toContain('Windows asks you once to allow it');
    // Nothing of Lite's data is known yet: the figure shows no number.
    expect(within(card).getByTestId('lite-figure').textContent).toContain('Background service');
    // The manual way shows only after a refusal or a failure.
    expect(card.textContent).not.toContain('"Remove service"');
    expect(screen.queryByTestId('lite-none')).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Allow and continue' }));
    await waitFor(() => expect(bridge.unlock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('lite-found')).toBeTruthy();
  });

  it('Lite as a background service: waiting for Windows shows no buttons', async () => {
    const { bridge } = fakeBridge(
      liteState({ phase: 'protected', lite: null, liteService: true, unlock: 'waiting' }),
    );
    window.watiLiteImport = bridge;
    renderPage();
    const card = await screen.findByTestId('lite-protected');
    expect(within(card).getByRole('status').textContent).toContain('Waiting for Windows');
    // The prompt can open behind the app window: the text says where to find it.
    expect(within(card).getByRole('status').textContent).toContain('shield icon on the taskbar');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it.each([
    ['declined', 'Windows did not allow it. Nothing changed.'],
    ['failed', 'Could not free EzyChat Lite’s data.'],
  ] as const)(
    'Lite as a background service, %s: says so, Try again, and the manual way',
    async (unlock, text) => {
      const { bridge } = fakeBridge(
        liteState({ phase: 'protected', lite: null, liteService: true, unlock }),
      );
      window.watiLiteImport = bridge;
      renderPage();
      const card = await screen.findByTestId('lite-protected');
      expect(card.textContent).toContain(text);
      expect(card.textContent).toContain('"Remove service"');
      await userEvent.click(within(card).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(bridge.unlock).toHaveBeenCalledTimes(1));
    },
  );
});

describe('helpers', () => {
  it('defaultTeam matches by username, else adds with the Lite role', () => {
    expect(defaultTeam(LITE.users, USERS)).toEqual([
      { liteUserId: 1, action: 'match', matchUserId: 10, role: 'admin' },
      { liteUserId: 2, action: 'add', matchUserId: null, role: 'agent' },
      { liteUserId: 3, action: 'add', matchUserId: null, role: 'agent' },
    ]);
  });

  it('stepsPercent counts finished steps and the running share', () => {
    expect(stepsPercent([])).toBe(0);
    expect(stepsPercent(STEPS)).toBe(38);
  });

  it('rescan scans only when the reset leaves nothing scanned', async () => {
    const { bridge } = fakeBridge(liteState());
    bridge.reset.mockResolvedValueOnce(liteState({ phase: 'blocked' }));
    expect((await rescan(bridge)).phase).toBe('blocked');
    expect(bridge.scan).not.toHaveBeenCalled();
  });
});

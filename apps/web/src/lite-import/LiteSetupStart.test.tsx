import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LiteSetupStart } from './LiteSetupStart';
import { STEPS, fakeBridge, liteState } from './fake-bridge.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderStart(needsSetup = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/setup/status'
        ? json({ needsSetup })
        : json({ error: { code: 'not_found', message: 'nope' } }, 404),
    ),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LiteSetupStart startNew={<div data-testid="today-wizard" />} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.watiLiteImport;
});

describe('LiteSetupStart', () => {
  it('without the desktop bridge the wizard is exactly today’s', () => {
    renderStart();
    expect(screen.getByTestId('today-wizard')).toBeTruthy();
  });

  it('without Lite data on this PC the wizard is today’s', async () => {
    window.watiLiteImport = fakeBridge(
      liteState({ mode: 'copy', phase: 'none', lite: null }),
    ).bridge;
    renderStart();
    expect(await screen.findByTestId('today-wizard')).toBeTruthy();
  });

  it('an install that already has an account goes on as today', async () => {
    window.watiLiteImport = fakeBridge(liteState({ mode: 'copy' })).bridge;
    renderStart(false);
    expect(await screen.findByTestId('today-wizard')).toBeTruthy();
  });

  it('offers Bring from EzyChat Lite or Start new; Start new is today’s wizard', async () => {
    window.watiLiteImport = fakeBridge(liteState({ mode: 'copy' })).bridge;
    renderStart();
    const bring = await screen.findByTestId('lite-setup-bring');
    expect(bring.textContent).toContain('214 chats and customers');
    expect(bring.textContent).toContain('3 teammates, same passwords');
    expect(bring.textContent).toContain('No new QR scan');
    expect(screen.getByText('EzyChat Lite found on this PC')).toBeTruthy();
    expect(screen.getByTestId('lite-figure').textContent).toContain('Same number');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start new' }));
    expect(screen.getByTestId('today-wizard')).toBeTruthy();
  });

  it('Lite as a background service: Bring stays offered and opens the Allow step', async () => {
    const { bridge } = fakeBridge(
      liteState({ phase: 'protected', mode: null, lite: null, liteService: true }),
    );
    bridge.unlock.mockResolvedValueOnce(liteState({ phase: 'found', mode: 'copy' }));
    window.watiLiteImport = bridge;
    renderStart();
    const user = userEvent.setup();
    const bring = await screen.findByTestId('lite-setup-bring');
    // The counts are in the locked folder: generic points, and Windows asks first.
    expect(bring.textContent).toContain('Chats, customers and team');
    expect(bring.textContent).toContain('Windows asks you once to allow it');
    expect(screen.getByTestId('lite-figure').textContent).toContain('Background service');
    await user.click(within(bring).getByRole('button', { name: 'Bring from EzyChat Lite' }));
    const card = await screen.findByTestId('lite-protected');
    await user.click(within(card).getByRole('button', { name: 'Allow and continue' }));
    expect(bridge.unlock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('lite-checks')).toBeTruthy();
  });

  it('Lite as a background service: Start new on the Allow step is today’s wizard', async () => {
    window.watiLiteImport = fakeBridge(
      liteState({ phase: 'protected', mode: null, lite: null, liteService: true }),
    ).bridge;
    renderStart();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bring from EzyChat Lite' }));
    const card = await screen.findByTestId('lite-protected');
    await user.click(within(card).getByRole('button', { name: 'Start new' }));
    expect(screen.getByTestId('today-wizard')).toBeTruthy();
  });

  it('Bring from EzyChat Lite: checks, copy, then sign in with the Lite password', async () => {
    const { bridge, emit } = fakeBridge(liteState({ mode: 'copy' }));
    window.watiLiteImport = bridge;
    renderStart();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Bring from EzyChat Lite' }));
    expect(screen.getByTestId('lite-setup').getAttribute('data-path')).toBe('lite');
    expect(screen.getByTestId('lite-checks').textContent).toContain('Disk space OK');
    await u.click(screen.getByRole('button', { name: 'Bring my data' }));
    expect(bridge.start).toHaveBeenCalledWith({ team: [] });
    expect(await screen.findByTestId('lite-running')).toBeTruthy();
    act(() =>
      emit(
        liteState({
          mode: 'copy',
          phase: 'done',
          steps: STEPS.map((s) => ({ ...s, state: 'done' as const })),
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
      ),
    );
    expect((await screen.findByTestId('lite-sign-in')).textContent).toContain(
      'Sign in with your EzyChat Lite password',
    );
    expect(screen.getByRole('list', { name: 'Steps' }).textContent).toContain('Ready');
  });

  it('a failed copy offers Start new; a reload mid-import stays on the Lite path', async () => {
    const { bridge } = fakeBridge(
      liteState({ mode: 'copy', phase: 'failed', failure: 'lite_running_again' }),
    );
    window.watiLiteImport = bridge;
    renderStart(false);
    expect(await screen.findByTestId('lite-failed')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start new' }));
    expect(screen.getByTestId('today-wizard')).toBeTruthy();
  });

  it('an unreadable bridge falls back to today’s wizard', async () => {
    const { bridge } = fakeBridge(liteState({ mode: 'copy' }));
    bridge.getState.mockRejectedValueOnce(new Error('ipc'));
    window.watiLiteImport = bridge;
    renderStart();
    expect(await screen.findByTestId('today-wizard')).toBeTruthy();
  });
});

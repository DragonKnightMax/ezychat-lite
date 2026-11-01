import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import type { LiteImportNotice } from '@ezychat/shared';
import { LiteChecklistCard, LiteImportEntry, LiteMcpNoticeCard } from './notice';
import { fakeBridge, liteState } from './fake-bridge.test.helpers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const NOTICE: LiteImportNotice = {
  checklist: {
    inboxId: 3,
    inboxName: 'Lite – +60 12-345 6789',
    liteUsers: 4,
    tokens: [
      { name: 'Claude Desktop', kind: 'oauth' },
      { name: 'ChatGPT', kind: 'token' },
    ],
    items: { share: true, signin: false, notifications: false, mcp: false },
  },
  mcp: { reason: 'quick', mcpUrl: 'https://abc.trycloudflare.com/mcp' },
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(node: React.ReactNode, initial: LiteImportNotice | null = NOTICE, putFails = false) {
  let notice = initial;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/lite-import/notice' || !notice)
      return json({ error: { code: 'not_found', message: 'nope' } }, 404);
    if (init?.method === 'PUT') {
      if (putFails) return json({ error: { code: 'internal', message: 'boom' } }, 500);
      const body = JSON.parse(String(init.body)) as {
        item?: 'share' | 'signin' | 'notifications' | 'mcp';
        done?: boolean;
        dismiss?: 'checklist' | 'mcp';
      };
      if (body.dismiss) notice = { ...notice, [body.dismiss]: null };
      else if (body.item && notice.checklist)
        notice = {
          ...notice,
          checklist: {
            ...notice.checklist,
            items: { ...notice.checklist.items, [body.item]: body.done === true },
          },
        };
    }
    return json(notice);
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  const puts = () =>
    fetchMock.mock.calls
      .filter(([, i]) => i?.method === 'PUT')
      .map(([, i]) => JSON.parse(String(i!.body)) as unknown);
  return { puts, u: userEvent.setup() };
}

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
  vi.mocked(toast.error).mockClear();
});

describe('LiteChecklistCard', () => {
  it('shows the four items with progress and Lite token names', async () => {
    setup(<LiteChecklistCard />);
    const card = await screen.findByTestId('lite-checklist');
    expect(card.textContent).toContain('Finish for Lite’s team');
    expect(card.textContent).toContain('Lite – +60 12-345 6789');
    expect(card.textContent).toContain('1 of 4 done');
    expect(card.textContent).toContain('Share the address with 4 teammates');
    expect(card.textContent).toContain('Claude Desktop');
    expect(
      screen.getByRole('checkbox', { name: /Share the address/ }).getAttribute('data-state'),
    ).toBe('checked');
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeTruthy();
  });

  it('ticks an item and dismisses the card through the server', async () => {
    const { puts, u } = setup(<LiteChecklistCard />);
    await u.click(await screen.findByRole('checkbox', { name: 'They sign in again' }));
    await waitFor(() =>
      expect(screen.getByTestId('lite-checklist').textContent).toContain('2 of 4 done'),
    );
    await u.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lite-checklist')).toBeNull());
    expect(puts()).toEqual([{ item: 'signin', done: true }, { dismiss: 'checklist' }]);
  });

  it('a failed save shows the error', async () => {
    const { u } = setup(<LiteChecklistCard />, NOTICE, true);
    await u.click(await screen.findByRole('checkbox', { name: 'They sign in again' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('shows nothing without a notice (no import, older server)', async () => {
    setup(<LiteChecklistCard />, null);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('lite-checklist')).toBeNull();
  });
});

describe('LiteMcpNoticeCard', () => {
  it('shows the new address with Copy, the token names and the quick-tunnel hint', async () => {
    const { puts, u } = setup(<LiteMcpNoticeCard />);
    const card = await screen.findByTestId('lite-mcp-flag');
    expect(card.textContent).toContain('EzyChat’s address changed');
    expect(card.textContent).toContain('https://abc.trycloudflare.com/mcp');
    expect(card.textContent).toContain('ChatGPT');
    expect(card.textContent).toContain('Quick addresses change');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('lite-mcp-flag')).toBeNull());
    expect(puts()).toEqual([{ dismiss: 'mcp' }]);
  });

  it('without a known address it points to Phone access', async () => {
    setup(<LiteMcpNoticeCard />, { checklist: null, mcp: { reason: 'domain', mcpUrl: null } });
    const card = await screen.findByTestId('lite-mcp-flag');
    expect(card.textContent).not.toContain('Quick addresses change');
    expect(
      screen
        .getByRole('link', { name: 'Turn on Phone access to get the new address' })
        .getAttribute('href'),
    ).toBe('/admin/tunnel');
  });
});

describe('LiteImportEntry', () => {
  it('only in the desktop window and only with several numbers', () => {
    const { unmount } = render(
      <MemoryRouter>
        <LiteImportEntry maxInboxes={10} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('lite-import-entry')).toBeNull();
    unmount();
    window.watiLiteImport = fakeBridge(liteState()).bridge;
    const second = render(
      <MemoryRouter>
        <LiteImportEntry maxInboxes={1} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('lite-import-entry')).toBeNull();
    second.unmount();
    render(
      <MemoryRouter>
        <LiteImportEntry maxInboxes={10} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Add a number from EzyChat Lite' });
    expect(link.getAttribute('href')).toBe('/admin/inboxes/lite');
  });
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SafetyChatState } from '@ezychat/shared';
import { BlockNumber } from './BlockNumber';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const role = { current: 'admin' as 'admin' | 'agent' };
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ user: { role: role.current } }) }));

const JID = '601164988966@s.whatsapp.net';
const URL_BASE = `/api/safety/chats/${encodeURIComponent(JID)}`;
let chat: SafetyChatState;
let client: QueryClient;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === URL_BASE) return json(chat);
  if (url === `${URL_BASE}/block`) {
    chat = { ...chat, blocked: { by: 'Admin', at: 1, auto: false } };
    return json(chat);
  }
  if (url === `${URL_BASE}/unblock`) {
    chat = { ...chat, blocked: null };
    return json(chat);
  }
  throw new Error(`unexpected ${url} ${init?.method}`);
});

beforeEach(() => {
  role.current = 'admin';
  chat = {
    enabled: false,
    scam: false,
    blocked: null,
    maybeHacked: false,
    itemId: null,
    canBlock: true,
  };
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockClear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(toast.success).mockClear();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

const wrap = () =>
  render(
    <QueryClientProvider client={client}>
      <BlockNumber jid={JID} />
    </QueryClientProvider>,
  );
const bodyOf = (path: string) => {
  const call = fetcher.mock.calls.find(([url]) => url === path);
  return call ? JSON.parse(String(call[1]?.body ?? '{}')) : undefined;
};

it('blocks any chat after a confirm, marking it as spam by default', async () => {
  wrap();
  await userEvent.click(await screen.findByRole('button', { name: 'Block number' }));
  expect(screen.getByRole('alertdialog').textContent).toContain('the AI agent stops replying');
  expect(
    screen.getByRole('checkbox', { name: /Also mark as spam/ }).getAttribute('aria-checked'),
  ).toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'Block' }));
  await waitFor(() => expect(bodyOf(`${URL_BASE}/block`)).toEqual({ spam: true }));
  expect(await screen.findByText('This number is blocked on WhatsApp.')).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith('Number blocked.');
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('blocks without spam when the box is cleared, and Cancel blocks nothing', async () => {
  wrap();
  await userEvent.click(await screen.findByRole('button', { name: 'Block number' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fetcher.mock.calls.some(([url]) => url === `${URL_BASE}/block`)).toBe(false);

  await userEvent.click(screen.getByRole('button', { name: 'Block number' }));
  await userEvent.click(screen.getByRole('checkbox', { name: /Also mark as spam/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Block' }));
  await waitFor(() => expect(bodyOf(`${URL_BASE}/block`)).toEqual({ spam: false }));
});

it('unblocks a blocked number', async () => {
  chat = { ...chat, blocked: { by: 'Admin', at: 1, auto: false } };
  wrap();
  await userEvent.click(await screen.findByRole('button', { name: 'Unblock' }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      `${URL_BASE}/unblock`,
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  expect(await screen.findByRole('button', { name: 'Block number' })).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith('Number unblocked.');
});

it('explains when the inbox cannot block now, and shows nothing to an agent', async () => {
  chat = { ...chat, canBlock: false };
  wrap();
  expect(
    (await screen.findByRole<HTMLButtonElement>('button', { name: 'Block number' })).disabled,
  ).toBe(true);
  expect(screen.getByText(/within 24 hours of their last message/)).toBeTruthy();
  cleanup();
  client.clear();

  role.current = 'agent';
  wrap();
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(URL_BASE, expect.anything()));
  expect(screen.queryByTestId('block-number')).toBeNull();
});

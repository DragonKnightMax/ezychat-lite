// How often one open of the inbox loads GET /api/chats. Over the tunnel each load costs ~1 s, and the
// live app loaded the list several times per open: once on mount, again when the live connection
// joined (it reloads every list), and again on each wake of the phone (focus + reconnect).
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider, focusManager, type QueryClient } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Chat } from '@ezychat/shared';
import { createQueryClient } from '../api/query-client';
import { qk, type ChatFilters, type ChatsData } from '../api/queries';
import type * as Queries from '../api/queries';
import { RealtimeProvider, SOCKET_WAIT_MS } from '../api/socket';
import { ChatList } from './ChatList';
import { buildDirectory } from './useDirectory';

const socket = vi.hoisted(() => {
  const callbacks = new Map<string, Set<(...args: unknown[]) => void>>();
  const fire = (event: string, ...args: unknown[]) =>
    callbacks.get(event)?.forEach((handler) => handler(...args));
  return {
    callbacks,
    fire,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      const handlers = callbacks.get(event) ?? new Set();
      handlers.add(callback);
      callbacks.set(event, handlers);
    },
    off: (event: string, callback: (...args: unknown[]) => void) =>
      callbacks.get(event)?.delete(callback),
    disconnect: () => {},
    removeAllListeners: () => callbacks.clear(),
    emit: () => {},
  };
});
vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('../api/queries', async (importOriginal) => {
  const original = await importOriginal<typeof Queries>();
  return {
    ...original,
    useMe: () => ({ data: { id: 1, disabled: false, mustChangePassword: false } }),
    useWaStatus: () => ({ data: { state: 'open' } }),
  };
});

const filters: ChatFilters = { assigned: 'any', status: 'open' };

function chat(name: string): Chat {
  return {
    jid: '60123@s.whatsapp.net',
    inboxId: 1,
    waJid: '60123@s.whatsapp.net',
    type: 'dm',
    name,
    avatarUrl: null,
    unreadCount: 0,
    lastMessageAt: 0,
    lastMessagePreview: 'Hello',
    status: 'open',
    assignedTo: null,
    updatedAt: 0,
    phone: null,
    lastInboundAt: null,
  };
}

let serverName = 'Fresh from the server';
let chatLoads = 0;
let holdChats: Promise<void> | null = null;

beforeEach(() => {
  serverName = 'Fresh from the server';
  chatLoads = 0;
  holdChats = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/chats?')) {
        chatLoads++;
        const name = serverName;
        if (holdChats) await holdChats;
        return Response.json({ chats: [chat(name)], nextCursor: null });
      }
      if (url === '/api/inboxes') return Response.json({ inboxes: [] });
      return Response.json({ error: 'not_found' }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  socket.callbacks.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A list kept from the last visit: shown at once, older than any stale time. */
function keepList(qc: QueryClient, name: string) {
  const data: ChatsData = {
    pages: [{ chats: [chat(name)], nextCursor: null }],
    pageParams: [null],
  };
  qc.setQueryData(qk.chats(filters), data, { updatedAt: Date.now() - 60 * 60_000 });
}

function open(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RealtimeProvider>
          <ChatList
            filters={filters}
            activeJid={null}
            directory={buildDirectory(null, false, [])}
          />
        </RealtimeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

it('shows a kept list at once and loads it once, when the live connection joins', async () => {
  const qc = createQueryClient();
  keepList(qc, 'Kept on the phone');
  open(qc);
  expect(screen.getByText('Kept on the phone')).toBeTruthy();
  await settle();
  // Loading now would be repeated by the reload that every connection makes when it joins.
  expect(chatLoads).toBe(0);

  await act(async () => socket.fire('connect'));
  await screen.findByText('Fresh from the server');
  await settle();
  expect(chatLoads).toBe(1);
  qc.clear();
});

it('loads once when the phone wakes up and the live connection comes back', async () => {
  const qc = createQueryClient();
  keepList(qc, 'Kept on the phone');
  open(qc);
  await act(async () => socket.fire('connect'));
  await screen.findByText('Fresh from the server');
  await settle();
  expect(chatLoads).toBe(1);

  // The phone slept: the connection dropped and the list is stale. Waking up fires focus first.
  serverName = 'After waking up';
  act(() => socket.fire('disconnect', 'transport close'));
  await act(() => qc.invalidateQueries({ queryKey: qk.chatsAll, refetchType: 'none' }));
  act(() => focusManager.setFocused(true));
  await settle();
  expect(chatLoads).toBe(1);

  await act(async () => socket.fire('connect'));
  await screen.findByText('After waking up');
  await settle();
  expect(chatLoads).toBe(2);
  qc.clear();
});

it('loads a first list at once and shares that load with a connection that joins meanwhile', async () => {
  const qc = createQueryClient();
  let release!: () => void;
  holdChats = new Promise<void>((resolve) => (release = resolve));
  open(qc);
  await waitFor(() => expect(chatLoads).toBe(1));
  await act(async () => socket.fire('connect'));
  release();
  await screen.findByText('Fresh from the server');
  await settle();
  expect(chatLoads).toBe(1);
  qc.clear();
});

it('still loads a kept list when the live connection does not come', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const qc = createQueryClient();
  keepList(qc, 'Kept on the phone');
  open(qc);
  await settle();
  expect(chatLoads).toBe(0);
  await act(async () => {
    vi.advanceTimersByTime(SOCKET_WAIT_MS);
  });
  await screen.findByText('Fresh from the server');
  expect(chatLoads).toBe(1);
  qc.clear();
});

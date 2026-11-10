import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatAvatar } from '../inbox/ChatAvatar';
import { RealtimeProvider } from './socket';
import type * as Queries from './queries';

const socket = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const callbacks = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    callbacks,
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const handlers = callbacks.get(event) ?? new Set();
      handlers.add(callback);
      callbacks.set(event, handlers);
      listeners.set(event, (...args) => handlers.forEach((handler) => handler(...args)));
    }),
    off: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      callbacks.get(event)?.delete(callback);
      if (!callbacks.get(event)?.size) listeners.delete(event);
    }),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(() => {
      listeners.clear();
      callbacks.clear();
    }),
    emit: vi.fn(),
  };
});
vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('./queries', async (importOriginal) => {
  const original = await importOriginal<typeof Queries>();
  return {
    ...original,
    useMe: () => ({ data: { id: 1, disabled: false, mustChangePassword: false } }),
    useWaStatus: () =>
      useQuery({
        queryKey: original.qk.wa,
        queryFn: () => Promise.resolve({ state: 'connecting' }),
        staleTime: Infinity,
      }),
  };
});

afterEach(() => {
  cleanup();
  socket.listeners.clear();
  socket.callbacks.clear();
});

it('restores profile requests when WhatsApp opens after the inbox, and after a later reconnect', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <ChatAvatar name="Test Customer" src="/api/chats/test%40s.whatsapp.net/avatar" />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(socket.listeners.has('connect')).toBe(true));
  await act(async () => socket.listeners.get('connect')!());
  expect(view.container.querySelector('img')).toBeNull();
  act(() => socket.listeners.get('wa:status')!({ state: 'open' }));
  await waitFor(() => expect(view.container.querySelector('img')).toBeTruthy());
  const first = view.container.querySelector('img')!;
  fireEvent.error(first);
  expect(view.container.querySelector('img')).toBeNull();
  act(() => socket.listeners.get('wa:status')!({ state: 'connecting' }));
  await waitFor(() => expect(view.container.querySelector('img')).toBeNull());
  act(() => socket.listeners.get('wa:status')!({ state: 'open' }));
  await waitFor(() => expect(view.container.querySelector('img')).toBeTruthy());
  expect(view.container.querySelector('img')).not.toBe(first);
  fireEvent.load(view.container.querySelector('img')!);
  expect(view.container.textContent).not.toContain('TC');
  qc.clear();
});

it('fetches changes missed before the first socket connection and during a reconnect', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let serverChat = 'Before the connection';
  function Chats() {
    const { data } = useQuery({
      queryKey: ['chats'],
      queryFn: async () => serverChat,
      staleTime: Infinity,
    });
    return <span>{data}</span>;
  }
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <Chats />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Before the connection');
  serverChat = 'Arrived before joining the socket';
  await act(async () => socket.listeners.get('connect')!());
  await screen.findByText(serverChat);
  act(() => socket.listeners.get('disconnect')!());
  serverChat = 'Arrived while offline';
  await act(async () => socket.listeners.get('connect')!());
  await screen.findByText(serverChat);
  qc.clear();
});

it('coalesces a bulk chat update into one list/count refresh and replaces stale in-flight responses', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const listKey = ['chats', { assigned: 'any' }];
  qc.setQueryData(listKey, { pages: [{ chats: [], nextCursor: null }], pageParams: [null] });
  qc.setQueryData(['open-chat-count'], { openCount: 205 });
  let serverCount = 205;
  const aborted = vi.fn();
  const queryCount = vi.fn(({ signal }: { signal: AbortSignal }) => {
    const snapshot = serverCount;
    return new Promise<{ openCount: number }>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ openCount: snapshot }), 200);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          aborted();
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  });
  const queryList = vi.fn(async () => ({
    pages: [{ chats: [], nextCursor: null }],
    pageParams: [null],
  }));
  function Counts() {
    const { data } = useQuery({ queryKey: ['open-chat-count'], queryFn: queryCount });
    useQuery({ queryKey: listKey, queryFn: queryList });
    return <span>{data?.openCount} open chats</span>;
  }
  const view = render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <Counts />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('205 open chats');
  // This response represents a count read just before the reset committed.
  void qc.refetchQueries({ queryKey: ['open-chat-count'] });
  await waitFor(() => expect(queryCount).toHaveBeenCalledTimes(1));
  serverCount = 0;
  act(() => {
    for (let i = 0; i < 205; i++)
      socket.listeners.get('chat:updated')!({ jid: `${i}@s.whatsapp.net`, status: 'resolved' });
  });
  await screen.findByText('0 open chats');
  expect(queryCount).toHaveBeenCalledTimes(2); // The old request, then one fresh request.
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(queryList).toHaveBeenCalledTimes(1);
  // An update queued just before unmount must not start another request afterward.
  act(() => socket.listeners.get('chat:updated')!({ jid: 'later@s.whatsapp.net', status: 'open' }));
  view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(queryCount).toHaveBeenCalledTimes(2);
  qc.clear();
});

it('shares one list/count refresh between a new message and its chat update', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const listKey = ['chats', { assigned: 'any' }];
  const list = { pages: [{ chats: [], nextCursor: null }], pageParams: [null] };
  qc.setQueryData(listKey, list);
  qc.setQueryData(['open-chat-count'], { openCount: 0 });
  const queryList = vi.fn(async () => list);
  const queryCount = vi.fn(async () => ({ openCount: 1 }));
  function Counts() {
    const { data } = useQuery({ queryKey: ['open-chat-count'], queryFn: queryCount });
    useQuery({ queryKey: listKey, queryFn: queryList });
    return <span>{data?.openCount} open chats</span>;
  }
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <Counts />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('0 open chats');
  act(() => {
    socket.listeners.get('message:new')!({
      id: 'incoming',
      chatJid: '1@s.whatsapp.net',
      clientId: null,
    });
    socket.listeners.get('chat:updated')!({ jid: '1@s.whatsapp.net', status: 'open' });
  });
  await screen.findByText('1 open chats');
  expect(queryCount).toHaveBeenCalledTimes(1);
  expect(queryList).toHaveBeenCalledTimes(1);
  qc.clear();
});

it('relabels cached group messages when a sender profile name changes', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const group = 'team@g.us';
  const farah = '601@s.whatsapp.net';
  const groupMsg = (id: string, senderProfile: unknown) => ({
    id,
    chatJid: group,
    senderJid: farah,
    fromMe: false,
    clientId: null,
    senderProfile,
  });
  qc.setQueryData(['messages', group], {
    pages: [
      {
        messages: [
          groupMsg('G1', { chatJid: farah, name: 'Farah' }),
          groupMsg('G2', { chatJid: 'other@s.whatsapp.net', name: 'Ali' }),
        ],
        nextBefore: null,
      },
    ],
    pageParams: [null],
  });
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <span />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(socket.listeners.has('chat:updated')).toBe(true));
  const profiles = () =>
    (
      qc.getQueryData(['messages', group]) as {
        pages: { messages: { senderProfile: unknown }[] }[];
      }
    ).pages[0]!.messages.map((m) => m.senderProfile);
  act(() =>
    socket.listeners.get('chat:updated')!({
      jid: farah,
      type: 'dm',
      name: 'Farah Aziz',
      whatsappName: 'Farah 🌸',
      status: 'open',
    }),
  );
  expect(profiles()).toEqual([
    { chatJid: farah, name: 'Farah Aziz' },
    { chatJid: 'other@s.whatsapp.net', name: 'Ali' },
  ]);
  // Profile name cleared: the chat name falls back to the WhatsApp name.
  act(() =>
    socket.listeners.get('chat:updated')!({
      jid: farah,
      type: 'dm',
      name: 'Farah 🌸',
      whatsappName: 'Farah 🌸',
      status: 'open',
    }),
  );
  expect(profiles()).toEqual([null, { chatJid: 'other@s.whatsapp.net', name: 'Ali' }]);
  qc.clear();
});

it('refetches an open customer profile when its chat is updated live', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const profileKey = ['customer-profile', '1@s.whatsapp.net'];
  let name = 'Farah';
  const queryProfile = vi.fn(async () => name);
  function Profile() {
    const { data } = useQuery({ queryKey: profileKey, queryFn: queryProfile });
    return <span>Profile {data}</span>;
  }
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <Profile />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Profile Farah');
  await waitFor(() => expect(socket.listeners.has('chat:updated')).toBe(true));
  name = 'Farah Aziz';
  act(() => socket.listeners.get('chat:updated')!({ jid: '1@s.whatsapp.net', status: 'open' }));
  await screen.findByText('Profile Farah Aziz');
  qc.clear();
});

it('refreshes the tag suggestions when a chat arrives with tags (a teammate added a new tag)', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  let tags = ['VIP'];
  const queryTags = vi.fn(async () => tags);
  function Tags() {
    const { data } = useQuery({ queryKey: ['customer-tags', ''], queryFn: queryTags });
    return <span>Tags {data?.join(',')}</span>;
  }
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <Tags />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Tags VIP');
  await waitFor(() => expect(socket.listeners.has('chat:updated')).toBe(true));
  tags = ['Hungry', 'VIP'];
  act(() =>
    socket.listeners.get('chat:updated')!({
      jid: '1@s.whatsapp.net',
      status: 'open',
      tags: ['Hungry'],
    }),
  );
  await screen.findByText('Tags Hungry,VIP');
  qc.clear();
});

it('refreshes the AI assistant settings when the tunnel status changes (new tunnel URL)', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { qk } = await vi.importActual<typeof Queries>('./queries');
  qc.setQueryData(qk.mcpSettings, {
    enabled: true,
    endpointPath: '/mcp',
    publicUrl: null,
    localUrl: 'x',
  });
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <span />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(socket.listeners.has('tunnel:status')).toBe(true));
  expect(qc.getQueryState(qk.mcpSettings)?.isInvalidated).toBe(false);
  act(() =>
    socket.listeners.get('tunnel:status')!({ state: 'running', url: 'https://new.example' }),
  );
  expect(qc.getQueryState(qk.mcpSettings)?.isInvalidated).toBe(true);
  qc.clear();
});

it('keeps a message that arrives while its chat is still loading (the load started before it existed)', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const jid = 'group@g.us';
  const reply = { id: 'reply', chatJid: jid, clientId: null, timestamp: 2, body: 'Review noted' };
  const page = (messages: unknown[]) => ({
    pages: [{ messages, nextBefore: null }],
    pageParams: [null],
  });
  // The first load answers with the state from before the reply; a later load includes it.
  let releaseFirst!: () => void;
  const first = new Promise<void>((r) => (releaseFirst = r));
  const load = vi
    .fn()
    .mockImplementationOnce(async () => {
      await first;
      return page([]);
    })
    .mockImplementation(async () => page([reply]));
  function Messages() {
    const { data } = useQuery({ queryKey: ['messages', jid], queryFn: load });
    const list = (data?.pages[0]?.messages ?? []) as Array<{ body: string }>;
    return <span>{list.length ? list.map((m) => m.body).join(',') : 'no messages'}</span>;
  }
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <Messages />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  // The live event comes while that first load is still running ...
  act(() => socket.listeners.get('message:new')!(reply));
  // ... and the old answer arrives afterwards. The reply must still show.
  await act(async () => releaseFirst());
  await screen.findByText('Review noted');
  qc.clear();
});

it('keeps the inbox list current: a status patches it, a change reloads inboxes, team and chats', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const open = { state: 'open', me: null, qr: null, lastError: null };
  qc.setQueryData(['inboxes'], {
    inboxes: [
      { id: 2, name: 'Catering', tone: 'warning', number: null, removed: false, status: open },
    ],
    maxInboxes: 3,
    canAdd: true,
  });
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <span />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(socket.listeners.has('inbox:status')).toBe(true));
  act(() =>
    socket.listeners.get('inbox:status')!({
      inboxId: 2,
      status: { ...open, state: 'disconnected' },
    }),
  );
  expect(
    (qc.getQueryData(['inboxes']) as { inboxes: { status: { state: string } }[] }).inboxes[0]!
      .status.state,
  ).toBe('disconnected');
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  act(() => socket.listeners.get('inboxes:changed')!());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inboxes'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] });
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chats'] }));
  invalidate.mockClear();
  // the chats this user may open changed (an agent limited to chosen chats)
  act(() => socket.listeners.get('chats:access')!());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users', 'directory'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chat'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['messages'] });
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chats'] }));
  qc.clear();
});

it('replaces the reactions of a cached message when someone reacts, changes or removes one', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const jid = '601@s.whatsapp.net';
  qc.setQueryData(['messages', jid], {
    pages: [
      {
        messages: [
          { id: 'M1', chatJid: jid, clientId: null, reactions: [] },
          { id: 'M2', chatJid: jid, clientId: null, reactions: [] },
        ],
        nextBefore: null,
      },
    ],
    pageParams: [null],
  });
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <span />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(socket.listeners.has('message:reactions')).toBe(true));
  const reactions = [{ emoji: '👍', senderJid: jid, senderName: 'Farah', fromMe: false, at: 2 }];
  const cached = () =>
    (
      qc.getQueryData(['messages', jid]) as { pages: { messages: { reactions: unknown }[] }[] }
    ).pages[0]!.messages.map((m) => m.reactions);
  act(() =>
    socket.listeners.get('message:reactions')!({ chatJid: jid, messageId: 'M1', reactions }),
  );
  expect(cached()).toEqual([reactions, []]);
  act(() =>
    socket.listeners.get('message:reactions')!({ chatJid: jid, messageId: 'M1', reactions: [] }),
  );
  expect(cached()).toEqual([[], []]);
  qc.clear();
});

it.each(['message:reactions', 'message:updated'] as const)(
  'keeps a %s change that arrives while a reload of its chat is running (the reload started before it)',
  async (event) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const jid = '601@s.whatsapp.net';
    const before = { id: 'M1', chatJid: jid, clientId: null, body: 'Yes', reactions: [] };
    const reactions = [{ emoji: '👍', senderJid: jid, senderName: 'Farah', fromMe: false, at: 2 }];
    const after = { ...before, body: 'Yes, Saturday', reactions };
    const page = (m: unknown) => ({
      pages: [{ messages: [m], nextBefore: null }],
      pageParams: [null],
    });
    // The first load shows the message; a reload starts before the change and answers after it.
    let releaseReload!: () => void;
    const reloadAnswer = new Promise<void>((r) => (releaseReload = r));
    const load = vi
      .fn()
      .mockImplementationOnce(async () => page(before))
      .mockImplementationOnce(async () => {
        await reloadAnswer;
        return page(before);
      })
      .mockImplementation(async () => page(after));
    function Messages() {
      const { data } = useQuery({ queryKey: ['messages', jid], queryFn: load });
      const m = data?.pages[0]?.messages[0] as typeof after | undefined;
      return <span>{m ? `${m.body}:${m.reactions.map((r) => r.emoji).join('')}` : 'none'}</span>;
    }
    render(
      <QueryClientProvider client={qc}>
        <RealtimeProvider>
          <Messages />
        </RealtimeProvider>
      </QueryClientProvider>,
    );
    await screen.findByText('Yes:');
    act(() => void qc.invalidateQueries({ queryKey: ['messages', jid] }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    act(() =>
      event === 'message:reactions'
        ? socket.listeners.get(event)!({ chatJid: jid, messageId: 'M1', reactions })
        : socket.listeners.get(event)!(after),
    );
    await screen.findByText(event === 'message:reactions' ? 'Yes:👍' : 'Yes, Saturday:👍');
    // The stale reload answers afterwards: one more load follows it, so the change still shows.
    await act(async () => releaseReload());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await screen.findByText('Yes, Saturday:👍');
    qc.clear();
  },
);

it('refreshes a group AI state on a group line and when a teammate writes during a pause', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const group = '120363000000000001@g.us';
  const key = ['ai-groups', 'chat', group];
  qc.setQueryData(key, {
    enabled: true,
    agentId: 3,
    agentName: 'Aina',
    agentAnswersGroups: true,
    paused: false,
  });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <span>ready</span>
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('ready');
  const groupCalls = () =>
    invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(key));

  // Not paused: our own message does not refetch.
  act(() =>
    socket.listeners.get('message:new')!({
      id: 'm1',
      chatJid: group,
      fromMe: true,
      clientId: null,
    }),
  );
  expect(groupCalls()).toHaveLength(0);
  // A look-up line without a group part does not either.
  act(() =>
    socket.listeners.get('chat:event')!({
      id: 1,
      chatJid: group,
      type: 'ai_tool_used',
      actorId: 9,
      payload: { title: 'Find', sourceLabel: 'Lejar' },
      at: 0,
    }),
  );
  expect(groupCalls()).toHaveLength(0);
  act(() =>
    socket.listeners.get('chat:event')!({
      id: 2,
      chatJid: group,
      type: 'ai_tool_used',
      actorId: 9,
      payload: { title: 'Group', sourceLabel: 'WhatsApp', group: { kind: 'paused', member: null } },
      at: 0,
    }),
  );
  expect(groupCalls()).toHaveLength(1);
  qc.setQueryData(key, { ...qc.getQueryData<object>(key), paused: true });
  act(() =>
    socket.listeners.get('message:new')!({
      id: 'm2',
      chatJid: group,
      fromMe: true,
      clientId: null,
    }),
  );
  expect(groupCalls()).toHaveLength(2);
  qc.clear();
});

it('reloads Group info and its admin view when a group changes', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const group = '120363000000000001@g.us';
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <span>ready</span>
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('ready');
  act(() => socket.listeners.get('group:changed')!({ chatJid: group }));
  const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
  expect(keys).toContain(JSON.stringify(['group-admin', group]));
  expect(keys).toContain(JSON.stringify(['group-members', group]));
  qc.clear();
});

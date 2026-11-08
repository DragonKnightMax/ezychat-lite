import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type default as React } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubXhr } from '../test/fake-xhr';
import { uploadProgressOf as progressOf, useUploadProgress } from '../lib/upload-progress';
import {
  DEFAULT_INBOX_CAPABILITIES,
  type Inbox,
  type InboxListResponse,
  type Message,
  type WaStatus,
} from '@ezychat/shared';
import {
  patchInboxStatusInCache,
  patchMessageInCache,
  qk,
  upsertMessageInCache,
  useChats,
  useInboxStatus,
  useInboxes,
  useCustomerProfile,
  useCustomerTags,
  useSaveCustomerProfile,
  useSendMedia,
  useSendReaction,
  type MessagesData,
} from './queries';

const JID = '60123456789@s.whatsapp.net';

function msg(fields: Partial<Message>): Message {
  return {
    id: 'm1',
    chatJid: JID,
    senderJid: null,
    senderName: null,
    fromMe: true,
    sentByUserId: 1,
    type: 'text',
    body: 'Hello!',
    mediaUrl: null,
    mediaMime: null,
    mediaName: null,
    mediaStatus: 'none',
    quotedId: null,
    status: 'pending',
    error: null,
    timestamp: 1000,
    clientId: 'c1',
    reactions: [],
    ...fields,
  };
}

function seed(qc: QueryClient, messages: Message[]) {
  qc.setQueryData<MessagesData>(qk.messages(JID), {
    pages: [{ messages, nextBefore: null }],
    pageParams: [null],
  });
}

function cached(qc: QueryClient): Message[] {
  return qc.getQueryData<MessagesData>(qk.messages(JID))!.pages.flatMap((p) => p.messages);
}

describe('message cache', () => {
  it('a late POST response does not regress a status already advanced by the socket', () => {
    const qc = new QueryClient();
    seed(qc, [msg({ id: 'local-c1' })]);
    // Socket: sent (renamed to WA id), then delivered — before the POST response arrives.
    patchMessageInCache(
      qc,
      JID,
      { id: 'srv-1', clientId: 'c1' },
      { status: 'sent', error: null, id: 'WA-1' },
    );
    patchMessageInCache(
      qc,
      JID,
      { id: 'WA-1', clientId: 'c1' },
      { status: 'delivered', error: null },
    );
    // POST response: still the pending server row.
    upsertMessageInCache(qc, msg({ id: 'srv-1', status: 'pending' }));

    const all = cached(qc);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'WA-1', status: 'delivered', clientId: 'c1' });
  });

  it('a live message that arrives while the first fetch is in flight triggers a refetch', async () => {
    const qc = new QueryClient();
    let calls = 0;
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: qk.messages(JID),
      initialPageParam: null as string | null,
      getNextPageParam: () => undefined,
      queryFn: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { messages: calls === 1 ? [] : [msg({ id: 'live-1' })], nextBefore: null };
      },
    });
    const unsub = observer.subscribe(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    upsertMessageInCache(qc, msg({ id: 'live-1' }));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(cached(qc).map((x) => x.id)).toEqual(['live-1']));
    expect(calls).toBe(2);
    unsub();
  });

  it('a live message with no messages query at all does nothing', () => {
    const qc = new QueryClient();
    upsertMessageInCache(qc, msg({ id: 'live-1' }));
    expect(qc.getQueryCache().find({ queryKey: qk.messages(JID) })).toBeUndefined();
  });

  it('a newer status from the server replaces the cached one', () => {
    const qc = new QueryClient();
    seed(qc, [msg({ id: 'local-c1' })]);
    upsertMessageInCache(qc, msg({ id: 'WA-1', status: 'sent' }));
    expect(cached(qc)[0]).toMatchObject({ id: 'WA-1', status: 'sent' });
  });

  it('a retry (failed → pending) is applied', () => {
    const qc = new QueryClient();
    seed(qc, [msg({ id: 'srv-1', status: 'failed', error: 'x' })]);
    upsertMessageInCache(qc, msg({ id: 'srv-1', status: 'pending', error: null }));
    expect(cached(qc)[0]).toMatchObject({ status: 'pending', error: null });
  });

  it('renaming a sent media message also moves its mediaUrl to the new id', () => {
    const qc = new QueryClient();
    seed(qc, [msg({ id: 'local-c1', type: 'document', mediaUrl: '/api/media/local-c1' })]);
    patchMessageInCache(
      qc,
      JID,
      { id: 'local-c1', clientId: 'c1' },
      { status: 'sent', error: null, id: 'WA/1' },
    );
    expect(cached(qc)[0]).toMatchObject({ id: 'WA/1', mediaUrl: '/api/media/WA%2F1' });
    // A late POST response with the stale local URL must not bring it back.
    upsertMessageInCache(
      qc,
      msg({ id: 'local-c1', type: 'document', status: 'pending', mediaUrl: '/api/media/local-c1' }),
    );
    expect(cached(qc)[0]).toMatchObject({ id: 'WA/1', mediaUrl: '/api/media/WA%2F1' });
  });

  it('keeps a known sender profile when a copy of the message arrives without one', () => {
    const qc = new QueryClient();
    const senderProfile = { chatJid: '601@s.whatsapp.net', name: 'Farah Aziz' };
    seed(qc, [msg({ id: 'G1', fromMe: false, status: 'delivered', senderProfile })]);
    upsertMessageInCache(qc, msg({ id: 'G1', fromMe: false, status: 'delivered' }));
    expect(cached(qc)[0]!.senderProfile).toEqual(senderProfile);
    // An explicit null (profile name cleared) still applies.
    upsertMessageInCache(
      qc,
      msg({ id: 'G1', fromMe: false, status: 'delivered', senderProfile: null }),
    );
    expect(cached(qc)[0]!.senderProfile).toBeNull();
  });

  it('a text message rename leaves mediaUrl null', () => {
    const qc = new QueryClient();
    seed(qc, [msg({ id: 'local-c1' })]);
    patchMessageInCache(
      qc,
      JID,
      { id: 'local-c1', clientId: 'c1' },
      { status: 'sent', error: null, id: 'WA-1' },
    );
    expect(cached(qc)[0]!.mediaUrl).toBeNull();
  });
});

describe('customer profile queries', () => {
  const FARAH = '601@s.whatsapp.net';
  const response = {
    profile: {
      id: 'p1',
      name: 'Farah Aziz',
      company: null,
      email: null,
      otherPhone: null,
      address: null,
      tags: ['VIP'],
      updatedAt: 1,
      updatedBy: 1,
    },
    whatsappName: 'Farah',
  };

  function mockFetchJson(data: unknown) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${String(init.body)}` : ''}`);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the tag filter in the chat list query', async () => {
    const calls = mockFetchJson({ chats: [], nextCursor: null });
    const { wrapper } = setup();
    renderHook(() => useChats({ assigned: 'any', tag: 'VIP' }), { wrapper });
    await waitFor(() => expect(calls[0]).toContain('tag=VIP'));
  });

  it('loads a customer profile only when a chat is given', async () => {
    const calls = mockFetchJson(response);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ jid }: { jid: string | null }) => useCustomerProfile(jid),
      { wrapper, initialProps: { jid: null as string | null } },
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(calls).toEqual([]);
    rerender({ jid: FARAH });
    await waitFor(() => expect(result.current.data).toEqual(response));
    expect(calls).toEqual(['GET /api/chats/601%40s.whatsapp.net/profile']);
  });

  it('saves a customer profile and stores the response in the cache', async () => {
    const calls = mockFetchJson(response);
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useSaveCustomerProfile(FARAH), { wrapper });
    await act(() =>
      result.current.mutateAsync({
        name: 'Farah Aziz',
        company: '',
        email: '',
        otherPhone: '',
        address: '',
        tags: ['VIP'],
      }),
    );
    expect(calls[0]).toMatch(/^PUT \/api\/chats\/601%40s\.whatsapp\.net\/profile /);
    expect(queryClient.getQueryData(qk.customerProfile(FARAH))).toEqual(response);
  });

  it('refreshes the chat and the chat list after a save, without waiting for the socket', async () => {
    mockFetchJson(response);
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSaveCustomerProfile(FARAH), { wrapper });
    await act(() =>
      result.current.mutateAsync({
        name: 'Farah Aziz',
        company: '',
        email: '',
        otherPhone: '',
        address: '',
        tags: ['VIP'],
      }),
    );
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(qk.chat(FARAH));
    expect(keys).toContainEqual(qk.chatsAll);
  });

  it('sends a reaction and puts the answered reactions on the cached message', async () => {
    const reactions = [
      { emoji: '👍', senderJid: null, senderName: null, fromMe: true, at: 5, sentByUserId: 1 },
    ];
    const calls = mockFetchJson({ messageId: 'WA/1', reactions });
    const { queryClient, wrapper } = setup();
    seed(queryClient, [msg({ id: 'WA/1', status: 'delivered', clientId: null })]);
    const { result } = renderHook(() => useSendReaction(), { wrapper });
    await act(() => result.current.mutateAsync({ chatJid: JID, messageId: 'WA/1', emoji: '👍' }));
    expect(calls).toEqual(['PUT /api/messages/WA%2F1/reaction {"emoji":"👍"}']);
    expect(cached(queryClient)[0]!.reactions).toEqual(reactions);
  });

  it('loads tag suggestions for a search', async () => {
    const calls = mockFetchJson({ tags: ['VIP', 'Vegan'] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useCustomerTags('v i'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(['VIP', 'Vegan']));
    expect(calls).toEqual(['GET /api/customer-tags?q=v%20i']);
  });
});

describe('inboxes', () => {
  const open: WaStatus = { state: 'open', me: null, qr: null, lastError: null };
  const offline: WaStatus = { ...open, state: 'disconnected' };
  const inbox = (id: number, status: WaStatus): Inbox => ({
    id,
    name: `Inbox ${id}`,
    tone: 'primary',
    number: null,
    removed: false,
    aiAgentId: null,
    type: 'linked_phone',
    capabilities: DEFAULT_INBOX_CAPABILITIES,
    status,
  });
  const list: InboxListResponse = {
    inboxes: [inbox(1, open), inbox(2, offline)],
    maxInboxes: 3,
    canAdd: true,
  };

  function mockRoutes(routes: Record<string, { status?: number; body: unknown }>) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        const r = routes[url] ?? { status: 404, body: { error: { code: 'not_found' } } };
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  function wrap() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    return { qc, wrapper };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('sends the inbox filter in the chat list query', async () => {
    const calls = mockRoutes({});
    const { wrapper } = wrap();
    renderHook(() => useChats({ assigned: 'any', inbox: 2 }), { wrapper });
    await waitFor(() => expect(calls[0]).toContain('inbox=2'));
  });

  it('loads the inbox list, and counts a server without the route as no inboxes', async () => {
    mockRoutes({ '/api/inboxes': { body: list } });
    let { wrapper } = wrap();
    const loaded = renderHook(() => useInboxes(), { wrapper });
    await waitFor(() => expect(loaded.result.current.data).toEqual(list));

    mockRoutes({});
    ({ wrapper } = wrap());
    const missing = renderHook(() => useInboxes(), { wrapper });
    await waitFor(() =>
      expect(missing.result.current.data).toEqual({ inboxes: [], maxInboxes: 1, canAdd: false }),
    );

    mockRoutes({ '/api/inboxes': { status: 500, body: { error: { code: 'boom' } } } });
    ({ wrapper } = wrap());
    const failed = renderHook(() => useInboxes(), { wrapper });
    await waitFor(() => expect(failed.result.current.isError).toBe(true));
  });

  it('reads inbox 1 from the WhatsApp status and other inboxes from the inbox list', async () => {
    const calls = mockRoutes({
      '/api/inboxes': { body: list },
      '/api/wa/status': { body: { ...open, state: 'connecting' } },
    });
    const { wrapper } = wrap();
    const primary = renderHook(() => useInboxStatus(1), { wrapper });
    await waitFor(() => expect(primary.result.current?.state).toBe('connecting'));
    expect(calls).toEqual(['/api/wa/status']);
    const second = renderHook(() => useInboxStatus(2), { wrapper });
    await waitFor(() => expect(second.result.current?.state).toBe('disconnected'));
    const unknown = renderHook(() => useInboxStatus(undefined), { wrapper });
    expect(unknown.result.current).toBeUndefined();
  });

  it('applies a socket inbox status to the cached list only for a known inbox', () => {
    const qc = new QueryClient();
    patchInboxStatusInCache(qc, { inboxId: 2, status: open });
    expect(qc.getQueryData(qk.inboxes)).toBeUndefined();
    qc.setQueryData(qk.inboxes, list);
    patchInboxStatusInCache(qc, { inboxId: 2, status: open });
    const after = qc.getQueryData<InboxListResponse>(qk.inboxes)!;
    expect(after.inboxes.map((i) => i.status.state)).toEqual(['open', 'open']);
    patchInboxStatusInCache(qc, { inboxId: 7, status: offline });
    expect(qc.getQueryData(qk.inboxes)).toBe(after);
  });
});

describe('media upload refusals', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function upload(status: number, code: string, body?: string) {
    stubXhr(() => ({ status, body: body ?? { error: { code, message: 'Server words' } } }));
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    seed(qc, []);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useSendMedia(JID), { wrapper });
    const file = new File(['x'], 'big.mp4', { type: 'video/mp4' });
    await act(async () => {
      await result.current.mutateAsync({ file, clientId: 'c9' }).catch(() => undefined);
    });
    return cached(qc).find((m) => m.clientId === 'c9')!;
  }

  it('sends asFile=1 for a video going as a file', async () => {
    const uploads = stubXhr(() => ({ status: 500, body: { error: { code: 'x', message: 'no' } } }));
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    seed(qc, []);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useSendMedia(JID), { wrapper });
    const file = new File(['x'], 'big.mp4', { type: 'video/mp4' });
    await act(async () => {
      await result.current
        .mutateAsync({ file, clientId: 'c8', asFile: true })
        .catch(() => undefined);
    });
    expect(uploads[0]!.url).toBe(`/api/chats/${encodeURIComponent(JID)}/media`);
    expect(uploads[0]!.form.get('asFile')).toBe('1');
    expect(uploads[0]!.form.get('clientId')).toBe('c8');
  });

  it('keeps the code of a size refusal so the bubble words it, else the server message', async () => {
    expect(await upload(413, 'too_large_as_video')).toMatchObject({
      status: 'failed',
      error: 'too_large_as_video',
      type: 'video',
    });
    expect((await upload(413, 'too_large_for_whatsapp')).error).toBe('too_large_for_whatsapp');
    expect((await upload(413, 'something_else')).error).toBe('Server words');
    expect((await upload(500, 'too_large')).error).toBe('Server words');
    // Cloudflare's tunnel refuses a large body without our JSON
    expect((await upload(413, '', '<html>413 Request Entity Too Large</html>')).error).toBe(
      'tunnel_too_large',
    );
  });

  it('reports the upload progress while it goes, and clears it when it ends', async () => {
    const seen: Array<number | null> = [];
    stubXhr(() => {
      seen.push(progressOf('c10'));
      return { status: 201, body: { id: 'M10', clientId: 'c10', chatJid: JID } };
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    seed(qc, []);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useSendMedia(JID), { wrapper });
    const { result: progress } = renderHook(() => useUploadProgress('c10'));
    await act(async () => {
      await result.current.mutateAsync({ file: new File(['x'], 'a.pdf'), clientId: 'c10' });
    });
    expect(seen).toEqual([1]);
    expect(progress.current).toBeNull();
  });
});

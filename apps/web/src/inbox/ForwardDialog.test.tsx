import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { Chat, Inbox, Message } from '@ezychat/shared';
import { ApiError } from '../api/client';
import { ForwardDialog, forwardProblemOf } from './ForwardDialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const MB = 1024 * 1024;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fail = (code: string, status: number) => json({ error: { code, message: code } }, status);

const inbox = (over: Partial<Inbox>): Inbox => ({
  id: 1,
  name: 'Kopi Apong',
  tone: 'primary',
  number: '60123456789',
  status: { state: 'open', me: null, qr: null, lastError: null },
  removed: false,
  aiAgentId: null,
  type: 'linked_phone',
  capabilities: {
    qrLink: true,
    history: true,
    groups: true,
    replyWindowHours: null,
    templates: false,
    needsPublicUrl: false,
  },
  ...over,
});
const cloud = inbox({
  id: 2,
  name: 'Online orders',
  tone: 'warning',
  type: 'wa-cloud',
  capabilities: {
    qrLink: false,
    history: false,
    groups: false,
    replyWindowHours: 24,
    templates: true,
    needsPublicUrl: true,
    mediaLimits: { video: 16 * MB, image: 5 * MB, audio: 16 * MB, document: 100 * MB },
  },
});

let n = 0;
const chat = (name: string, over: Partial<Chat> = {}): Chat => ({
  jid: `60${++n}@s.whatsapp.net`,
  inboxId: 1,
  waJid: `60${n}@s.whatsapp.net`,
  type: 'dm',
  name,
  avatarUrl: null,
  unreadCount: 0,
  lastMessageAt: 1,
  lastMessagePreview: null,
  status: 'open',
  assignedTo: null,
  updatedAt: 1,
  phone: null,
  lastInboundAt: null,
  ...over,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 'SRC1',
  chatJid: '600@s.whatsapp.net',
  senderJid: null,
  senderName: null,
  fromMe: false,
  sentByUserId: null,
  type: 'text',
  body: 'Promo: 2 for 1 on Kopi Peng today',
  mediaUrl: null,
  mediaMime: null,
  mediaName: null,
  mediaStatus: 'none',
  quotedId: null,
  status: 'delivered',
  error: null,
  timestamp: 1,
  clientId: null,
  reactions: [],
  ...over,
});

let inboxes: Inbox[];
let chats: Chat[];
let waState: string;
let forwardAnswer: () => Response;
let calls: Array<{ url: string; method: string; body: unknown }>;

function ChatPage() {
  return <p>chat {useParams().jid}</p>;
}

function show(m: Message = message(), sourceInboxId = 1) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/inboxes') return json({ inboxes, maxInboxes: 3, canAdd: false });
      if (url === '/api/wa/status')
        return json({ state: waState, me: null, qr: null, lastError: null });
      if (url.startsWith('/api/chats?')) {
        const q = new URL(url, 'http://x').searchParams.get('q')?.toLowerCase();
        return json({
          chats: q ? chats.filter((c) => c.name.toLowerCase().includes(q)) : chats,
          nextCursor: null,
        });
      }
      if (url === `/api/messages/${m.id}/forward` && method === 'POST') return forwardAnswer();
      return fail('not_found', 404);
    }),
  );
  const onClose = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={<ForwardDialog message={m} sourceInboxId={sourceInboxId} onClose={onClose} />}
          />
          <Route path="/chats/:jid" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onClose, qc };
}

const rowOf = async (name: string) =>
  (await screen.findAllByTestId('forward-row')).find((r) => r.textContent?.includes(name))!;
const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(within(await rowOf(name)).getByRole('checkbox'));
const forwardCalls = () => calls.filter((c) => c.url.endsWith('/forward'));

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  n = 0;
  inboxes = [inbox({})];
  chats = [
    chat('Priya'),
    chat('Farah Catering'),
    chat('Kopi Apong Staff', { type: 'group', jid: '1203@g.us' }),
    chat('Jason'),
    chat('Nurul'),
    chat('Ahmad', { status: 'resolved' }),
  ];
  waState = 'open';
  forwardAnswer = () => json({ messages: [] }, 201);
  calls = [];
  vi.mocked(toast.success).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Forward dialog: choosing chats', () => {
  it('shows what is forwarded and lists open and resolved chats and groups, searchable', async () => {
    const { user } = show();
    expect(screen.getByTestId('forward-preview').textContent).toBe(
      'Promo: 2 for 1 on Kopi Peng today',
    );
    expect(screen.getByTestId('forward-count').textContent).toBe('0 of 5 chosen');
    expect((await screen.findAllByTestId('forward-row')).map((r) => r.textContent)).toEqual([
      'PPriya',
      'FCFarah Catering',
      'KSKopi Apong StaffGroup',
      'JJason',
      'NNurul',
      'AAhmad',
    ]);
    expect(screen.queryByTestId('inbox-chip')).toBeNull();
    expect(screen.getByTestId('forward-send')).toHaveProperty('disabled', true);
    // The list asks for every chat (any assignee, every status).
    expect(calls.find((c) => c.url.startsWith('/api/chats?'))?.url).toBe('/api/chats?assigned=any');

    await user.type(screen.getByTestId('forward-search'), 'kopi');
    await waitFor(() =>
      expect(screen.getAllByTestId('forward-row').map((r) => r.textContent)).toEqual([
        'KSKopi Apong StaffGroup',
      ]),
    );
    expect(calls.some((c) => c.url === '/api/chats?assigned=any&q=kopi')).toBe(true);
    await user.clear(screen.getByTestId('forward-search'));
    await user.type(screen.getByTestId('forward-search'), 'zzz');
    expect(await screen.findByText('No chats found')).toBeTruthy();
    expect(
      screen.getByText('Try another name or number. To message a new number, use New chat.'),
    ).toBeTruthy();
  });

  it('says so when there is no chat at all, or the list fails', async () => {
    chats = [];
    show();
    expect(await screen.findByText('You have no chats to forward to yet.')).toBeTruthy();
  });

  it('says so when the chat list cannot be loaded', async () => {
    show();
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).startsWith('/api/chats?') ? fail('boom', 500) : json({ inboxes, maxInboxes: 1 }),
    );
    await userEvent.type(screen.getByTestId('forward-search'), 'x');
    expect(await screen.findByText('Chats could not be loaded. Close and try again.')).toBeTruthy();
  });

  it('caps at 5 chats: the rest are disabled, a chip removes one again', async () => {
    const { user } = show();
    for (const name of ['Priya', 'Farah Catering', 'Kopi Apong Staff', 'Jason', 'Nurul'])
      await pick(user, name);
    expect(screen.getByTestId('forward-count').textContent).toBe('5 of 5 chosen');
    expect(screen.getByTestId('forward-full').textContent).toBe(
      'You can forward to 5 chats at a time.',
    );
    expect(within(await rowOf('Ahmad')).getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('forward-send').textContent).toBe('Forward to 5 chats');
    await user.click(screen.getByRole('button', { name: 'Remove Jason' }));
    expect(screen.getByTestId('forward-count').textContent).toBe('4 of 5 chosen');
    expect(screen.queryByTestId('forward-full')).toBeNull();
    // Unticking a row removes it too.
    await pick(user, 'Priya');
    expect(screen.getAllByTestId('forward-chip').map((c) => c.textContent)).toEqual([
      'Farah Catering',
      'Kopi Apong Staff',
      'Nurul',
    ]);
  });

  it('a message forwarded many times goes to one chat at a time', async () => {
    const { user } = show(message({ forwarded: { manyTimes: true } }));
    expect(screen.getByTestId('forward-many-note').textContent).toContain(
      'WhatsApp lets you forward it to one chat at a time.',
    );
    await pick(user, 'Priya');
    expect(screen.getByTestId('forward-count').textContent).toBe('1 of 1 chosen');
    // No "5 at a time" note for a cap of one.
    expect(screen.queryByTestId('forward-full')).toBeNull();
    expect(within(await rowOf('Jason')).getByRole('checkbox')).toHaveProperty('disabled', true);
  });

  it('greys out a Business API chat whose reply window closed, with the reason', async () => {
    inboxes = [inbox({}), cloud];
    chats = [
      chat('Priya'),
      chat('Online buyer', { inboxId: 2, lastInboundAt: Date.now() - 30 * 3_600_000 }),
      chat('Recent buyer', { inboxId: 2, lastInboundAt: Date.now() - 3_600_000 }),
    ];
    const { user } = show();
    const closed = await rowOf('Online buyer');
    expect(closed.textContent).toContain('Reply window closed: send a template from the chat');
    expect(within(closed).getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(within(await rowOf('Recent buyer')).getByRole('checkbox')).toHaveProperty(
      'disabled',
      false,
    );
    // Two inboxes: each row names its number; a chat on another number gets the note.
    expect(screen.getAllByTestId('inbox-chip').map((c) => c.textContent)).toEqual([
      'Kopi Apong',
      'Online orders',
      'Online orders',
    ]);
    await pick(user, 'Priya');
    expect(screen.queryByTestId('forward-other-inbox')).toBeNull();
    await pick(user, 'Recent buyer');
    expect(screen.getByTestId('forward-other-inbox').textContent).toBe(
      'Each chat gets the message from its own WhatsApp number.',
    );
  });

  it('leaves out chats of a removed inbox (read only)', async () => {
    inboxes = [inbox({}), inbox({ id: 3, name: 'Old', removed: true })];
    chats = [chat('Priya'), chat('Old customer', { inboxId: 3 })];
    show();
    await rowOf('Priya');
    expect(screen.getAllByTestId('forward-row')).toHaveLength(1);
  });
});

describe('Forward dialog: large files', () => {
  it('a 70 MB video: size, large-file note, Send as Video or File', async () => {
    const video = message({
      type: 'video',
      body: null,
      mediaName: 'hall.mp4',
      mediaSize: 70 * MB,
    });
    const { user } = show(video);
    expect(screen.getByTestId('forward-preview').textContent).toBe('[Video]');
    expect(screen.getByTestId('forward-size').textContent).toBe('70 MB');
    expect(screen.getByTestId('forward-large').textContent).toBe(
      'Large file (70 MB). Each copy is uploaded to WhatsApp again, so it can take a few minutes.',
    );
    const asVideo = screen.getByRole('button', { name: 'Video' });
    const asFile = screen.getByRole('button', { name: 'File' });
    expect(asVideo.getAttribute('aria-pressed')).toBe('true');
    await user.click(asFile);
    expect(asFile.getAttribute('aria-pressed')).toBe('true');
    await user.click(asVideo);
    await pick(user, 'Priya');
    await user.click(screen.getByTestId('forward-send'));
    await waitFor(() => expect(forwardCalls()).toHaveLength(1));
    expect(forwardCalls()[0]!.body).toMatchObject({ sendAs: 'original' });
  });

  it('to a number that takes smaller videos: Video is disabled and it goes as a file', async () => {
    inboxes = [inbox({}), cloud];
    chats = [chat('Online buyer', { inboxId: 2, lastInboundAt: Date.now() }), chat('Priya')];
    const { user } = show(message({ type: 'video', body: null, mediaSize: 70 * MB }));
    expect(screen.getByTestId('forward-send-as-note').textContent).toContain('A video plays');
    await pick(user, 'Online buyer');
    expect(screen.getByRole('button', { name: 'Video' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'File' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('forward-send-as-note').textContent).toBe(
      'This video (70 MB) is too big to send as a video to the chats you chose (up to 16 MB). It goes as a file, in full quality.',
    );
    await user.click(screen.getByTestId('forward-send'));
    await waitFor(() => expect(forwardCalls()).toHaveLength(1));
    expect(forwardCalls()[0]!.body).toMatchObject({ sendAs: 'file' });
  });

  it('a file above a number’s file limit cannot be picked there', async () => {
    inboxes = [inbox({}), cloud];
    chats = [chat('Online buyer', { inboxId: 2, lastInboundAt: Date.now() }), chat('Priya')];
    show(message({ type: 'document', body: null, mediaName: 'big.zip', mediaSize: 120 * MB }));
    expect(screen.getByTestId('forward-preview').textContent).toBe('[Document] big.zip');
    const row = await rowOf('Online buyer');
    expect(row.textContent).toContain('Too large for this number: files up to 100 MB');
    expect(within(row).getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(within(await rowOf('Priya')).getByRole('checkbox')).toHaveProperty('disabled', false);
    expect(screen.queryByTestId('forward-send-as')).toBeNull();
  });
});

describe('Forward dialog: sending', () => {
  it('one chat: toast with Open chat, one request id per opening', async () => {
    const { user, onClose } = show(
      message({ type: 'document', body: null, mediaName: 'menu.pdf' }),
    );
    await pick(user, 'Kopi Apong Staff');
    expect(screen.getByTestId('forward-send').textContent).toBe('Forward to 1 chat');
    await user.click(screen.getByTestId('forward-send'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = forwardCalls()[0]!.body as { to: string[]; clientRequestId: string };
    expect(body.to).toEqual(['1203@g.us']);
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    const [text, opts] = vi.mocked(toast.success).mock.calls[0]!;
    expect(text).toBe('Forwarded to Kopi Apong Staff');
    const action = (opts as { action: { label: string; onClick(): void } }).action;
    expect(action.label).toBe('Open chat');
    action.onClick();
    expect(await screen.findByText('chat 1203@g.us')).toBeTruthy();
  });

  it('several chats: "Forwarded to n chats", the copies go into the caches', async () => {
    forwardAnswer = () =>
      json(
        {
          messages: [
            message({ id: 'C1', chatJid: chats[0]!.jid, fromMe: true, status: 'pending' }),
            message({ id: 'C2', chatJid: chats[3]!.jid, fromMe: true, status: 'pending' }),
          ],
        },
        201,
      );
    const { user, onClose, qc } = show();
    await pick(user, 'Priya');
    await pick(user, 'Jason');
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await user.click(screen.getByTestId('forward-send'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Forwarded to 2 chats', undefined);
    expect(forwardCalls()[0]!.body).toMatchObject({
      to: [chats[0]!.jid, chats[3]!.jid],
      sendAs: 'original',
    });
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        '["chats"]',
        `["messages","${chats[0]!.jid}"]`,
        `["messages","${chats[3]!.jid}"]`,
      ]),
    );
  });

  it.each([
    [
      'wa_disconnected',
      503,
      'WhatsApp is not connected',
      'Forward again when Kopi Apong is back online.',
    ],
    [
      'inbox_not_connected',
      409,
      'WhatsApp is not connected',
      'Forward again when Kopi Apong is back online.',
    ],
    ['window_closed', 409, 'Reply window closed', 'A chat you chose has not written'],
    ['safety_locked', 409, 'This file is locked', 'found this file dangerous'],
    ['rate_limited', 429, 'Too many forwards', 'Wait a moment and try again.'],
    ['media_unavailable', 502, 'File not available', 'could not be downloaded'],
    ['message_deleted', 409, 'Message deleted', 'This message was deleted'],
    ['message_not_sent', 409, 'Not sent yet', 'Wait until it is sent.'],
    ['inbox_removed', 409, 'Number removed', 'was removed'],
    ['forward_many_times', 400, 'One chat at a time', 'Choose one chat.'],
    ['too_large_as_video', 413, 'Too big for a video', 'Send it as a file instead.'],
    ['too_large_for_whatsapp', 413, 'Too large for WhatsApp', 'Remove it and try again.'],
    ['not_found', 404, 'Not forwarded', 'Nothing was sent.'],
  ])('shows the refusal %s as a banner', async (code, status, title, body) => {
    forwardAnswer = () => fail(code, status);
    const { user, onClose } = show();
    await pick(user, 'Priya');
    await user.click(screen.getByTestId('forward-send'));
    const banner = await screen.findByText(title);
    expect(banner.parentElement!.textContent).toContain(body);
    expect(onClose).not.toHaveBeenCalled();
    // Changing the choice clears it.
    await pick(user, 'Jason');
    expect(screen.queryByText(title)).toBeNull();
  });

  it('maps unknown errors to "Not forwarded"', () => {
    expect(forwardProblemOf(new Error('x'))).toBe('other');
    expect(forwardProblemOf(new ApiError(400, 'validation', 'x'))).toBe('other');
    expect(forwardProblemOf(new ApiError(503, 'wa_disconnected', 'x'))).toBe('wa_disconnected');
  });

  it('Cancel closes', async () => {
    const { user, onClose } = show();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Forward dialog: what blocks it', () => {
  it('a file WhatsApp Safety rated High: danger banner, no list, Forward disabled', async () => {
    show(
      message({
        type: 'document',
        body: null,
        mediaName: 'invoice.zip',
        safety: {
          itemId: 1,
          level: 'high',
          rules: [],
          aiReason: null,
          locked: true,
          deletedBy: null,
          status: 'open',
        },
      }),
    );
    expect(screen.getByText('This file is locked')).toBeTruthy();
    expect(screen.queryByTestId('forward-list')).toBeNull();
    expect(screen.getByTestId('forward-send')).toHaveProperty('disabled', true);
  });

  it('WhatsApp offline (one number): danger banner naming it, no list', async () => {
    waState = 'disconnected';
    inboxes = [inbox({ status: { state: 'disconnected', me: null, qr: null, lastError: null } })];
    show();
    expect(await screen.findByText('WhatsApp is not connected')).toBeTruthy();
    expect(screen.getByText('Forward again when Kopi Apong is back online.')).toBeTruthy();
    expect(screen.queryByTestId('forward-list')).toBeNull();
    expect(screen.getByTestId('forward-send')).toHaveProperty('disabled', true);
  });

  it('a chosen chat on an offline number: banner naming that number, Forward disabled', async () => {
    inboxes = [
      inbox({}),
      inbox({
        id: 2,
        name: 'Catering',
        tone: 'warning',
        status: { state: 'qr', me: null, qr: null, lastError: null },
      }),
    ];
    chats = [chat('Priya'), chat('Event client', { inboxId: 2 })];
    const { user } = show();
    await pick(user, 'Event client');
    expect(screen.getByText('Forward again when Catering is back online.')).toBeTruthy();
    expect(screen.getByTestId('forward-send')).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Remove Event client' }));
    await pick(user, 'Priya');
    expect(screen.queryByText('WhatsApp is not connected')).toBeNull();
    expect(screen.getByTestId('forward-send')).toHaveProperty('disabled', false);
  });
});

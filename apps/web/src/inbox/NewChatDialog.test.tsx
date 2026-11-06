import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { Inbox, MessageTemplate, NewChatStatus } from '@ezychat/shared';
import { NewChatButton } from './NewChatDialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
const template: MessageTemplate = {
  name: 'order_update',
  language: 'en',
  category: 'utility',
  body: 'Hi {{1}}, your order {{2}} is ready.',
  variables: 2,
  examples: ['Aisyah', '#1024'],
  header: null,
  buttons: false,
  sendable: true,
};

let status: NewChatStatus;
let inboxes: Inbox[];
let answers: Record<string, () => Response>;
const calls: Array<{ url: string; body: unknown }> = [];

function Chat() {
  return <p>chat {useParams().jid}</p>;
}

function show() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (answers[url]) return answers[url]!();
    if (url === '/api/new-chat') return json(status);
    if (url === '/api/inboxes') return json({ inboxes, maxInboxes: 3, canAdd: false });
    if (url === '/api/inboxes/3/templates') return json({ templates: [template] });
    return fail('not_found', 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<NewChatButton />} />
          <Route path="/chats/:jid" element={<Chat />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New chat' }));
  return screen.findByRole('dialog', { name: 'New chat' });
}

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  status = {
    allowed: true,
    staffEnabled: false,
    dailyLimit: 20,
    perUserPerHour: 5,
    inboxes: [{ inboxId: 1, mode: 'check', usedToday: 3, countryCode: '60' }],
  };
  inboxes = [inbox({})];
  answers = {};
  calls.length = 0;
  vi.mocked(toast.success).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('New chat button', () => {
  it('is hidden for someone who may not start chats', async () => {
    status = { ...status, allowed: false, inboxes: [] };
    show();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/new-chat')).toBe(true));
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
  });
});

describe('linked phone', () => {
  it('shows the ban warning and today’s count, checks the number and opens the new chat', async () => {
    const user = show();
    const dialog = await open(user);
    expect(within(dialog).queryByLabelText('Send from')).toBeNull();
    expect(within(dialog).getByText('Only message people who expect it')).toBeTruthy();
    expect(within(dialog).getByTestId('new-chat-usage').textContent).toBe(
      '3 of 20 new chats used today on Kopi Apong.',
    );

    // A bad number shows the format error and sends nothing.
    await user.type(within(dialog).getByLabelText('Phone number'), '12345');
    await user.click(within(dialog).getByRole('button', { name: 'Start chat' }));
    expect(
      within(dialog).getByText('Enter a phone number, for example 012-345 6789 or +65 9123 4567.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/new-chat/check'))).toBe(false);

    answers['/api/inboxes/1/new-chat/check'] = () => json({ next: 'check', phone: '60128887777' });
    answers['/api/inboxes/1/new-chat'] = () =>
      json({ chatJid: '60128887777@s.whatsapp.net', created: true }, 201);
    const phone = within(dialog).getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '012-888 7777');
    expect(within(dialog).getByText('You will message +60128887777.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Name (optional)'), 'Farah Ismail');
    await user.click(within(dialog).getByRole('button', { name: 'Start chat' }));
    expect(await screen.findByText('chat 60128887777@s.whatsapp.net')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Chat started. Write your first message.');
    const startCall = calls.find((c) => c.url === '/api/inboxes/1/new-chat')!;
    expect(startCall.body).toMatchObject({ phone: '012-888 7777', name: 'Farah Ismail' });
    expect((startCall.body as { clientRequestId: string }).clientRequestId).toMatch(
      /[0-9a-f-]{36}/,
    );
  });

  it('offers Open chat for a number that already has one', async () => {
    answers['/api/inboxes/1/new-chat/check'] = () =>
      json({ next: 'existing', phone: '60125550142', chatJid: '60125550142@s.whatsapp.net' });
    const user = show();
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText('Phone number'), '012-555 0142');
    await user.click(within(dialog).getByRole('button', { name: 'Start chat' }));
    expect(await within(dialog).findByText('Already in your inbox')).toBeTruthy();
    expect(within(dialog).getByText('+60125550142 already has a chat.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Open chat' }));
    expect(await screen.findByText('chat 60125550142@s.whatsapp.net')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ['not_on_whatsapp', 404, '+60123456780 is not on WhatsApp'],
    ['new_chat_hourly_limit', 429, 'Too many new chats'],
    ['own_number', 400, 'This is your own number'],
  ])('explains %s from Start', async (code, httpStatus, title) => {
    answers['/api/inboxes/1/new-chat/check'] = () => json({ next: 'check', phone: '60123456780' });
    answers['/api/inboxes/1/new-chat'] = () => fail(code, httpStatus);
    const user = show();
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText('Phone number'), '012-345 6780');
    await user.click(within(dialog).getByRole('button', { name: 'Start chat' }));
    expect(await within(dialog).findByText(title)).toBeTruthy();
  });

  it('explains a refused check and a server error in plain words', async () => {
    answers['/api/inboxes/1/new-chat/check'] = () =>
      json({ error: { code: 'internal', message: 'Something broke' } }, 500);
    const user = show();
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText('Phone number'), '012-345 6789');
    await user.click(within(dialog).getByRole('button', { name: 'Start chat' }));
    expect(await within(dialog).findByText('Something went wrong')).toBeTruthy();
    expect(within(dialog).getByText('Something broke')).toBeTruthy();
  });

  it('blocks Start when the daily limit is reached or WhatsApp is offline, and shows no limit at 0', async () => {
    status.inboxes[0]!.usedToday = 20;
    let user = show();
    let dialog = await open(user);
    expect(within(dialog).getByText('Daily limit reached')).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Start chat' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    inboxes = [inbox({ status: { state: 'disconnected', me: null, qr: null, lastError: null } })];
    user = show();
    dialog = await open(user);
    expect(within(dialog).getByText('WhatsApp is not connected')).toBeTruthy();
    cleanup();

    inboxes = [inbox({})];
    status = { ...status, dailyLimit: 0, inboxes: [{ ...status.inboxes[0]!, usedToday: 25 }] };
    user = show();
    dialog = await open(user);
    expect(within(dialog).getByTestId('new-chat-usage').textContent).toBe(
      '25 new chats started today on Kopi Apong (no daily limit).',
    );
  });
});

describe('Business API', () => {
  beforeEach(() => {
    inboxes = [
      inbox({}),
      inbox({
        id: 3,
        name: 'Online orders',
        number: '60327855000',
        tone: 'info',
        type: 'wa-cloud',
        capabilities: {
          qrLink: false,
          history: false,
          groups: false,
          replyWindowHours: 24,
          templates: true,
          needsPublicUrl: true,
        },
      }),
    ];
    status.inboxes.push({ inboxId: 3, mode: 'template', usedToday: 0, countryCode: '60' });
  });

  it('chooses the inbox, fills a template and opens the chat once it is sent; a refusal creates nothing', async () => {
    answers['/api/inboxes/3/new-chat/check'] = () =>
      json({ next: 'template', phone: '60128885001' });
    const user = show();
    const dialog = await open(user);
    await user.click(within(dialog).getByLabelText('Send from'));
    await user.click(await screen.findByRole('option', { name: /Online orders/ }));
    expect(within(dialog).getByText('Starts with an approved template')).toBeTruthy();
    expect(within(dialog).queryByTestId('new-chat-usage')).toBeNull();
    await user.type(within(dialog).getByLabelText('Phone number'), '012-888 5001');
    await user.type(within(dialog).getByLabelText('Name (optional)'), 'Ravi Kumar');
    await user.click(within(dialog).getByRole('button', { name: 'Choose a template' }));

    const step = await screen.findByRole('dialog', { name: 'Choose a template' });
    expect(within(step).getByText(/Each template starts a paid conversation/)).toBeTruthy();
    await user.click(await within(step).findByRole('button', { name: /order_update/ }));
    expect((within(step).getByLabelText('Variable 1') as HTMLInputElement).value).toBe('Ravi');
    await user.type(within(step).getByLabelText('Variable 2'), '#1042');
    expect(within(step).getByTestId('template-preview').textContent).toBe(
      'Hi Ravi, your order #1042 is ready.',
    );

    answers['/api/inboxes/3/new-chat'] = () => fail('template_failed', 502);
    await user.click(within(step).getByRole('button', { name: 'Send template' }));
    expect(await within(step).findByText('The template was not sent')).toBeTruthy();
    const starts = () => calls.filter((c) => c.url === '/api/inboxes/3/new-chat');
    const firstId = (starts().at(-1)!.body as { clientRequestId: string }).clientRequestId;

    answers['/api/inboxes/3/new-chat'] = () =>
      json({ chatJid: '60128885001@s.whatsapp.net#3', created: true }, 201);
    await user.click(within(step).getByRole('button', { name: 'Send template' }));
    expect(await screen.findByText('chat 60128885001@s.whatsapp.net#3')).toBeTruthy();
    const sent = starts().at(-1)!.body as {
      clientRequestId: string;
      template: { name: string; params: string[] };
    };
    expect(sent.template).toEqual({
      name: 'order_update',
      language: 'en',
      params: ['Ravi', '#1042'],
    });
    expect(sent.clientRequestId).not.toBe(firstId);
    expect(toast.success).toHaveBeenCalledWith(
      'Template sent. You can write freely once they reply.',
    );
  });

  it('asks for every variable and goes back to the number', async () => {
    answers['/api/inboxes/3/new-chat/check'] = () =>
      json({ next: 'template', phone: '60128885001' });
    const user = show();
    const dialog = await open(user);
    await user.click(within(dialog).getByLabelText('Send from'));
    await user.click(await screen.findByRole('option', { name: /Online orders/ }));
    await user.type(within(dialog).getByLabelText('Phone number'), '012-888 5001');
    await user.click(within(dialog).getByRole('button', { name: 'Choose a template' }));
    const step = await screen.findByRole('dialog', { name: 'Choose a template' });
    await user.click(await within(step).findByRole('button', { name: /order_update/ }));
    await user.click(within(step).getByRole('button', { name: 'Send template' }));
    expect(within(step).getAllByText('Fill this in.').length).toBeGreaterThan(0);
    expect(calls.some((c) => c.url === '/api/inboxes/3/new-chat')).toBe(false);
    await user.click(within(step).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'New chat' })).toBeTruthy();
  });
});

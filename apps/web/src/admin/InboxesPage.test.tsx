import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import {
  DEFAULT_INBOX_CAPABILITIES,
  type AiAgentSummary,
  type Inbox,
  type InboxListResponse,
  type User,
  type WaStatus,
} from '@ezychat/shared';
import { qk } from '../api/queries';
import { InboxesPage } from './InboxesPage';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const member = (id: number, displayName: string, extra: Partial<User> = {}): User => ({
  id,
  username: displayName.toLowerCase().replace(/\s/g, ''),
  displayName,
  role: 'agent',
  mustChangePassword: false,
  disabled: false,
  createdAt: 1_700_000_000_000,
  locale: null,
  ...extra,
});

const USERS: User[] = [
  member(1, 'Alice Admin', { role: 'admin' }),
  member(2, 'Bob Agent'),
  member(3, 'Carol Agent'),
  member(4, 'Business AI', { kind: 'ai' }),
  member(5, 'Dan Gone', { disabled: true }),
];

const open: WaStatus = {
  state: 'open',
  qr: null,
  me: { jid: '60111@s.whatsapp.net', name: 'Sales' },
  lastError: null,
};
const status = (state: WaStatus['state'], qr: string | null = null): WaStatus => ({
  state,
  qr,
  me: null,
  lastError: null,
});

const SALES: Inbox = {
  id: 1,
  name: 'Sales',
  tone: 'primary',
  number: '60111',
  status: open,
  removed: false,
  aiAgentId: null,
  type: 'linked_phone',
  capabilities: DEFAULT_INBOX_CAPABILITIES,
  memberIds: [2],
};
const CATERING: Inbox = {
  id: 2,
  name: 'Catering',
  tone: 'warning',
  number: null,
  status: status('qr', 'QR-CATERING'),
  removed: false,
  aiAgentId: null,
  type: 'linked_phone',
  capabilities: DEFAULT_INBOX_CAPABILITIES,
  memberIds: [2],
};

const SALES_AI: AiAgentSummary = {
  id: 1,
  userId: 4,
  displayName: 'Business AI',
  enabled: true,
  preset: 'sales',
  inboxId: 1,
  documentCount: 0,
  answerDirect: true,
  groupCount: 0,
};
const FAQ_AI: AiAgentSummary = {
  ...SALES_AI,
  id: 2,
  userId: 6,
  displayName: 'Clinic FAQ',
  preset: 'faq',
  inboxId: null,
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Setup {
  agents?: AiAgentSummary[];
  list?: InboxListResponse;
  wa?: WaStatus;
  respond?: (url: string, init: RequestInit | undefined) => Response | undefined;
}

function setup({ list, wa = open, respond, agents = [] }: Setup = {}) {
  let inboxList: InboxListResponse = list ?? {
    inboxes: [SALES, CATERING, { ...CATERING, id: 3, name: 'Old', removed: true }],
    maxInboxes: 3,
    canAdd: true,
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = respond?.(url, init);
    if (custom) return custom;
    const method = init?.method ?? 'GET';
    if (url === '/api/inboxes' && method === 'GET') return json(inboxList);
    if (url === '/api/users') return json({ users: USERS });
    if (url === '/api/wa/status') return json(wa);
    if (url === '/api/ai/agents') return json({ agents, maxAgents: 3 });
    if (url === '/api/audit') return json({ entries: [] });
    return json({ error: { code: 'not_found', message: 'nope' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <InboxesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const calls = (method: string, url: string) =>
    fetchMock.mock.calls
      .filter(([u, i]) => u === url && (i?.method ?? 'GET') === method)
      .map(([, i]) => (i?.body ? (JSON.parse(String(i.body)) as unknown) : undefined));
  const setList = (next: InboxListResponse) => {
    inboxList = next;
  };
  return { fetchMock, qc, calls, setList, user: userEvent.setup() };
}

beforeAll(() => {
  // The phone-sized drawer (vaul) captures the pointer; jsdom lacks it.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  // Radix Select scrolls the chosen option into view.
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  // Radix checkboxes measure themselves; jsdom has no ResizeObserver.
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
  vi.useRealTimers();
});

describe('InboxesPage', () => {
  it('shows one card per active inbox with its status and who can open it', async () => {
    setup();
    const cards = await screen.findAllByTestId('inbox-card');
    expect(cards).toHaveLength(2);
    const [sales, catering] = cards as [HTMLElement, HTMLElement];
    expect(within(sales).getByText('+60111')).toBeTruthy();
    expect(within(sales).getByText('WhatsApp app (linked phone)')).toBeTruthy();
    expect(await within(sales).findByText('Connected')).toBeTruthy();
    // Admins always; agents by membership; never the AI member or a disabled member.
    expect(within(sales).getByText('Alice Admin · admin')).toBeTruthy();
    expect(within(sales).getByText('Bob Agent')).toBeTruthy();
    expect(within(sales).queryByText('Carol Agent')).toBeNull();
    expect(within(sales).queryByText(/Business AI|Dan Gone/)).toBeNull();
    expect(within(catering).getByText('Shown after the scan')).toBeTruthy();
    expect(within(catering).getByText('Waiting for the QR scan')).toBeTruthy();
    expect(within(catering).getByText('Scan the QR code')).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();
  });

  it('does not offer Remove for inbox 1', async () => {
    setup();
    const [sales, catering] = (await screen.findAllByTestId('inbox-card')) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(within(sales).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(sales).getByRole('button', { name: 'Edit · Sales' })).toBeTruthy();
    expect(within(catering).getByRole('button', { name: 'Remove · Catering' })).toBeTruthy();
  });

  it('names an offline phone and a session opened elsewhere on the card', async () => {
    setup({
      list: {
        inboxes: [
          SALES,
          { ...CATERING, status: status('disconnected') },
          { ...CATERING, id: 3, name: 'Events', status: status('replaced') },
        ],
        maxInboxes: 3,
        canAdd: false,
      },
    });
    expect(await screen.findByText('The phone is offline')).toBeTruthy();
    expect(screen.getByText('Phone offline')).toBeTruthy();
    expect(screen.getByText('Opened elsewhere')).toBeTruthy();
    // The edition's limit is reached: no more inboxes.
    const add = screen.getByRole('button', { name: 'Add inbox' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByTestId('inbox-limit').textContent).toBe(
      'This edition allows 3 inboxes. Remove one to add another.',
    );
  });

  it('shows an error with a retry when the inboxes cannot be read', async () => {
    setup({
      respond: (url) =>
        url === '/api/inboxes'
          ? json({ error: { code: 'server', message: 'Boom' } }, 500)
          : undefined,
    });
    expect(await screen.findByText("Couldn't load")).toBeTruthy();
  });

  it('Add inbox posts name + memberIds then shows the QR from the status', async () => {
    const created: Inbox = { ...CATERING, id: 4, name: 'Events', tone: 'success', memberIds: [3] };
    const { calls, setList, qc, user } = setup({
      list: { inboxes: [SALES], maxInboxes: 3, canAdd: true },
      respond: (url, init) =>
        url === '/api/inboxes' && init?.method === 'POST'
          ? json({ ...created, status: status('connecting') }, 201)
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Add inbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an inbox' });
    // Admins are shown, never ticked; agents are tick boxes, the warning shows while none is ticked.
    expect(within(dialog).getByText('Alice Admin · admin')).toBeTruthy();
    expect(within(dialog).getByText('No agent ticked: only admins see this inbox.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('This is required.')).toBeTruthy();
    expect(calls('POST', '/api/inboxes')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Inbox name'), '  Events ');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Carol Agent' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Bob Agent' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Bob Agent' }));
    setList({
      inboxes: [SALES, { ...created, status: status('connecting') }],
      maxInboxes: 3,
      canAdd: true,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls('POST', '/api/inboxes')).toEqual([{ name: 'Events', memberIds: [3] }]),
    );
    expect(toast.success).toHaveBeenCalledWith('Inbox added. Now scan the QR code with the phone.');
    const next = await screen.findByRole('dialog', { name: 'Inbox “Events”' });
    expect(await within(next).findByTestId('inbox-qr-waiting')).toBeTruthy();
    expect(within(next).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(next).getByLabelText(/whatsapp number/i).id).toBe('wa-phone-4');
    // The pairing-code form is never nested in the inbox form (invalid HTML, a hydration error).
    expect(next.querySelector('form form')).toBeNull();
    expect(
      within(next)
        .getByLabelText(/whatsapp number/i)
        .closest('form')?.id,
    ).not.toBe('inbox-form');

    // The socket's `inbox:status` brings the QR code, then the linked number.
    act(() => {
      qc.setQueryData<InboxListResponse>(qk.inboxes, {
        inboxes: [SALES, { ...created, status: status('qr', 'QR-EVENTS') }],
        maxInboxes: 3,
        canAdd: true,
      });
    });
    expect(await within(next).findByLabelText('WhatsApp link QR code')).toBeTruthy();
    act(() => {
      qc.setQueryData<InboxListResponse>(qk.inboxes, {
        inboxes: [SALES, { ...created, number: '60199', status: open }],
        maxInboxes: 3,
        canAdd: true,
      });
    });
    expect(await within(next).findByText('Linked to +60199')).toBeTruthy();
    await user.click(within(next).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says the limit is reached when another admin added the last inbox first', async () => {
    const { user } = setup({
      list: { inboxes: [SALES], maxInboxes: 2, canAdd: true },
      respond: (url, init) =>
        url === '/api/inboxes' && init?.method === 'POST'
          ? json({ error: { code: 'inbox_limit', message: 'Inbox limit reached' } }, 409)
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Add inbox' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Inbox name'), 'Events');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('This edition allows 2 inboxes. Remove one to add another.'),
    ).toBeTruthy();
  });

  it('Edit inbox ticks the current members and saves the changed set', async () => {
    const { calls, user } = setup({
      respond: (url, init) =>
        url === '/api/inboxes/2' && init?.method === 'PATCH'
          ? json({ ...CATERING, memberIds: [3] })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Edit · Catering' }));
    const dialog = await screen.findByRole('dialog', { name: 'Inbox “Catering”' });
    const bob = within(dialog).getByRole('checkbox', { name: 'Bob Agent' });
    expect(bob.getAttribute('data-state')).toBe('checked');
    expect(
      within(dialog).getByRole('checkbox', { name: 'Carol Agent' }).getAttribute('data-state'),
    ).toBe('unchecked');
    // The phone still has to scan: the QR code shows in Edit too.
    expect(within(dialog).getByLabelText('WhatsApp link QR code')).toBeTruthy();
    await user.click(bob);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Carol Agent' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH', '/api/inboxes/2')).toEqual([{ memberIds: [3] }]));
    expect(toast.success).toHaveBeenCalledWith('Inbox saved');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renames an inbox, and closes without a request when nothing changed', async () => {
    const { calls, user } = setup({
      respond: (url, init) =>
        url === '/api/inboxes/1' && init?.method === 'PATCH'
          ? json({ ...SALES, name: 'Sales MY' })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Edit · Sales' }));
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls('PATCH', '/api/inboxes/1')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Edit · Sales' }));
    dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Inbox name');
    await user.clear(name);
    await user.type(name, 'Sales MY');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH', '/api/inboxes/1')).toEqual([{ name: 'Sales MY' }]));
  });

  it('keeps a disabled member when the inbox is renamed or its ticks change', async () => {
    const withGone: Inbox = { ...CATERING, memberIds: [2, 5] };
    const { calls, user } = setup({
      list: { inboxes: [SALES, withGone], maxInboxes: 3, canAdd: true },
      respond: (url, init) =>
        url === '/api/inboxes/2' && init?.method === 'PATCH' ? json(withGone) : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Edit · Catering' }));
    let dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Inbox name');
    await user.clear(name);
    await user.type(name, 'Catering MY');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    // Only the name changed: the disabled member Dan (id 5) is not taken away.
    await waitFor(() =>
      expect(calls('PATCH', '/api/inboxes/2')).toEqual([{ name: 'Catering MY' }]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Edit · Catering' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Carol Agent' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH', '/api/inboxes/2')).toHaveLength(2));
    expect(calls('PATCH', '/api/inboxes/2')[1]).toEqual({ memberIds: [2, 3, 5] });
  });

  it('does not save the members while the team list cannot be read', async () => {
    const { calls, user } = setup({
      respond: (url) =>
        url === '/api/users'
          ? json({ error: { code: 'server', message: 'Boom' } }, 500)
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Edit · Catering' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(calls('PATCH', '/api/inboxes/2')).toHaveLength(0);
  });

  it('links the phone of a connected inbox again and shows the QR code', async () => {
    const { calls, qc, user } = setup({
      wa: open,
      respond: (url, init) =>
        url === '/api/inboxes/1/wa/relink' && init?.method === 'POST'
          ? json({ ok: true })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Edit · Sales' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Linked to +60111')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Link the phone again' }));
    await waitFor(() => expect(calls('POST', '/api/inboxes/1/wa/relink')).toHaveLength(1));
    // Inbox 1 still answers `/wa/status` with `open` here; the dialog waits for the new code.
    expect(await within(dialog).findByTestId('inbox-qr')).toBeTruthy();
    act(() => qc.setQueryData(qk.wa, status('qr', 'QR-SALES')));
    expect(await within(dialog).findByLabelText('WhatsApp link QR code')).toBeTruthy();
    act(() => qc.setQueryData(qk.wa, open));
    expect(await within(dialog).findByText('Linked to +60111')).toBeTruthy();
    expect(within(dialog).queryByTestId('inbox-qr')).toBeNull();
  });

  it('shows the error of a failed relink and offers Take over when opened elsewhere', async () => {
    const { calls, user } = setup({
      list: {
        inboxes: [SALES, { ...CATERING, status: status('replaced') }],
        maxInboxes: 3,
        canAdd: true,
      },
      respond: (url) =>
        url.startsWith('/api/inboxes/2/wa/')
          ? json({ error: { code: 'wa_unavailable', message: 'x' } }, 503)
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Edit · Catering' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(calls('POST', '/api/inboxes/2/wa/takeover')).toHaveLength(1));
    expect(await within(dialog).findByText('WhatsApp is not connected.')).toBeTruthy();
    expect(within(dialog).queryByTestId('inbox-qr')).toBeNull();
  });

  it('asks for the status again while the phone links', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Edit · Catering' }));
    await screen.findByRole('dialog');
    const reads = () => fetchMock.mock.calls.filter(([u]) => u === '/api/inboxes').length;
    const before = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('shows the AI agent of each inbox on its card, linked to the agent page', async () => {
    setup({
      list: { inboxes: [{ ...SALES, aiAgentId: 1 }, CATERING], maxInboxes: 3, canAdd: true },
      agents: [SALES_AI, FAQ_AI],
    });
    const lines = await screen.findAllByTestId('inbox-agent');
    await waitFor(() =>
      expect(within(lines[0]!).getByRole('link').textContent).toBe('Business AI'),
    );
    expect(within(lines[0]!).getByRole('link').getAttribute('href')).toBe('/admin/members/ai/1');
    expect(lines[1]!.textContent).toBe('None');
  });

  it('moves an agent to another inbox from Edit and warns where it moves from', async () => {
    const { calls, qc, user } = setup({
      list: { inboxes: [{ ...SALES, aiAgentId: 1 }, CATERING], maxInboxes: 3, canAdd: true },
      agents: [SALES_AI, FAQ_AI],
      respond: (url, init) =>
        url === '/api/inboxes/2' && init?.method === 'PATCH'
          ? json({ ...CATERING, aiAgentId: 1 })
          : undefined,
    });
    await screen.findAllByText('Business AI');
    await user.click(screen.getByRole('button', { name: 'Edit · Catering' }));
    const dialog = await screen.findByRole('dialog', { name: 'Inbox “Catering”' });
    await user.click(within(dialog).getByRole('combobox', { name: 'AI agent' }));
    expect(await screen.findByRole('option', { name: 'Clinic FAQ' })).toBeTruthy();
    await user.click(screen.getByRole('option', { name: 'Business AI (on Sales)' }));
    expect(
      within(dialog).getByText(
        'Business AI answers Sales now. When you save, Business AI moves to this inbox and stops answering Sales.',
      ),
    ).toBeTruthy();
    const refresh = vi.spyOn(qc, 'invalidateQueries');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH', '/api/inboxes/2')).toEqual([{ aiAgentId: 1 }]));
    // The list, every open agent page and the inbox-1 view show the agent's new inbox.
    await waitFor(() => {
      for (const queryKey of [['ai-agents'], ['ai-agent'], ['ai-member']])
        expect(refresh).toHaveBeenCalledWith({ queryKey });
    });
  });

  it('unassigns the agent of an inbox with None', async () => {
    const { calls, user } = setup({
      list: { inboxes: [{ ...SALES, aiAgentId: 1 }, CATERING], maxInboxes: 3, canAdd: true },
      agents: [SALES_AI, FAQ_AI],
      respond: (url, init) =>
        url === '/api/inboxes/1' && init?.method === 'PATCH'
          ? json({ ...SALES, aiAgentId: null })
          : undefined,
    });
    await screen.findAllByText('Business AI');
    await user.click(screen.getByRole('button', { name: 'Edit · Sales' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByRole('combobox', { name: 'AI agent' });
    expect(select.textContent).toBe('Business AI');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'None' }));
    expect(
      within(dialog).getByText(
        'Business AI answers this inbox now. When you save, Business AI is unassigned.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH', '/api/inboxes/1')).toEqual([{ aiAgentId: null }]));
  });

  it('sends the chosen AI agent with a new inbox', async () => {
    const created: Inbox = { ...CATERING, id: 4, name: 'Events', memberIds: [], aiAgentId: 2 };
    const { calls, user } = setup({
      list: { inboxes: [{ ...SALES, aiAgentId: 1 }], maxInboxes: 3, canAdd: true },
      agents: [SALES_AI, FAQ_AI],
      respond: (url, init) =>
        url === '/api/inboxes' && init?.method === 'POST' ? json(created, 201) : undefined,
    });
    await screen.findAllByText('Business AI');
    await user.click(screen.getByRole('button', { name: 'Add inbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an inbox' });
    await user.type(within(dialog).getByLabelText('Inbox name'), 'Events');
    await user.click(within(dialog).getByRole('combobox', { name: 'AI agent' }));
    await user.click(await screen.findByRole('option', { name: 'Clinic FAQ' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls('POST', '/api/inboxes')).toEqual([
        { name: 'Events', memberIds: [], aiAgentId: 2 },
      ]),
    );
  });

  it('says the agent is unassigned when its inbox is removed', async () => {
    const { user } = setup({
      list: {
        inboxes: [SALES, { ...CATERING, aiAgentId: 2 }],
        maxInboxes: 3,
        canAdd: true,
      },
      agents: [SALES_AI, { ...FAQ_AI, inboxId: 2 }],
    });
    await screen.findAllByText('Clinic FAQ');
    await user.click(screen.getByRole('button', { name: 'Remove · Catering' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText('Its AI agent Clinic FAQ is unassigned and stops answering.'),
    ).toBeTruthy();
  });

  it('removes an inbox after the confirmation', async () => {
    const { calls, qc, user } = setup({
      respond: (url, init) =>
        url === '/api/inboxes/2' && init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : undefined,
    });
    await user.click(await screen.findByRole('button', { name: 'Remove · Catering' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Remove “Catering”?')).toBeTruthy();
    const refresh = vi.spyOn(qc, 'invalidateQueries');
    await user.click(within(confirm).getByRole('button', { name: 'Remove inbox' }));
    await waitFor(() => expect(calls('DELETE', '/api/inboxes/2')).toHaveLength(1));
    expect(toast.success).toHaveBeenCalledWith('Inbox removed');
    // Its agent no longer answers an inbox: every agent view reloads.
    for (const queryKey of [['ai-agents'], ['ai-agent'], ['ai-member']])
      expect(refresh).toHaveBeenCalledWith({ queryKey });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});

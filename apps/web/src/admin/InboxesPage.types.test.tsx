import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';
import { Cloud } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_INBOX_CAPABILITIES,
  type AiAgentSummary,
  type Inbox,
  type InboxCapabilities,
  type InboxListResponse,
  type User,
  type WaStatus,
} from '@ezychat/shared';
import {
  registerExtensionCatalogs,
  WebExtensionsProvider,
  type WebExtension,
  type WebExtensionInboxType,
} from '../extensions';
import { InboxesPage } from './InboxesPage';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const USERS: User[] = [
  {
    id: 1,
    username: 'alice',
    displayName: 'Alice Admin',
    role: 'admin',
    mustChangePassword: false,
    disabled: false,
    createdAt: 1_700_000_000_000,
    locale: null,
  },
  {
    id: 2,
    username: 'bob',
    displayName: 'Bob Agent',
    role: 'agent',
    mustChangePassword: false,
    disabled: false,
    createdAt: 1_700_000_000_000,
    locale: null,
  },
];

const open: WaStatus = { state: 'open', qr: null, me: null, lastError: null };
const API_CAPS: InboxCapabilities = {
  qrLink: false,
  history: false,
  groups: false,
  replyWindowHours: 24,
  templates: true,
  needsPublicUrl: true,
};

const PHONE: Inbox = {
  id: 1,
  name: 'Sales',
  tone: 'primary',
  number: '60111',
  status: open,
  removed: false,
  aiAgentId: null,
  memberIds: [2],
  type: 'linked_phone',
  capabilities: DEFAULT_INBOX_CAPABILITIES,
};
const CLOUD: Inbox = {
  id: 2,
  name: 'Support',
  tone: 'warning',
  number: null,
  status: open,
  removed: false,
  aiAgentId: 1,
  memberIds: [],
  type: 'wa-cloud',
  capabilities: API_CAPS,
};
const AGENT: AiAgentSummary = {
  id: 1,
  userId: 9,
  displayName: 'Support AI',
  enabled: true,
  preset: 'faq',
  inboxId: 2,
  documentCount: 0,
  answerDirect: true,
  groupCount: 0,
};

/** What the fake extension components received, so tests can drive their callbacks. */
const seen: {
  create?: ComponentProps<WebExtensionInboxType['CreateForm']>;
  switchFrom?: { onChanged: () => void; onCancel: () => void };
  edit?: { onChanged: () => void };
} = {};

const cloudType: WebExtensionInboxType = {
  type: 'wa-cloud',
  labelKey: 'ext.cloudtest.label',
  descriptionKey: 'ext.cloudtest.description',
  icon: Cloud,
  CreateForm: (props) => {
    seen.create = props;
    return <p data-testid="cloud-create">create form for {props.draft.name || '(no name)'}</p>;
  },
  CardDetails: ({ inbox }) => <p data-testid="cloud-details">details of {inbox.name}</p>,
  EditSection: ({ inbox, onChanged }) => {
    seen.edit = { onChanged };
    return <p data-testid="cloud-edit">edit {inbox.name}</p>;
  },
  SwitchFromPhone: ({ inbox, onChanged, onCancel }) => {
    seen.switchFrom = { onChanged, onCancel };
    return <p data-testid="cloud-switch">move {inbox.name}</p>;
  },
};

const extension: WebExtension = {
  name: 'cloudtest',
  inboxTypes: [cloudType],
  catalogs: {
    en: {
      'ext.cloudtest.label': 'Business API',
      'ext.cloudtest.description': 'Meta Cloud API with your own app.',
    },
  },
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup({
  extensions = [extension],
  inboxes = [PHONE, CLOUD],
}: { extensions?: WebExtension[]; inboxes?: Inbox[] } = {}) {
  let list: InboxListResponse = { inboxes, maxInboxes: 3, canAdd: true };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/inboxes' && method === 'GET') return json(list);
    if (url === '/api/users') return json({ users: USERS });
    if (url === '/api/wa/status') return json(open);
    if (url === '/api/ai/agents') return json({ agents: [AGENT], maxAgents: 3 });
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
        <WebExtensionsProvider extensions={extensions}>
          <InboxesPage />
        </WebExtensionsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const inboxReads = () =>
    fetchMock.mock.calls.filter(([u, i]) => u === '/api/inboxes' && (i?.method ?? 'GET') === 'GET')
      .length;
  const posts = () => fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST').length;
  return {
    user: userEvent.setup(),
    inboxReads,
    posts,
    setList: (next: Inbox[]) => {
      list = { ...list, inboxes: next };
    },
  };
}

beforeAll(async () => {
  await registerExtensionCatalogs([extension]);
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  delete seen.create;
  delete seen.switchFrom;
  delete seen.edit;
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
});

async function cards() {
  return (await screen.findAllByTestId('inbox-card')) as [HTMLElement, HTMLElement];
}

describe('InboxesPage with extension inbox types', () => {
  it('describes the page by the connection types this build offers', async () => {
    setup();
    expect(await screen.findByText(/connect the number another way/)).toBeTruthy();
    cleanup();
    setup({ extensions: [], inboxes: [PHONE] });
    expect(await screen.findByText(/by a QR scan, as you do today/)).toBeTruthy();
    expect(screen.queryByText(/connect the number another way/)).toBeNull();
  });

  it('Lite: Add inbox has no type choice and goes straight to Save', async () => {
    const { user } = setup({ extensions: [], inboxes: [PHONE] });
    await user.click(await screen.findByRole('button', { name: 'Add inbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an inbox' });
    expect(within(dialog).queryByTestId('inbox-type-choice')).toBeNull();
    expect(within(dialog).queryByText('How is this number connected?')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('names each card by its type and shows the type rows, without QR texts for an API inbox', async () => {
    setup();
    const [phone, cloud] = await cards();
    expect(within(phone).getByTestId('inbox-type').textContent).toBe('WhatsApp app (linked phone)');
    expect(within(phone).queryByTestId('cloud-details')).toBeNull();
    expect(within(cloud).getByTestId('inbox-type').textContent).toBe('Business API');
    expect(within(cloud).getByTestId('cloud-details').textContent).toBe('details of Support');
    // No number yet and no QR link: never "Shown after the scan".
    expect(within(cloud).queryByText('Shown after the scan')).toBeNull();
    // Its AI agent replies only inside the window.
    expect(within(cloud).getByTestId('inbox-ai-window').textContent).toBe(
      "On this number the AI agent replies only within 24 hours of the customer's last message; after that it hands the chat to the team.",
    );
    expect(within(phone).queryByTestId('inbox-ai-window')).toBeNull();
  });

  it('falls back to a generic type name when no extension knows the type', async () => {
    setup({ extensions: [] });
    const [, cloud] = await cards();
    expect(within(cloud).getByTestId('inbox-type').textContent).toBe('Other connection');
  });

  it('uses the generic remove text for an inbox without a QR link', async () => {
    const { user } = setup();
    const [, cloud] = await cards();
    await user.click(within(cloud).getByRole('button', { name: 'Remove · Support' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText(
        'EzyChat stops receiving and sending for this number. Its chats stay, read only, for admins.',
        { exact: false },
      ),
    ).toBeTruthy();
    expect(within(confirm).queryByText(/unlinks this phone/)).toBeNull();
  });

  it('Add inbox: linked phone is the default; another type replaces Save with its form', async () => {
    const { user, inboxReads, posts, setList } = setup();
    await user.click(await screen.findByRole('button', { name: 'Add inbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an inbox' });
    const choice = within(dialog).getByTestId('inbox-type-choice');
    const phoneCard = within(choice).getByRole('button', { name: /WhatsApp app \(linked phone\)/ });
    const cloudCard = within(choice).getByRole('button', { name: /Business API/ });
    expect(phoneCard.getAttribute('aria-pressed')).toBe('true');
    expect(cloudCard.getAttribute('aria-pressed')).toBe('false');
    expect(within(dialog).getByText('Meta Cloud API with your own app.')).toBeTruthy();
    expect(within(dialog).queryByTestId('cloud-create')).toBeNull();

    await user.click(cloudCard);
    expect(cloudCard.getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    const section = within(dialog).getByTestId('inbox-type-create');
    expect(within(section).getByRole('heading', { name: 'Business API' })).toBeTruthy();
    expect(within(section).getByTestId('cloud-create').textContent).toBe(
      'create form for (no name)',
    );

    // validate() checks the core fields first and shows their errors.
    let valid = true;
    act(() => {
      valid = seen.create!.validate();
    });
    expect(valid).toBe(false);
    expect(within(dialog).getByText('This is required.')).toBeTruthy();

    await user.type(within(dialog).getByLabelText('Inbox name'), ' Events ');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Bob Agent' }));
    expect(seen.create!.draft).toEqual({ name: 'Events', memberIds: [2], aiAgentId: null });
    act(() => {
      valid = seen.create!.validate();
    });
    expect(valid).toBe(true);

    // The type's own route created it: the page refreshes the inbox list.
    const created: Inbox = { ...CLOUD, id: 3, name: 'Events', aiAgentId: null, memberIds: [2] };
    setList([PHONE, CLOUD, created]);
    const before = inboxReads();
    act(() => seen.create!.onCreated(created));
    await waitFor(() => expect(inboxReads()).toBeGreaterThan(before));
    expect(toast.success).toHaveBeenCalledWith('Inbox added. The number is connected.');
    expect(await screen.findByRole('dialog', { name: 'Inbox “Events”' })).toBeTruthy();
    expect(screen.getAllByTestId('cloud-details').map((n) => n.textContent)).toContain(
      'details of Events',
    );
    expect(screen.queryByTestId('cloud-create')).toBeNull();
    expect(screen.queryByTestId('inbox-qr')).toBeNull();
    // The core never posted an inbox itself.
    expect(posts()).toBe(0);
  });

  it('Edit of a linked phone offers each type under Connection type', async () => {
    const { user, inboxReads } = setup();
    const [phone] = await cards();
    await user.click(within(phone).getByRole('button', { name: 'Edit · Sales' }));
    const dialog = await screen.findByRole('dialog', { name: 'Inbox “Sales”' });
    const section = within(dialog).getByTestId('inbox-connection-type');
    expect(within(section).getByRole('heading', { name: 'Connection type' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Link the phone again' })).toBeTruthy();
    expect(within(dialog).queryByTestId('cloud-edit')).toBeNull();

    await user.click(within(section).getByRole('button', { name: 'Move to Business API' }));
    expect(within(section).getByTestId('cloud-switch').textContent).toBe('move Sales');
    act(() => seen.switchFrom!.onCancel());
    expect(within(section).queryByTestId('cloud-switch')).toBeNull();

    await user.click(within(section).getByRole('button', { name: 'Move to Business API' }));
    const before = inboxReads();
    act(() => seen.switchFrom!.onChanged());
    await waitFor(() => expect(inboxReads()).toBeGreaterThan(before));
    expect(within(section).queryByTestId('cloud-switch')).toBeNull();
  });

  it('Edit of an API inbox shows its section and no QR or relink', async () => {
    const { user, inboxReads } = setup();
    const [, cloud] = await cards();
    await user.click(within(cloud).getByRole('button', { name: 'Edit · Support' }));
    const dialog = await screen.findByRole('dialog', { name: 'Inbox “Support”' });
    expect(within(dialog).getByTestId('cloud-edit').textContent).toBe('edit Support');
    expect(within(dialog).queryByRole('button', { name: 'Link the phone again' })).toBeNull();
    expect(within(dialog).queryByTestId('inbox-qr')).toBeNull();
    expect(within(dialog).queryByTestId('inbox-connection-type')).toBeNull();
    expect(
      within(dialog).getByText(
        'Give the inbox a name, choose who can open it, then connect the number below.',
      ),
    ).toBeTruthy();
    const before = inboxReads();
    act(() => seen.edit!.onChanged());
    await waitFor(() => expect(inboxReads()).toBeGreaterThan(before));
  });

  it('keeps the page when an extension component crashes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: WebExtension = {
      ...extension,
      inboxTypes: [
        {
          ...cloudType,
          CardDetails: () => {
            throw new Error('boom');
          },
        },
      ],
    };
    setup({ extensions: [broken] });
    const [phone, cloud] = await cards();
    expect(within(phone).getByText('Sales')).toBeTruthy();
    expect(within(cloud).getByTestId('inbox-type').textContent).toBe('Business API');
    expect(within(cloud).queryByTestId('cloud-details')).toBeNull();
  });
});

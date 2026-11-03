import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AiAgentStatus, AiDocument } from '@ezychat/shared';
import { useAiAgent } from '../api/ai';
import { AiContextPanel } from './AiContextPanel';

const AGENT = 5;
const DAY = 24 * 60 * 60 * 1000;
function documents(): AiDocument[] {
  const now = Date.now();
  return [
    {
      id: 1,
      name: 'menu.pdf',
      kind: 'file',
      size: 2 * 1024 * 1024,
      characters: 30_000,
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY,
      internal: false,
    },
    {
      id: 2,
      name: 'Price list',
      kind: 'text',
      size: 900,
      characters: 900,
      createdAt: now - DAY / 2,
      updatedAt: now - DAY / 2,
      internal: false,
    },
  ];
}
function status(docs = documents()): AiAgentStatus {
  return {
    agent: {
      id: AGENT,
      userId: 3,
      displayName: 'Sales Assistant',
      enabled: false,
      preset: 'sales',
      inboxId: 1,
      documentCount: docs.length,
      answerDirect: true,
      groupCount: 0,
    },
    settings: {
      displayName: 'Sales Assistant',
      enabled: false,
      mode: 'api',
      model: '',
      instructions: '',
    },
    documents: docs,
  };
}
function json(data: unknown, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
}
const TEXTS: Record<number, string> = { 1: 'Nasi lemak RM8', 2: 'Cake RM50' };
const BASE = `/api/ai/agents/${AGENT}`;

function Harness() {
  const query = useAiAgent(AGENT);
  return query.data ? <AiContextPanel agentId={AGENT} documents={query.data.documents} /> : null;
}
type Override = (
  url: string,
  init: RequestInit | undefined,
  drop: (id: number) => void,
) => Response | undefined;
function setup(initial = status(), override?: Override) {
  let current = initial;
  const drop = (id: number) => {
    current = { ...current, documents: current.documents.filter((d) => d.id !== id) };
  };
  const add = (doc: Partial<AiDocument> & Pick<AiDocument, 'id' | 'name' | 'kind'>) => {
    current = {
      ...current,
      documents: [
        ...current.documents,
        {
          size: 10,
          characters: 10,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          internal: false,
          ...doc,
        },
      ],
    };
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = override?.(url, init, drop);
    if (custom) return custom;
    const method = init?.method ?? 'GET';
    const id = Number(new RegExp(`^${BASE}/documents/(\\d+)$`).exec(url)?.[1]);
    if (url === BASE && method === 'GET') return json(current);
    if (url === `${BASE}/documents/text` && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as {
        name: string;
        text: string;
        internal?: boolean;
      };
      add({ id: 9, name: body.name, kind: 'text', internal: body.internal ?? false });
      return json(current);
    }
    if (url === `${BASE}/documents` && method === 'POST') {
      const form = init!.body as FormData;
      const file = form.get('file') as File;
      add({ id: 10, name: file.name, kind: 'file', internal: form.get('internal') === 'true' });
      return json(current);
    }
    if (id && method === 'GET') {
      const doc = current.documents.find((d) => d.id === id)!;
      return json({ ...doc, text: TEXTS[id] ?? '', truncated: doc.kind === 'file' });
    }
    if (id && method === 'PATCH') {
      const body = JSON.parse(String(init!.body)) as Partial<AiDocument>;
      current = {
        ...current,
        documents: current.documents.map((d) => (d.id === id ? { ...d, ...body } : d)),
      };
      return json(current);
    }
    if (id && method === 'DELETE') {
      drop(id);
      return json(current);
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  return { fetchMock };
}
const writes = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter((call) => call[1]?.method && call[1].method !== 'GET')
    .map((call) => `${call[1]!.method} ${call[0]}`);
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, method: string) =>
  JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === method)![1]!.body));
const table = async () => within(await screen.findByRole('table'));
const mobileList = () => within(screen.getByRole('list', { name: 'Business context' }));
const internal = (): AiDocument[] => [
  ...documents(),
  {
    id: 3,
    name: 'Lowest prices',
    kind: 'text',
    size: 40,
    characters: 40,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    internal: true,
  },
];

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
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
  vi.restoreAllMocks();
});

describe('Business context panel', () => {
  it('lists items with name, size and added date, with the limits', async () => {
    setup();
    const rows = await table();
    expect(rows.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(
      expect.arrayContaining(['Name', 'Size', 'Details']),
    );
    expect(rows.getByText('menu.pdf').getAttribute('title')).toBe('menu.pdf');
    expect(rows.getByText('2.0 MB')).toBeTruthy();
    expect(rows.getByText('Added 2 days ago')).toBeTruthy();
    expect(rows.getByText('900 B')).toBeTruthy();
    expect(rows.getByText('Added 12 hours ago')).toBeTruthy();
    expect(rows.getByLabelText('File')).toBeTruthy();
    expect(rows.getByLabelText('Text content')).toBeTruthy();
    expect(screen.getByText('Up to 20 items, 10 MB per file')).toBeTruthy();
    expect(screen.getByText(/Mark an item Internal .* without telling customers/)).toBeTruthy();
  });

  it('shows the same items as stacked cards below 640px without horizontal scroll', async () => {
    setup();
    const wide = (await screen.findByRole('table')).closest('[data-slot="context-table"]')!;
    expect(wide.className).toContain('hidden');
    expect(wide.className).toContain('sm:block');
    const list = screen.getByRole('list', { name: 'Business context' });
    expect(list.className).toContain('sm:hidden');
    const name = mobileList().getByText('menu.pdf');
    expect(name.className).toContain('truncate');
    expect(name.closest('li')!.innerHTML).not.toMatch(/w-\[\d{3,}px\]|min-w-\[/);
    expect(mobileList().getByText('2.0 MB · Added 2 days ago')).toBeTruthy();
    expect(mobileList().getByText('Price list')).toBeTruthy();
  });

  it('filters items by name from the search field', async () => {
    setup();
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole('button', { name: 'Search business context' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search business context' }), 'PRICE');
    const rows = await table();
    expect(rows.getByText('Price list')).toBeTruthy();
    expect(rows.queryByText('menu.pdf')).toBeNull();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'tyres');
    expect(screen.getByText('No items match “tyres”.')).toBeTruthy();
  });

  it('marks Internal items with a badge and the Internal filter shows only them', async () => {
    setup(status(internal()));
    const user = userEvent.setup();
    const rows = await table();
    const badges = rows.getAllByTestId('internal-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest('tr')!.textContent).toContain('Lowest prices');
    expect(screen.getByText('Internal items: 40 / 10,000 characters')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Internal (1)' }));
    expect((await table()).queryByText('menu.pdf')).toBeNull();
    expect((await table()).getByText('Lowest prices')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Customer-facing (2)' }));
    expect((await table()).queryByText('Lowest prices')).toBeNull();
    expect((await table()).getByText('menu.pdf')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'All (3)' }));
    expect((await table()).getByText('Lowest prices')).toBeTruthy();
  });

  it('says so when a filter has no items', async () => {
    setup();
    const user = userEvent.setup();
    await table();
    expect(screen.queryByText(/^Internal items:/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Internal (0)' }));
    expect(screen.getByText('No items in this view.')).toBeTruthy();
  });

  it('selects items and deletes them after confirming, then leaves Select', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    const rows = await table();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const deleteButton = screen.getByRole('button', { name: 'Delete 0' }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    await user.click(rows.getByRole('checkbox', { name: 'Select menu.pdf' }));
    await user.click(rows.getByRole('checkbox', { name: 'Select Price list' }));
    await user.click(screen.getByRole('button', { name: 'Delete 2' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Delete 2 items?')).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(writes(fetchMock)).toEqual([
        `DELETE ${BASE}/documents/1`,
        `DELETE ${BASE}/documents/2`,
      ]),
    );
    expect(await screen.findByText(/No context yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete \d/ })).toBeNull();
  });

  it('treats an already-deleted item (404) as deleted and finishes the batch', async () => {
    const { fetchMock } = setup(status(), (url, init) =>
      url === `${BASE}/documents/1` && init?.method === 'DELETE'
        ? json({ error: { code: 'not_found', message: 'Not found' } }, 404)
        : undefined,
    );
    const user = userEvent.setup();
    const rows = await table();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(rows.getByRole('checkbox', { name: 'Select menu.pdf' }));
    await user.click(rows.getByRole('checkbox', { name: 'Select Price list' }));
    await user.click(screen.getByRole('button', { name: 'Delete 2' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes(fetchMock)).toEqual([`DELETE ${BASE}/documents/1`, `DELETE ${BASE}/documents/2`]);
  });

  it('after a partial failure keeps only the failed items, names them and does not resend deleted ones', async () => {
    let failing = true;
    const { fetchMock } = setup(status(), (url, init) =>
      url === `${BASE}/documents/2` && init?.method === 'DELETE' && failing
        ? json({ error: { code: 'internal', message: 'Boom' } }, 500)
        : undefined,
    );
    const user = userEvent.setup();
    const rows = await table();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(rows.getByRole('checkbox', { name: 'Select menu.pdf' }));
    await user.click(rows.getByRole('checkbox', { name: 'Select Price list' }));
    await user.click(screen.getByRole('button', { name: 'Delete 2' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    const dialog = (await screen.findByText('Delete Price list?')).closest(
      '[role="alertdialog"]',
    ) as HTMLElement;
    expect(within(dialog).getByText(/Could not delete: Price list/)).toBeTruthy();
    failing = false;
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes(fetchMock)).toEqual([
      `DELETE ${BASE}/documents/1`,
      `DELETE ${BASE}/documents/2`,
      `DELETE ${BASE}/documents/2`,
    ]);
  });

  it('entering Select clears the search and the confirmation lists the selected names', async () => {
    setup();
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole('button', { name: 'Search business context' }));
    await user.type(screen.getByRole('searchbox'), 'menu');
    expect(screen.queryByText('Price list')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    const rows = await table();
    expect(rows.getByText('Price list')).toBeTruthy();
    await user.click(rows.getByRole('checkbox', { name: 'Select menu.pdf' }));
    await user.click(rows.getByRole('checkbox', { name: 'Select Price list' }));
    await user.click(screen.getByRole('button', { name: 'Delete 2' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('menu.pdf, Price list')).toBeTruthy();
  });

  it('lists at most five names in the confirmation, then "+N more"', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...documents()[1]!,
      id: i + 1,
      name: `Item ${i + 1}`,
    }));
    setup(status(many));
    const user = userEvent.setup();
    const rows = await table();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    for (let i = 1; i <= 7; i++)
      await user.click(rows.getByRole('checkbox', { name: `Select Item ${i}` }));
    await user.click(screen.getByRole('button', { name: 'Delete 7' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Item 1, Item 2, Item 3, Item 4, Item 5 +2 more')).toBeTruthy();
  });

  it('Cancel leaves Select without deleting anything', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    const rows = await table();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(rows.getByRole('checkbox', { name: 'Select menu.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('Add offers Upload from device and Add text content, under the agent', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await table();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Upload from device' }));
    expect(click).toHaveBeenCalled();
    const input = screen.getByTestId('ai-context-file') as HTMLInputElement;
    expect(input.accept).toBe('.txt,.md,.pdf,.docx');
    await user.upload(input, new File(['Open 9am'], 'hours.md', { type: 'text/markdown' }));
    // The picked file is confirmed in a dialog that can mark it Internal.
    const fileDialog = await screen.findByRole('dialog');
    expect(within(fileDialog).getByText('Add a file')).toBeTruthy();
    expect(within(fileDialog).getByText('hours.md')).toBeTruthy();
    await user.click(within(fileDialog).getByRole('button', { name: 'Add' }));
    expect(await (await table()).findByText('hours.md')).toBeTruthy();
    const form = fetchMock.mock.calls.find((call) => call[0] === `${BASE}/documents`)![1]!
      .body as FormData;
    expect(form.get('internal')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add text content' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Delivery');
    await user.type(within(dialog).getByLabelText('Text content'), 'Delivery costs RM10.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await (await table()).findByText('Delivery')).toBeTruthy();
    expect(writes(fetchMock)).toEqual([`POST ${BASE}/documents`, `POST ${BASE}/documents/text`]);
    const post = fetchMock.mock.calls.find((call) => call[0] === `${BASE}/documents/text`)!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      name: 'Delivery',
      text: 'Delivery costs RM10.',
      internal: false,
    });
  });

  it('uploads a file marked Internal with the internal field before the file', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await table();
    await user.upload(
      screen.getByTestId('ai-context-file'),
      new File(['Floor RM5'], 'floor.md', { type: 'text/markdown' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('switch', { name: 'Internal' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes(fetchMock)).toEqual([`POST ${BASE}/documents`]));
    const form = fetchMock.mock.calls.find((call) => call[0] === `${BASE}/documents`)![1]!
      .body as FormData;
    expect([...form.keys()]).toEqual(['internal', 'file']);
    expect(form.get('internal')).toBe('true');
    expect(await (await table()).findByTestId('internal-badge')).toBeTruthy();
  });

  it('adds a text item marked Internal', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add text content' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Floor prices');
    await user.type(within(dialog).getByLabelText('Text content'), 'Lowest RM5');
    await user.click(within(dialog).getByRole('switch', { name: 'Internal' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(fetchMock)).toEqual([`POST ${BASE}/documents/text`]));
    expect(bodyOf(fetchMock, 'POST')).toEqual({
      name: 'Floor prices',
      text: 'Lowest RM5',
      internal: true,
    });
  });

  it('shows the Internal limit error in the admin language', async () => {
    setup(status(), (url, init) =>
      url === `${BASE}/documents/text` && init?.method === 'POST'
        ? json(
            {
              error: {
                code: 'internal_too_large',
                message: 'Internal items can contain up to 10,000 characters in total',
              },
            },
            409,
          )
        : undefined,
    );
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add text content' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Floor prices');
    await user.type(within(dialog).getByLabelText('Text content'), 'Lowest RM5');
    await user.click(within(dialog).getByRole('switch', { name: 'Internal' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/Shorten an Internal item or make it customer-facing/),
    ).toBeTruthy();
  });

  it('takes a file dropped on Business context into the add dialog', async () => {
    const { fetchMock } = setup();
    await table();
    const card = screen
      .getByTestId('ai-context-file')
      .closest('[data-slot="card"]')!.parentElement!;
    const file = new File(['Open 9am'], 'hours.md', { type: 'text/markdown' });
    fireEvent.dragEnter(card, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.getByTestId('file-drop-overlay').textContent).toContain(
      'Drop a file to add it to Business context',
    );
    fireEvent.drop(card, { dataTransfer: { types: ['Files'], files: [file] } });
    const fileDialog = await screen.findByRole('dialog');
    expect(within(fileDialog).getByText('hours.md')).toBeTruthy();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('rejects an unsupported file type before uploading', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup({ applyAccept: false });
    await table();
    await user.upload(
      screen.getByTestId('ai-context-file'),
      new File(['x'], 'photo.png', { type: 'image/png' }),
    );
    expect(await screen.findByText('Choose a TXT, Markdown, PDF or DOCX document.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('rejects a file over 10 MB before uploading', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await table();
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await user.upload(screen.getByTestId('ai-context-file'), big);
    expect(await screen.findByText('Documents must be 10 MB or smaller.')).toBeTruthy();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('opens a text item to edit its name and text', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click((await table()).getByRole('button', { name: 'Price list' }));
    const dialog = await screen.findByRole('dialog');
    const text = (await within(dialog).findByLabelText('Text content')) as HTMLTextAreaElement;
    expect(text.value).toBe('Cake RM50');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Price list');
    // A long document wraps in a fixed-size box instead of widening the dialog.
    expect(text.className).toContain('field-sizing-fixed');
    expect(within(dialog).getByText('9 / 100,000 characters')).toBeTruthy();
    await user.clear(text);
    await user.type(text, 'Cake RM45');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(fetchMock)).toEqual([`PATCH ${BASE}/documents/2`]));
    expect(bodyOf(fetchMock, 'PATCH')).toEqual({
      name: 'Price list',
      text: 'Cake RM45',
      internal: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the Internal switch alone enables Save in a text item', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click((await table()).getByRole('button', { name: 'Price list' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Text content');
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(within(dialog).getByRole('switch', { name: 'Internal' }));
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(writes(fetchMock)).toEqual([`PATCH ${BASE}/documents/2`]));
    expect(bodyOf(fetchMock, 'PATCH')).toMatchObject({ internal: true });
  });

  it('shows a file item as a read-only preview whose Internal flag can change', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click((await table()).getByRole('button', { name: 'menu.pdf' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Nasi lemak RM8')).toBeTruthy();
    expect(within(dialog).getByText('Showing the start of the extracted text.')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(within(dialog).getByRole('switch', { name: 'Internal' }));
    await user.click(save);
    await waitFor(() => expect(writes(fetchMock)).toEqual([`PATCH ${BASE}/documents/1`]));
    expect(bodyOf(fetchMock, 'PATCH')).toEqual({ internal: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  describe('Internal from the list', () => {
    it('marks an item Internal from its row, sending only the flag', async () => {
      const { fetchMock } = setup();
      const user = userEvent.setup();
      const rows = await table();
      await user.click(rows.getByRole('button', { name: 'Mark Price list as Internal' }));
      await waitFor(() => expect(writes(fetchMock)).toEqual([`PATCH ${BASE}/documents/2`]));
      expect(bodyOf(fetchMock, 'PATCH')).toEqual({ internal: true });
      // The row now shows the badge and offers the way back; no dialog opened.
      const row = (await table()).getByText('Price list').closest('tr')!;
      expect(await within(row).findByTestId('internal-badge')).toBeTruthy();
      expect(
        within(row).getByRole('button', { name: 'Mark Price list as customer-facing' }),
      ).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('marks an Internal item customer-facing from the phone list', async () => {
      const { fetchMock } = setup(status(internal()));
      const user = userEvent.setup();
      await table();
      await user.click(
        mobileList().getByRole('button', { name: 'Mark Lowest prices as customer-facing' }),
      );
      await waitFor(() => expect(writes(fetchMock)).toEqual([`PATCH ${BASE}/documents/3`]));
      expect(bodyOf(fetchMock, 'PATCH')).toEqual({ internal: false });
    });

    it('refuses an item that would pass the Internal limit without asking the server', async () => {
      const big = documents().map((doc) =>
        doc.id === 1 ? { ...doc, internal: true, characters: 9_500 } : doc,
      );
      const { fetchMock } = setup(status(big));
      const user = userEvent.setup();
      const rows = await table();
      await user.click(rows.getByRole('button', { name: 'Mark Price list as Internal' }));
      expect(
        await screen.findByText(/up to 10,000 characters in total\. Shorten an Internal item/),
      ).toBeTruthy();
      expect(writes(fetchMock)).toEqual([]);
    });

    it('shows the server Internal limit error in the admin language', async () => {
      setup(status(), (url, init) =>
        url === `${BASE}/documents/2` && init?.method === 'PATCH'
          ? json({ error: { code: 'internal_too_large', message: 'Too large' } }, 409)
          : undefined,
      );
      const user = userEvent.setup();
      const rows = await table();
      await user.click(rows.getByRole('button', { name: 'Mark Price list as Internal' }));
      expect(
        await screen.findByText(/Shorten an Internal item or make it customer-facing/),
      ).toBeTruthy();
    });

    it('hides the row buttons while selecting', async () => {
      setup();
      const user = userEvent.setup();
      await table();
      await user.click(screen.getByRole('button', { name: 'Select' }));
      expect(screen.queryByRole('button', { name: /^Mark .* as Internal$/ })).toBeNull();
    });
  });

  it('deletes a file item from its dialog after confirming', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click((await table()).getByRole('button', { name: 'menu.pdf' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Nasi lemak RM8');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Delete menu.pdf?')).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes(fetchMock)).toEqual([`DELETE ${BASE}/documents/1`]));
  });

  it('shows the empty state with the Add button', async () => {
    setup(status([]));
    expect(
      await screen.findByText(
        'No context yet: add your company brief, product list, prices and FAQs.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
  });
});

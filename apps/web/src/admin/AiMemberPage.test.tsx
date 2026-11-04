import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  AI_AGENT_PRESETS,
  type AiAgentBody,
  type AiAgentStatus,
  type AiAgentSummary,
  type AiDocument,
  type AiMemberStatus,
} from '@ezychat/shared';
import { AiMemberPage } from './AiMemberPage';
import {
  useAgentSection,
  validateWebExtensions,
  WebExtensionsProvider,
  type WebExtension,
} from '../extensions';
import { activateLocale } from '../i18n';
import msAdmin from '../i18n/locales/ms/admin.json';

const SALES = AI_AGENT_PRESETS.sales;
const FAQ = AI_AGENT_PRESETS.faq;
const item: AiDocument = {
  id: 1,
  name: 'Business context',
  kind: 'text',
  size: 13,
  characters: 13,
  createdAt: 1,
  updatedAt: 1,
  internal: false,
};

interface World {
  /** Connection (GET /api/ai). */
  connected: boolean;
  maxAgents: number;
  agents: AiAgentStatus[];
  inboxes: { id: number; name: string; aiAgentId: number | null }[];
  /** The connection uses a Claude API key instead of an OpenAI one. */
  claude?: boolean;
}
function agentStatus(
  id = 5,
  patch: Partial<AiAgentSummary> = {},
  settings: Partial<AiAgentStatus['settings']> = {},
  documents: AiDocument[] = [],
): AiAgentStatus {
  const agent: AiAgentSummary = {
    id,
    userId: 3,
    displayName: 'Sales Assistant',
    enabled: false,
    preset: 'sales',
    inboxId: 1,
    documentCount: documents.length,
    answerDirect: true,
    groupCount: 0,
    ...patch,
  };
  return {
    agent,
    settings: {
      displayName: agent.displayName,
      enabled: agent.enabled,
      mode: 'api',
      model: '',
      instructions: SALES.instructions,
      handoffRules: SALES.handoffRules,
      ...settings,
    },
    documents,
  };
}
function world(patch: Partial<World> = {}): World {
  return {
    connected: true,
    maxAgents: 1,
    agents: [agentStatus()],
    inboxes: [{ id: 1, name: 'Sales line', aiAgentId: 5 }],
    ...patch,
  };
}
function memberStatus(w: World): AiMemberStatus {
  return {
    hasClaudeApiKey: !!w.claude && w.connected,
    member: null,
    settings: {
      displayName: 'Sales Assistant',
      enabled: false,
      mode: w.claude ? 'claude' : 'api',
      model: '',
      instructions: '',
    },
    hasApiKey: !w.claude && w.connected,
    connection: { state: 'connected', loginUrl: null, error: null },
    documents: [],
    agents: w.agents.map((a) => a.agent),
    maxAgents: w.maxAgents,
  };
}
function json(data: unknown, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
}
const notFound = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404);
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
type Respond = (url: string, init: RequestInit | undefined, w: World) => Response | undefined;

function setup(
  w: World = world(),
  path = '/admin/members/ai/5',
  respond?: Respond,
  extensions: readonly WebExtension[] = [],
) {
  const list = () => ({ agents: w.agents.map((a) => a.agent), maxAgents: w.maxAgents });
  const find = (id: number) => w.agents.find((a) => a.agent.id === id);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = respond?.(url, init, w);
    if (custom) return custom;
    const method = init?.method ?? 'GET';
    const agentMatch = /^\/api\/ai\/agents\/(\d+)(\/.*)?$/.exec(url);
    const id = agentMatch ? Number(agentMatch[1]) : 0;
    const rest = agentMatch?.[2] ?? '';
    if (url === '/api/ai') return json(memberStatus(w));
    if (url === '/api/ai/agents' && method === 'GET') return json(list());
    if (url === '/api/ai/agents' && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as AiAgentBody;
      const created = agentStatus(
        8,
        {
          displayName: body.displayName,
          enabled: body.enabled,
          preset: body.preset ?? 'sales',
          inboxId: body.inboxId ?? (w.maxAgents <= 1 ? 1 : null),
        },
        { instructions: body.instructions, handoffRules: body.handoffRules },
      );
      w.agents = [...w.agents, created];
      return json(created);
    }
    if (url === '/api/inboxes' && method === 'GET')
      return json({
        inboxes: w.inboxes.map((inbox, i) => ({
          ...inbox,
          tone: (['primary', 'warning', 'info', 'success'] as const)[i % 4],
          number: null,
          status: 'connected',
          removed: false,
        })),
        maxInboxes: w.maxAgents,
        canAdd: false,
      });
    const inboxMatch = /^\/api\/inboxes\/(\d+)$/.exec(url);
    if (inboxMatch && method === 'PATCH') {
      const inboxId = Number(inboxMatch[1]);
      const body = JSON.parse(String(init!.body)) as { aiAgentId: number | null };
      w.agents = w.agents.map((a) =>
        a.agent.inboxId === inboxId && body.aiAgentId === null
          ? { ...a, agent: { ...a.agent, inboxId: null } }
          : a,
      );
      return json({});
    }
    const current = find(id);
    if (!agentMatch) return notFound();
    if (!current)
      return json({ error: { code: 'agent_not_found', message: 'AI agent not found' } }, 404);
    if (rest === '' && method === 'GET') return json(current);
    if (rest === '' && method === 'PUT') {
      const body = JSON.parse(String(init!.body)) as AiAgentBody;
      const next = agentStatus(
        id,
        {
          ...current.agent,
          displayName: body.displayName,
          enabled: body.enabled,
          preset: body.preset ?? current.agent.preset,
          ...(body.inboxId !== undefined ? { inboxId: body.inboxId } : {}),
        },
        { instructions: body.instructions, handoffRules: body.handoffRules },
        current.documents,
      );
      w.agents = w.agents.map((a) => (a.agent.id === id ? next : a));
      return json(next);
    }
    if (rest === '' && method === 'DELETE') {
      w.agents = w.agents.filter((a) => a.agent.id !== id);
      return json(list());
    }
    if (rest === '/documents/text' && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { name: string };
      const next = {
        ...current,
        documents: [...current.documents, { ...item, id: 7, name: body.name }],
      };
      w.agents = w.agents.map((a) => (a.agent.id === id ? next : a));
      return json(next);
    }
    return notFound();
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <WebExtensionsProvider extensions={validateWebExtensions(extensions)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/admin/members/ai/new" element={<AiMemberPage />} />
            <Route path="/admin/members/ai/:agentId" element={<AiMemberPage />} />
            <Route path="/admin/settings/ai" element={<h1>Settings AI</h1>} />
            <Route path="/admin/members" element={<h1>Members list</h1>} />
          </Routes>
          <Location />
        </MemoryRouter>
      </WebExtensionsProvider>
    </QueryClientProvider>,
  );
  return { fetchMock, world: w };
}
const writes = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((call) => call[1]?.method && call[1].method !== 'GET');
const writeLines = (fetchMock: ReturnType<typeof vi.fn>) =>
  writes(fetchMock).map((call) => `${call[1]!.method} ${call[0]}`);
const lastBody = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse(String(writes(fetchMock).at(-1)![1]!.body));
/** The header's Turn on (Next steps repeats it below the header). */
const headerTurnOn = async () =>
  (await screen.findAllByRole('button', { name: 'Turn on' }))[0] as HTMLButtonElement;
const cardTitles = () =>
  [...document.querySelectorAll('[data-slot="card-title"]')].map((title) => title.textContent);
const withContext = (patch: Partial<AiAgentSummary> = {}) =>
  world({ agents: [agentStatus(5, patch, {}, [{ ...item }])] });
const enterprise = (patch: Partial<World> = {}) =>
  world({
    maxAgents: 2,
    agents: [
      agentStatus(5, {}, {}, [{ ...item }, { ...item, id: 2, name: 'Prices' }]),
      agentStatus(6, { displayName: 'Help Desk', preset: 'faq', inboxId: 2 }),
    ],
    inboxes: [
      { id: 1, name: 'Sales line', aiAgentId: 5 },
      { id: 2, name: 'Support line', aiAgentId: 6 },
    ],
    ...patch,
  });

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AI agent page', () => {
  it('renders extension agent rows right under Business context, each behind a boundary', async () => {
    function Boom(): never {
      throw new Error('row exploded');
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setup(world(), undefined, undefined, [
      {
        name: 'connectors',
        agentSections: [
          { agent: 'sales', id: 'row', element: <p>Connectors row</p> },
          { agent: 'sales', id: 'broken', element: <Boom /> },
        ],
      },
    ]);
    const row = await screen.findByText('Connectors row');
    const sections = screen.getByTestId('agent-extension-sections');
    expect(sections.contains(row)).toBe(true);
    expect(within(sections).getByTestId('error-boundary')).toBeTruthy();
    const titles = [...document.querySelectorAll('[data-slot="card-title"]')];
    const context = titles.find((el) => el.textContent === 'Business context')!;
    const tryIt = titles.find((el) => el.textContent === 'Try it')!;
    expect(
      context.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(sections.compareDocumentPosition(tryIt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('tells an extension row which agent page it is on', async () => {
    function AgentName() {
      const section = useAgentSection();
      return (
        <p>{section ? `${section.agentId}:${section.displayName}:${section.preset}` : 'none'}</p>
      );
    }
    function Outside() {
      return <p data-testid="outside">{useAgentSection() === null ? 'no agent' : 'agent'}</p>;
    }
    setup(enterprise(), '/admin/members/ai/6', undefined, [
      {
        name: 'connectors',
        agentSections: [{ agent: 'sales', id: 'row', element: <AgentName /> }],
      },
    ]);
    expect(await screen.findByText('6:Help Desk:faq')).toBeTruthy();
    cleanup();
    render(<Outside />);
    expect(screen.getByTestId('outside').textContent).toBe('no agent');
  });

  it('adds no extension rows without extensions', async () => {
    setup();
    await screen.findByText('Business context');
    expect(screen.queryByTestId('agent-extension-sections')).toBeNull();
  });

  it('shows Name, Business context, Try it, the Advanced texts and the safety rules', async () => {
    setup();
    await screen.findByText('Business context');
    expect(cardTitles()).toEqual([
      'Next steps',
      'Start from a business template',
      'Agent type',
      'Name',
      'Business context',
      'Connectors',
      'Closing chats',
      'Groups',
      'Try it',
      'Role',
      'Hand-over rules',
    ]);
    // The safety rules are a closed section after the cards, not a card.
    expect(screen.getByTestId('safety-rules').textContent).toContain('Always-on safety rules');
    expect(screen.getByRole('heading', { name: 'Sales Assistant' })).toBeTruthy();
    expect(screen.getByText(/own role, its own Business context/)).toBeTruthy();
    expect(screen.getByTestId('preset-badge').textContent).toBe('Sales agent');
  });

  it('shows the four fixed safety rules as read-only text, closed by default', async () => {
    setup();
    await screen.findByText('Always-on safety rules');
    const card = screen.getByTestId('safety-rules') as HTMLDetailsElement;
    expect(card.open).toBe(false);
    expect(within(card).getByText('Cannot be changed')).toBeTruthy();
    expect(within(card).getAllByRole('listitem')).toHaveLength(4);
    expect(within(card).queryByRole('textbox')).toBeNull();
  });

  it('names the saved Claude key in the connection line', async () => {
    setup(world({ claude: true }));
    expect(await screen.findByText(/Anthropic API key is saved/)).toBeTruthy();
    expect(screen.queryByText(/ChatGPT:/)).toBeNull();
  });

  it('keeps Turn on disabled with the reason until the connection works', async () => {
    const w = withContext();
    w.connected = false;
    setup(w);
    const turnOn = await headerTurnOn();
    expect(turnOn.disabled).toBe(true);
    expect(screen.getByText('Needs connection')).toBeTruthy();
    // Another reason than the status's own words stays visible under the header.
    expect(screen.getByText('Connect the AI below first.').className).not.toContain('sr-only');
    // The connect card comes right after Next steps, before the Name card.
    expect(cardTitles().slice(0, 2)).toEqual(['Next steps', 'Connect the AI']);
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy();
    // Try it explains why it cannot ask yet.
    expect(screen.getByText('Connect AI under Settings → AI to try the agent.')).toBeTruthy();
  });

  it('hides the connect card once the AI connection works', async () => {
    setup(withContext());
    await screen.findByLabelText('Agent name');
    expect(screen.queryByText('Connect the AI')).toBeNull();
  });

  it('keeps Turn on disabled until there is a context item, then turns on', async () => {
    setup();
    const user = userEvent.setup();
    const turnOn = await headerTurnOn();
    expect(turnOn.disabled).toBe(true);
    expect(screen.getByText('Needs business context')).toBeTruthy();
    // The status says it already: the reason is kept for screen readers only.
    const reason = screen.getByText('Add business context first.');
    expect(reason.className).toContain('sr-only');
    expect(turnOn.getAttribute('aria-describedby')).toBe(reason.id);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add text content' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Delivery');
    await user.type(within(dialog).getByLabelText('Text content'), 'Delivery RM10');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(turnOn.disabled).toBe(false));
    expect(screen.getByText('Off')).toBeTruthy();
  });

  describe('Next steps', () => {
    const steps = () => within(screen.getByTestId('next-steps'));
    const row = (name: string) =>
      steps().getByRole('button', { name }).closest('li') as HTMLElement;

    it('numbers the open steps, checks done ones and jumps to their section', async () => {
      const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
      setup();
      const user = userEvent.setup();
      await screen.findByTestId('next-steps');
      expect(row('Add Business context').dataset.done).toBe('false');
      expect(within(row('Add Business context')).getByText('Step 1')).toBeTruthy();
      expect(within(row('Try a test question')).getByText('Step 2')).toBeTruthy();
      const turnOn = steps().getByRole('button', { name: 'Turn on' }) as HTMLButtonElement;
      expect(turnOn.disabled).toBe(true);
      await user.click(steps().getByRole('button', { name: 'Add Business context' }));
      const contextTitle = screen.getByText('Business context', {
        selector: '[data-slot="card-title"]',
      });
      expect((scroll.mock.contexts.at(-1) as HTMLElement).contains(contextTitle)).toBe(true);
      // Focus follows the jump, so keyboard and screen-reader users land on the section too.
      expect(document.activeElement).toBe(scroll.mock.contexts.at(-1));
      await user.click(steps().getByRole('button', { name: 'Try a test question' }));
      expect((scroll.mock.contexts.at(-1) as HTMLElement).textContent).toContain('Try it');
      expect(document.activeElement).toBe(scroll.mock.contexts.at(-1));
    });

    it('checks Business context and the test question, then turns on from the card', async () => {
      const { fetchMock } = setup(withContext(), undefined, (url, init) =>
        url === '/api/ai/agents/5/try' && init?.method === 'POST'
          ? json({ ok: true, reply: 'RM10.', action: 'answer', model: 'm', error: null })
          : undefined,
      );
      const user = userEvent.setup();
      await screen.findByTestId('next-steps');
      expect(row('Add Business context').dataset.done).toBe('true');
      expect(within(row('Add Business context')).getByText('Done')).toBeTruthy();
      expect(row('Try a test question').dataset.done).toBe('false');
      await user.type(screen.getByLabelText('Customer question'), 'Delivery?');
      await user.click(screen.getByRole('button', { name: 'Ask' }));
      await waitFor(() => expect(row('Try a test question').dataset.done).toBe('true'));
      await user.click(steps().getByRole('button', { name: 'Turn on' }));
      await screen.findByRole('button', { name: 'Turn off' });
      expect(lastBody(fetchMock)).toMatchObject({ enabled: true });
      // An agent that is on needs no Next steps.
      expect(screen.queryByTestId('next-steps')).toBeNull();
    });

    it('does not check the test question when Try it failed', async () => {
      setup(withContext(), undefined, (url, init) =>
        url === '/api/ai/agents/5/try' && init?.method === 'POST'
          ? json({ ok: false, reply: null, action: null, model: 'm', error: 'Model failed' })
          : undefined,
      );
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText('Customer question'), 'Delivery?');
      await user.click(screen.getByRole('button', { name: 'Ask' }));
      await screen.findByText(/Model failed/);
      expect(row('Try a test question').dataset.done).toBe('false');
    });
  });

  it('Turn on saves unsaved edits in the same request', async () => {
    const { fetchMock } = setup(withContext());
    const user = userEvent.setup();
    const role = await screen.findByLabelText('Role (instructions)');
    await user.clear(role);
    await user.type(role, 'Be brief.');
    expect(screen.getByText('Unsaved')).toBeTruthy();
    await user.click(await headerTurnOn());
    await screen.findByRole('button', { name: 'Turn off' });
    expect(screen.getByText('On')).toBeTruthy();
    expect(writeLines(fetchMock)).toEqual(['PUT /api/ai/agents/5']);
    // Lite never sends an inbox: its one agent always answers inbox 1.
    expect(lastBody(fetchMock)).toEqual({
      displayName: 'Sales Assistant',
      enabled: true,
      preset: 'sales',
      instructions: 'Be brief.',
      handoffRules: SALES.handoffRules,
    });
    expect(screen.queryByText('Unsaved')).toBeNull();
  });

  it('Turn off saves the agent as disabled', async () => {
    const { fetchMock } = setup(withContext({ enabled: true }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    await headerTurnOn();
    expect(lastBody(fetchMock)).toMatchObject({ enabled: false });
  });

  it('keeps the role and hand-over rules in a closed Advanced section', async () => {
    setup();
    const summary = await screen.findByText('Advanced: role and hand-over rules');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Using recommended settings')).toBeTruthy();
    expect(within(details).getByText(/Using the Sales starting text/)).toBeTruthy();
    expect(within(details).queryByRole('button', { name: /Use the .* template/ })).toBeNull();
  });

  it('says Customised and offers the template, which asks before replacing the texts', async () => {
    setup(world({ agents: [agentStatus(5, {}, { instructions: 'Only answer in haiku.' })] }));
    const user = userEvent.setup();
    const summary = await screen.findByText('Advanced: role and hand-over rules');
    expect(within(summary.closest('details')!).getByText('Customised')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use the Sales template' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Use the Sales template?')).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Use template' }));
    expect((screen.getByLabelText('Role (instructions)') as HTMLTextAreaElement).value).toBe(
      SALES.instructions,
    );
    expect(screen.queryByRole('button', { name: 'Use the Sales template' })).toBeNull();
  });

  describe('business templates', () => {
    /** Browse templates → select one in the gallery → Apply template. */
    const applyTemplate = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
      const card = await screen.findByTestId('business-templates');
      await user.click(within(card).getByRole('button', { name: 'Browse templates' }));
      const gallery = await screen.findByRole('dialog', { name: 'Business templates' });
      await user.click(within(gallery).getByRole('radio', { name }));
      await user.click(within(gallery).getByRole('button', { name: 'Apply template' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Business templates' })).toBeNull(),
      );
      return card;
    };

    it('creates a clinic agent from the template and adds its Business context item', async () => {
      const w = world({ maxAgents: 2, agents: [agentStatus()] });
      const { fetchMock } = setup(w, '/admin/members/ai/new?preset=sales');
      const user = userEvent.setup();
      const card = await screen.findByTestId('business-templates');
      await applyTemplate(user, 'Clinic');
      // Unedited starting texts are replaced at once: no question.
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect((screen.getByLabelText('Agent name') as HTMLInputElement).value).toBe(
        'Clinic assistant',
      );
      const role = (screen.getByLabelText('Role (instructions)') as HTMLTextAreaElement).value;
      expect(role.startsWith(FAQ.instructions)).toBe(true);
      expect(role).toContain('You answer for a clinic');
      expect((screen.getByLabelText('Hand-over rules') as HTMLTextAreaElement).value).toContain(
        'describes symptoms',
      );
      const picker = screen.getByRole('radiogroup', { name: 'Starting point' });
      expect(
        (within(picker).getByRole('radio', { name: /FAQ/ }) as HTMLButtonElement).dataset.state,
      ).toBe('checked');
      expect(within(card).getByText(/Save also adds the Business context item/)).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Create agent' }));
      await waitFor(() =>
        expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/8'),
      );
      expect(writeLines(fetchMock)).toEqual([
        'POST /api/ai/agents',
        'POST /api/ai/agents/8/documents/text',
      ]);
      const itemBody = lastBody(fetchMock) as { name: string; text: string };
      expect(itemBody.name).toBe('Clinic details');
      expect(itemBody.text.split('\n')).toContain('Opening hours:');
    });

    it('asks before replacing own texts, keeps the name, and adds the item on Save', async () => {
      const own = agentStatus(5, {}, { instructions: 'Only answer in haiku.' });
      const { fetchMock } = setup(world({ agents: [own] }));
      const user = userEvent.setup();
      await applyTemplate(user, 'Car workshop');
      const confirm = await screen.findByRole('alertdialog');
      expect(within(confirm).getByText('Apply the Car workshop template?')).toBeTruthy();
      await user.click(within(confirm).getByRole('button', { name: 'Apply template' }));
      expect((screen.getByLabelText('Agent name') as HTMLInputElement).value).toBe(
        'Sales Assistant',
      );
      expect((screen.getByLabelText('Role (instructions)') as HTMLTextAreaElement).value).toContain(
        'You answer for a car workshop',
      );
      expect(writes(fetchMock)).toHaveLength(0);

      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(writeLines(fetchMock)).toEqual([
          'PUT /api/ai/agents/5',
          'POST /api/ai/agents/5/documents/text',
        ]),
      );
      expect((lastBody(fetchMock) as { name: string }).name).toBe('Workshop details');
      // Added once: the note goes away and a second Save sends nothing new for the item.
      await waitFor(() =>
        expect(screen.queryByText(/Save also adds the Business context item/)).toBeNull(),
      );
    });

    it('keeps the texts when the admin declines', async () => {
      setup(world({ agents: [agentStatus(5, {}, { instructions: 'Only answer in haiku.' })] }));
      const user = userEvent.setup();
      await applyTemplate(user, 'Tuition centre');
      const confirm = await screen.findByRole('alertdialog');
      await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
      expect((screen.getByLabelText('Role (instructions)') as HTMLTextAreaElement).value).toBe(
        'Only answer in haiku.',
      );
      expect(screen.queryByText(/Save also adds the Business context item/)).toBeNull();
    });

    /** Answers the two group switches of a new agent; `fail` refuses "Answer in groups". */
    const groupSwitches =
      (fail = false): Respond =>
      (url, init) => {
        if (init?.method !== 'PUT' || !/^\/api\/ai\/agents\/\d+\/(groups|direct)$/.test(url))
          return undefined;
        if (fail) return json({ error: { code: 'internal', message: 'Failed' } }, 500);
        const enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
        const direct = url.endsWith('/direct');
        return json({
          enabled: direct ? true : enabled,
          inboxName: 'Claims line',
          groups: [],
          loopGuard: 10,
          answerDirect: direct ? enabled : true,
          directAvailable: true,
          heldDirect: 0,
        });
      };

    it('creates a Claims agent as a group-only Custom agent with its Claim rules', async () => {
      const { fetchMock } = setup(
        world({ maxAgents: 2, agents: [agentStatus()] }),
        '/admin/members/ai/new?preset=sales',
        groupSwitches(),
      );
      const user = userEvent.setup();
      const card = await applyTemplate(user, 'Claims agent');
      expect((screen.getByLabelText('Agent name') as HTMLInputElement).value).toBe(
        'Claims assistant',
      );
      const role = (screen.getByLabelText('Role (instructions)') as HTMLTextAreaElement).value;
      // Its own text only: no sales or FAQ starting text before it.
      expect(role.startsWith('CLAIMS\n')).toBe(true);
      expect(role).toContain('save it as a new row in the tab "Claims"');
      expect(role).not.toContain(SALES.instructions.split('\n')[0]);
      expect((screen.getByLabelText('Hand-over rules') as HTMLTextAreaElement).value).toContain(
        'approved, rejected or paid',
      );
      const picker = screen.getByRole('radiogroup', { name: 'Starting point' });
      expect(
        (within(picker).getByRole('radio', { name: /Custom/ }) as HTMLButtonElement).dataset.state,
      ).toBe('checked');
      expect(within(card).getByTestId('group-setup').textContent).toContain(
        'Save also makes it a group agent',
      );

      await user.click(screen.getByRole('button', { name: 'Create agent' }));
      await waitFor(() =>
        expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/8'),
      );
      expect(writeLines(fetchMock)).toEqual([
        'POST /api/ai/agents',
        'POST /api/ai/agents/8/documents/text',
        'PUT /api/ai/agents/8/groups',
        'PUT /api/ai/agents/8/direct',
      ]);
      const bodies = writes(fetchMock).map((call) => JSON.parse(String(call[1]!.body)));
      expect(bodies[0]).toMatchObject({ preset: 'custom', instructions: role });
      expect(bodies[1].name).toBe('Claim rules');
      expect(bodies[1].text.split('\n')).toContain('Submission deadline:');
      expect(bodies.slice(2)).toEqual([{ enabled: true }, { enabled: false }]);
    });

    it('keeps the new Claims agent when its group settings fail', async () => {
      const { fetchMock } = setup(
        world({ maxAgents: 2, agents: [agentStatus()] }),
        '/admin/members/ai/new?preset=sales',
        groupSwitches(true),
      );
      const user = userEvent.setup();
      await applyTemplate(user, 'Claims agent');
      await user.click(screen.getByRole('button', { name: 'Create agent' }));
      await waitFor(() =>
        expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/8'),
      );
      // Answer direct chats stays on when Answer in groups could not be turned on.
      expect(writeLines(fetchMock)).toEqual([
        'POST /api/ai/agents',
        'POST /api/ai/agents/8/documents/text',
        'PUT /api/ai/agents/8/groups',
      ]);
    });

    it('only tells an existing agent which switches to change (its chats stay)', async () => {
      const { fetchMock } = setup(world(), undefined, groupSwitches());
      const user = userEvent.setup();
      const card = await applyTemplate(user, 'Claims agent');
      // Unedited Sales texts: replaced at once, and the saved name is kept.
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect((screen.getByLabelText('Agent name') as HTMLInputElement).value).toBe(
        'Sales Assistant',
      );
      expect(within(card).getByTestId('group-setup').textContent).toContain(
        'turn on Answer in groups and turn off Answer direct chats',
      );
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(writeLines(fetchMock)).toEqual([
          'PUT /api/ai/agents/5',
          'POST /api/ai/agents/5/documents/text',
        ]),
      );
      // The steps stay in view after Save.
      expect(within(card).getByTestId('group-setup')).toBeTruthy();
    });

    it('drops the group note when another template replaces Claims', async () => {
      setup(world({ maxAgents: 2 }), '/admin/members/ai/new?preset=sales');
      const user = userEvent.setup();
      const card = await applyTemplate(user, 'Claims agent');
      expect(within(card).getByTestId('group-setup')).toBeTruthy();
      await applyTemplate(user, 'Clinic');
      // The Claims texts are not a type's starting text, so it asks first.
      const confirm = await screen.findByRole('alertdialog');
      await user.click(within(confirm).getByRole('button', { name: 'Apply template' }));
      await waitFor(() => expect(within(card).queryByTestId('group-setup')).toBeNull());
    });
  });

  it('Try it sends the agent id and the unsaved name and texts', async () => {
    const { fetchMock } = setup(world(), undefined, (url, init) =>
      url === '/api/ai/agents/5/try' && init?.method === 'POST'
        ? json({ ok: true, reply: 'Delivery is RM10.', action: 'answer', model: 'm', error: null })
        : undefined,
    );
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Agent name');
    await user.clear(name);
    await user.type(name, 'Ezy Bot');
    await user.type(screen.getByLabelText('Customer question'), 'How much is delivery?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('Delivery is RM10.');
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/ai/agents/5/try')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({
      question: 'How much is delivery?',
      knowledge: {
        displayName: 'Ezy Bot',
        instructions: SALES.instructions,
        handoffRules: SALES.handoffRules,
      },
      agentId: 5,
    });
    expect(writes(fetchMock).some((c) => c[1]!.method === 'PUT')).toBe(false);
  });

  it('shows the connection banner and deep-links to Settings → AI', async () => {
    const w = world();
    setup(w, undefined, (url) =>
      url === '/api/ai'
        ? json({
            ...memberStatus(w),
            settings: { ...memberStatus(w).settings, mode: 'chatgpt' },
            connection: {
              state: 'error',
              loginUrl: null,
              error: 'ChatGPT stopped accepting this connection.',
              email: 'owner@example.com',
            },
          })
        : undefined,
    );
    const user = userEvent.setup();
    expect(await screen.findByText('ChatGPT connection stopped working')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Settings → AI' });
    expect(links.every((link) => link.getAttribute('href') === '/admin/settings/ai')).toBe(true);
    await user.click(links[0]!);
    expect(screen.getByTestId('location').textContent).toBe('/admin/settings/ai');
  });

  it('keeps How it works collapsed and links back to Members', async () => {
    setup();
    const summary = await screen.findByText('How it works');
    expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole('link', { name: 'Members' }).getAttribute('href')).toBe(
      '/admin/members',
    );
  });

  it('restores unsaved edits per agent and opens Advanced for them', async () => {
    const first = setup();
    const user = userEvent.setup();
    const role = await screen.findByLabelText('Role (instructions)');
    await user.clear(role);
    await user.type(role, 'Be brief');
    const stored = JSON.parse(sessionStorage.getItem('wati.ai-draft.5')!);
    expect(stored).toMatchObject({ preset: 'sales', draft: { instructions: 'Be brief' } });
    cleanup();
    first.fetchMock.mockClear();
    setup();
    const restored = (await screen.findByLabelText('Role (instructions)')) as HTMLTextAreaElement;
    expect(restored.value).toBe('Be brief');
    expect(restored.closest('details')!.open).toBe(true);
    expect(screen.getByText('Unsaved')).toBeTruthy();
  });

  it('drops a stored draft in an older shape without crashing', async () => {
    sessionStorage.setItem(
      'wati.ai-draft.5',
      JSON.stringify({ displayName: 'Old draft', instructions: 'Be kind', handoffRules: '' }),
    );
    setup(world({ agents: [agentStatus(5, {}, { instructions: 'Saved rules' })] }));
    expect(
      ((await screen.findByLabelText('Role (instructions)')) as HTMLTextAreaElement).value,
    ).toBe('Saved rules');
    expect(screen.queryByText('Unsaved')).toBeNull();
    await waitFor(() => expect(sessionStorage.getItem('wati.ai-draft.5')).toBeNull());
  });

  it('saves edits, then clears the stored draft', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    const rules = await screen.findByLabelText('Hand-over rules');
    await user.clear(rules);
    await user.type(rules, '- The customer asks for a wholesale price');
    expect(screen.getByText(/Always handed over, whatever you write here/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeLines(fetchMock)).toEqual(['PUT /api/ai/agents/5']));
    expect(lastBody(fetchMock).handoffRules).toBe('- The customer asks for a wholesale price');
    await waitFor(() => expect(sessionStorage.getItem('wati.ai-draft.5')).toBeNull());
  });

  it('changes an existing agent to FAQ: own texts stay, starting texts follow the type', async () => {
    // Own texts (the Sales agent of an upgraded Lite install whose role was rewritten).
    const own = withContext();
    own.agents = [
      agentStatus(5, {}, { instructions: 'Answer politely.', handoffRules: '- Refunds' }),
    ];
    const { fetchMock } = setup(own);
    const user = userEvent.setup();
    const card = await screen.findByTestId('agent-type');
    // The page header's badge names the type and follows a change at once.
    expect(screen.getByTestId('preset-badge').textContent).toBe('Sales agent');
    await user.click(within(card).getByRole('button', { name: 'Change' }));
    await user.click(within(card).getByRole('radio', { name: /FAQ/ }));
    expect(screen.getByTestId('preset-badge').textContent).toBe('FAQ agent');
    expect(within(card).getByText('The role and hand-over rules are your own texts.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Use the FAQ template' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeLines(fetchMock)).toEqual(['PUT /api/ai/agents/5']));
    expect(lastBody(fetchMock)).toMatchObject({
      preset: 'faq',
      instructions: 'Answer politely.',
      handoffRules: '- Refunds',
    });
  });

  it('loads the FAQ starting texts when the agent still has the Sales starting texts', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    const card = await screen.findByTestId('agent-type');
    await user.click(within(card).getByRole('button', { name: 'Change' }));
    await user.click(within(card).getByRole('radio', { name: /FAQ/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeLines(fetchMock)).toEqual(['PUT /api/ai/agents/5']));
    expect(lastBody(fetchMock)).toMatchObject({
      preset: 'faq',
      instructions: AI_AGENT_PRESETS.faq.instructions,
    });
  });

  it('opens Edit with AI for the role from the Agent type card', async () => {
    setup();
    const user = userEvent.setup();
    const card = await screen.findByTestId('agent-type');
    await user.click(within(card).getByRole('button', { name: 'Edit role with AI' }));
    expect(await screen.findByText('Edit AI instructions with AI')).toBeTruthy();
  });

  it('asks for a name before saving', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Agent name'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a name for the agent.')).toBeTruthy();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('shows a save error from the server', async () => {
    setup(world(), undefined, (url, init) =>
      url === '/api/ai/agents/5' && init?.method === 'PUT'
        ? json({ error: { code: 'agent_not_found', message: 'AI agent not found' } }, 404)
        : undefined,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Agent name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('This AI agent does not exist. It may have been deleted.'),
    ).toBeTruthy();
  });

  describe('create', () => {
    it('creates a FAQ agent with the FAQ starting texts and opens it', async () => {
      const w = world({ maxAgents: 2, agents: [agentStatus()] });
      const { fetchMock } = setup(w, '/admin/members/ai/new?preset=faq');
      const user = userEvent.setup();
      const picker = await screen.findByRole('radiogroup', { name: 'Starting point' });
      expect(
        (within(picker).getByRole('radio', { name: /FAQ/ }) as HTMLButtonElement).dataset.state,
      ).toBe('checked');
      // A short page: Business context, Try it, Next steps and the safety rules come after Create.
      expect(cardTitles()).toEqual([
        'Start from a business template',
        'Starting point',
        'Name',
        'Role',
        'Hand-over rules',
      ]);
      expect(screen.getByRole('heading', { name: 'New AI agent' })).toBeTruthy();
      expect(
        screen.getByText(
          'After you create the agent, add its Business context, try it and turn it on.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText('How it works')).toBeNull();
      const role = screen.getByLabelText('Role (instructions)') as HTMLTextAreaElement;
      expect(role.value).toBe(FAQ.instructions);
      expect(role.closest('details')!.open).toBe(true);
      expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
      await user.type(screen.getByLabelText('Agent name'), 'Help Desk');
      await user.click(screen.getByRole('button', { name: 'Create agent' }));
      await waitFor(() =>
        expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/8'),
      );
      // The new agent page opens at its top (name, status and Next steps).
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 });
      expect(await screen.findByTestId('next-steps')).toBeTruthy();
      expect(writeLines(fetchMock)).toEqual(['POST /api/ai/agents']);
      expect(lastBody(fetchMock)).toEqual({
        displayName: 'Help Desk',
        enabled: false,
        preset: 'faq',
        instructions: FAQ.instructions,
        handoffRules: FAQ.handoffRules,
        // Every inbox has an agent: the new one shares the first inbox (it works in groups there).
        inboxId: 1,
      });
      expect(sessionStorage.getItem('wati.ai-draft.new-faq')).toBeNull();
    });

    it('binds a new agent to the first free inbox in Enterprise, without the no-inbox hint', async () => {
      const w = enterprise({
        agents: [agentStatus(5)],
        inboxes: [
          { id: 1, name: 'Sales line', aiAgentId: 5 },
          { id: 2, name: 'Support line', aiAgentId: null },
        ],
      });
      const { fetchMock } = setup(w, '/admin/members/ai/new');
      const user = userEvent.setup();
      await screen.findByTestId('agent-inbox');
      await waitFor(() =>
        expect(within(screen.getByTestId('agent-inbox')).getByRole('combobox').textContent).toBe(
          'Support line',
        ),
      );
      expect(screen.queryByTestId('no-free-inbox')).toBeNull();
      await user.type(screen.getByLabelText('Agent name'), 'Second');
      await user.click(screen.getByRole('button', { name: 'Create agent' }));
      await waitFor(() => expect(writeLines(fetchMock)).toEqual(['POST /api/ai/agents']));
      expect(lastBody(fetchMock)).toMatchObject({ preset: 'sales', inboxId: 2 });
    });

    it('shows no extension rows on the create page', async () => {
      setup(world({ maxAgents: 2 }), '/admin/members/ai/new', undefined, [
        { name: 'connectors', agentSections: [{ agent: 'sales', id: 'row', element: <p>Row</p> }] },
      ]);
      await screen.findByRole('radiogroup', { name: 'Starting point' });
      expect(screen.queryByTestId('agent-extension-sections')).toBeNull();
    });

    it('starts a new agent on a shared inbox when every inbox has an agent (Enterprise)', async () => {
      setup(enterprise({ maxAgents: 3 }), '/admin/members/ai/new');
      const select = within(await screen.findByTestId('agent-inbox')).getByRole('combobox');
      await waitFor(() => expect(select.textContent).not.toBe(''));
      expect(select.textContent).not.toBe('None (the agent does not answer any chat)');
      expect(screen.queryByTestId('no-free-inbox')).toBeNull();
    });

    it('switches the starting texts directly while unedited, and asks once edited', async () => {
      setup(world({ maxAgents: 2 }), '/admin/members/ai/new');
      const user = userEvent.setup();
      const picker = await screen.findByRole('radiogroup', { name: 'Starting point' });
      const role = screen.getByLabelText('Role (instructions)') as HTMLTextAreaElement;
      expect(role.value).toBe(SALES.instructions);
      await user.click(within(picker).getByRole('radio', { name: /FAQ/ }));
      expect(role.value).toBe(FAQ.instructions);
      await user.type(role, ' Extra.');
      await user.click(within(picker).getByRole('radio', { name: /Custom/ }));
      const confirm = await screen.findByRole('alertdialog');
      expect(within(confirm).getByText('Use the Custom template?')).toBeTruthy();
      await user.click(within(confirm).getByRole('button', { name: 'Use template' }));
      expect(role.value).toBe('');
      expect(screen.getByText('Role not written yet')).toBeTruthy();
    });

    it('says the limit is reached instead of a create page', async () => {
      setup(world(), '/admin/members/ai/new');
      expect(await screen.findByText('You have the maximum number of AI agents')).toBeTruthy();
      expect(screen.getByText('Lite has one AI agent. Change your agent instead.')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Back to Members' }).getAttribute('href')).toBe(
        '/admin/members',
      );
      const upgrade = screen.getByRole('link', { name: 'Upgrade to Enterprise' });
      expect(upgrade.getAttribute('href')).toBe(
        'https://ezychat.ai/?utm_source=ezychat-lite&utm_medium=app&utm_campaign=upgrade#enterprise',
      );
      expect(upgrade.getAttribute('target')).toBe('_blank');
    });
  });

  it('says an unknown agent does not exist', async () => {
    setup(world(), '/admin/members/ai/99');
    expect(await screen.findByText('This AI agent does not exist')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Members' })).toBeTruthy();
  });

  it('Lite renders no inbox select, no inbox chip and no Delete', async () => {
    const { fetchMock } = setup();
    await screen.findByText('Business context');
    expect(screen.queryByTestId('agent-inbox')).toBeNull();
    expect(screen.queryByTestId('inbox-chip')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete agent' })).toBeNull();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/inboxes')).toBe(false);
  });

  describe('Enterprise', () => {
    it('shows the inbox chip and the inbox select with the agent on each inbox', async () => {
      setup(enterprise());
      const user = userEvent.setup();
      expect((await screen.findByTestId('inbox-chip')).textContent).toBe('Sales line');
      const select = within(await screen.findByTestId('agent-inbox')).getByRole('combobox');
      await waitFor(() => expect(select.textContent).toBe('Sales line'));
      await user.click(select);
      expect(
        await screen.findByRole('option', { name: 'Support line (has Help Desk)' }),
      ).toBeTruthy();
      expect(
        screen.getByRole('option', { name: 'None (the agent does not answer any chat)' }),
      ).toBeTruthy();
    });

    it('moving to an inbox with a direct-chat agent warns and saves without moving that agent', async () => {
      const { fetchMock } = setup(enterprise());
      const user = userEvent.setup();
      const select = within(await screen.findByTestId('agent-inbox')).getByRole('combobox');
      await waitFor(() => expect(select.textContent).toBe('Sales line'));
      await user.click(select);
      await user.click(await screen.findByRole('option', { name: 'Support line (has Help Desk)' }));
      expect(screen.getByText(/Help Desk answers the direct chats of Support line/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(writeLines(fetchMock)).toEqual(['PUT /api/ai/agents/5']));
      expect(lastBody(fetchMock)).toMatchObject({ inboxId: 2 });
    });

    it('keeps the agent and shows why when Delete is refused', async () => {
      const { fetchMock } = setup(enterprise(), '/admin/members/ai/5', (url, init) =>
        url === '/api/ai/agents/5' && init?.method === 'DELETE'
          ? json({ error: { code: 'last_agent', message: 'Last agent' } }, 409)
          : undefined,
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Delete agent' }));
      const confirm = await screen.findByRole('alertdialog');
      await user.click(within(confirm).getByRole('button', { name: 'Delete agent' }));
      expect(await screen.findByText('You cannot delete the only AI agent.')).toBeTruthy();
      expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/5');
      expect(writeLines(fetchMock)).toEqual(['DELETE /api/ai/agents/5']);
    });

    it('says when the agent answers no inbox', async () => {
      setup(
        enterprise({
          agents: [agentStatus(5, { inboxId: null })],
          inboxes: [{ id: 1, name: 'Sales line', aiAgentId: null }],
        }),
      );
      expect(await screen.findByText('No inbox')).toBeTruthy();
    });

    it('Delete names the item count, deletes and goes back to Members', async () => {
      const { fetchMock } = setup(enterprise());
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Delete agent' }));
      const confirm = await screen.findByRole('alertdialog');
      expect(within(confirm).getByText('Delete Sales Assistant?')).toBeTruthy();
      expect(within(confirm).getByText(/Its 2 Business context/)).toBeTruthy();
      await user.click(within(confirm).getByRole('button', { name: 'Delete agent' }));
      await waitFor(() =>
        expect(screen.getByTestId('location').textContent).toBe('/admin/members'),
      );
      expect(writeLines(fetchMock)).toEqual(['DELETE /api/ai/agents/5']);
    });
  });

  describe('Edit with AI', () => {
    const card = (title: string) =>
      screen
        .getByText(title, { selector: '[data-slot="card-title"]' })
        .closest('[data-slot="card"]')!;

    it("rewrites the hand-over rules with the agent's route and preset, without saving", async () => {
      const { fetchMock } = setup(
        world({
          agents: [agentStatus(5, { preset: 'faq' }, { handoffRules: 'Hand off complaints.' })],
        }),
        undefined,
        (url, init) =>
          url === '/api/ai/agents/5/edit' && init?.method === 'POST'
            ? json({ ok: true, text: 'Hand off complaints.\nHand off refunds.', error: null })
            : undefined,
      );
      const user = userEvent.setup();
      await screen.findByText('Business context');
      await user.click(
        within(card('Hand-over rules') as HTMLElement).getByRole('button', {
          name: 'Edit with AI',
        }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('What should change?'), 'Add refunds');
      await user.click(within(dialog).getByRole('button', { name: 'Suggest' }));
      await within(dialog).findByText('Suggested hand-off rules');
      const sent = fetchMock.mock.calls.find((call) => call[0] === '/api/ai/agents/5/edit')!;
      expect(JSON.parse(String(sent[1]!.body))).toMatchObject({ preset: 'faq' });
      await user.click(within(dialog).getByRole('button', { name: 'Apply to hand-off rules' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect((screen.getByLabelText('Hand-over rules') as HTMLTextAreaElement).value).toBe(
        'Hand off complaints.\nHand off refunds.',
      );
      expect(screen.getByText('Unsaved')).toBeTruthy();
      expect(writeLines(fetchMock)).toEqual(['POST /api/ai/agents/5/edit']);
    });

    it('is disabled with the reason while the AI is not connected', async () => {
      const w = world();
      w.connected = false;
      setup(w);
      await screen.findByText('Business context');
      const buttons = screen.getAllByRole('button', { name: 'Edit with AI' });
      expect(buttons).toHaveLength(2);
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
        const describedBy = button.getAttribute('aria-describedby') ?? '';
        expect(document.getElementById(describedBy)?.textContent).toBe(
          'Connect the AI above to use Edit with AI.',
        );
      }
    });
  });

  it('shows the never-edited defaults in the admin language (Malay)', async () => {
    await activateLocale('ms');
    try {
      setup();
      const rules = (await screen.findByLabelText(
        msAdmin.ai.agents.handoffTitle,
      )) as HTMLTextAreaElement;
      expect(rules.value).toBe(msAdmin.ai.defaults.sales.handoffRules);
      expect(screen.getByDisplayValue(/PERANAN/)).toBeTruthy();
      expect(screen.queryByText('Unsaved')).toBeNull();
    } finally {
      await activateLocale('en');
    }
  });
});

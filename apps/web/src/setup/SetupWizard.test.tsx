import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  DEFAULT_AI_HANDOFF_RULES,
  DEFAULT_AI_INSTRUCTIONS,
  type AiMemberBody,
  type AiMemberStatus,
} from '@ezychat/shared';
import { SetupWizard } from './SetupWizard';
import { AiAssistantStep } from './AiAssistantStep';
import { agentNameFor } from './agent-name';
import { usernameFrom } from './username';

// The connect card is its own component (tested with the admin pages); here it only has to render.
vi.mock('@/admin/AiQuickConnect', () => ({
  AiQuickConnect: () => <div data-testid="quick-connect" />,
}));

function json(data: unknown, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
}

function aiStatus(ready: boolean): AiMemberStatus {
  return {
    hasClaudeApiKey: false,
    member: null,
    settings: {
      displayName: 'AI assistant',
      enabled: false,
      mode: 'api',
      model: '',
      instructions: '',
    },
    hasApiKey: ready,
    connection: { state: 'signed_out', loginUrl: null, error: null },
    documents: [],
    agents: [],
    maxAgents: 1,
  };
}

type Call = { url: string; method: string; body: unknown };

/** The agent `PUT /api/ai` ensures (inbox 1's), and another agent the wizard must never use. */
const DEFAULT_AGENT = {
  id: 7,
  userId: 9,
  displayName: 'Kedai Aisyah AI',
  enabled: false,
  preset: 'sales' as const,
  inboxId: 1,
  documentCount: 0,
  answerDirect: true,
  groupCount: 0,
};
const OTHER_AGENT = { ...DEFAULT_AGENT, id: 8, userId: 10, displayName: 'FAQ', inboxId: 2 };
const AI_USER = {
  id: 9,
  username: 'ai-assistant',
  displayName: 'Kedai Aisyah AI',
  role: 'agent' as const,
  mustChangePassword: false,
  disabled: true,
  createdAt: 1_700_000_000_000,
  locale: null,
  kind: 'ai' as const,
  aiRole: 'sales' as const,
  aiAgentId: 7,
};

/** Fake server: setup, WhatsApp (linked) and the AI endpoints the wizard uses. */
function stubServer(
  opts: {
    aiReady?: boolean;
    failText?: boolean;
    /** What `PUT /api/ai` answers: the member's agent among two (default), only one, or none. */
    saved?: 'member' | 'only' | 'none';
  } = {},
) {
  const calls: Call[] = [];
  let ai = aiStatus(opts.aiReady ?? false);
  let textFailures = opts.failText ? 1 : 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/setup/status') return json({ needsSetup: true });
    if (url === '/api/setup/admin' && method === 'POST') return json({ ok: true });
    if (url === '/api/me') return json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    if (url === '/api/wa/status')
      return json({ state: 'open', me: null, qr: null, lastError: null });
    if (url === '/api/ai' && method === 'GET') return json(ai);
    if (url === '/api/ai' && method === 'PUT') {
      const b = body as AiMemberBody;
      // Idempotent: the same default agent every time (created on the first save only).
      const saved = opts.saved ?? 'member';
      ai = {
        ...ai,
        member: saved === 'member' ? AI_USER : null,
        settings: { ...ai.settings, ...b },
        agents:
          saved === 'member'
            ? [OTHER_AGENT, DEFAULT_AGENT]
            : saved === 'only'
              ? [DEFAULT_AGENT]
              : [],
        maxAgents: 2,
      };
      return json(ai);
    }
    if (url === '/api/ai/documents/text' && method === 'POST') return json(ai);
    if (url === '/api/ai/agents/7/documents/text' && method === 'POST') {
      if (textFailures > 0) {
        textFailures -= 1;
        return json({ error: { code: 'internal', message: 'Disk full' } }, 500);
      }
      return json({ agent: DEFAULT_AGENT, settings: ai.settings, documents: [] });
    }
    return json({ error: { code: 'not_found', message: `unexpected ${method} ${url}` } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWizard() {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={['/setup']}>
        <SetupWizard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderAiStep(
  onDone: (on: boolean) => void,
  businessName = 'Kedai Aisyah',
  qc: QueryClient = client(),
) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AiAssistantStep businessName={businessName} onDone={onDone} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('usernameFrom', () => {
  it('turns a name into a lowercase sign-in name with allowed characters only', () => {
    expect(usernameFrom('Aisyah Rahman')).toBe('aisyah.rahman');
    expect(usernameFrom('  José   Ñúñez ')).toBe('jose.nunez');
    expect(usernameFrom("O'Brien & Co.")).toBe('obrien.co');
    expect(usernameFrom('a'.repeat(40))).toHaveLength(32);
  });

  it('never ends with a dot after cutting a long name', () => {
    const name = usernameFrom('Nurul Aisyah binti Abdul Rahman Al-Haddad Muhammad Iskandar');
    expect(name).toBe('nurul.aisyah.binti.abdul.rahman');
    expect(name).toMatch(/^[a-z0-9_.-]{3,32}$/);
  });

  it('picks admin when the name gives too few letters (e.g. Chinese) and stays empty without a name', () => {
    expect(usernameFrom('陈伟')).toBe('admin');
    expect(usernameFrom('Jo')).toBe('admin');
    expect(usernameFrom('   ')).toBe('');
  });
});

describe('agentNameFor', () => {
  const en = (business: string) => `${business} AI`;
  const ms = (business: string) => `AI ${business}`;

  it('keeps a short name whole', () => {
    expect(agentNameFor('Kedai Aisyah', en)).toBe('Kedai Aisyah AI');
  });

  it('shortens a long business at a word and keeps the AI part, within 64 characters', () => {
    const long =
      'Kedai Runcit dan Kopitiam Keluarga Sri Bintang Sentosa Enterprise Sdn Bhd (Cawangan Seksyen 13)';
    const name = agentNameFor(long, en);
    expect(name).toBe('Kedai Runcit dan Kopitiam Keluarga Sri Bintang Sentosa AI');
    expect(name.length).toBeLessThanOrEqual(64);
    const malay = agentNameFor(long, ms);
    expect(malay.startsWith('AI Kedai Runcit')).toBe(true);
    expect(malay.length).toBeLessThanOrEqual(64);
    expect(malay.endsWith(' ')).toBe(false);
  });

  it('cuts a name without spaces (CJK) to fit', () => {
    const name = agentNameFor('茶'.repeat(80), en);
    expect(name).toBe(`${'茶'.repeat(61)} AI`);
  });
});

describe('SetupWizard account step', () => {
  it('needs a business name, fills the username from your name and sends the admin', async () => {
    const calls = stubServer();
    renderWizard();
    const user = userEvent.setup();
    const submit = await screen.findByRole('button', { name: 'Continue' });
    expect(screen.queryByLabelText('Confirm password')).toBeNull();

    await user.type(screen.getByLabelText('Your name'), 'Aisyah Rahman');
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('aisyah.rahman');
    await user.type(screen.getByLabelText('Password'), 'longpassword');
    // Business name is required.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Business name'), 'Kedai Aisyah');
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    await user.click(submit);
    await screen.findByText('WhatsApp linked');
    const post = calls.find((c) => c.url === '/api/setup/admin');
    // The business name stays in the wizard; the server contract is unchanged.
    expect(post?.body).toEqual({
      username: 'aisyah.rahman',
      displayName: 'Aisyah Rahman',
      password: 'longpassword',
    });
  });

  it('stops filling the username once it is edited and checks its characters', async () => {
    stubServer();
    renderWizard();
    const user = userEvent.setup();
    const username = (await screen.findByLabelText('Username')) as HTMLInputElement;
    await user.type(screen.getByLabelText('Your name'), 'Ali');
    expect(username.value).toBe('ali');
    await user.clear(username);
    await user.type(username, 'boss');
    await user.type(screen.getByLabelText('Your name'), ' Bin Abu');
    expect(username.value).toBe('boss');

    await user.clear(username);
    await user.type(username, 'no spaces');
    expect(screen.getByText(/3–32|3-32/)).toBeTruthy();

    // A cleared username explains why Continue is off.
    await user.clear(username);
    expect(screen.getByText(/3–32|3-32/)).toBeTruthy();
  });

  it('picks a username for a name in Chinese and says so', async () => {
    stubServer();
    renderWizard();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Business name'), '茶餐厅');
    await user.type(screen.getByLabelText('Your name'), '陈伟');
    await user.type(screen.getByLabelText('Password'), 'longpassword');
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('admin');
    expect(screen.getByText(/we picked one/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('rejects a short password', async () => {
    stubServer();
    renderWizard();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Business name'), 'Shop');
    await user.type(screen.getByLabelText('Your name'), 'Ali Baba');
    await user.type(screen.getByLabelText('Password'), 'short');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('walks WhatsApp → AI assistant (skipped) → Ready with teammate and phone links', async () => {
    stubServer();
    renderWizard();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Business name'), 'Kedai Aisyah');
    await user.type(screen.getByLabelText('Your name'), 'Aisyah');
    await user.type(screen.getByLabelText('Password'), 'longpassword');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('WhatsApp linked');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'AI assistant' })).toBeTruthy();
    await screen.findByTestId('quick-connect');
    const text = screen.getByLabelText('About your business') as HTMLTextAreaElement;
    expect(text.value.startsWith('Kedai Aisyah\n')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(await screen.findByText('Your inbox is ready')).toBeTruthy();
    expect(
      screen.getByText('AI assistant is off. Set it up any time from the inbox.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add teammates' }).getAttribute('href')).toBe(
      '/admin/members',
    );
    expect(
      screen.getByRole('link', { name: 'Use on phones outside this Wi-Fi' }).getAttribute('href'),
    ).toBe('/admin/tunnel');
    expect(screen.getByRole('button', { name: 'Go to inbox' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/cloudflare/i);
  });
});

describe('AiAssistantStep', () => {
  it('refuses the untouched template and saves nothing', async () => {
    const calls = stubServer({ aiReady: true });
    const onDone = vi.fn();
    renderAiStep(onDone);
    const user = userEvent.setup();
    await screen.findByTestId('quick-connect');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(
      await screen.findByText(
        'Fill in a few details about your business first, or choose Skip for now.',
      ),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('saves the Sales Agent, the business text and turns it on when connected', async () => {
    const calls = stubServer({ aiReady: true });
    const onDone = vi.fn();
    const qc = client();
    const refresh = vi.spyOn(qc, 'invalidateQueries');
    renderAiStep(onDone, undefined, qc);
    const user = userEvent.setup();
    const turnOn = await screen.findByRole('switch', { name: 'Turn on the AI assistant now' });
    expect(turnOn.getAttribute('aria-checked')).toBe('true');
    await user.type(screen.getByLabelText('About your business'), 'Teh tarik RM4');
    await user.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT /api/ai',
      'POST /api/ai/agents/7/documents/text',
      'PUT /api/ai',
    ]);
    expect(writes[0]?.body).toEqual({
      displayName: 'Kedai Aisyah AI',
      enabled: false,
      instructions: DEFAULT_AI_INSTRUCTIONS,
      handoffRules: DEFAULT_AI_HANDOFF_RULES,
    });
    const textBody = writes[1]?.body as { name: string; text: string };
    expect(textBody.name).toBe('About the business');
    expect(textBody.text).toMatch(/^Kedai Aisyah\n[\s\S]*Teh tarik RM4$/);
    expect((writes[2]?.body as AiMemberBody).enabled).toBe(true);
    // Members and the agent page show the agent as saved last (turned on).
    expect(refresh).toHaveBeenCalledWith({ queryKey: ['ai-agents'] });
    expect(refresh).toHaveBeenCalledWith({ queryKey: ['ai-agent'] });
  });

  it('leaves the agent off when the owner switches it off', async () => {
    const calls = stubServer({ aiReady: true });
    const onDone = vi.fn();
    renderAiStep(onDone);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Turn on the AI assistant now' }));
    await user.type(screen.getByLabelText('About your business'), 'Open 9-5');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('saves the text but keeps the AI off when it is not connected', async () => {
    const calls = stubServer({ aiReady: false });
    const onDone = vi.fn();
    renderAiStep(onDone);
    const user = userEvent.setup();
    await screen.findByTestId('quick-connect');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText(/stays off until it is connected/)).toBeTruthy();
    await user.type(screen.getByLabelText('About your business'), 'Open 9-5');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT /api/ai',
      'POST /api/ai/agents/7/documents/text',
    ]);
  });

  it('retried after a failed item step, saves the same agent again and never creates one', async () => {
    const calls = stubServer({ aiReady: false, failText: true });
    const onDone = vi.fn();
    renderAiStep(onDone);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('About your business'), 'Open 9-5');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByText('Disk full')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);
    expect(writes).toEqual([
      'PUT /api/ai',
      'POST /api/ai/agents/7/documents/text',
      'PUT /api/ai',
      'POST /api/ai/agents/7/documents/text',
    ]);
    expect(calls.some((c) => c.url === '/api/ai/agents' && c.method === 'POST')).toBe(false);
  });

  it.each([
    ['the only agent', 'only' as const, 'POST /api/ai/agents/7/documents/text'],
    ['the old route on a server without agents', 'none' as const, 'POST /api/ai/documents/text'],
  ])('adds the text to %s', async (_label, saved, route) => {
    const calls = stubServer({ aiReady: false, saved });
    const onDone = vi.fn();
    renderAiStep(onDone);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('About your business'), 'Open 9-5');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect(calls.filter((c) => c.method === 'POST').map((c) => `${c.method} ${c.url}`)).toEqual([
      route,
    ]);
  });

  it('shows a failed save and can retry', async () => {
    const calls = stubServer({ aiReady: true, failText: true });
    const onDone = vi.fn();
    renderAiStep(onDone);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('About your business'), 'Open 9-5');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByText('Disk full')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(calls.filter((c) => c.url === '/api/ai/agents/7/documents/text')).toHaveLength(2);
  });

  it('Skip for now saves nothing', async () => {
    const calls = stubServer({ aiReady: true });
    const onDone = vi.fn();
    renderAiStep(onDone);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(onDone).toHaveBeenCalledWith(false);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

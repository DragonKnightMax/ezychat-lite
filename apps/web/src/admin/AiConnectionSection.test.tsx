import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AiMemberStatus } from '@ezychat/shared';
import { AiConnectionSection } from './AiConnectionSection';
import { activateLocale } from '../i18n';

function status(): AiMemberStatus {
  return {
    member: null,
    settings: {
      displayName: 'Sales Assistant',
      enabled: false,
      mode: 'api',
      model: '',
      instructions: '',
    },
    hasApiKey: true,
    hasClaudeApiKey: false,
    connection: { state: 'signed_out', loginUrl: null, error: null },
    documents: [],
    agents: [],
    maxAgents: 1,
  };
}
function json(data: unknown, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
}
function setup(
  initial = status(),
  respond?: (url: string, init?: RequestInit) => Response | undefined,
) {
  let current = initial;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = respond?.(url, init);
    if (custom) return custom;
    if (url === '/api/ai/connection' && init?.method === 'PATCH') {
      const { apiKey, ...settings } = JSON.parse(String(init.body));
      current = {
        ...current,
        settings: { ...current.settings, ...settings },
        hasApiKey: current.hasApiKey || (settings.mode === 'api' && Boolean(apiKey)),
        hasClaudeApiKey: current.hasClaudeApiKey || (settings.mode === 'claude' && Boolean(apiKey)),
      };
      return json(current);
    }
    if (url === '/api/ai') return json(current);
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AiConnectionSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, setStatus: (next: AiMemberStatus) => void (current = next) };
}
const patchBody = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')![1]!.body));

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
afterEach(async () => {
  cleanup();
  await activateLocale('en');
  vi.unstubAllGlobals();
});

describe('Settings → AI connection (inline)', () => {
  it('edits in place with one Save and an Unsaved marker', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Advanced: choose a model' }));
    const model = screen.getByLabelText('Model (optional)');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Unsaved')).toBeNull();
    await user.type(model, 'gpt-4.1-mini');
    expect(screen.getByText('Unsaved')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull());
    expect(patchBody(fetchMock)).toEqual({ mode: 'api', model: 'gpt-4.1-mini' });
  });

  it('shows a saved API key as a read-only status with Replace', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    expect(await screen.findByText('OpenAI API key is saved.')).toBeTruthy();
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    await user.type(screen.getByLabelText('OpenAI API key'), 'sk-new-key-1234567890');
    expect(screen.getByText('Unsaved')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep saved key' }));
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull();
    expect(screen.queryByText('Unsaved')).toBeNull();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('asks for a key directly when none is saved', async () => {
    setup({ ...status(), hasApiKey: false });
    expect(await screen.findByLabelText('OpenAI API key')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Replace key' })).toBeNull();
  });

  it('switches with option cards, lists ChatGPT first as recommended and offers Auto first', async () => {
    const initial = status();
    initial.settings.model = 'gpt-4.1-mini';
    const { fetchMock } = setup(initial, (url) =>
      url === '/api/ai/models'
        ? json({
            source: 'live',
            models: [
              { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
              { id: 'gpt-5.5', label: 'GPT-5.5' },
            ],
          })
        : undefined,
    );
    const user = userEvent.setup();
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'ChatGPTRecommendedYour ChatGPT account. Experimental.',
      'OpenAI API keyYour own key, billed by OpenAI.',
      'Claude API keyYour own key, billed by Anthropic.',
    ]);
    await user.click(screen.getByRole('radio', { name: /ChatGPT/ }));
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain(
      'Auto (recommended)',
    );
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Auto (recommended)',
        'GPT-6.1-Sol',
        'GPT-5.5',
      ]),
    );
    await user.click(screen.getByRole('option', { name: 'GPT-5.5' }));
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await waitFor(() =>
      expect(patchBody(fetchMock)).toEqual({ mode: 'chatgpt', model: 'gpt-5.5' }),
    );
  });

  it('signs in with one click: saves ChatGPT mode, starts sign-in and opens the page', async () => {
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    const open = vi.fn(() => tab);
    vi.stubGlobal('open', open);
    const loginUrl = 'https://auth.openai.com/oauth/authorize?state=test';
    const { fetchMock, setStatus } = setup(status(), (url, init) => {
      if (url === '/api/ai/chatgpt/login' && init?.method === 'POST') {
        const signingIn: AiMemberStatus = {
          ...status(),
          settings: { ...status().settings, mode: 'chatgpt' },
          connection: { state: 'signing_in', loginUrl, error: null },
        };
        setStatus(signingIn);
        return json(signingIn);
      }
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /ChatGPT/ }));
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    await waitFor(() => expect(tab.location.href).toBe(loginUrl));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    const writes = fetchMock.mock.calls.filter((call) => call[1]?.method !== 'GET');
    expect(writes.map((call) => `${call[1]?.method} ${call[0]}`)).toEqual([
      'PATCH /api/ai/connection',
      'POST /api/ai/chatgpt/login',
    ]);
  });

  it('falls back to an Open sign-in link when the browser blocks the tab', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    const initial = status();
    initial.settings.mode = 'chatgpt';
    const signingIn: AiMemberStatus = {
      ...initial,
      connection: {
        state: 'signing_in',
        loginUrl: 'https://auth.openai.com/oauth/authorize?state=test',
        error: null,
      },
    };
    setup(initial, (url, init) =>
      url === '/api/ai/chatgpt/login' && init?.method === 'POST' ? json(signingIn) : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));
    const link = await screen.findByRole('link', { name: 'Open sign-in' });
    expect(link.getAttribute('href')).toBe(signingIn.connection.loginUrl);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/blocked from opening/)).toBeTruthy();
  });

  it('finishes sign-in from a pasted address (admin on another computer)', async () => {
    const initial = status();
    initial.settings.mode = 'chatgpt';
    initial.connection = {
      state: 'signing_in',
      loginUrl: 'https://auth.openai.com/oauth/authorize?state=test',
      error: null,
    };
    const connected: AiMemberStatus = {
      ...initial,
      connection: { state: 'connected', loginUrl: null, error: null, email: 'owner@example.com' },
    };
    let done = false;
    const pasted = 'http://localhost:1455/auth/callback?code=abc&state=test';
    const { fetchMock } = setup(initial, (url, init) => {
      if (url === '/api/ai/chatgpt/callback' && init?.method === 'POST') {
        done = true;
        return json(connected);
      }
      if (url === '/api/ai' && done) return json(connected);
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Signing in on another computer?'), pasted);
    await user.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await screen.findByText('Signed in as owner@example.com');
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/ai/chatgpt/callback')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ url: pasted });
  });

  it('tests the saved connection and shows the reply and model', async () => {
    const initial = status();
    initial.settings.mode = 'chatgpt';
    initial.connection = { state: 'connected', loginUrl: null, error: null, email: null };
    setup(initial, (url, init) =>
      url === '/api/ai/chatgpt/test' && init?.method === 'POST'
        ? json({ ok: true, model: 'gpt-6.1-sol', reply: 'OK', error: null })
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    await screen.findByText('gpt-6.1-sol replied: OK');
  });

  it('shows one banner when the sign-in expired, with Sign in and Sign out', async () => {
    const initial = status();
    initial.settings.mode = 'chatgpt';
    initial.connection = {
      state: 'expired',
      loginUrl: null,
      error: 'ChatGPT sign-in expired. Sign in again.',
      email: 'owner@example.com',
    };
    setup(initial);
    expect(await screen.findByText('ChatGPT sign-in expired')).toBeTruthy();
    expect(screen.getByText('ChatGPT sign-in expired. Sign in again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('keeps the model typed for each mode while flipping, and clears Unsaved when back to saved', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Advanced: choose a model' }));
    await user.type(screen.getByLabelText('Model (optional)'), 'gpt-4.1-mini');
    expect(screen.getByText('Unsaved')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /ChatGPT/ }));
    await user.click(screen.getByRole('radio', { name: /^OpenAI API key/ }));
    expect(((await screen.findByLabelText('Model (optional)')) as HTMLInputElement).value).toBe(
      'gpt-4.1-mini',
    );
    await user.clear(screen.getByLabelText('Model (optional)'));
    expect(screen.queryByText('Unsaved')).toBeNull();
  });

  it('offers no Sign out or Test after a failed first sign-in (no tokens)', async () => {
    const initial = status();
    initial.settings.mode = 'chatgpt';
    initial.connection = { state: 'error', loginUrl: null, error: 'Sign-in failed', email: null };
    setup(initial);
    expect(await screen.findByText('ChatGPT connection stopped working')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  });

  it('shows the rate-limit message when starting sign-in is refused (429)', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ opener: {}, location: { href: '' }, close: vi.fn() })),
    );
    const initial = status();
    initial.settings.mode = 'chatgpt';
    setup(initial, (url, init) =>
      url === '/api/ai/chatgpt/login' && init?.method === 'POST'
        ? json({ error: { code: 'rate_limited', message: 'Too many attempts, retry in 30s' } }, 429)
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));
    await screen.findByText('Too many attempts. Try again in 30 s.');
  });

  it('shows the rate-limit message when the pasted address is refused (429)', async () => {
    const initial = status();
    initial.settings.mode = 'chatgpt';
    initial.connection = {
      state: 'signing_in',
      loginUrl: 'https://auth.openai.com/oauth/authorize?state=test',
      error: null,
    };
    setup(initial, (url, init) =>
      url === '/api/ai/chatgpt/callback' && init?.method === 'POST'
        ? json({ error: { code: 'rate_limited', message: 'Too many attempts, retry in 30s' } }, 429)
        : undefined,
    );
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText('Signing in on another computer?'),
      'http://localhost:1455/x',
    );
    await user.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await screen.findByText('Too many attempts. Try again in 30 s.');
  });

  it('shows a failed connection test', async () => {
    const initial = status();
    initial.settings.mode = 'chatgpt';
    initial.connection = { state: 'connected', loginUrl: null, error: null, email: 'a@b.co' };
    setup(initial, (url, init) =>
      url === '/api/ai/chatgpt/test' && init?.method === 'POST'
        ? json({ ok: false, model: null, reply: null, error: 'Model not available' })
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    await screen.findByText(/Model not available/);
  });

  it('keeps an unsaved draft while the language changes', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Advanced: choose a model' }));
    await user.type(screen.getByLabelText('Model (optional)'), 'gpt-4.1-mini');
    // The Malay catalog is lazy-loaded; under a full parallel test run that import can take seconds.
    await act(() => activateLocale('ms'));
    const model = await screen.findByLabelText('Model (pilihan)', undefined, { timeout: 10_000 });
    expect((model as HTMLInputElement).value).toBe('gpt-4.1-mini');
    await user.click(screen.getByRole('button', { name: 'Simpan sambungan AI' }));
    await waitFor(() =>
      expect(patchBody(fetchMock)).toEqual({ mode: 'api', model: 'gpt-4.1-mini' }),
    );
  }, 20_000);

  it('selects ChatGPT when the Recommended badge on its option is clicked', async () => {
    setup();
    const user = userEvent.setup();
    const chatgpt = await screen.findByRole('radio', { name: /ChatGPT/ });
    expect(chatgpt.getAttribute('aria-checked')).toBe('false');
    await user.click(screen.getByText('Recommended'));
    expect(chatgpt.getAttribute('aria-checked')).toBe('true');
  });

  it('tests a new API key before saving it and never saves a failing key', async () => {
    let verdict: { ok: boolean; error: string | null } = { ok: false, error: 'invalid_key' };
    const { fetchMock } = setup({ ...status(), hasApiKey: false }, (url, init) =>
      url === '/api/ai/connection/test' && init?.method === 'POST' ? json(verdict) : undefined,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('OpenAI API key'), 'sk-wrong-key-123');
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await screen.findByText('OpenAI did not accept this key. Check that you copied all of it.');
    const testCall = fetchMock.mock.calls.find((call) => call[0] === '/api/ai/connection/test');
    expect(JSON.parse(String(testCall![1]!.body))).toEqual({ apiKey: 'sk-wrong-key-123' });
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);

    verdict = { ok: true, error: null };
    const input = screen.getByLabelText('OpenAI API key');
    await user.clear(input);
    await user.type(input, 'sk-good-key-123');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByText('Key works.');
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await waitFor(() =>
      expect(patchBody(fetchMock)).toEqual({ mode: 'api', model: '', apiKey: 'sk-good-key-123' }),
    );
    // The key tested with Test key is not tested a second time on Save.
    expect(
      fetchMock.mock.calls.filter((call) => call[0] === '/api/ai/connection/test'),
    ).toHaveLength(2);
  });

  it('explains an unreachable or rate-limited key check', async () => {
    let error = 'unreachable';
    setup({ ...status(), hasApiKey: false }, (url, init) =>
      url === '/api/ai/connection/test' && init?.method === 'POST'
        ? json({ ok: false, error })
        : undefined,
    );
    const user = userEvent.setup();
    const input = await screen.findByLabelText('OpenAI API key');
    await user.type(input, 'sk-some-key-123');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByText(/Could not reach OpenAI to check the key/);
    error = 'rate_limited';
    await user.type(input, '4');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByText(/OpenAI is busy or this key has reached its limit/);
  });

  it('saves a restricted key anyway, but offers no Save anyway for a rejected key', async () => {
    let error = 'invalid_key';
    const { fetchMock } = setup({ ...status(), hasApiKey: false }, (url, init) =>
      url === '/api/ai/connection/test' && init?.method === 'POST'
        ? json({ ok: false, error })
        : undefined,
    );
    const user = userEvent.setup();
    const input = await screen.findByLabelText('OpenAI API key');
    await user.type(input, 'sk-restricted-123');
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await screen.findByText(/OpenAI did not accept this key/);
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();

    error = 'forbidden';
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByText(/OpenAI did not let this key list models/);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() =>
      expect(patchBody(fetchMock)).toEqual({ mode: 'api', model: '', apiKey: 'sk-restricted-123' }),
    );
  });

  it('links to a new agent once the connection is ready and no agent exists', async () => {
    setup();
    const link = await screen.findByRole('link', { name: 'Set up your AI agent' });
    expect(link.getAttribute('href')).toBe('/admin/members/ai/new');
    expect(screen.getByText('The AI connection is ready.')).toBeTruthy();
  });

  it("links to the agent's own page when there is one", async () => {
    setup({
      ...status(),
      agents: [
        {
          id: 5,
          userId: 9,
          displayName: 'Business AI',
          enabled: false,
          preset: 'sales',
          inboxId: 1,
          documentCount: 0,
          answerDirect: true,
          groupCount: 0,
        },
      ],
    });
    const link = await screen.findByRole('link', { name: 'Set up your AI agent' });
    expect(link.getAttribute('href')).toBe('/admin/members/ai/5');
  });

  it('opens Members with every agent when there are several', async () => {
    const agent = {
      id: 5,
      userId: 9,
      displayName: 'Business AI',
      enabled: false,
      preset: 'sales' as const,
      inboxId: 1,
      documentCount: 0,
      answerDirect: true,
      groupCount: 0,
    };
    setup({ ...status(), agents: [agent, { ...agent, id: 6, userId: 10, inboxId: 2 }] });
    const link = await screen.findByRole('link', { name: 'Open AI agents' });
    expect(link.getAttribute('href')).toBe('/admin/members');
    expect(screen.queryByRole('link', { name: 'Set up your AI agent' })).toBeNull();
    expect(screen.getByText(/shared by all your AI agents/)).toBeTruthy();
  });

  it('hides the agent link while nothing is connected', async () => {
    setup({ ...status(), hasApiKey: false });
    await screen.findByLabelText('OpenAI API key');
    expect(screen.queryByRole('link', { name: 'Set up your AI agent' })).toBeNull();
  });
});

describe('Settings → AI connection: Claude API key', () => {
  const claudeStatus = (): AiMemberStatus => ({
    ...status(),
    settings: { ...status().settings, mode: 'claude', model: '' },
    hasClaudeApiKey: true,
    connection: { state: 'connected', loginUrl: null, error: null },
  });

  it('asks for an Anthropic key, tests it with Anthropic and saves Claude with the chosen model', async () => {
    const { fetchMock } = setup(status(), (url, init) =>
      url === '/api/ai/connection/test' && init?.method === 'POST'
        ? json({ ok: true, error: null })
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Claude API key/ }));
    expect(
      screen.getByText('Starts with sk-ant-. Stored securely on the inbox server.'),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Get a key at console.anthropic.com' });
    expect(link.getAttribute('href')).toBe('https://console.anthropic.com/settings/keys');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/Voice notes use the on-device model with Claude/)).toBeTruthy();
    const model = screen.getByRole('combobox', { name: 'Claude model' });
    expect(model.textContent).toContain('Claude Sonnet 5.5 (recommended)');
    await user.click(model);
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Claude Sonnet 5.5 (recommended)',
        'Claude Opus 5.5',
        'Claude Haiku 5.5',
      ]),
    );
    await user.click(screen.getByRole('option', { name: 'Claude Opus 5.5' }));
    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-good-key');
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await waitFor(() =>
      expect(patchBody(fetchMock)).toEqual({
        mode: 'claude',
        model: 'claude-opus-5-5',
        apiKey: 'sk-ant-good-key',
      }),
    );
    const testCall = fetchMock.mock.calls.find((call) => call[0] === '/api/ai/connection/test');
    expect(JSON.parse(String(testCall![1]!.body))).toEqual({
      apiKey: 'sk-ant-good-key',
      mode: 'claude',
    });
  });

  it('needs an Anthropic key before Claude can be saved the first time', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Claude API key/ }));
    expect(screen.getByText('Unsaved')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await screen.findByText('Enter your Anthropic API key.');
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('keeps both saved keys when switching between Claude and OpenAI', async () => {
    const { fetchMock } = setup({ ...claudeStatus(), hasApiKey: true });
    const user = userEvent.setup();
    expect(await screen.findByText('Anthropic API key is saved.')).toBeTruthy();
    expect(screen.getByText('The AI connection is ready.')).toBeTruthy();
    expect(screen.queryByLabelText('Anthropic API key')).toBeNull();
    // Cloud voice has no OpenAI key to use under Claude.
    expect(screen.getByText(/Voice notes use the on-device model with Claude/)).toBeTruthy();
    // The connection test is a ChatGPT sign-in check only.
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: /^OpenAI API key/ }));
    expect(screen.getByText('OpenAI API key is saved.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await waitFor(() => expect(patchBody(fetchMock)).toEqual({ mode: 'api', model: '' }));
  });

  it('replaces a saved Claude key, or keeps it', async () => {
    const { fetchMock } = setup(claudeStatus(), (url, init) =>
      url === '/api/ai/connection/test' && init?.method === 'POST'
        ? json({ ok: true, error: null })
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Replace key' }));
    expect(screen.getByText('Enter the new key. Leave blank to keep the saved one.')).toBeTruthy();
    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-next');
    await user.click(screen.getByRole('button', { name: 'Keep saved key' }));
    expect(screen.queryByLabelText('Anthropic API key')).toBeNull();
    expect(screen.queryByText('Unsaved')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-next');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByText('Key works.');
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await waitFor(() =>
      expect(patchBody(fetchMock)).toEqual({ mode: 'claude', model: '', apiKey: 'sk-ant-next' }),
    );
    expect(
      fetchMock.mock.calls.filter((call) => call[0] === '/api/ai/connection/test'),
    ).toHaveLength(1);
  });

  it('points an OpenAI key in the Anthropic field to the OpenAI option and never tests it', async () => {
    const { fetchMock } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Claude API key/ }));
    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-proj-openai-key');
    await user.click(screen.getByRole('button', { name: 'Save AI connection' }));
    await screen.findByText(/This is an OpenAI key/);
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/ai/connection/test')).toBe(false);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('names Anthropic in a failed check and saves anyway when it was only unreachable', async () => {
    let error = 'invalid_key';
    const { fetchMock } = setup(status(), (url, init) =>
      url === '/api/ai/connection/test' && init?.method === 'POST'
        ? json({ ok: false, error })
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Claude API key/ }));
    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-key-1');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByText(/Anthropic did not accept this key/);
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();

    for (const [code, text] of [
      ['forbidden', /Anthropic did not let this key list models/],
      ['rate_limited', /Anthropic is busy or this key has reached its limit/],
      ['unreachable', /Could not reach Anthropic to check the key/],
    ] as const) {
      error = code;
      await user.click(screen.getByRole('button', { name: 'Test key' }));
      await screen.findByText(text);
    }
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() =>
      expect(patchBody(fetchMock)).toEqual({ mode: 'claude', model: '', apiKey: 'sk-ant-key-1' }),
    );
  });

  it('points a Claude key in the OpenAI field to the Claude option', async () => {
    const { fetchMock } = setup({ ...status(), hasApiKey: false });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('OpenAI API key'), 'sk-ant-claude-key');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    expect(await screen.findByText(/This is a Claude \(Anthropic\) key/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/connection/test')).toBe(false);
  });
});

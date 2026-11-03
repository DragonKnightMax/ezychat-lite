import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AiGroupChat, AiGroupChatBody } from '@ezychat/shared';
import { GroupAiBadge, GroupAiRow } from './GroupAiRow';

const GROUP = '120363000000000001@g.us';
const URL = `/api/chats/${encodeURIComponent(GROUP)}/ai-group`;

const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

const state = (patch: Partial<AiGroupChat> = {}): AiGroupChat => ({
  enabled: false,
  agentId: 3,
  agentName: 'Aina',
  agentEnabled: true,
  agentAnswersGroups: true,
  paused: false,
  listen: false,
  agents: [],
  ...patch,
});
const TWO = [
  { id: 3, name: 'Aina' },
  { id: 7, name: 'Claims agent' },
];

type Call = { url: string; method: string; body: unknown };

function stubServer(start: AiGroupChat | null, putCode = 200) {
  let current = start;
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url !== URL || !current)
        return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
      if (method === 'PUT') {
        if (putCode !== 200)
          return json({ error: { code: 'forbidden', message: 'Admins only' } }, putCode);
        const put = body as AiGroupChatBody;
        const agent = current.agents.find((a) => a.id === put.agentId);
        current = {
          ...current,
          enabled: put.enabled,
          listen: put.listen ?? current.listen,
          ...(agent && { agentId: agent.id, agentName: agent.name, agentAnswersGroups: true }),
        };
      }
      return json(current);
    }),
  );
  return calls;
}

function renderRow(isAdmin: boolean) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GroupAiRow jid={GROUP} isAdmin={isAdmin} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TITLE = 'AI agent in this group';

beforeAll(() => {
  // Radix Select uses pointer capture and scrollIntoView, which jsdom lacks.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Group info → AI agent row', () => {
  it('lets an admin switch the group on with a PUT of only { enabled }', async () => {
    const calls = stubServer(state());
    renderRow(true);
    const sw = await screen.findByRole('switch', { name: TITLE });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByText(
        'Aina answers only when a member @mentions your number or quotes an AI message.',
      ),
    ).toBeTruthy();
    await userEvent.setup().click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      url: URL,
      method: 'PUT',
      body: { enabled: true },
    });
    expect(screen.queryByText('Only admins can change this.')).toBeNull();
  });

  it('shows agents the state read only', async () => {
    stubServer(state({ enabled: true }));
    renderRow(false);
    expect((await screen.findByTestId('group-ai-state')).textContent).toBe('On');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Only admins can change this.')).toBeTruthy();
    expect(screen.getByRole('region', { name: TITLE })).toBeTruthy();
  });

  it('shows Off to agents while the agent does not answer groups', async () => {
    stubServer(state({ enabled: true, agentAnswersGroups: false }));
    renderRow(false);
    expect((await screen.findByTestId('group-ai-state')).textContent).toBe('Off');
    // Agents get no link to the agent page.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it("is disabled with a hint and a link while the agent's Answer in groups is off", async () => {
    stubServer(state({ enabled: true, agentAnswersGroups: false }));
    renderRow(true);
    const sw = await screen.findByRole('switch', { name: TITLE });
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByText(/Answer in groups is off for Aina. Turn it on on the agent page first./),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Aina' }).getAttribute('href')).toBe(
      '/admin/members/ai/3',
    );
  });

  it('says the agent itself is off (before its Answer in groups switch)', async () => {
    stubServer(state({ enabled: true, agentEnabled: false, agentAnswersGroups: false }));
    renderRow(true);
    const sw = await screen.findByRole('switch', { name: TITLE });
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText(/Aina is off. Nothing is answered in groups until you turn Aina on./),
    ).toBeTruthy();
    expect(screen.queryByText(/Answer in groups is off/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Aina' }).getAttribute('href')).toBe(
      '/admin/members/ai/3',
    );
  });

  it('says when no AI agent works in the inbox', async () => {
    stubServer(state({ agentId: null, agentName: null, agentAnswersGroups: false }));
    renderRow(true);
    expect(await screen.findByText('No AI agent works in this inbox.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: TITLE }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('explains the loop guard pause', async () => {
    stubServer(state({ enabled: true, paused: true }));
    renderRow(true);
    expect(
      await screen.findByText(
        'Paused: many answers in a row. A teammate’s message starts it again.',
      ),
    ).toBeTruthy();
  });

  it('keeps the switch when the save is refused', async () => {
    const calls = stubServer(state(), 403);
    renderRow(true);
    const sw = await screen.findByRole('switch', { name: TITLE });
    await userEvent.setup().click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('renders nothing when the server has no answer for the group', async () => {
    const calls = stubServer(null);
    const { container } = renderRow(true);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });

  it('hides the agent choice with one group agent and sends it when switching on', async () => {
    const calls = stubServer(
      state({ agentId: null, agentName: null, agents: [{ id: 7, name: 'Claims agent' }] }),
    );
    renderRow(true);
    const sw = await screen.findByRole('switch', { name: TITLE });
    expect(screen.queryByTestId('group-ai-agent')).toBeNull();
    expect(
      screen.getByText(
        'Claims agent answers only when a member @mentions your number or quotes an AI message.',
      ),
    ).toBeTruthy();
    await userEvent.setup().click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true, agentId: 7 });
  });

  it('asks for an agent first with 2+ group agents, then switches on with the chosen one', async () => {
    const calls = stubServer(state({ agentId: null, agentName: null, agents: TWO }));
    renderRow(true);
    const sw = await screen.findByRole('switch', { name: TITLE });
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Choose the AI agent for this group, then switch it on.')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Agent' }));
    await user.click(await screen.findByRole('option', { name: 'Claims agent' }));
    // Choosing while off saves nothing yet.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(sw.hasAttribute('disabled')).toBe(false);
    await user.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true, agentId: 7 });
    expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toBe('Claims agent');
  });

  it('moves a switched-on group to another agent at once', async () => {
    const calls = stubServer(state({ enabled: true, agents: TWO }));
    renderRow(true);
    const user = userEvent.setup();
    const select = await screen.findByRole('combobox', { name: 'Agent' });
    expect(select.textContent).toBe('Aina');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Claims agent' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { enabled: true, agentId: 7 },
      ]),
    );
  });

  it('switches Reads every message for the group with its agent, and explains it', async () => {
    const calls = stubServer(state({ enabled: true }));
    renderRow(true);
    const listen = await screen.findByRole('switch', { name: 'Reads every message' });
    expect(listen.getAttribute('aria-checked')).toBe('false');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'What is Reads every message?' }));
    expect(await screen.findByText(/The agent sees every member message/)).toBeTruthy();
    await user.click(listen);
    await waitFor(() => expect(listen.getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      enabled: true,
      agentId: 3,
      listen: true,
    });
    expect(
      screen.getByText('Aina reads every member message and follows its instructions.'),
    ).toBeTruthy();
  });

  it('hides Reads every message while the group is off and from agents', async () => {
    stubServer(state());
    renderRow(true);
    await screen.findByRole('switch', { name: TITLE });
    expect(screen.queryByTestId('group-ai-listen')).toBeNull();
    cleanup();
    stubServer(state({ enabled: true, listen: true, agents: TWO }));
    renderRow(false);
    expect(
      await screen.findByText('Aina reads every member message and follows its instructions.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('group-ai-listen')).toBeNull();
    expect(screen.queryByTestId('group-ai-agent')).toBeNull();
  });
});

describe('GroupAiBadge', () => {
  it('shows only while the AI answers the group, and says when it is paused', () => {
    const { rerender, container } = render(<GroupAiBadge ai={state({ enabled: true })} />);
    expect(screen.getByTestId('group-ai-badge').textContent).toBe(
      'AI answers when tagged or quoted',
    );
    rerender(<GroupAiBadge ai={state({ enabled: true, listen: true })} />);
    expect(screen.getByTestId('group-ai-badge').textContent).toBe('AI reads every message');
    rerender(<GroupAiBadge ai={state({ enabled: true, paused: true })} />);
    expect(screen.getByTestId('group-ai-badge').textContent).toBe('AI paused');
    rerender(<GroupAiBadge ai={state({ enabled: true, agentAnswersGroups: false })} />);
    expect(container.textContent).toBe('');
    rerender(<GroupAiBadge ai={state()} />);
    expect(container.textContent).toBe('');
    rerender(<GroupAiBadge ai={null} />);
    expect(container.textContent).toBe('');
  });
});

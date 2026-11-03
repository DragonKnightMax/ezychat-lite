import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentStatus, AiAgentSummary } from '@ezychat/shared';
import {
  aiAgentKey,
  aiAgentsKey,
  aiMemberKey,
  BatchDeleteError,
  useAiAgent,
  useAiAgentAction,
  useAiAgentDocument,
  useAiAgents,
  useAiEdit,
  useAiTry,
} from './ai';
import { qk } from './queries';

const summary = (fields: Partial<AiAgentSummary> = {}): AiAgentSummary => ({
  id: 3,
  userId: 9,
  displayName: 'Help desk',
  enabled: false,
  preset: 'faq',
  inboxId: 2,
  documentCount: 0,
  answerDirect: true,
  groupCount: 0,
  ...fields,
});
const agentStatus = (fields: Partial<AiAgentSummary> = {}): AiAgentStatus => ({
  agent: summary(fields),
  settings: {
    displayName: fields.displayName ?? 'Help desk',
    enabled: false,
    mode: 'api',
    model: '',
    instructions: 'Answer questions.',
    handoffRules: '',
  },
  documents: [],
});
const inbox = (id: number, aiAgentId: number | null) => ({
  id,
  name: `Inbox ${id}`,
  tone: 'primary',
  number: null,
  status: { state: 'open', me: null, qr: null, lastError: null },
  removed: false,
  aiAgentId,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[] = [];
/** Answers each request with the first matching route; unmatched → 500. */
let routes: Array<[method: string, path: string, answer: () => [number, unknown]]> = [];

beforeEach(() => {
  calls = [];
  routes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace(/^\/api/, '');
      const body =
        init.body instanceof FormData
          ? [...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name])
          : init.body
            ? JSON.parse(String(init.body))
            : undefined;
      calls.push({ method, path, body });
      const route = routes.find(([m, p]) => m === method && p === path);
      const [status, data] = route ? route[2]() : [500, { error: { code: 'x', message: 'x' } }];
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated: unknown[] = [];
  const original = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = ((filters?: Parameters<typeof original>[0]) => {
    invalidated.push(filters?.queryKey);
    return original(filters);
  }) as typeof qc.invalidateQueries;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return { qc, invalidated, wrapper };
}

describe('agent queries', () => {
  it('lists the agents with the edition limit', async () => {
    routes.push(['GET', '/ai/agents', () => [200, { agents: [summary()], maxAgents: 3 }]]);
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiAgents(), { wrapper });
    await waitFor(() => expect(result.current.data?.maxAgents).toBe(3));
    expect(result.current.data?.agents[0]?.preset).toBe('faq');
  });

  it('reads one agent, and nothing for a new one', async () => {
    routes.push(['GET', '/ai/agents/3', () => [200, agentStatus()]]);
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiAgent(3), { wrapper });
    await waitFor(() => expect(result.current.data?.agent.id).toBe(3));
    const empty = renderHook(() => useAiAgent(null), { wrapper });
    expect(empty.result.current.fetchStatus).toBe('idle');
    expect(calls.map((c) => c.path)).toEqual(['/ai/agents/3']);
  });

  it("reads an item under its agent's path", async () => {
    routes.push([
      'GET',
      '/ai/agents/3/documents/7',
      () => [
        200,
        {
          id: 7,
          name: 'Lowest prices',
          kind: 'text',
          size: 5,
          characters: 5,
          createdAt: 1,
          updatedAt: 1,
          internal: true,
          text: 'RM 10',
          truncated: false,
        },
      ],
    ]);
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiAgentDocument(3, 7), { wrapper });
    await waitFor(() => expect(result.current.data?.internal).toBe(true));
  });
});

describe('useAiAgentAction', () => {
  const EVERYTHING = [aiAgentsKey, ['ai-agent'], aiMemberKey, qk.users, qk.inboxes];

  it('saves the agent, caches it and refreshes every view of agents', async () => {
    routes.push(['PUT', '/ai/agents/3', () => [200, agentStatus({ displayName: 'Desk' })]]);
    const { qc, invalidated, wrapper } = setup();
    const { result } = renderHook(() => useAiAgentAction(3), { wrapper });
    const body = {
      displayName: 'Desk',
      enabled: false,
      instructions: 'Answer questions.',
      handoffRules: '',
      inboxId: 2,
    };
    await act(() => result.current.mutateAsync({ kind: 'save', body }));
    expect(calls).toEqual([{ method: 'PUT', path: '/ai/agents/3', body }]);
    expect(qc.getQueryData<AiAgentStatus>(aiAgentKey(3))?.agent.displayName).toBe('Desk');
    for (const key of EVERYTHING) expect(invalidated).toContainEqual(key);
  });

  it('creates an agent and caches it under its new id', async () => {
    routes.push(['POST', '/ai/agents', () => [200, agentStatus({ id: 5 })]]);
    const { qc, invalidated, wrapper } = setup();
    const { result } = renderHook(() => useAiAgentAction(null), { wrapper });
    const body = {
      displayName: 'Help desk',
      enabled: false,
      preset: 'faq' as const,
      instructions: 'x',
      handoffRules: 'y',
    };
    const created = await act(() => result.current.mutateAsync({ kind: 'create', body }));
    expect(created && 'agent' in created ? created.agent.id : null).toBe(5);
    expect(calls[0]).toEqual({ method: 'POST', path: '/ai/agents', body });
    expect(qc.getQueryData(aiAgentKey(5))).toBeDefined();
    expect(invalidated).toContainEqual(aiAgentsKey);
    expect(invalidated).toContainEqual(qk.users);
  });

  it('uploads a file with the Internal field before the file', async () => {
    routes.push(['POST', '/ai/agents/3/documents', () => [200, agentStatus()]]);
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiAgentAction(3), { wrapper });
    const file = new File(['RM 10'], 'prices.txt', { type: 'text/plain' });
    await act(() => result.current.mutateAsync({ kind: 'upload', file, internal: true }));
    expect(calls[0]?.body).toEqual([
      ['internal', 'true'],
      ['file', 'prices.txt'],
    ]);
    await act(() => result.current.mutateAsync({ kind: 'upload', file }));
    expect(calls[1]?.body).toEqual([['file', 'prices.txt']]);
  });

  it('adds, edits and removes text items under the agent', async () => {
    routes.push(
      ['POST', '/ai/agents/3/documents/text', () => [200, agentStatus()]],
      ['PATCH', '/ai/agents/3/documents/7', () => [200, agentStatus()]],
      ['DELETE', '/ai/agents/3/documents/7', () => [200, agentStatus()]],
    );
    const { qc, wrapper } = setup();
    qc.setQueryData(['ai-document', 3, 7], { id: 7 });
    const { result } = renderHook(() => useAiAgentAction(3), { wrapper });
    const text = { name: 'Lowest prices', text: 'RM 10', internal: true };
    await act(() => result.current.mutateAsync({ kind: 'addText', body: text }));
    await act(() =>
      result.current.mutateAsync({ kind: 'updateText', id: 7, body: { internal: false } }),
    );
    await act(() => result.current.mutateAsync({ kind: 'remove', id: 7 }));
    expect(calls).toEqual([
      { method: 'POST', path: '/ai/agents/3/documents/text', body: text },
      { method: 'PATCH', path: '/ai/agents/3/documents/7', body: { internal: false } },
      { method: 'DELETE', path: '/ai/agents/3/documents/7', body: undefined },
    ]);
    // An open item reloads after a change.
    expect(qc.getQueryData(['ai-document', 3, 7])).toBeUndefined();
  });

  it('deletes many items: a 404 counts as deleted, other failures are retried', async () => {
    routes.push(
      ['DELETE', '/ai/agents/3/documents/1', () => [200, agentStatus()]],
      ['DELETE', '/ai/agents/3/documents/2', () => [404, { error: { code: 'not_found' } }]],
      ['GET', '/ai/agents/3', () => [200, agentStatus()]],
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiAgentAction(3), { wrapper });
    await act(() => result.current.mutateAsync({ kind: 'removeMany', ids: [2] }));
    // Only a 404: the agent is read again for the result.
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/ai/agents/3' });
    let error: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ kind: 'removeMany', ids: [1, 2, 4] });
      } catch (e) {
        error = e;
      }
    });
    expect(error).toBeInstanceOf(BatchDeleteError);
    expect((error as BatchDeleteError).failedIds).toEqual([4]);
  });

  it('deletes the agent: the list comes back and the agent leaves the cache', async () => {
    routes.push(['DELETE', '/ai/agents/3', () => [200, { agents: [], maxAgents: 3 }]]);
    const { qc, invalidated, wrapper } = setup();
    qc.setQueryData(aiAgentKey(3), agentStatus());
    const { result } = renderHook(() => useAiAgentAction(3), { wrapper });
    await act(() => result.current.mutateAsync({ kind: 'delete' }));
    expect(qc.getQueryData(aiAgentsKey)).toEqual({ agents: [], maxAgents: 3 });
    expect(qc.getQueryData(aiAgentKey(3))).toBeUndefined();
    expect(invalidated).toContainEqual(aiMemberKey);
    expect(invalidated).toContainEqual(qk.inboxes);
  });

  it('binds the agent to an inbox, or frees its current inbox', async () => {
    routes.push(
      ['PATCH', '/inboxes/4', () => [200, inbox(4, 3)]],
      ['GET', '/ai/agents/3', () => [200, agentStatus()]],
      ['PATCH', '/inboxes/2', () => [200, inbox(2, null)]],
    );
    const { qc, invalidated, wrapper } = setup();
    // Agent 5 answered inbox 4 until now: its open page must reload too.
    qc.setQueryData(aiAgentKey(5), agentStatus({ id: 5, inboxId: 4 }));
    const { result } = renderHook(() => useAiAgentAction(3), { wrapper });
    await act(() => result.current.mutateAsync({ kind: 'setInbox', inboxId: 4 }));
    expect(qc.getQueryState(aiAgentKey(5))?.isInvalidated).toBe(true);
    expect(calls.slice(0, 2)).toEqual([
      { method: 'PATCH', path: '/inboxes/4', body: { aiAgentId: 3 } },
      { method: 'GET', path: '/ai/agents/3', body: undefined },
    ]);
    calls = [];
    // The agent answers inbox 2 (agentStatus): "None" frees inbox 2.
    await act(() => result.current.mutateAsync({ kind: 'setInbox', inboxId: null }));
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', '/ai/agents/3', undefined],
      ['PATCH', '/inboxes/2', { aiAgentId: null }],
      ['GET', '/ai/agents/3', undefined],
    ]);
    expect(invalidated).toContainEqual(qk.inboxes);
  });

  it('refuses an agent action before the agent exists', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiAgentAction(null), { wrapper });
    await expect(result.current.mutateAsync({ kind: 'delete' })).rejects.toThrow(/agent/i);
    expect(calls).toEqual([]);
  });

  it('reloads the agent after a failed action', async () => {
    const { invalidated, wrapper } = setup();
    const { result } = renderHook(() => useAiAgentAction(3), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ kind: 'remove', id: 9 }).catch(() => undefined);
    });
    expect(invalidated).toContainEqual(['ai-agent']);
  });
});

describe('Try it and Edit with AI for one agent', () => {
  const tryBody = {
    question: 'Lowest price?',
    knowledge: { displayName: 'Desk', instructions: '', handoffRules: '' },
  };
  const tryResult = {
    ok: true,
    reply: null,
    action: 'handoff',
    handoffReason: 'confidential_leak',
    model: 'm',
    error: null,
  };

  it("answers with the agent's saved items when the body names the agent", async () => {
    routes.push(
      ['POST', '/ai/agents/3/try', () => [200, tryResult]],
      ['POST', '/ai/try', () => [200, tryResult]],
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiTry(), { wrapper });
    const answer = await act(() => result.current.mutateAsync({ ...tryBody, agentId: 3 }));
    expect(answer.handoffReason).toBe('confidential_leak');
    await act(() => result.current.mutateAsync(tryBody));
    expect(calls.map((c) => c.path)).toEqual(['/ai/agents/3/try', '/ai/try']);
    expect(calls[0]?.body).toMatchObject({ agentId: 3 });
  });

  it('edits a text with the agent named in the path', async () => {
    const edit = { ok: true, text: 'New', error: null };
    routes.push(
      ['POST', '/ai/agents/3/edit', () => [200, edit]],
      ['POST', '/ai/edit', () => [200, edit]],
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiEdit(3), { wrapper });
    const body = {
      field: 'instructions' as const,
      current: '',
      request: 'Shorter',
      preset: 'faq' as const,
    };
    await act(() => result.current.mutateAsync({ body, signal: new AbortController().signal }));
    const old = renderHook(() => useAiEdit(), { wrapper });
    await act(() => old.result.current.mutateAsync({ body, signal: new AbortController().signal }));
    expect(calls.map((c) => c.path)).toEqual(['/ai/agents/3/edit', '/ai/edit']);
  });
});

import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@ezychat/shared';
import { buildDirectory, canOpenInbox, useDirectory } from './useDirectory';

const agent: User = {
  id: 2,
  username: 'daniel',
  displayName: 'Daniel',
  role: 'agent',
  mustChangePassword: false,
  disabled: false,
  createdAt: 0,
  locale: null,
};

describe('inbox access in the team directory', () => {
  it('admins, the AI member and rows without an inbox list open every inbox', () => {
    expect(canOpenInbox({ id: 1, displayName: 'A', role: 'admin', disabled: false }, 5)).toBe(true);
    expect(
      canOpenInbox(
        { id: 9, displayName: 'AI', role: 'agent', disabled: false, kind: 'ai', inboxIds: [] },
        5,
      ),
    ).toBe(true);
    expect(canOpenInbox({ id: 2, displayName: 'D', role: 'agent', disabled: false }, 5)).toBe(true);
    expect(
      canOpenInbox({ id: 2, displayName: 'D', role: 'agent', disabled: false, inboxIds: 'all' }, 5),
    ).toBe(true);
  });

  it('with several inboxes, an agent row without an inbox list opens no inbox', () => {
    const bare = { id: 2, displayName: 'D', role: 'agent' as const, disabled: false };
    expect(canOpenInbox(bare, 1, true)).toBe(false);
    expect(canOpenInbox({ ...bare, inboxIds: 'all' }, 2, true)).toBe(true);
    expect(canOpenInbox({ ...bare, role: 'admin' }, 2, true)).toBe(true);
  });

  it('an agent with no inboxes is not assignable for inbox 2', () => {
    const list = [
      { id: 2, displayName: 'Daniel', role: 'agent' as const, disabled: false, inboxIds: [] },
      { id: 3, displayName: 'Mei Ling', role: 'agent' as const, disabled: false },
      { id: 1, displayName: 'Aisyah', role: 'admin' as const, disabled: false },
    ];
    const multi = buildDirectory(null, true, list, { multiInbox: true });
    expect(multi.assignableFor(2).map((u) => u.displayName)).toEqual(['Aisyah']);
    // One inbox (Lite): a row without an inbox list stays assignable.
    const single = buildDirectory(null, true, list);
    expect(single.assignableFor(1).map((u) => u.displayName)).toEqual(['Aisyah', 'Mei Ling']);
  });

  it('an agent limited to chosen chats is offered only for those chats, in Lite too', () => {
    const list = [
      {
        id: 2,
        displayName: 'Ravi',
        role: 'agent' as const,
        disabled: false,
        chatScope: 'chosen' as const,
        chatJids: ['a@s.whatsapp.net'],
      },
      { id: 3, displayName: 'Mei Ling', role: 'agent' as const, disabled: false },
    ];
    const dir = buildDirectory(null, true, list);
    expect(dir.assignableFor(1, { chatJid: 'a@s.whatsapp.net' }).map((u) => u.id)).toEqual([3, 2]);
    expect(dir.assignableFor(1, { chatJid: 'b@s.whatsapp.net' }).map((u) => u.id)).toEqual([3]);
    // without a chat key (no chat open) a limited agent is never offered
    expect(dir.assignableFor(1).map((u) => u.id)).toEqual([3]);
    // a limited row known only by its scope (no chats the viewer may see) is never offered
    const bare = buildDirectory(null, true, [{ ...list[0]!, chatJids: undefined }]);
    expect(bare.assignableFor(1, { chatJid: 'a@s.whatsapp.net' })).toEqual([]);
    // the signed-in limited agent keeps the chats from the directory row
    const me = { ...agent, id: 2, chatScope: 'chosen' as const };
    const mine = buildDirectory(me, false, list);
    expect(mine.byId.get(2)?.chatJids).toEqual(['a@s.whatsapp.net']);
  });

  it('agents open only their inboxes', () => {
    const u = { id: 2, displayName: 'D', role: 'agent' as const, disabled: false, inboxIds: [1] };
    expect(canOpenInbox(u, 1)).toBe(true);
    expect(canOpenInbox(u, 2)).toBe(false);
  });

  it('assignableFor lists active members of the chat’s inbox, sorted', () => {
    const dir = buildDirectory(null, true, [
      { id: 3, displayName: 'Mei Ling', role: 'agent', disabled: false, inboxIds: [2] },
      { id: 2, displayName: 'Daniel', role: 'agent', disabled: false, inboxIds: [1] },
      { id: 4, displayName: 'Ali', role: 'agent', disabled: true, inboxIds: [2] },
      { id: 1, displayName: 'Aisyah', role: 'admin', disabled: false },
    ]);
    expect(dir.assignableFor(2).map((u) => u.displayName)).toEqual(['Aisyah', 'Mei Ling']);
    expect(dir.assignableFor(1).map((u) => u.displayName)).toEqual(['Aisyah', 'Daniel']);
  });

  it('leaves a group-only AI agent out of a direct chat, not out of a group', () => {
    const list = [
      { id: 1, displayName: 'Aisyah', role: 'admin' as const, disabled: false },
      {
        id: 7,
        displayName: 'Group AI',
        role: 'agent' as const,
        disabled: false,
        kind: 'ai' as const,
        aiRole: 'sales' as const,
        aiAgentId: 70,
        aiNoDirect: true,
        inboxIds: 'all' as const,
      },
    ];
    const dir = buildDirectory(null, true, list, { inboxAgents: new Map([[1, 70]]) });
    expect(dir.assignableFor(1, { direct: true }).map((u) => u.displayName)).toEqual(['Aisyah']);
    expect(dir.assignableFor(1).map((u) => u.displayName)).toEqual(['Aisyah', 'Group AI']);
  });

  it('offers an AI agent only for the inbox it answers, and never a deleted agent', () => {
    const ai = (id: number, name: string, aiAgentId: number, extra = {}) => ({
      id,
      displayName: name,
      role: 'agent' as const,
      disabled: false,
      kind: 'ai' as const,
      aiRole: 'sales' as const,
      aiAgentId,
      inboxIds: 'all' as const,
      ...extra,
    });
    const list = [
      { id: 1, displayName: 'Aisyah', role: 'admin' as const, disabled: false },
      ai(7, 'Sales AI', 70),
      ai(8, 'FAQ AI', 80),
      // A deleted agent stays only to name its old messages (the server also marks it disabled).
      ai(9, 'Old AI', 90, { aiDeleted: true }),
      ai(10, 'Ghost AI', 100, { aiDeleted: true, disabled: true }),
    ];
    const dir = buildDirectory(null, true, list, {
      multiInbox: true,
      inboxAgents: new Map([
        [1, 70],
        [2, 80],
        [3, 90],
        [4, null],
      ]),
    });
    expect(dir.assignableFor(1).map((u) => u.displayName)).toEqual(['Aisyah', 'Sales AI']);
    expect(dir.assignableFor(2).map((u) => u.displayName)).toEqual(['Aisyah', 'FAQ AI']);
    expect(dir.assignableFor(3).map((u) => u.displayName)).toEqual(['Aisyah']);
    expect(dir.assignableFor(4).map((u) => u.displayName)).toEqual(['Aisyah']);
    expect(dir.assignable.map((u) => u.displayName)).not.toContain('Old AI');
    // A deleted agent still names its old messages.
    expect(dir.nameOf(9)).toContain('Old AI');
    // Inboxes not known yet: no AI is offered (the server would refuse it).
    expect(
      buildDirectory(null, true, list)
        .assignableFor(1)
        .map((u) => u.id),
    ).toEqual([1]);
  });

  it('keeps the directory’s inbox list for the signed-in agent', () => {
    const dir = buildDirectory(agent, false, [
      { id: 2, displayName: 'Daniel', role: 'agent', disabled: false, inboxIds: [1] },
    ]);
    expect(dir.byId.get(2)?.inboxIds).toEqual([1]);
    expect(dir.assignableFor(2)).toEqual([]);
  });
});

describe('useDirectory', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function json(data: unknown, code = 200) {
    return new Response(JSON.stringify(data), {
      status: code,
      headers: { 'content-type': 'application/json' },
    });
  }

  const inbox = (id: number, aiAgentId: number | null) => ({
    id,
    name: `Inbox ${id}`,
    tone: 'primary',
    number: null,
    status: { state: 'open', qr: null, me: null, lastError: null },
    removed: false,
    aiAgentId,
  });

  function run(maxInboxes: number | null) {
    const admin = { ...agent, id: 1, displayName: 'Aisyah', role: 'admin' as const };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/me') return json(admin);
        if (url === '/api/users')
          return json({
            users: [
              admin,
              { ...agent, inboxIds: [] },
              { ...agent, id: 3, displayName: 'Mei' },
              { ...agent, id: 4, displayName: 'Bot', kind: 'ai', aiRole: 'sales', aiAgentId: 7 },
            ],
          });
        if (url === '/api/inboxes' && maxInboxes != null)
          return json({ inboxes: [inbox(1, 7), inbox(2, null)], maxInboxes, canAdd: false });
        return json({ error: { code: 'not_found', message: 'nope' } }, 404);
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    return renderHook(() => useDirectory(), { wrapper });
  }

  it('fails closed for rows without an inbox list in a multi-inbox install', async () => {
    const { result } = run(3);
    await waitFor(() => expect(result.current.byId.size).toBe(4));
    await waitFor(() =>
      expect(result.current.assignableFor(2).map((u) => u.displayName)).toEqual(['Aisyah']),
    );
    // The AI agent of inbox 1 is offered there only.
    await waitFor(() =>
      expect(result.current.assignableFor(1).map((u) => u.displayName)).toEqual(['Aisyah', 'Bot']),
    );
  });

  it('keeps rows without an inbox list assignable on a single-inbox server', async () => {
    const { result } = run(null);
    await waitFor(() => expect(result.current.byId.size).toBe(4));
    expect(result.current.assignableFor(1).map((u) => u.displayName)).toEqual(['Aisyah', 'Mei']);
  });
});

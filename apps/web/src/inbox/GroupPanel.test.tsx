import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { GroupInfoResponse, GroupMember } from '@ezychat/shared';
import { GroupPanel, MEMBER_PAGE } from './GroupPanel';

const GROUP = '120363000000000001@g.us';
const BASE = `/api/chats/${encodeURIComponent(GROUP)}/members`;

const member = (over: Partial<GroupMember>): GroupMember => ({
  jid: '60111@s.whatsapp.net',
  phone: '60111',
  lid: null,
  name: null,
  username: null,
  role: 'member',
  isMe: false,
  chatJid: null,
  ...over,
});

const MEMBERS: GroupMember[] = [
  member({
    jid: '60000000000@s.whatsapp.net',
    phone: '60000000000',
    isMe: true,
    role: 'superadmin',
  }),
  member({
    jid: '60162214433@s.whatsapp.net',
    phone: '60162214433',
    name: '(kingsly) Oyen Jarvis',
    role: 'admin',
    chatJid: '60162214433@s.whatsapp.net',
  }),
  member({
    jid: '311222333444555@lid',
    phone: '60137782210',
    lid: '311222333444555@lid',
    name: 'Nurul Aisyah',
    username: 'nurul.aisyah',
  }),
  member({ jid: '60175550192@s.whatsapp.net', phone: '60175550192' }),
  member({ jid: '184392017734251@lid', phone: null, lid: '184392017734251@lid' }),
];

const info = (members = MEMBERS): GroupInfoResponse => ({
  group: {
    jid: GROUP,
    name: 'Malaysia SME Founders',
    description: null,
    createdAt: Date.UTC(2024, 2, 12),
    createdBy: {
      jid: '60162214433@s.whatsapp.net',
      name: '(kingsly) Oyen Jarvis',
      phone: '60162214433',
    },
    size: 965,
    adminCount: members.filter((m) => m.role !== 'member').length,
  },
  members,
  fetchedAt: Date.now(),
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi(data: GroupInfoResponse | null, abouts: Record<string, string> = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === BASE && method === 'GET')
        return data
          ? json(data)
          : json({ error: { code: 'wa_unavailable', message: 'WhatsApp is not connected' } }, 503);
      const about = /\/members\/([^/]+)\/about$/.exec(url);
      if (about) return json({ about: abouts[decodeURIComponent(about[1]!)] ?? null });
      const start = /\/members\/([^/]+)\/chat$/.exec(url);
      if (start && method === 'POST') return json({ chatJid: decodeURIComponent(start[1]!) });
      return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    }),
  );
  return calls;
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPanel(onClose = vi.fn(), isAdmin = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats/g']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GroupPanel jid={GROUP} open onClose={onClose} isAdmin={isAdmin} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GroupPanel', () => {
  it('shows the AI agent row under the group name: a switch for admins, the state for agents', async () => {
    mockApi(info());
    const members = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith('/ai-group')
          ? json({
              enabled: true,
              agentId: 3,
              agentName: 'Aina',
              agentEnabled: true,
              agentAnswersGroups: true,
              paused: false,
            })
          : members(url, init),
      ),
    );
    renderPanel(vi.fn(), true);
    const sw = await screen.findByRole('switch', {
      name: 'AI agent in this group',
    });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    cleanup();
    renderPanel();
    expect((await screen.findByTestId('group-ai-state')).textContent).toBe('On');
  });

  it('lists members with only what WhatsApp shared', async () => {
    mockApi(info());
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Group members' });
    const rows = [...list.querySelectorAll('li')].map((r) => r.textContent ?? '');
    const expected = [
      'You+60000000000Admin',
      '(kingsly) Oyen Jarvis+60162214433Admin',
      'Nurul Aisyah@nurul.aisyah',
      '+60175550192Name not shared yet',
      '184392017734251@lidNumber hidden by WhatsApp',
    ];
    expect(rows).toHaveLength(expected.length);
    expected.forEach((text, i) => expect(rows[i]).toContain(text));
    expect(screen.getByText('965 members · 2 admins')).toBeTruthy();
    expect(screen.getByText(/Created .*2024 by \(kingsly\) Oyen Jarvis/)).toBeTruthy();
  });

  it('searches names, numbers and usernames, and filters admins', async () => {
    mockApi(info());
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Group members' });
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search members' }), 'aisyah');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(1));
    await user.clear(screen.getByRole('searchbox', { name: 'Search members' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search members' }), '0192');
    await waitFor(() =>
      expect(within(list).getAllByRole('button')[0]?.textContent).toContain('+60175550192'),
    );
    await user.clear(screen.getByRole('searchbox', { name: 'Search members' }));
    await user.click(screen.getByRole('button', { name: 'Admins · 2' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Group members' })).getAllByRole('button'),
      ).toHaveLength(2),
    );
    expect(screen.getByRole('button', { name: 'Admins · 2' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // With a search and the Admins filter, All still counts every match it would show.
    await user.type(screen.getByRole('searchbox', { name: 'Search members' }), '601');
    await waitFor(() => expect(screen.getByRole('button', { name: 'All · 3' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Admins · 1' })).toBeTruthy();
  });

  it('shows large groups a page at a time', { timeout: 20_000 }, async () => {
    const many = Array.from({ length: MEMBER_PAGE + 20 }, (_, i) =>
      member({ jid: `6011${10_000_000 + i}@s.whatsapp.net`, phone: `6011${10_000_000 + i}` }),
    );
    mockApi(info(many));
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Group members' });
    expect(list.querySelectorAll('li')).toHaveLength(MEMBER_PAGE);
    await userEvent
      .setup()
      .click(
        screen.getByRole('button', { name: `Show more (${MEMBER_PAGE} of ${MEMBER_PAGE + 20})` }),
      );
    expect(list.querySelectorAll('li')).toHaveLength(MEMBER_PAGE + 20);
  });

  it('opens a member’s details with About and opens their existing chat', async () => {
    mockApi(info(), { '60162214433@s.whatsapp.net': 'Hello. I’m using WhatsApp Business.' });
    const { onClose } = renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Oyen Jarvis/ }));
    const details = screen.getByRole('region', { name: 'WhatsApp details' });
    expect(await within(details).findByText('Hello. I’m using WhatsApp Business.')).toBeTruthy();
    expect(within(details).getByText('+60162214433')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/chats/60162214433%40s.whatsapp.net');
  });

  it('an agent limited to chosen chats sees the number but no Open chat or Message', async () => {
    mockApi(info(), { '60162214433@s.whatsapp.net': 'Hello.' });
    const api = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        url === '/api/me'
          ? json({
              id: 5,
              username: 'ravi',
              displayName: 'Ravi',
              role: 'agent',
              chatScope: 'chosen',
              mustChangePassword: false,
              disabled: false,
              createdAt: 0,
              locale: null,
            })
          : api(url, init),
      ),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Oyen Jarvis/ }));
    expect(await screen.findByTestId('chosen-only-no-member-chat')).toBeTruthy();
    const details = screen.getByRole('region', { name: 'WhatsApp details' });
    expect(within(details).getByText('+60162214433')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('says when an About could not be read and lets you retry', async () => {
    mockApi(info());
    const ok = globalThis.fetch;
    let failed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/about') && !failed) {
          failed = true;
          return json({ error: { code: 'wa_unavailable', message: 'unavailable' } }, 503);
        }
        if (url.endsWith('/about')) return json({ about: 'Back online' });
        return ok(url, init);
      }),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Oyen Jarvis/ }));
    const details = screen.getByRole('region', { name: 'WhatsApp details' });
    expect(await within(details).findByText('Couldn’t load')).toBeTruthy();
    await user.click(within(details).getByRole('button', { name: 'Try again' }));
    expect(await within(details).findByText('Back online')).toBeTruthy();
  });

  it('asks before starting a chat with a member who has none, then opens it', async () => {
    const calls = mockApi(info());
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Number hidden by WhatsApp/ }));
    expect(screen.getByText('184392017734251@lid', { selector: 'span' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Message' }));
    const confirm = screen.getByRole('alertdialog', {
      name: 'Start a chat with 184392017734251@lid?',
    });
    expect(
      within(confirm).getByText(/Unsolicited messages can get your WhatsApp number banned/),
    ).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/chats/184392017734251%40lid'),
    );
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('starts a chat by the member’s WhatsApp ID, never their reusable number', async () => {
    const calls = mockApi(
      info([
        member({
          jid: '60175550192@s.whatsapp.net',
          phone: '60175550192',
          lid: '311000000000001@lid',
          name: 'Farid',
        }),
      ]),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Farid/ }));
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.url).toBe(
        `${BASE}/${encodeURIComponent('311000000000001@lid')}/chat`,
      ),
    );
  });

  it('offers no chat actions on the linked number itself', async () => {
    mockApi(info());
    renderPanel();
    await userEvent.setup().click(await screen.findByRole('button', { name: /^You/ }));
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
  });

  it('shows the description, and Group info still works when the admin view cannot be read', async () => {
    const calls = mockApi({
      ...info(),
      group: { ...info().group, description: 'Founders only.\nBe kind.' },
    });
    renderPanel();
    expect((await screen.findByTestId('group-description')).textContent).toBe(
      'Founders only.\nBe kind.',
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/chats/${encodeURIComponent(GROUP)}/group`)).toBe(
        true,
      ),
    );
    expect(screen.queryByRole('region', { name: 'Manage group' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Group members' })).toBeTruthy();
  });

  it('explains when members cannot be loaded and lets you retry', async () => {
    mockApi(null);
    renderPanel();
    expect(
      await screen.findByText('Couldn’t load the members. WhatsApp must be connected.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AiAgentGroupChatsBody, AiAgentGroups, AiGroupRow } from '@ezychat/shared';
import { AgentGroupsCard } from './AgentGroupsCard';
import { agentGroupsData, json, renderWithQuery, stubFetch } from './agent-cards.test.helpers';

const KL = '120363000000000001@g.us';
const PENANG = '120363000000000002@g.us';
const KUCHING = '120363000000000003@g.us';
const IPOH = '120363000000000004@g.us';
const KOPI = '120363000000000005@g.us';

const row = (jid: string, name: string, patch: Partial<AiGroupRow> = {}): AiGroupRow => ({
  jid,
  name,
  memberCount: 18,
  paused: false,
  enabled: false,
  agentId: null,
  agentName: null,
  listen: false,
  ...patch,
});
const mine = { enabled: true, agentId: 3, agentName: 'Claims agent' };

const GROUPS = [
  row(KL, 'Claims KL', { ...mine, listen: true }),
  row(PENANG, 'Claims Penang', { ...mine, memberCount: null }),
  row(KUCHING, 'Claims Kuching', { memberCount: 7 }),
  row(IPOH, 'Claims Ipoh', { memberCount: 6 }),
  row(KOPI, 'Kopi Lovers Club', { enabled: true, agentId: 1, agentName: 'Aina' }),
];

const SWITCH = 'Answer in groups';

/**
 * A stand-in server for the agent's groups (`group-chats` gives or takes groups) and its switch.
 * `refuse` answers the next group-chats PUT with that error code.
 */
function stubServer(start: AiAgentGroups, refuse?: { status: number; code: string }) {
  let state = structuredClone(start);
  return stubFetch((url, method, body) => {
    if (url === '/api/ai/agents/3/groups') {
      if (method === 'PUT') {
        if (refuse) return json({ error: { code: refuse.code, message: 'Boom' } }, refuse.status);
        state = { ...state, enabled: (body as { enabled: boolean }).enabled };
      }
      return json(state);
    }
    if (url === '/api/ai/agents/3/group-chats' && method === 'PUT') {
      if (refuse) return json({ error: { code: refuse.code, message: 'Taken' } }, refuse.status);
      const { jids, enabled, listen } = body as AiAgentGroupChatsBody;
      state = {
        ...state,
        groups: state.groups.map((g) =>
          !jids.includes(g.jid)
            ? g
            : enabled
              ? { ...g, ...mine, listen: listen ?? g.listen }
              : { ...g, enabled: false, agentId: null, agentName: null, listen: false },
        ),
      };
      return json(state);
    }
    return undefined;
  });
}

function renderCard(props: Partial<Parameters<typeof AgentGroupsCard>[0]> = {}) {
  renderWithQuery(
    <MemoryRouter>
      <AgentGroupsCard
        agentId={3}
        name="Claims agent"
        agentEnabled
        inboxName="Main number"
        {...props}
      />
    </MemoryRouter>,
  );
}

const data = (patch: Partial<AiAgentGroups> = {}): AiAgentGroups =>
  agentGroupsData({ groups: GROUPS, ...patch });
const groupPuts = (calls: ReturnType<typeof stubServer>) =>
  calls.filter((c) => c.url === '/api/ai/agents/3/group-chats').map((c) => c.body);

beforeEach(() => {
  // A desktop window: Add groups opens as a dialog (phones get the bottom drawer).
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Agent page → Groups', () => {
  it("lists only this agent's groups with Reads every message, the info box and the limits", async () => {
    stubServer(data());
    renderCard();
    const list = await screen.findByRole('list', { name: 'Groups of Claims agent' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('Kopi Lovers Club')).toBeNull();
    const kl = screen.getByRole('link', { name: 'Open Claims KL' });
    expect(kl.getAttribute('href')).toBe(`/chats/${encodeURIComponent(KL)}`);
    expect(kl.textContent).toContain('18 members · Reads every message');
    const penang = screen.getByRole('link', { name: 'Open Claims Penang' });
    expect(penang.textContent).toBe('Claims PenangAnswers when tagged or quoted');
    expect(
      screen
        .getByRole('switch', { name: 'Reads every message in Claims KL' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen
        .getByRole('switch', { name: 'Reads every message in Claims Penang' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByText(
        /the agent sees every member message and follows its instructions \(saves a claim, asks for a missing detail, or stays quiet\)/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Loop guard: after 10 answers in a row with no teammate message, Claims agent pauses in that group until a teammate writes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/adds rows to sheet tabs set to Add rows/)).toBeTruthy();
  });

  it('switches Reads every message and removes a group through group-chats', async () => {
    const calls = stubServer(data());
    renderCard();
    const user = userEvent.setup();
    const listen = await screen.findByRole('switch', {
      name: 'Reads every message in Claims Penang',
    });
    await user.click(listen);
    await waitFor(() => expect(listen.getAttribute('aria-checked')).toBe('true'));
    await user.click(screen.getByRole('button', { name: 'Remove Claims KL' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Open Claims KL' })).toBeNull());
    expect(groupPuts(calls)).toEqual([
      { jids: [PENANG], enabled: true, listen: true },
      { jids: [KL], enabled: false },
    ]);
  });

  it('adds groups from the dialog, with Read every message on by default', async () => {
    const calls = stubServer(data());
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add groups' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add groups to Claims agent' });
    expect(
      within(dialog).getByText('Groups of Main number. A group can have one AI agent.'),
    ).toBeTruthy();
    // A group another agent holds is shown but cannot be chosen.
    const kopi = within(dialog).getByRole('checkbox', { name: /Kopi Lovers Club/ });
    expect(kopi.hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByText('18 members · has Aina')).toBeTruthy();
    // This agent's own groups are not offered again.
    expect(within(dialog).queryByText('Claims KL')).toBeNull();
    const save = within(dialog).getByTestId('add-groups-save');
    expect(save.hasAttribute('disabled')).toBe(true);
    // Search narrows the list.
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search groups' }), 'kuch');
    expect(within(dialog).queryByText('Claims Ipoh')).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: /Claims Kuching/ }));
    await user.clear(within(dialog).getByRole('searchbox', { name: 'Search groups' }));
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search groups' }), 'nothing');
    expect(within(dialog).getByText('No group matches.')).toBeTruthy();
    await user.clear(within(dialog).getByRole('searchbox', { name: 'Search groups' }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Claims Ipoh/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Claims Ipoh/ }));
    expect(
      within(dialog)
        .getByRole('checkbox', { name: 'Read every message in these groups' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(groupPuts(calls)).toEqual([{ jids: [KUCHING], enabled: true, listen: true }]);
    expect(
      (await screen.findByRole('link', { name: 'Open Claims Kuching' })).textContent,
    ).toContain('7 members · Reads every message');
  });

  it('adds without Read every message when it is unticked, and can be cancelled', async () => {
    const calls = stubServer(data());
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add groups' }));
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Add groups' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Claims Ipoh/ }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Read every message in these groups' }),
    );
    await user.click(within(dialog).getByTestId('add-groups-save'));
    await waitFor(() =>
      expect(groupPuts(calls)).toEqual([{ jids: [IPOH], enabled: true, listen: false }]),
    );
  });

  it('says when a chosen group already has another agent (409 group_has_agent)', async () => {
    stubServer(data(), { status: 409, code: 'group_has_agent' });
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add groups' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Claims Ipoh/ }));
    await user.click(within(dialog).getByTestId('add-groups-save'));
    expect(
      await within(dialog).findByText(
        'A group you chose already has another AI agent. Choose again.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says when the inbox has no other group to add', async () => {
    stubServer(data({ groups: GROUPS.slice(0, 2) }));
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add groups' }));
    expect(await screen.findByText('Main number has no other groups.')).toBeTruthy();
  });

  it('marks a group the loop guard paused', async () => {
    stubServer(data({ groups: [row(KL, 'Claims KL', { ...mine, paused: true })] }));
    renderCard();
    const kl = await screen.findByRole('link', { name: 'Open Claims KL' });
    expect(kl.textContent).toContain('18 members · Paused: many answers in a row');
    expect(kl.querySelector('.text-warning')).toBeTruthy();
  });

  it('says no group is given to the agent yet, and still offers Add groups', async () => {
    stubServer(data({ groups: GROUPS.slice(2) }));
    renderCard();
    expect(
      await screen.findByText(
        'No group is given to Claims agent yet. Add groups to choose where Claims agent works.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add groups' })).toBeTruthy();
  });

  it('is off by default: a summary, and turning it on PUTs { enabled: true }', async () => {
    const calls = stubServer(data({ enabled: false, inboxName: 'Sales line' }));
    renderCard({ inboxName: 'WhatsApp' });
    expect(
      await screen.findByText(
        'Sales line is in 5 groups. Turn this on to choose where Claims agent answers.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add groups' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('switch', { name: SWITCH }));
    expect(await screen.findByRole('list', { name: 'Groups of Claims agent' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      url: '/api/ai/agents/3/groups',
      method: 'PUT',
      body: { enabled: true },
    });
  });

  it('shows the empty state for an inbox without groups', async () => {
    stubServer(data({ groups: [] }));
    renderCard();
    expect(
      await screen.findByText(
        'Main number is not in any WhatsApp group yet. Groups show here when the number is added to one.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('warns that nothing is answered while the agent itself is off', async () => {
    stubServer(data());
    renderCard({ agentEnabled: false });
    expect(
      await screen.findByText(
        'Claims agent is off. Nothing is answered in groups until you turn Claims agent on.',
      ),
    ).toBeTruthy();
  });

  it('asks for an inbox first when the agent answers no inbox', async () => {
    stubServer(data());
    renderCard({ inboxName: null });
    expect(await screen.findByText('Choose an inbox for Claims agent first.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('keeps the switches as they were when saving fails', async () => {
    const calls = stubServer(data(), { status: 500, code: 'internal' });
    renderCard();
    const user = userEvent.setup();
    const sw = await screen.findByRole('switch', { name: SWITCH });
    await user.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('true');
    const listen = screen.getByRole('switch', { name: 'Reads every message in Claims Penang' });
    await user.click(listen);
    await waitFor(() => expect(listen.hasAttribute('disabled')).toBe(false));
    expect(listen.getAttribute('aria-checked')).toBe('false');
  });

  it('offers Retry when the groups cannot load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'internal', message: 'Boom' } }, 500)),
    );
    renderCard();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

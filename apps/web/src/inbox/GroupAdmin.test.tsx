import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type {
  GroupAdminCaps,
  GroupAdminResponse,
  GroupInfoResponse,
  GroupMember,
} from '@ezychat/shared';
import { GroupPanel } from './GroupPanel';
import { ApiError } from '../api/client';
import { i18n } from '@/i18n';
import { groupAdminErrorText, othersCount } from './GroupAdminShared';
import { changeLine } from './GroupAdminDialogs';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const GROUP = '120363000000000001@g.us';
const BASE = `/api/chats/${encodeURIComponent(GROUP)}`;

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
  member({ jid: '60000000000@s.whatsapp.net', phone: '60000000000', isMe: true, role: 'admin' }),
  member({
    jid: '60162214433@s.whatsapp.net',
    phone: '60162214433',
    name: 'Oyen Jarvis',
    role: 'superadmin',
  }),
  member({
    jid: '60137782210@s.whatsapp.net',
    phone: '60137782210',
    lid: '311222333444555@lid',
    name: 'Nurul Aisyah',
    role: 'admin',
  }),
  member({ jid: '60175550192@s.whatsapp.net', phone: '60175550192', name: 'Farid' }),
];

const info = (over: Partial<GroupInfoResponse['group']> = {}): GroupInfoResponse => ({
  group: {
    jid: GROUP,
    name: 'SME Founders',
    description: 'Monthly meetups for founders.',
    createdAt: null,
    createdBy: null,
    size: 4,
    adminCount: 3,
    ...over,
  },
  members: MEMBERS,
  fetchedAt: Date.now(),
});

const PHONE_CAPS: GroupAdminCaps = {
  editInfo: true,
  addMembers: true,
  inviteOnly: false,
  removeMembers: true,
  admins: true,
  inviteLink: true,
  resetInviteLink: true,
  settings: ['announce', 'locked', 'memberAdd', 'approval'],
  joinRequests: true,
  maxMembers: null,
  nameMax: 100,
  descriptionMax: 2048,
};

const API_CAPS: GroupAdminCaps = {
  ...PHONE_CAPS,
  addMembers: false,
  inviteOnly: true,
  admins: false,
  settings: [],
  maxMembers: 8,
  nameMax: 128,
};

const view = (over: Partial<GroupAdminResponse> = {}): GroupAdminResponse => ({
  caps: PHONE_CAPS,
  canManage: true,
  online: true,
  myRole: 'admin',
  settings: { announce: false, locked: true, memberAdd: 'admins', approval: false },
  inviteLink: 'https://chat.whatsapp.com/AbCdEf123',
  requests: [
    { jid: '60123000111@s.whatsapp.net', phone: '60123000111', name: 'Mei Ling', at: 1 },
    { jid: '60123000222@s.whatsapp.net', phone: '60123000222', name: null, at: null },
  ],
  changes: [
    {
      at: Date.UTC(2026, 10, 3),
      byUserId: 1,
      byName: 'Admin',
      action: 'member_add',
      memberJid: '60175550192@s.whatsapp.net',
      memberName: 'Farid',
      setting: null,
      value: null,
    },
  ],
  size: 4,
  ...over,
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const fail = (status: number, code: string) =>
  json({ error: { code, message: `Refused: ${code}` } }, status);

type Handler = (body: unknown) => Response;

/** The group routes; `routes` overrides one mutation as `METHOD path-after-/group`. */
function mockApi(admin: GroupAdminResponse, routes: Record<string, Handler> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === `${BASE}/members` && method === 'GET') return json(info());
      if (url === `${BASE}/group` && method === 'GET') return json(admin);
      if (url.startsWith(`${BASE}/group`)) {
        const path = decodeURIComponent(url.slice(`${BASE}/group`.length));
        calls.push({ method, path, body });
        const own = routes[`${method} ${path}`];
        if (own) return own(body);
        if (method === 'POST' && path === '/members')
          return json({
            result: 'added',
            memberJid: `${String((body as { phone: string }).phone)}@s.whatsapp.net`,
          });
        // Like WhatsApp: the next read of the group reports the change.
        if (path === '/invite-link/reset') {
          admin.inviteLink = 'https://chat.whatsapp.com/NewLink999';
          return json({ inviteLink: admin.inviteLink });
        }
        if (path === '/settings') admin.settings = { ...admin.settings, ...(body as object) };
        if (path.endsWith('/invite')) return json({ result: 'sent' });
        return json({ ok: true });
      }
      if (url.endsWith('/about')) return json({ about: null });
      return fail(404, 'not_found');
    }),
  );
  return calls;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GroupPanel jid={GROUP} open onClose={vi.fn()} isAdmin />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const bar = () => screen.findByRole('region', { name: 'Manage group' });

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Manage group bar', () => {
  it('shows the description and the actions the connection allows', async () => {
    mockApi(view());
    renderPanel();
    const region = await bar();
    expect(screen.getByTestId('group-description').textContent).toBe(
      'Monthly meetups for founders.',
    );
    for (const name of ['Edit info', 'Add member', 'Invite link', 'Settings'])
      expect(within(region).getByRole('button', { name })).toHaveProperty('disabled', false);
    const requests = within(region).getByTestId('join-requests');
    expect(requests.textContent).toContain('2 people asked to join');
    expect(requests.textContent).toContain('Mei Ling');
    expect(requests.textContent).toContain('+60123000111');
    // No name shared: the number is the name.
    expect(requests.textContent).toContain('+60123000222');
  });

  it('agents see Group info read-only with one line, and the description', async () => {
    mockApi(view({ canManage: false, inviteLink: null, requests: [], changes: [] }));
    renderPanel();
    const region = await bar();
    expect(within(region).getByTestId('group-admin-readonly').textContent).toBe(
      'Only EzyChat admins can change this group.',
    );
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('group-description')).toBeTruthy();
    // No admin actions on a member either.
    await userEvent.setup().click(screen.getByRole('button', { name: /Farid/ }));
    expect(screen.queryByTestId('member-admin')).toBeNull();
  });

  it('warns when the linked number is not a group admin, and offers no actions', async () => {
    mockApi(view({ myRole: 'member' }));
    renderPanel();
    const region = await bar();
    expect(region.textContent).toContain('Your WhatsApp number is not an admin of this group');
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
    expect(within(region).queryByTestId('join-requests')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: /Farid/ }));
    expect(screen.queryByTestId('member-admin')).toBeNull();
  });

  it('treats an unknown role while connected as not a group admin', async () => {
    mockApi(view({ myRole: null }));
    renderPanel();
    expect((await bar()).textContent).toContain('is not an admin of this group');
  });

  it('disables every action while WhatsApp is offline', async () => {
    mockApi(view({ online: false, myRole: null }));
    renderPanel();
    const region = await bar();
    expect(region.textContent).toContain('WhatsApp is offline. Changes are paused');
    for (const b of within(region).getAllByRole('button'))
      expect(b).toHaveProperty('disabled', true);
    await userEvent.setup().click(screen.getByRole('button', { name: /Farid/ }));
    const actions = screen.getByTestId('member-admin');
    for (const name of ['Make group admin', 'Remove from group'])
      expect(within(actions).getByRole('button', { name })).toHaveProperty('disabled', true);
  });

  it('shows nothing to manage when the connection can change nothing', async () => {
    mockApi(
      view({
        caps: {
          ...PHONE_CAPS,
          editInfo: false,
          addMembers: false,
          removeMembers: false,
          admins: false,
          inviteLink: false,
          resetInviteLink: false,
          joinRequests: false,
          settings: [],
        },
      }),
    );
    renderPanel();
    await screen.findByRole('list', { name: 'Group members' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Manage group' })).toBeNull());
  });

  it('invite-only connections: no Add member, the n of max count, no admin actions', async () => {
    mockApi(view({ caps: API_CAPS, settings: {}, requests: [] }));
    renderPanel();
    const region = await bar();
    expect(within(region).getByTestId('invite-only-note').textContent).toBe(
      'WhatsApp Business API: people join only with the invite link. 3 of 8 members.',
    );
    expect(within(region).queryByRole('button', { name: 'Add member' })).toBeNull();
    expect(within(region).getByRole('button', { name: 'Invite people' })).toBeTruthy();
    // Settings: none on this connection, but Recent changes is there.
    const user = userEvent.setup();
    await user.click(within(region).getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Group settings' });
    expect(dialog.textContent).toContain('The WhatsApp Business API has no group settings.');
    expect(within(dialog).queryAllByRole('switch')).toHaveLength(0);
    expect(within(dialog).getByTestId('group-history').textContent).toContain('Admin added Farid');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    // A member: Remove only, and the API wording.
    await user.click(screen.getByRole('button', { name: /Farid/ }));
    const actions = screen.getByTestId('member-admin');
    expect(within(actions).queryByRole('button', { name: 'Make group admin' })).toBeNull();
    await user.click(within(actions).getByRole('button', { name: 'Remove from group' }));
    expect(screen.getByRole('alertdialog').textContent).toContain(
      "can't rejoin with the invite link",
    );
  });

  it('says when an invite-only group is full and blocks approvals', async () => {
    mockApi(
      view({
        caps: { ...API_CAPS, maxMembers: 3 },
        settings: {},
        requests: [{ jid: '60123000111@s.whatsapp.net', phone: '60123000111', name: null, at: 1 }],
      }),
    );
    renderPanel();
    const region = await bar();
    expect(region.textContent).toContain('This group is full (3 members).');
    expect(within(region).getByRole('button', { name: 'Approve' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('without a member limit, the invite-only note has no count', async () => {
    mockApi(view({ caps: { ...API_CAPS, maxMembers: null }, settings: {}, requests: [] }));
    renderPanel();
    expect((await bar()).textContent).toContain(
      'WhatsApp Business API: people join only with the invite link.',
    );
    expect(screen.getByTestId('invite-only-note').textContent).not.toContain(' of ');
  });
});

describe('Edit info', () => {
  it('counts the name, saves only what changed and closes', async () => {
    const calls = mockApi(view());
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Edit info' }));
    const dialog = screen.getByRole('dialog', { name: 'Group name and description' });
    expect(within(dialog).getByTestId('group-name-count').textContent).toBe('12 / 100');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    const name = within(dialog).getByLabelText('Group name');
    await user.clear(name);
    expect(save).toHaveProperty('disabled', true); // a group needs a name
    await user.type(name, 'SME Founders KL');
    expect(within(dialog).getByTestId('group-name-count').textContent).toBe('15 / 100');
    expect(name.getAttribute('maxlength')).toBe('100');
    await user.click(save);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Group updated'));
    expect(calls).toEqual([{ method: 'PATCH', path: '', body: { name: 'SME Founders KL' } }]);
    expect(screen.queryByRole('dialog', { name: 'Group name and description' })).toBeNull();
  });

  it('clears the description and shows a refusal in the dialog', async () => {
    const calls = mockApi(view(), { 'PATCH ': () => fail(409, 'not_group_admin') });
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Edit info' }));
    const dialog = screen.getByRole('dialog', { name: 'Group name and description' });
    await user.clear(within(dialog).getByLabelText('Description'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Your WhatsApp number is not an admin of this group.',
    );
    expect(calls[0]?.body).toEqual({ description: '' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Group name and description' })).toBeNull();
  });
});

describe('Add member', () => {
  it('adds one number and closes with a toast', async () => {
    const calls = mockApi(view());
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Add member' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a member' });
    expect(dialog.textContent).toContain('Adding many strangers can get your number banned');
    const add = within(dialog).getByRole('button', { name: 'Add' });
    await user.type(within(dialog).getByLabelText('WhatsApp number'), '+60 12');
    expect(add).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByLabelText('WhatsApp number'), '-345 6789{Enter}');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('+60123456789 was added'));
    expect(calls).toEqual([{ method: 'POST', path: '/members', body: { phone: '60123456789' } }]);
  });

  it('refused by privacy: offers Send invite, sends it only on click, then says it was sent', async () => {
    const calls = mockApi(view(), {
      'POST /members': () => json({ result: 'invite_needed', memberJid: '311999@lid' }),
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Add member' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a member' });
    await user.type(within(dialog).getByLabelText('WhatsApp number'), '60123456787');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText("Couldn't add this person")).toBeTruthy();
    expect(dialog.textContent).toContain('+60123456787 only lets people they know add them');
    expect(calls).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(await within(dialog).findByText('Invite sent')).toBeTruthy();
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/members/311999@lid/invite',
      body: undefined,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Add a member' })).toBeNull();
  });

  it('says when the number is not on WhatsApp, and when an invite fails', async () => {
    let refuse = true;
    mockApi(view(), {
      'POST /members': () =>
        refuse
          ? fail(422, 'not_on_whatsapp')
          : json({ result: 'invite_needed', memberJid: '60123456787@s.whatsapp.net' }),
      'POST /members/60123456787@s.whatsapp.net/invite': () => fail(409, 'invite_expired'),
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Add member' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a member' });
    await user.type(within(dialog).getByLabelText('WhatsApp number'), '60123456780');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This number is not on WhatsApp.',
    );
    refuse = false;
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Send invite' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'This invite has expired.',
    );
  });
});

describe('Members', () => {
  it('makes a member a group admin by their WhatsApp ID', async () => {
    const calls = mockApi(view());
    renderPanel();
    const user = userEvent.setup();
    await bar();
    await user.click(screen.getByRole('button', { name: /Farid/ }));
    await user.click(screen.getByRole('button', { name: 'Make group admin' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Farid is now a group admin'));
    expect(calls).toEqual([
      { method: 'PUT', path: '/members/60175550192@s.whatsapp.net/role', body: { admin: true } },
    ]);
  });

  it('asks before removing someone as admin', async () => {
    const calls = mockApi(view());
    renderPanel();
    const user = userEvent.setup();
    await bar();
    await user.click(screen.getByRole('button', { name: /Nurul Aisyah/ }));
    await user.click(screen.getByRole('button', { name: 'Remove as admin' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Remove Nurul Aisyah as admin?' });
    expect(confirm.textContent).toContain('They stay in the group as a member.');
    await user.click(within(confirm).getByRole('button', { name: 'Remove as admin' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Nurul Aisyah is no longer an admin'),
    );
    expect(calls).toEqual([
      { method: 'PUT', path: '/members/311222333444555@lid/role', body: { admin: false } },
    ]);
  });

  it('removes a member only after the confirm, then goes back to the list', async () => {
    const calls = mockApi(view());
    renderPanel();
    const user = userEvent.setup();
    await bar();
    await user.click(screen.getByRole('button', { name: /Farid/ }));
    await user.click(screen.getByRole('button', { name: 'Remove from group' }));
    let confirm = screen.getByRole('alertdialog', { name: 'Remove Farid from the group?' });
    expect(confirm.textContent).toContain('You can add them back later.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Remove from group' }));
    confirm = screen.getByRole('alertdialog', { name: 'Remove Farid from the group?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Farid was removed'));
    expect(calls).toEqual([
      { method: 'DELETE', path: '/members/60175550192@s.whatsapp.net', body: undefined },
    ]);
    expect(await screen.findByRole('list', { name: 'Group members' })).toBeTruthy();
  });

  it('shows a refused removal and keeps the member open', async () => {
    mockApi(view(), {
      'DELETE /members/60175550192@s.whatsapp.net': () => fail(409, 'not_member'),
    });
    renderPanel();
    const user = userEvent.setup();
    await bar();
    await user.click(screen.getByRole('button', { name: /Farid/ }));
    await user.click(screen.getByRole('button', { name: 'Remove from group' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This person is no longer in the group.'),
    );
    expect(screen.getByTestId('member-admin')).toBeTruthy();
  });

  it('never offers actions on the creator or on the linked number', async () => {
    mockApi(view());
    renderPanel();
    const user = userEvent.setup();
    await bar();
    await user.click(screen.getByRole('button', { name: /Oyen Jarvis/ }));
    const actions = screen.getByTestId('member-admin');
    expect(actions.textContent).toContain("The group creator can't be removed or lose admin.");
    expect(within(actions).queryByRole('button', { name: /^(Make|Remove)/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Members' }));
    await user.click(await screen.findByRole('button', { name: /^You/ }));
    expect(screen.queryByTestId('member-admin')).toBeNull();
  });
});

describe('Invite link', () => {
  it('copies the link and resets it only after the confirm', async () => {
    const calls = mockApi(view({ settings: { approval: true } }));
    renderPanel();
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(within(await bar()).getByRole('button', { name: 'Invite link' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite link' });
    expect(dialog.textContent).toContain('An admin approves each person who uses the link.');
    expect(within(dialog).getByRole('textbox', { name: 'Invite link' })).toHaveProperty(
      'value',
      'https://chat.whatsapp.com/AbCdEf123',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('https://chat.whatsapp.com/AbCdEf123');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Link copied'));

    await user.click(within(dialog).getByRole('button', { name: 'Reset link' }));
    let confirm = screen.getByRole('alertdialog', { name: 'Reset the invite link?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls).toHaveLength(0);
    await user.click(
      within(screen.getByRole('dialog', { name: 'Invite link' })).getByRole('button', {
        name: 'Reset link',
      }),
    );
    confirm = screen.getByRole('alertdialog', { name: 'Reset the invite link?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reset link' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('New invite link ready'));
    expect(calls).toEqual([{ method: 'POST', path: '/invite-link/reset', body: undefined }]);
    expect(await screen.findByDisplayValue('https://chat.whatsapp.com/NewLink999')).toBeTruthy();
  });

  it('says when the link could not be read, and a reset can fail', async () => {
    mockApi(view({ inviteLink: null }), {
      'POST /invite-link/reset': () => fail(503, 'wa_unavailable'),
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Invite link' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite link' });
    expect(dialog.textContent).toContain("The link couldn't be read from WhatsApp.");
    await user.click(within(dialog).getByRole('button', { name: 'Reset link' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset link' }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'WhatsApp is offline. Try again when it reconnects.',
      ),
    );
  });
});

describe('Group settings', () => {
  it('changes a setting and shows Recent changes', async () => {
    const calls = mockApi(
      view({
        changes: [
          {
            at: Date.UTC(2026, 10, 3),
            byUserId: 1,
            byName: 'Admin',
            action: 'setting',
            memberJid: null,
            memberName: null,
            setting: 'announce',
            value: true,
          },
          {
            at: Date.UTC(2026, 10, 2),
            byUserId: null,
            byName: null,
            action: 'member_remove',
            memberJid: '60175550192@s.whatsapp.net',
            memberName: null,
            setting: null,
            value: null,
          },
        ],
      }),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Group settings' });
    const announce = within(dialog).getByRole('switch', { name: 'Only admins send messages' });
    expect(announce.getAttribute('aria-checked')).toBe('false');
    expect(
      within(dialog)
        .getByRole('switch', { name: 'Only admins edit group info' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(announce);
    await waitFor(() => expect(announce.getAttribute('aria-checked')).toBe('true'));
    await user.click(within(dialog).getByRole('radio', { name: 'Everyone' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { method: 'PUT', path: '/settings', body: { announce: true } },
      { method: 'PUT', path: '/settings', body: { memberAdd: 'all' } },
    ]);
    const history = within(dialog).getByTestId('group-history');
    expect(history.textContent).toContain('Admin changed who can send messages');
    expect(history.textContent).toContain('A former teammate removed +60175550192');
  });

  it('shows only settings WhatsApp reported, and a refusal', async () => {
    mockApi(view({ settings: { approval: false }, changes: [] }), {
      'PUT /settings': () => fail(429, 'too_many_adds'),
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Group settings' });
    expect(within(dialog).getAllByRole('switch')).toHaveLength(1);
    expect(dialog.textContent).toContain('No changes made in EzyChat yet.');
    await user.click(within(dialog).getByRole('switch', { name: 'Approve new members' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Too many people added in a short time. Wait an hour to keep your number safe.',
      ),
    );
  });

  it('a connection with none: a plain line', async () => {
    mockApi(view({ caps: { ...PHONE_CAPS, settings: [] } }));
    renderPanel();
    const user = userEvent.setup();
    await user.click(within(await bar()).getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Group settings' }).textContent).toContain(
      'This WhatsApp connection has no group settings EzyChat can change.',
    );
  });
});

describe('Join requests', () => {
  it('approves and rejects', async () => {
    const calls = mockApi(view());
    renderPanel();
    const user = userEvent.setup();
    const requests = within(await bar()).getByTestId('join-requests');
    await user.click(within(requests).getAllByRole('button', { name: 'Approve' })[0]!);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mei Ling joined the group'));
    await user.click(within(requests).getAllByRole('button', { name: 'Reject' })[1]!);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { method: 'POST', path: '/requests/60123000111@s.whatsapp.net', body: { approve: true } },
      { method: 'POST', path: '/requests/60123000222@s.whatsapp.net', body: { approve: false } },
    ]);
  });

  it('shows a refused decision', async () => {
    mockApi(view(), {
      'POST /requests/60123000111@s.whatsapp.net': () => fail(409, 'group_full'),
      'POST /requests/60123000222@s.whatsapp.net': () => fail(502, 'group_change_failed'),
    });
    renderPanel();
    const user = userEvent.setup();
    const requests = within(await bar()).getByTestId('join-requests');
    await user.click(within(requests).getAllByRole('button', { name: 'Approve' })[0]!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This group is full. Remove someone first.'),
    );
    await user.click(within(requests).getAllByRole('button', { name: 'Reject' })[1]!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "WhatsApp didn't make the change. Try again in a moment.",
      ),
    );
  });
});

describe('error text', () => {
  const t = i18n.getFixedT('en', 'inbox');
  it.each([
    ['already_member', 'This person is already in the group.'],
    ['cannot_change_owner', "The group creator can't be changed."],
    ['not_supported', "This WhatsApp connection can't do that."],
    [
      'inbox_removed',
      "This WhatsApp number was removed from EzyChat, so its groups can't be changed.",
    ],
  ])('%s', (code, text) => {
    expect(groupAdminErrorText(new ApiError(409, code, 'x'), t as never)).toBe(text);
  });

  it("falls back to the app's own text for other errors", () => {
    expect(groupAdminErrorText(new ApiError(400, 'validation', 'Bad phone'), t as never)).toBe(
      'Bad phone',
    );
    expect(groupAdminErrorText(new Error('boom'), t as never)).toBe('boom');
  });

  it('names every Recent changes action', () => {
    const base = {
      at: 0,
      byUserId: 1,
      byName: 'Sara',
      memberJid: '311@lid',
      memberName: null,
      setting: null,
      value: null,
    };
    const line = (action: Parameters<typeof changeLine>[0]['action'], over = {}) =>
      changeLine({ ...base, action, ...over }, t as never);
    expect(line('rename')).toBe('Sara renamed the group');
    expect(line('description')).toBe('Sara changed the description');
    expect(line('member_invite')).toBe('Sara sent an invite to someone');
    expect(line('admin_promote', { memberName: 'Ali' })).toBe('Sara made Ali an admin');
    expect(line('admin_demote', { memberName: 'Ali' })).toBe('Sara removed Ali as admin');
    expect(line('invite_reset')).toBe('Sara reset the invite link');
    expect(line('join_approve', { memberName: 'Ali' })).toBe('Sara approved Ali');
    expect(line('join_reject', { memberName: 'Ali' })).toBe('Sara rejected Ali');
    expect(line('setting', { setting: 'locked' })).toBe('Sara changed who can edit group info');
    expect(line('setting', { setting: 'approval' })).toBe('Sara changed join approval');
    expect(line('setting', { setting: 'memberAdd' })).toBe('Sara changed who can add members');
    expect(line('setting')).toBe('Sara changed who can send messages');
  });

  it('counts members besides the business number', () => {
    expect(othersCount(view({ size: null }), 9)).toBe(8);
    expect(othersCount(view({ size: 5, myRole: null }), 0)).toBe(5);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiGroupChat, Chat } from '@ezychat/shared';
import { ConversationHeader } from './ConversationHeader';
import { buildDirectory } from './useDirectory';

const base: Chat = {
  jid: '123456789012345@lid',
  inboxId: 1,
  waJid: '123456789012345@lid',
  type: 'dm',
  name: '',
  avatarUrl: null,
  unreadCount: 0,
  lastMessageAt: null,
  lastMessagePreview: null,
  status: 'open',
  assignedTo: null,
  updatedAt: 0,
  phone: null,
  lastInboundAt: null,
};

function renderHeader(
  chat: Chat,
  customer: {
    customerOpen?: boolean;
    onToggleCustomer?: () => void;
    onOpenInfo?: () => void;
    memberCount?: number | null;
    groupAi?: AiGroupChat | null;
  } = {},
) {
  return render(
    <ConversationHeader
      chat={chat}
      directory={buildDirectory(null, false, [])}
      onBack={vi.fn()}
      onAssign={vi.fn()}
      onToggleStatus={vi.fn()}
      notesOpen={false}
      notesCount={0}
      onToggleNotes={vi.fn()}
      showCustomer={chat.type === 'dm'}
      customerOpen={customer.customerOpen ?? false}
      onToggleCustomer={customer.onToggleCustomer ?? vi.fn()}
      onOpenInfo={customer.onOpenInfo ?? vi.fn()}
      memberCount={customer.memberCount ?? null}
      groupAi={customer.groupAi ?? null}
    />,
  );
}

afterEach(cleanup);

describe('ConversationHeader identity', () => {
  it('shows "Unknown contact" and "Phone number hidden" for a WhatsApp ID chat, never its digits', () => {
    const view = renderHeader(base);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Unknown contact');
    expect(screen.getByText('Phone number hidden')).toBeTruthy();
    expect(view.container.textContent).not.toContain('123456789012345');
  });

  it('shows the real phone number once WhatsApp has revealed it', () => {
    renderHeader({ ...base, name: 'Aisyah', phone: '60123456789' });
    expect(screen.getByText('+60123456789')).toBeTruthy();
    expect(screen.queryByText('Phone number hidden')).toBeNull();
  });

  it('uses +phone as the title when the chat has no name', () => {
    renderHeader({
      ...base,
      jid: '60123456789@s.whatsapp.net',
      name: '60123456789',
      phone: '60123456789',
    });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('+60123456789');
  });
});

describe('ConversationHeader customer button', () => {
  it('toggles the customer details of a direct chat', async () => {
    const onToggleCustomer = vi.fn();
    renderHeader({ ...base, name: 'Farah' }, { customerOpen: true, onToggleCustomer });
    const button = screen.getByRole('button', { name: 'Customer details' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toContain('Customer');
    fireEvent.click(button);
    expect(onToggleCustomer).toHaveBeenCalledOnce();
  });

  it('has no customer button in a group', () => {
    renderHeader({ ...base, jid: '1203@g.us', type: 'group', name: 'Team' });
    expect(screen.queryByRole('button', { name: 'Customer details' })).toBeNull();
  });
});

describe('ConversationHeader details', () => {
  it('opens group info from the group name and shows the member count', () => {
    const onOpenInfo = vi.fn();
    renderHeader(
      { ...base, jid: '1203@g.us', type: 'group', name: 'SME Founders' },
      { onOpenInfo, memberCount: 965 },
    );
    expect(screen.getByText('Group · 965 members')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open group info for SME Founders' }));
    expect(onOpenInfo).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('SME Founders');
  });

  it('opens customer details from a direct chat’s name', () => {
    const onOpenInfo = vi.fn();
    renderHeader({ ...base, name: 'Farah', phone: '60123456789' }, { onOpenInfo });
    fireEvent.click(screen.getByRole('button', { name: 'Open customer details for Farah' }));
    expect(onOpenInfo).toHaveBeenCalledOnce();
  });
});

describe('ConversationHeader inboxes', () => {
  it('shows no inbox chip without an inbox (one inbox, Lite)', () => {
    renderHeader({ ...base, name: 'Aisyah', phone: '60123456789' });
    expect(screen.queryByTestId('inbox-chip')).toBeNull();
  });

  it('shows the inbox chip before the number when the user sees two or more inboxes', () => {
    render(
      <ConversationHeader
        chat={{ ...base, name: 'Aisyah', phone: '60123456789', status: 'resolved' }}
        directory={buildDirectory(null, false, [])}
        inbox={{ name: 'Catering', tone: 'warning' }}
        onBack={vi.fn()}
        onAssign={vi.fn()}
        onToggleStatus={vi.fn()}
        notesOpen={false}
        notesCount={0}
        onToggleNotes={vi.fn()}
        showCustomer
        customerOpen={false}
        onToggleCustomer={vi.fn()}
      />,
    );
    const chip = screen.getByTestId('inbox-chip');
    expect(chip.textContent).toBe('Catering');
    expect(chip.nextElementSibling?.textContent).toBe('+60123456789 · Resolved');
  });

  it('offers only members who may open the chat’s inbox for assignment', async () => {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.hasPointerCapture ??= () => false;
    proto.setPointerCapture ??= () => {};
    proto.releasePointerCapture ??= () => {};
    proto.scrollIntoView ??= () => {};
    const onAssign = vi.fn();
    const ai = { role: 'agent', kind: 'ai', aiRole: 'sales', inboxIds: 'all' } as const;
    const directory = buildDirectory(
      null,
      false,
      [
        { id: 1, displayName: 'Aisyah', role: 'admin', disabled: false, inboxIds: 'all' },
        { id: 2, displayName: 'Daniel', role: 'agent', disabled: false, inboxIds: [1] },
        { id: 3, displayName: 'Mei Ling', role: 'agent', disabled: false, inboxIds: [2] },
        { ...ai, id: 4, displayName: 'Sales Agent', disabled: false, aiAgentId: 40 },
        // The agent of another inbox and a deleted agent are never offered.
        { ...ai, id: 5, displayName: 'Other AI', disabled: false, aiAgentId: 50 },
        { ...ai, id: 6, displayName: 'Old AI', disabled: true, aiAgentId: 60, aiDeleted: true },
      ],
      {
        inboxAgents: new Map([
          [1, 50],
          [2, 40],
        ]),
      },
    );
    const user = userEvent.setup();
    render(
      <ConversationHeader
        chat={{ ...base, jid: 'x@s.whatsapp.net#2', inboxId: 2, name: 'Bob', assignedTo: 2 }}
        directory={directory}
        onBack={vi.fn()}
        onAssign={onAssign}
        onToggleStatus={vi.fn()}
        notesOpen={false}
        notesCount={0}
        onToggleNotes={vi.fn()}
        showCustomer
        customerOpen={false}
        onToggleCustomer={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Assigned to' }));
    const options = await screen.findAllByRole('option');
    // Daniel (inbox 1 only) stays listed as the current assignee, but nobody else without access.
    expect(options.map((o) => o.textContent)).toEqual([
      'Unassigned',
      'Aisyah',
      'Mei Ling',
      'Sales Agent (AI Sales Agent)',
      'Daniel',
    ]);
    await user.click(screen.getByRole('option', { name: 'Mei Ling' }));
    expect(onAssign).toHaveBeenCalledWith(3);
  });
});

describe('ConversationHeader AI in groups badge', () => {
  const group: Chat = {
    ...base,
    jid: '120363000000000001@g.us',
    type: 'group',
    name: 'Kopi Lovers Club',
  };
  const ai = (patch: Partial<AiGroupChat> = {}): AiGroupChat => ({
    enabled: true,
    agentId: 3,
    agentName: 'Aina',
    agentEnabled: true,
    agentAnswersGroups: true,
    paused: false,
    listen: false,
    agents: [],
    ...patch,
  });

  it('shows on a switched-on group while the agent answers groups', () => {
    renderHeader(group, { groupAi: ai(), memberCount: 24 });
    expect(screen.getByTestId('group-ai-badge').textContent).toBe(
      'AI answers when tagged or quoted',
    );
    expect(screen.getByText('Group · 24 members')).toBeTruthy();
  });

  it('says when the loop guard paused the AI', () => {
    renderHeader(group, { groupAi: ai({ paused: true }) });
    expect(screen.getByTestId('group-ai-badge').textContent).toBe('AI paused');
  });

  it.each([
    ['the group is off', ai({ enabled: false })],
    ["the agent's Answer in groups is off", ai({ agentAnswersGroups: false })],
    ['nothing is known yet', null],
  ])('is hidden when %s', (_, groupAi) => {
    renderHeader(group, { groupAi });
    expect(screen.queryByTestId('group-ai-badge')).toBeNull();
  });

  it('never shows in a direct chat', () => {
    renderHeader(base, { groupAi: ai() });
    expect(screen.queryByTestId('group-ai-badge')).toBeNull();
  });
});

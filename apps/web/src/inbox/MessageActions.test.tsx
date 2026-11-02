import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Message } from '@ezychat/shared';
import { MessageBubble } from './MessageBubble';
import { DeleteMessageDialog, EditMessageDialog } from './MessageActions';
import { NO_RIGHTS, messageRights, type MessageChangeProps } from './message-changes';
import { buildDirectory } from './useDirectory';
import { qk, upsertMessageInCache, type MessagesData } from '../api/queries';

const NOW = Date.now();
const ours: Message = {
  id: 'OUT1',
  chatJid: '601@s.whatsapp.net',
  senderJid: null,
  senderName: null,
  fromMe: true,
  sentByUserId: 7,
  type: 'text',
  body: 'A large Kopi Peng is RM5.',
  mediaUrl: null,
  mediaMime: null,
  mediaName: null,
  mediaStatus: 'none',
  quotedId: null,
  status: 'sent',
  error: null,
  timestamp: NOW - 60_000,
  clientId: null,
  reactions: [],
};
const daniel = {
  id: 7,
  username: 'daniel',
  displayName: 'Daniel',
  role: 'agent' as const,
  kind: 'human' as const,
  locale: null,
  mustChangePassword: false,
  disabled: false,
  createdAt: 0,
};
const directory = buildDirectory(daniel as never, false, [
  daniel as never,
  { id: 1, displayName: 'Aisyah', role: 'admin', kind: 'human', disabled: false } as never,
]);

// Radix menus use pointer capture, which jsdom lacks.
const proto = Element.prototype as unknown as Record<string, unknown>;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};

let calls: Array<{ url: string; method: string; body: unknown }>;
let reply: (url: string, method: string) => Response;
beforeEach(() => {
  calls = [];
  reply = () => new Response('{}', { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return reply(url, init?.method ?? 'GET');
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function changes(user = { id: 7, role: 'agent' }, extra: Partial<MessageChangeProps> = {}) {
  return {
    rightsOf: (m: Message) =>
      messageRights(
        m,
        user,
        { editMessage: true, deleteForEveryone: true, deleteForMe: true },
        Date.now(),
      ),
    disabledReason: null,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    isAdmin: user.role === 'admin',
    ...extra,
  } satisfies MessageChangeProps;
}

function renderBubble(message: Message, props: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MessageBubble
          message={message}
          showSender={false}
          outboundLabel="Daniel"
          quoted={null}
          directory={directory}
          contactName="Ahmad Zulkifli"
          onReply={() => undefined}
          onReact={() => undefined}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the ⋮ menu of a message', () => {
  it('offers Edit and Delete on our own message and calls the handlers', async () => {
    const c = changes();
    renderBubble(ours, { changes: c });
    await userEvent.click(screen.getByTestId('message-more'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(c.onEdit).toHaveBeenCalledWith(ours);
    await userEvent.click(screen.getByTestId('message-more'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(c.onDelete).toHaveBeenCalledWith(ours);
  });

  it('after the windows: Edit and Delete stay visible, disabled, with the reason', async () => {
    renderBubble({ ...ours, timestamp: NOW - 3 * 24 * 3_600_000 }, { changes: changes() });
    await userEvent.click(screen.getByTestId('message-more'));
    const edit = await screen.findByRole('menuitem', { name: /Edit/ });
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    expect(edit.textContent).toContain('Only within 15 minutes of sending');
    const del = screen.getByRole('menuitem', { name: /Delete/ });
    expect(del.getAttribute('aria-disabled')).toBe('true');
  });

  it('WhatsApp offline: everything disabled with the reason', async () => {
    renderBubble(ours, {
      changes: changes(undefined, { disabledReason: 'WhatsApp is not connected.' }),
    });
    await userEvent.click(screen.getByTestId('message-more'));
    expect(
      (await screen.findByRole('menuitem', { name: 'Edit' })).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('WhatsApp is not connected.');
  });

  it("no menu on a teammate's or the customer's message for an agent", () => {
    renderBubble({ ...ours, sentByUserId: 1 }, { changes: changes() });
    renderBubble({ ...ours, id: 'IN1', fromMe: false, sentByUserId: null }, { changes: changes() });
    expect(screen.queryByTestId('message-more')).toBeNull();
  });

  it('on touch, Edit and Delete sit under Reply in the press-and-hold bar', async () => {
    const c = changes();
    renderBubble(ours, { changes: c });
    await userEvent.click(screen.getByTestId('reaction-picker-button'));
    const bar = await screen.findByTestId('reaction-picker');
    await userEvent.click(within(bar).getByRole('button', { name: 'Edit' }));
    expect(c.onEdit).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('reaction-picker-button'));
    await userEvent.click(
      within(await screen.findByTestId('reaction-picker')).getByRole('button', { name: 'Delete' }),
    );
    expect(c.onDelete).toHaveBeenCalled();
  });
});

describe('edited and deleted bubbles', () => {
  it('"Edited" opens the earlier versions with who and when', async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          messageId: 'OUT1',
          edits: [
            { previousBody: 'A large Kopi Peng is RM5.', at: NOW - 30_000, by: 'team', userId: 7 },
            { previousBody: 'RM5.20?', at: NOW - 20_000, by: 'phone', userId: null },
          ],
          original: null,
        }),
      );
    renderBubble({
      ...ours,
      body: 'A large Kopi Peng is RM5.50.',
      editedAt: NOW - 10_000,
      editCount: 2,
    });
    await userEvent.click(screen.getByTestId('edited-label'));
    expect(await screen.findByText('A large Kopi Peng is RM5.')).toBeTruthy();
    expect(screen.getByText(/Changed by You/)).toBeTruthy();
    expect(screen.getByText(/Changed by the phone/)).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(['/api/messages/OUT1/edits']);
  });

  it('a failed history load says so', async () => {
    reply = () => new Response('{"error":{"code":"x","message":"x"}}', { status: 500 });
    renderBubble({ ...ours, editedAt: NOW });
    await userEvent.click(screen.getByTestId('edited-label'));
    expect(await screen.findByText('Could not load. Try again.')).toBeTruthy();
  });

  it('a deleted message: placeholder, no text, reply, copy or ticks; admins reveal the original', async () => {
    reply = () =>
      new Response(JSON.stringify({ messageId: 'IN1', edits: [], original: 'Sorry, wrong chat' }));
    const gone: Message = {
      ...ours,
      id: 'IN1',
      fromMe: false,
      sentByUserId: null,
      body: null,
      deletedAt: NOW,
      deletedBy: 'sender',
    };
    const view = renderBubble(gone, { changes: changes({ id: 1, role: 'admin' }) });
    expect(screen.getByText('Ahmad Zulkifli deleted this message')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByTestId('copy-message')).toBeNull();
    expect(screen.queryByTestId('message-more')).toBeNull();
    await userEvent.click(screen.getByTestId('show-original'));
    expect(await screen.findByText('Sorry, wrong chat')).toBeTruthy();
    await userEvent.click(screen.getByTestId('show-original'));
    expect(screen.queryByText('Sorry, wrong chat')).toBeNull();
    view.unmount();

    // An agent never gets the button.
    renderBubble(gone, { changes: changes() });
    expect(screen.queryByTestId('show-original')).toBeNull();
  });

  it('names who deleted it: a teammate, the phone, a group admin', () => {
    const del = (extra: Partial<Message>) =>
      renderBubble({ ...ours, body: null, deletedAt: NOW, ...extra }).unmount;
    const a = del({ deletedBy: 'team', deletedByUserId: 1 });
    expect(screen.getByText('Aisyah deleted this message')).toBeTruthy();
    a();
    const b = del({ deletedBy: 'phone' });
    expect(screen.getByText('Deleted from the phone')).toBeTruthy();
    b();
    del({ fromMe: false, deletedBy: 'group_admin' });
    expect(screen.getByText('A group admin deleted this message')).toBeTruthy();
  });

  it('a quote of a deleted message says so', () => {
    renderBubble(
      { ...ours, id: 'R1', quotedId: 'IN1' },
      { quoted: { ...ours, id: 'IN1', body: null, deletedAt: NOW, deletedBy: 'sender' } },
    );
    expect(screen.getByText('This message was deleted')).toBeTruthy();
  });
});

function renderDialogs(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe('edit and delete dialogs', () => {
  it('edit: saves the trimmed text with Ctrl+Enter or Save; unchanged text cannot be saved', async () => {
    reply = () => new Response(JSON.stringify({ ...ours, body: 'RM5.50', editedAt: NOW }));
    const onClose = vi.fn();
    renderDialogs(<EditMessageDialog message={ours} onClose={onClose} />);
    const save = screen.getByTestId('edit-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const box = screen.getByTestId('edit-text');
    await userEvent.clear(box);
    await userEvent.type(box, '  RM5.50  ');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([
      { url: '/api/messages/OUT1', method: 'PATCH', body: { text: 'RM5.50' } },
    ]);
  });

  it('edit: a refusal shows the server message and keeps the dialog', async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'edit_window_closed',
            message: 'A message can be edited only within 15 minutes',
          },
        }),
        { status: 409 },
      );
    const onClose = vi.fn();
    renderDialogs(
      <EditMessageDialog message={{ ...ours, type: 'image', body: 'cap' }} onClose={onClose} />,
    );
    expect(screen.getByText('Edit caption')).toBeTruthy();
    await userEvent.type(screen.getByTestId('edit-text'), '!');
    await userEvent.click(screen.getByTestId('edit-save'));
    expect(await screen.findByText(/only within 15 minutes/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('delete: both choices for an admin; for everyone and for me call the server', async () => {
    reply = () =>
      new Response(JSON.stringify({ ...ours, body: null, deletedAt: NOW, deletedBy: 'team' }));
    const onClose = vi.fn();
    const rights = messageRights(
      ours,
      { id: 1, role: 'admin' },
      { editMessage: true, deleteForEveryone: true, deleteForMe: true },
      NOW,
    );
    const view = renderDialogs(
      <DeleteMessageDialog message={ours} rights={rights} onClose={onClose} />,
    );
    expect(screen.getByText(/removes it from the customer's WhatsApp/)).toBeTruthy();
    expect(screen.getByText(/hides it for the whole team/)).toBeTruthy();
    await userEvent.click(screen.getByTestId('delete-for-everyone'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    view.unmount();
    renderDialogs(<DeleteMessageDialog message={ours} rights={rights} onClose={onClose} />);
    await userEvent.click(screen.getByTestId('delete-for-me'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['DELETE', '/api/messages/OUT1?scope=everyone'],
      ['DELETE', '/api/messages/OUT1?scope=me'],
    ]);
  });

  it('delete: after 2 days only Delete for me is left; an error shows; closed with no message', async () => {
    reply = () =>
      new Response(
        JSON.stringify({ error: { code: 'not_supported', message: 'Cannot do this' } }),
        {
          status: 409,
        },
      );
    const rights = {
      ...NO_RIGHTS,
      canDeleteForEveryone: true,
      deleteWindowClosed: true,
      canDeleteForMe: true,
    };
    renderDialogs(<DeleteMessageDialog message={ours} rights={rights} onClose={() => undefined} />);
    expect(screen.queryByTestId('delete-for-everyone')).toBeNull();
    expect(screen.getByText(/only possible within 2 days/)).toBeTruthy();
    await userEvent.click(screen.getByTestId('delete-for-me'));
    expect(await screen.findByText('Cannot do this')).toBeTruthy();
    cleanup();
    renderDialogs(
      <DeleteMessageDialog message={null} rights={NO_RIGHTS} onClose={() => undefined} />,
    );
    expect(screen.queryByText('Delete message?')).toBeNull();
  });
});

describe('message cache', () => {
  it('a message hidden for the team leaves the conversation', () => {
    const qc = new QueryClient();
    const data: MessagesData = {
      pages: [{ messages: [ours, { ...ours, id: 'OUT2' }], nextBefore: null }],
      pageParams: [null],
    };
    qc.setQueryData(qk.messages(ours.chatJid), data);
    upsertMessageInCache(qc, { ...ours, hidden: true });
    expect(
      qc.getQueryData<MessagesData>(qk.messages(ours.chatJid))!.pages[0]!.messages.map((m) => m.id),
    ).toEqual(['OUT2']);
    // Not in the cache: nothing happens.
    upsertMessageInCache(qc, { ...ours, id: 'GONE', hidden: true });
    expect(
      qc.getQueryData<MessagesData>(qk.messages(ours.chatJid))!.pages[0]!.messages,
    ).toHaveLength(1);
  });
});

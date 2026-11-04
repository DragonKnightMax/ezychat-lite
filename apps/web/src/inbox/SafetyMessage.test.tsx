import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import type { Message, MessageSafety, SafetyChatState } from '@ezychat/shared';
import { copyText } from '@/lib/clipboard';
import { SafetyChatBar, SafetyFile, SafetyNotice, showsSafety } from './SafetyMessage';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn(async () => undefined) }));
const role = { current: 'admin' as 'admin' | 'agent' };
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ user: { role: role.current } }) }));

const safety = (over: Partial<MessageSafety> = {}): MessageSafety => ({
  itemId: 4,
  level: 'high',
  rules: ['exeInZip', 'doubleExtension', 'firstFile'],
  aiReason: 'A fake statement that installs malware.',
  locked: true,
  deletedBy: null,
  status: 'open',
  ...over,
});
const message = {
  id: 'M1',
  fromMe: false,
  mediaName: 'Statement.zip',
  type: 'document',
} as Message;

let chat: SafetyChatState;
let mediaStatus: number;
let client: QueryClient;
const fetcher = vi.fn(async (url: string) => {
  if (url.startsWith('/api/safety/chats/'))
    return new Response(JSON.stringify(chat), { headers: { 'content-type': 'application/json' } });
  if (url === '/api/media/M1') return new Response('x', { status: mediaStatus });
  if (url === '/api/safety/items/4/unblock')
    return new Response(
      JSON.stringify({
        settings: { enabled: true, ai: true, autoBlock: false, deleteAfterDays: 30 },
        aiReady: true,
        items: [],
        blocked: [],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  throw new Error(`unexpected ${url}`);
});

beforeEach(() => {
  role.current = 'admin';
  mediaStatus = 200;
  chat = { enabled: true, scam: false, blocked: null, maybeHacked: false, itemId: 4 };
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});
const wrap = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

it('shows the banner with at most two reasons and the AI line, only while it matters', () => {
  wrap(<SafetyNotice safety={safety()} hasFile />);
  const note = screen.getByTestId('safety-notice');
  expect(note.textContent).toContain("Don't open this file");
  expect(note.textContent).toContain('The ZIP hides a program');
  expect(note.textContent).not.toContain('First file');
  expect(note.textContent).toContain('installs malware');
  cleanup();
  wrap(
    <SafetyNotice
      safety={safety({ level: 'warning', rules: ['lookalikeLink'], aiReason: null })}
      hasFile={false}
    />,
  );
  expect(screen.getByTestId('safety-notice').textContent).toContain('Be careful with this message');
  expect(showsSafety({ ...message, safety: safety() })).toBe(true);
  expect(showsSafety({ ...message, safety: safety({ status: 'safe' }) })).toBe(false);
  expect(showsSafety({ ...message, fromMe: true, safety: safety() })).toBe(false);
});

it('locks the file for an agent: the try is sent (and recorded) and refused', async () => {
  role.current = 'agent';
  mediaStatus = 403;
  wrap(<SafetyFile message={message} safety={safety()} />);
  const file = screen.getByTestId('safety-file');
  expect(file.getAttribute('data-locked')).toBe('true');
  expect(file.textContent).toContain('Locked for safety. Ask an admin.');
  await userEvent.click(file);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('This file is locked. Ask an admin to unlock it.'),
  );
});

it('lets an admin download after the warning', async () => {
  wrap(<SafetyFile message={message} safety={safety()} />);
  await userEvent.click(screen.getByTestId('safety-file'));
  expect((await screen.findByTestId('safety-download-dialog')).textContent).toContain(
    'High-risk file',
  );
  await userEvent.click(screen.getByTestId('safety-download-confirm'));
  // Past the phone's file cache: the server checks the lock and records every download.
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      '/api/media/M1',
      expect.objectContaining({ cache: 'no-store' }),
    ),
  );
  await waitFor(() => expect(screen.queryByTestId('safety-download-dialog')).toBeNull());
});

it('shows a deleted file and a checked Warning file', () => {
  wrap(<SafetyFile message={message} safety={safety({ deletedBy: 'Aisyah' })} />);
  expect(screen.getByTestId('safety-file-deleted').textContent).toContain(
    'File deleted by Aisyah.',
  );
  cleanup();
  wrap(<SafetyFile message={message} safety={safety({ deletedBy: '' })} />);
  expect(screen.getByTestId('safety-file-deleted').textContent).toContain('File deleted.');
  cleanup();
  wrap(<SafetyFile message={message} safety={safety({ level: 'warning', locked: false })} />);
  expect(screen.getByTestId('safety-file').textContent).toContain('Tap to check before download.');
});

it('shows the chat bar: hacked customer with Copy warning, blocked with Unblock, reported', async () => {
  chat = { ...chat, maybeHacked: true };
  wrap(<SafetyChatBar jid="60129001234@s.whatsapp.net" />);
  expect((await screen.findByTestId('safety-chat-bar')).getAttribute('data-kind')).toBe('hacked');
  await userEvent.click(screen.getByRole('button', { name: 'Copy warning' }));
  expect(copyText).toHaveBeenCalledWith(expect.stringContaining('may be hacked'));
  cleanup();
  client.clear();

  chat = { ...chat, maybeHacked: false, blocked: { by: null, at: 1, auto: true } };
  wrap(<SafetyChatBar jid="601@s.whatsapp.net" />);
  const bar = await screen.findByTestId('safety-chat-bar');
  expect(bar.textContent).toContain('Blocked automatically');
  await userEvent.click(screen.getByRole('button', { name: 'Unblock' }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith('/api/safety/items/4/unblock', expect.anything()),
  );
  cleanup();
  client.clear();

  chat = { ...chat, blocked: { by: 'Aisyah', at: 1, auto: false } };
  role.current = 'agent';
  wrap(<SafetyChatBar jid="602@s.whatsapp.net" />);
  expect((await screen.findByTestId('safety-chat-bar')).textContent).toContain(
    'Blocked by Aisyah.',
  );
  expect(screen.queryByRole('button', { name: 'Unblock' })).toBeNull();
  cleanup();
  client.clear();

  chat = { ...chat, blocked: null, scam: true };
  wrap(<SafetyChatBar jid="603@s.whatsapp.net" />);
  expect((await screen.findByTestId('safety-chat-bar')).textContent).toContain(
    'reported this number as a scam',
  );
});

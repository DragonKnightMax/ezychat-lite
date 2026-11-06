import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NewChatStatus } from '@ezychat/shared';
import { NewChatSection } from './NewChatSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let status: NewChatStatus;
let failNext = false;
const puts: unknown[] = [];
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  status = { allowed: true, staffEnabled: false, dailyLimit: 20, perUserPerHour: 5, inboxes: [] };
  failNext = false;
  puts.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/new-chat/settings' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Partial<NewChatStatus>;
        puts.push(body);
        if (failNext) return json({ error: { code: 'internal', message: 'Could not save' } }, 500);
        status = { ...status, ...body };
        return json(status);
      }
      if (url === '/api/new-chat') return json(status);
      throw new Error(`unexpected ${url}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NewChatSection />
    </QueryClientProvider>,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('switches team members on and sets the daily limit in one save, with the ban warning', async () => {
  const user = userEvent.setup();
  const toggle = await screen.findByRole('switch', { name: 'Team members can start new chats' });
  expect(screen.getByText('Off: only admins see New chat.')).toBeTruthy();
  expect(screen.getByText('A high limit can get your number banned')).toBeTruthy();
  const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  await user.click(toggle);
  expect(
    screen.getByText('On: everyone can start new chats from the inbox they belong to.'),
  ).toBeTruthy();
  const limit = screen.getByLabelText('New chats per day, per WhatsApp number');
  await user.clear(limit);
  await user.type(limit, '0');
  expect(screen.getByText(/No limit: your team and AI assistants/)).toBeTruthy();
  await user.click(save);
  await waitFor(() => expect(puts).toEqual([{ staffEnabled: true, dailyLimit: 0 }]));
  await waitFor(() => expect(save.disabled).toBe(true));
});

it('refuses a limit outside 0–1000 and shows a failed save', async () => {
  const user = userEvent.setup();
  const limit = await screen.findByLabelText('New chats per day, per WhatsApp number');
  await waitFor(() => expect((limit as HTMLInputElement).value).toBe('20'));
  await user.clear(limit);
  expect(screen.getByText('Enter a whole number from 0 to 1000.')).toBeTruthy();
  const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await user.type(limit, '5');
  failNext = true;
  await user.click(save);
  expect(await screen.findByText('Could not save')).toBeTruthy();
  expect(puts).toEqual([{ dailyLimit: 5 }]);
});

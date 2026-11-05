import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Settings } from '@ezychat/shared';
import { UsageStatsCard } from './UsageStatsSwitch';

let client: QueryClient;
let settings: Settings;
let fail = false;
const patches: unknown[] = [];
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/settings' && init?.method === 'PATCH') {
    const body = JSON.parse(String(init.body)) as Partial<Settings>;
    patches.push(body);
    if (fail) return json({ error: { code: 'internal', message: 'Could not save' } }, 500);
    settings = { ...settings, ...body };
    return json({ settings, restartRequired: false });
  }
  if (url === '/api/settings') return json(settings);
  throw new Error(`unexpected ${url}`);
});

beforeEach(() => {
  settings = {
    port: 7420,
    lanEnabled: false,
    historyDays: 3,
    namedTunnelHostname: null,
    hasTunnelToken: false,
    usageStats: true,
  };
  fail = false;
  patches.length = 0;
  vi.stubGlobal('fetch', fetcher);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});
const show = () =>
  render(
    <QueryClientProvider client={client}>
      <UsageStatsCard />
    </QueryClientProvider>,
  );

it('is on by default and saves only the switch when turned off and on again', async () => {
  show();
  const toggle = await screen.findByRole('switch', { name: 'Share anonymous usage stats' });
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  expect(screen.getByText(/No names, numbers or messages/)).toBeTruthy();
  await userEvent.click(toggle);
  await waitFor(() => expect(settings.usageStats).toBe(false));
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  await userEvent.click(toggle);
  await waitFor(() => expect(settings.usageStats).toBe(true));
  expect(patches).toEqual([{ usageStats: false }, { usageStats: true }]);
});

it('explains what is sent and never sent, and shows a failed save', async () => {
  show();
  await userEvent.click(
    await screen.findByRole('button', { name: 'What are anonymous usage stats?' }),
  );
  expect(await screen.findByText(/Never who you are/)).toBeTruthy();
  fail = true;
  await userEvent.click(screen.getByRole('switch', { name: 'Share anonymous usage stats' }));
  expect(await screen.findByText('Could not save')).toBeTruthy();
});

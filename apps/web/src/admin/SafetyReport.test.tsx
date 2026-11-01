import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { SafetyReport } from '@ezychat/shared';
import { SafetyReportSection } from './SafetyReport';

const totals = {
  dangerousFiles: 4,
  scamMessages: 3,
  riskyDownloads: 1,
  refusedDownloads: 2,
  numbersBlocked: 2,
  autoBlocked: 1,
  maybeHacked: 1,
  flagged: 10,
  falseAlarms: 2,
};
let report: SafetyReport;
let client: QueryClient;
const fetcher = vi.fn(async (url: string) => {
  if (url === '/api/reports/safety?days=7' || url === '/api/reports/safety?days=7&inbox=2')
    return new Response(JSON.stringify(report), {
      headers: { 'content-type': 'application/json' },
    });
  throw new Error(`unexpected ${url}`);
});

beforeEach(() => {
  report = {
    days: 7,
    inboxId: null,
    enabled: true,
    totals,
    previous: { ...totals, dangerousFiles: 2, scamMessages: 6 },
    daily: [
      { date: '2026-10-25', high: 0, warning: 0 },
      { date: '2026-10-31', high: 2, warning: 1 },
    ],
    kinds: [
      { kind: 'hiddenProgram', count: 3 },
      { kind: 'fakeLink', count: 2 },
    ],
    senders: [
      {
        chatJid: '601123456789@s.whatsapp.net',
        phone: '601123456789',
        name: 'Accounts Dept',
        count: 3,
        status: 'blocked',
      },
    ],
    team: [{ name: 'Daniel', riskyDownloads: 1, refused: 2 }],
  };
  vi.stubGlobal('fetch', fetcher);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});
const show = () =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SafetyReportSection days={7} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

it('shows the six numbers with their change and the charts', async () => {
  show();
  const tiles = await screen.findByTestId('safety-totals');
  expect(tiles.textContent).toContain('Dangerous files4+100% vs previous 7 days');
  expect(tiles.textContent).toContain('Scam messages3−50% vs previous 7 days');
  expect(tiles.textContent).toContain('Downloaded by your team · 2 stopped by the lock');
  expect(tiles.textContent).toContain('1 automatically');
  expect(tiles.textContent).toContain('20%');
  expect(screen.getByTestId('safety-risky-downloads').className).toContain('border-danger');
  expect(screen.getByTestId('card-safety-daily').textContent).toContain('3 flagged');
  expect(screen.getByTestId('card-safety-kinds').textContent).toContain(
    'Most common: Program hidden in a file.',
  );
  expect(screen.getByTestId('card-safety-team').textContent).toContain('Daniel');
  expect(screen.getByTestId('card-safety-senders').textContent).toContain('+601123456789');
  await userEvent.click(screen.getAllByRole('button', { name: /table/i })[0]!);
  expect(screen.getByTestId('card-safety-daily').querySelector('table')).toBeTruthy();
});

it('says the lock stopped every try when nobody opened a risky file', async () => {
  report = { ...report, team: [{ name: 'Daniel', riskyDownloads: 0, refused: 2 }] };
  show();
  expect(
    await screen.findByText('The lock stopped every try. Nobody opened a risky file.'),
  ).toBeTruthy();
});

it('says when nothing was flagged, and when Safety is off', async () => {
  report = {
    ...report,
    totals: { ...totals, riskyDownloads: 0, flagged: 0, falseAlarms: 0, maybeHacked: 0 },
    previous: { ...totals, dangerousFiles: 0, scamMessages: 0 },
    daily: [{ date: '2026-10-31', high: 0, warning: 0 }],
    kinds: [],
    senders: [],
    team: [],
  };
  show();
  expect(await screen.findByText('Nobody tried to open a risky file.')).toBeTruthy();
  expect(screen.getAllByText('Nothing flagged in this period.').length).toBeGreaterThan(0);
  cleanup();
  client.clear();
  report = { ...report, enabled: false };
  show();
  expect(await screen.findByText('WhatsApp Safety is off, so nothing was checked.')).toBeTruthy();
});

it('counts only the inbox the page picked', async () => {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SafetyReportSection days={7} inbox={2} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByTestId('safety-totals');
  expect(fetcher.mock.calls.map(([url]) => url)).toContain('/api/reports/safety?days=7&inbox=2');
});

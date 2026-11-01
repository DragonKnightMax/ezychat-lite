import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  DEFAULT_INBOX_CAPABILITIES,
  type Inbox,
  type Report,
  type ReportDay,
} from '@ezychat/shared';
import { ReportsPage, busiestBlock } from './ReportsPage';

const query = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  days: [] as number[],
  inboxes: [] as Array<number | null>,
  safetyInboxes: [] as Array<number | null | undefined>,
  visible: [] as unknown[],
}));
// The WhatsApp Safety section has its own test (SafetyReport.test.tsx).
vi.mock('./SafetyReport', () => ({
  SafetyReportSection: ({ inbox }: { inbox?: number | null }) => {
    query.safetyInboxes.push(inbox);
    return null;
  },
}));
vi.mock('../api/queries', () => ({
  useReport: (days: number, inbox: number | null) => {
    query.days.push(days);
    query.inboxes.push(inbox);
    return query.current;
  },
}));
vi.mock('../inbox/useVisibleInboxes', () => ({ useVisibleInboxes: () => query.visible }));

function inbox(id: number, name: string, number: string | null): Inbox {
  return {
    id,
    name,
    tone: 'primary',
    number,
    removed: false,
    aiAgentId: null,
    type: 'linked_phone',
    capabilities: DEFAULT_INBOX_CAPABILITIES,
    status: { state: 'open', me: null, qr: null, lastError: null },
  };
}

const DAY = 86_400_000;
const NOW = Date.now();

function day(date: string, inbound: number, extra: Partial<ReportDay> = {}): ReportDay {
  return { date, inbound, outbound: inbound - 1, newCustomers: 1, activeChats: 2, ...extra };
}

/** 14 days from Mon 5 Oct 2026; Friday 16th is the busiest; weekends quiet. */
function daily(): ReportDay[] {
  return Array.from({ length: 14 }, (_, i) => {
    const date = `2026-10-${String(5 + i).padStart(2, '0')}`;
    const wd = i % 7;
    return day(date, date === '2026-10-16' ? 40 : wd >= 5 ? 3 : 10);
  });
}

function hours(): number[][] {
  return Array.from({ length: 7 }, (_, wd) =>
    Array.from({ length: 24 }, (_, h) => (wd === 4 && (h === 10 || h === 11) ? 6 : h > 8 ? 1 : 0)),
  );
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    days: 30,
    inboxId: null,
    timeZone: 'Asia/Kuala_Lumpur',
    firstDate: '2026-10-05',
    linkedDate: '2026-10-05',
    totals: {
      newCustomers: 12,
      messagesIn: 200,
      messagesOut: 150,
      activeChats: 30,
      medianFirstReplyMinutes: 9,
      missedLeads: 2,
      aiAnswered: 20,
      aiResolved: 3,
      aiHandoffs: 10,
    },
    previous: {
      newCustomers: 10,
      messagesIn: 200,
      messagesOut: 120,
      activeChats: 20,
      medianFirstReplyMinutes: 12,
      missedLeads: 1,
      aiAnswered: 0,
      aiResolved: 1,
      aiHandoffs: 5,
    },
    waitingAfterHandoff: { count: 2, oldestAt: NOW - 7 * DAY - 3_600_000 },
    daily: daily(),
    weekdays: [10, 10, 10, 10, 25, 3, 3].map((avgInbound, weekday) => ({
      weekday,
      avgInbound,
      avgChats: 2,
    })),
    hours: hours(),
    handoffReasons: [
      { reason: 'missing_facts', count: 6 },
      { reason: 'business_rule', count: 3 },
      { reason: 'brand_new_reason', count: 1 },
    ],
    team: [
      {
        userId: 2,
        name: 'Sales Agent',
        kind: 'ai',
        chats: 20,
        replies: 60,
        medianReplyMinutes: 0.4,
      },
      { userId: 1, name: 'Aisyah', kind: 'human', chats: 9, replies: 40, medianReplyMinutes: 75 },
      { userId: null, name: '', kind: 'phone', chats: 2, replies: 3, medianReplyMinutes: null },
    ],
    ...overrides,
  };
}

const ready = (data: Report) => ({
  data,
  isPending: false,
  isError: false,
  isSuccess: true,
  refetch: vi.fn(),
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  query.days = [];
  query.inboxes = [];
  query.safetyInboxes = [];
  query.visible = [];
});
afterEach(cleanup);

describe('ReportsPage', () => {
  it('shows the totals with the change against the previous period', () => {
    query.current = ready(report());
    renderPage();
    const totals = within(screen.getByTestId('report-totals'));
    expect(totals.getByText('12')).toBeTruthy();
    expect(totals.getByText('Up 20% vs previous 30 days')).toBeTruthy(); // new customers: better
    expect(totals.getByText('Same as previous 30 days')).toBeTruthy(); // messages in
    expect(totals.getByText('150 replies sent')).toBeTruthy();
    expect(totals.getByText('9 min')).toBeTruthy();
    // Faster first replies read as better (green) although the number went down.
    expect(totals.getByText('Down 25% vs previous 30 days').className).toContain('text-success');
    // More missed customers is worse.
    expect(totals.getByText('Up 100% vs previous 30 days').className).toContain('text-danger');
    expect(totals.getByText('3 closed by the AI, 10 handed to the team')).toBeTruthy();
    const waiting = within(screen.getByTestId('stat-waiting'));
    expect(waiting.getByText('Oldest waiting 7 days')).toBeTruthy();
    expect(waiting.getByRole('link', { name: 'Open chats' }).getAttribute('href')).toBe('/');
  });

  it('names the busy day and busy times, and the reasons and team', () => {
    query.current = ready(report());
    renderPage();
    expect(
      screen.getByText(
        'Friday is your busiest day: 25 messages on average. Saturday is the quietest.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Busiest: Friday 10/)).toBeTruthy();
    expect(screen.getByText('Answer not in the Business context')).toBeTruthy();
    expect(screen.getByText('Other')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Add the missing answers to the Business context' })
        .getAttribute('href'),
    ).toBe('/admin/members/ai');
    expect(screen.getByText('10 hand-offs in this period.')).toBeTruthy();
    const team = within(screen.getByTestId('card-team'));
    expect(team.getByText('WhatsApp phone')).toBeTruthy();
    expect(team.getByText('AI')).toBeTruthy();
    expect(team.getByText('< 1 min')).toBeTruthy();
    expect(team.getByText('1 h 15 min')).toBeTruthy();
    expect(team.getByText('–')).toBeTruthy();
    expect(screen.getByText(/Customers from the history imported on/)).toBeTruthy();
  });

  it('shows the numbers of the bar or square under the pointer or finger', () => {
    query.current = ready(report());
    renderPage();
    const readout = screen.getByTestId('daily-readout');
    expect(readout.textContent).toContain('busiest day');
    expect(readout.textContent).toContain('40 from customers, 39 replies, 2 chats');
    const bars = screen.getAllByTestId('daily-bar');
    fireEvent.pointerEnter(bars[0]!);
    expect(readout.textContent).not.toContain('busiest day');
    expect(readout.textContent).toContain('10 from customers');
    // A tap's pointerleave keeps the value; a mouse leaving clears it.
    fireEvent.pointerLeave(bars[0]!.parentElement!.parentElement!.parentElement!, {
      pointerType: 'touch',
    });
    expect(readout.textContent).toContain('10 from customers');
    fireEvent.pointerLeave(bars[0]!.parentElement!.parentElement!.parentElement!, {
      pointerType: 'mouse',
    });
    expect(readout.textContent).toContain('busiest day');

    const hourReadout = screen.getByTestId('hour-readout');
    expect(hourReadout.textContent).toContain('Darker = more messages');
    fireEvent.pointerDown(screen.getAllByTestId('hour-cell')[4 * 24 + 10]!);
    expect(hourReadout.textContent).toContain('6 messages on average');

    const newReadout = screen.getByTestId('new-readout');
    expect(newReadout.textContent).toContain('1 new customers a day on average');
    fireEvent.pointerMove(screen.getByTestId('new-customers-chart'), { clientX: 10 });
    expect(newReadout.textContent).toContain('1 new customer');
    fireEvent.pointerLeave(screen.getByTestId('new-customers-chart'), { pointerType: 'mouse' });
    expect(newReadout.textContent).toContain('a day on average');
  });

  it('shows every chart as a table', async () => {
    query.current = ready(report());
    renderPage();
    const user = userEvent.setup();
    const busyDays = within(screen.getByTestId('card-weekdays'));
    await user.click(busyDays.getByRole('button', { name: 'Show as table' }));
    expect(busyDays.getByRole('columnheader', { name: 'Messages (avg)' })).toBeTruthy();
    expect(busyDays.getByRole('cell', { name: 'Friday' })).toBeTruthy();
    await user.click(busyDays.getByRole('button', { name: 'Show as chart' }));
    expect(busyDays.queryByRole('table')).toBeNull();
    for (const id of ['card-hours', 'card-daily', 'card-new']) {
      const card = within(screen.getByTestId(id));
      await user.click(card.getByRole('button', { name: 'Show as table' }));
      expect(card.getByRole('table')).toBeTruthy();
    }
  });

  it('switches the period', async () => {
    query.current = ready(report());
    renderPage();
    await userEvent.setup().click(screen.getByText('7 days'));
    expect(query.days.at(-1)).toBe(7);
  });

  it('has no inbox choice with one WhatsApp number: everything together', () => {
    query.current = ready(report());
    query.visible = [inbox(1, 'Kopi Apong', '60123456789')];
    renderPage();
    expect(screen.queryByTestId('reports-inbox')).toBeNull();
    expect(query.inboxes.at(-1)).toBeNull();
  });

  it('shows every inbox together or one of them, the Safety section too', async () => {
    // Radix Select needs pointer capture and scrolling, which jsdom lacks.
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.hasPointerCapture ??= () => false;
    proto.setPointerCapture ??= () => {};
    proto.releasePointerCapture ??= () => {};
    proto.scrollIntoView ??= () => {};
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    query.current = ready(report());
    query.visible = [inbox(1, 'Kopi Apong', '60123456789'), inbox(2, 'Catering', null)];
    const u = userEvent.setup();
    const view = renderPage();
    const trigger = screen.getByRole('combobox', { name: 'Inbox' });
    expect(trigger.textContent).toBe('All inboxes (2)');
    expect(query.inboxes.at(-1)).toBeNull();
    expect(query.safetyInboxes.at(-1)).toBeNull();

    await u.click(trigger);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'All inboxes (2)',
      'Kopi Apong · +60123456789',
      'Catering',
    ]);
    await u.click(screen.getByRole('option', { name: 'Catering' }));
    expect(query.inboxes.at(-1)).toBe(2);
    expect(query.safetyInboxes.at(-1)).toBe(2);
    // The period keeps the inbox.
    await u.click(screen.getByText('7 days'));
    expect([query.days.at(-1), query.inboxes.at(-1)]).toEqual([7, 2]);

    // The chosen inbox is removed: back to every inbox together.
    query.visible = [inbox(1, 'Kopi Apong', '60123456789'), inbox(3, 'Events', null)];
    view.rerender(
      <MemoryRouter>
        <ReportsPage />
      </MemoryRouter>,
    );
    expect(query.inboxes.at(-1)).toBeNull();

    await u.click(screen.getByRole('combobox', { name: 'Inbox' }));
    await u.click(await screen.findByRole('option', { name: 'All inboxes (2)' }));
    expect(query.inboxes.at(-1)).toBeNull();
  });

  it('draws a single day as one narrow bar and labels it once', () => {
    query.current = ready(report({ daily: [day('2026-10-26', 12)], previous: null }));
    renderPage();
    const bar = screen.getByTestId('daily-bar');
    expect(bar.className).toContain('max-w-10');
    const daily = within(screen.getByTestId('card-daily'));
    expect(daily.getAllByText(/Oct 26|26 Oct/)).toHaveLength(2); // the readout and one axis label
    expect(screen.getByTestId('new-single-day')).toBeTruthy();
  });

  it('waits for 2 weeks of messages before naming patterns', () => {
    const few = daily().slice(-5);
    query.current = ready(
      report({ firstDate: few[0]!.date, daily: few, previous: null, handoffReasons: [], team: [] }),
    );
    renderPage();
    expect(screen.getByText('Only 5 days of messages so far')).toBeTruthy();
    expect(screen.getAllByText('Too early to tell: shown after 2 weeks of messages.')).toHaveLength(
      2,
    );
    expect(screen.getByTestId('reports-since').textContent).toContain('Counted from');
    expect(screen.getByText('No hand-offs in this period.')).toBeTruthy();
    expect(screen.getByText('No replies in this period.')).toBeTruthy();
    expect(screen.queryByText(/vs previous/)).toBeNull();
    expect(
      within(screen.getByTestId('stat-waiting')).getByText('Oldest waiting 7 days'),
    ).toBeTruthy();
  });

  it('shows an empty state, loading and an error with Retry', async () => {
    query.current = ready(report({ daily: [], firstDate: null, linkedDate: null }));
    const { unmount } = renderPage();
    expect(screen.getByText('No messages yet')).toBeTruthy();
    unmount();

    query.current = { isPending: true, isError: false };
    const loading = renderPage();
    expect(screen.getByTestId('reports-loading')).toBeTruthy();
    loading.unmount();

    const refetch = vi.fn();
    query.current = { isPending: false, isError: true, error: new Error('boom'), refetch };
    renderPage();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows nobody waiting without a warning colour', () => {
    query.current = ready(
      report({
        waitingAfterHandoff: { count: 0, oldestAt: null },
        totals: { ...report().totals, missedLeads: 0, medianFirstReplyMinutes: null },
      }),
    );
    renderPage();
    const waiting = within(screen.getByTestId('stat-waiting'));
    expect(waiting.getByText('Nobody is waiting')).toBeTruthy();
    expect(waiting.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('stat-missed').className).not.toContain('border-warning');
  });
});

describe('busiestBlock', () => {
  it('finds the two busiest hours in a row, or none', () => {
    expect(busiestBlock(hours())).toMatchObject({ wd: 4, h: 10 });
    expect(busiestBlock([new Array<number>(24).fill(0)])).toBeNull();
  });
});

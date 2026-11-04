import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin } from '../../../../packages/server/src/auth/guards.js';
import { HttpError } from '../../../../packages/server/src/http/errors.js';
import { localDate, localMidnight } from '../../../../packages/server/src/chats/stats.js';

/**
 * Proposed (reports): what the app's future `GET /api/reports?days=` answers. Everything is counted
 * from the local database (messages, chat events, AI hand-offs); nothing leaves the computer.
 */
export interface MockReport {
  days: number;
  timeZone: string;
  /** Local date of the first stored message: earlier history was not kept. */
  firstDate: string | null;
  /** Local date the WhatsApp history import ended: customers seen before it are not "new". */
  historyImportedUntil: string | null;
  totals: ReportTotals;
  /** The same totals for the period just before (for "vs previous 30 days"). */
  previous: ReportTotals | null;
  daily: Array<{
    date: string;
    inbound: number;
    outbound: number;
    newCustomers: number;
    activeChats: number;
  }>;
  /** Monday first; averages over the days of that weekday in the period. */
  weekdays: Array<{ weekday: number; avgInbound: number; avgChats: number }>;
  /** [weekday Monday first][hour 0–23]: average messages from customers in that hour. */
  hours: number[][];
  handoffReasons: Array<{ reason: string; count: number }>;
  team: Array<{
    name: string;
    kind: 'human' | 'ai';
    chats: number;
    replies: number;
    medianReplyMinutes: number | null;
  }>;
}

interface ReportTotals {
  newCustomers: number;
  messagesIn: number;
  messagesOut: number;
  activeChats: number;
  /** Median minutes from a customer's first message to the first reply (team or AI). */
  medianFirstReplyMinutes: number | null;
  /** New customers who got no reply within 1 hour. */
  missedLeads: number;
  /** Chats the AI handed to the team where the customer is still waiting. */
  waitingAfterHandoff: number;
  oldestWaitingAt: number | null;
  aiAnswered: number;
  aiResolved: number;
  aiHandoffs: number;
}

/** Mock-only: which data the page shows. */
type Scenario = 'normal' | 'short' | 'empty' | 'slow' | 'error';

const DAY_MS = 86_400_000;
// Monday first. Shaped like a small Malaysian shop: Friday busiest, weekends quiet.
const WEEKDAY_WEIGHT = [0.8, 1.05, 1, 0.8, 1.4, 0.3, 0.45];
// Customer messages by hour: late morning, after lunch and the evening after work.
const HOUR_WEIGHT = [
  0.05, 0.02, 0.01, 0.01, 0.01, 0.02, 0.1, 0.3, 0.6, 1, 1.3, 1.4, 1.1, 0.9, 1.1, 1.2, 1, 0.8, 0.7,
  0.8, 1.05, 1, 0.6, 0.25,
];

/** Small seeded random numbers, so every reload shows the same demo. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0 = Monday … 6 = Sunday for a local `YYYY-MM-DD`. */
function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function dayRow(date: string, index: number) {
  const rnd = random(index * 7919 + 17);
  const trend = 0.85 + Math.min(index, 120) / 400; // a little busier over the months
  const inbound = Math.round(30 * WEEKDAY_WEIGHT[weekday(date)]! * trend * (0.75 + rnd() * 0.5));
  const outbound = Math.round(inbound * (0.72 + rnd() * 0.15));
  const activeChats = Math.max(inbound ? 1 : 0, Math.round(inbound / (4.5 + rnd() * 1.5)));
  const newCustomers = Math.round(activeChats * (0.25 + rnd() * 0.25));
  return { date, inbound, outbound, newCustomers, activeChats };
}

function totals(
  rows: MockReport['daily'],
  seed: number,
  waiting: boolean,
  waitingDays = 7,
): ReportTotals {
  const rnd = random(seed);
  const sum = (key: 'inbound' | 'outbound' | 'newCustomers' | 'activeChats') =>
    rows.reduce((n, r) => n + r[key], 0);
  const activeChats = Math.round(sum('activeChats') * 0.55);
  const aiAnswered = Math.round(activeChats * 0.7);
  return {
    newCustomers: sum('newCustomers'),
    messagesIn: sum('inbound'),
    messagesOut: sum('outbound'),
    activeChats,
    medianFirstReplyMinutes: rows.length ? Math.round(4 + rnd() * 6) : null,
    missedLeads: Math.round(sum('newCustomers') * (0.06 + rnd() * 0.05)),
    waitingAfterHandoff: waiting ? 2 : 0,
    oldestWaitingAt: waiting ? Date.now() - waitingDays * DAY_MS - 3 * 3_600_000 : null,
    aiAnswered,
    aiResolved: Math.round(aiAnswered * 0.08),
    aiHandoffs: Math.round(aiAnswered * 0.84),
  };
}

export function buildReport(
  days: number,
  timeZone: string,
  now: number,
  scenario: Scenario,
): MockReport {
  const today = localDate(now, timeZone);
  // The demo install linked WhatsApp 120 days ago ("short": 5 days ago, "empty": today, no messages).
  const linkedDaysAgo = scenario === 'short' ? 5 : scenario === 'empty' ? 0 : 120;
  const dateAt = (back: number) =>
    localDate(localMidnight(today, timeZone) - back * DAY_MS + DAY_MS / 2, timeZone);
  const window = (offset: number) => {
    const rows: MockReport['daily'] = [];
    for (let back = offset + days - 1; back >= offset; back--) {
      if (back > linkedDaysAgo || scenario === 'empty') continue;
      const date = dateAt(back);
      const row = dayRow(date, 400 - back);
      // Today is partial: only the hours that already passed.
      if (back === 0) {
        const hour = Number(
          new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(
            now,
          ),
        );
        const part = HOUR_WEIGHT.slice(0, hour + 1).reduce((a, b) => a + b, 0) / 16.4;
        for (const key of ['inbound', 'outbound', 'newCustomers', 'activeChats'] as const)
          row[key] = Math.round(row[key] * Math.min(1, part));
      }
      rows.push(row);
    }
    return rows;
  };
  const daily = window(0);
  const before = window(days);
  const weekdays = Array.from({ length: 7 }, (_, wd) => {
    const of = daily.filter((r) => weekday(r.date) === wd);
    const avg = (key: 'inbound' | 'activeChats') =>
      of.length ? Math.round((of.reduce((n, r) => n + r[key], 0) / of.length) * 10) / 10 : 0;
    return { weekday: wd, avgInbound: avg('inbound'), avgChats: avg('activeChats') };
  });
  const rnd = random(days * 31);
  const hours = weekdays.map((w) =>
    HOUR_WEIGHT.map((h) => Math.round(((w.avgInbound * h) / 16.4) * (0.8 + rnd() * 0.4) * 10) / 10),
  );
  const empty = daily.every((r) => r.inbound === 0);
  const t = totals(daily, days, !empty, Math.min(7, linkedDaysAgo - 1));
  const scale = (n: number) => Math.max(empty ? 0 : 1, Math.round((n * t.aiHandoffs) / 100));
  return {
    days,
    timeZone,
    firstDate: empty ? null : dateAt(linkedDaysAgo),
    historyImportedUntil: empty ? null : dateAt(linkedDaysAgo),
    totals: t,
    previous: before.length >= days ? totals(before, days + 1, true) : null,
    daily,
    weekdays,
    hours,
    handoffReasons: empty
      ? []
      : [
          { reason: 'missing_facts', count: scale(33) },
          { reason: 'business_rule', count: scale(29) },
          { reason: 'needs_action', count: scale(22) },
          { reason: 'unsupported_message', count: scale(6) },
          { reason: 'asked_for_human', count: scale(5) },
          { reason: 'ai_unavailable', count: scale(4) },
          { reason: 'sensitive', count: scale(1) },
        ].sort((a, b) => b.count - a.count),
    team: empty
      ? []
      : [
          {
            name: 'Sales Agent',
            kind: 'ai',
            chats: t.aiAnswered,
            replies: Math.round(t.messagesOut * 0.45),
            medianReplyMinutes: 0,
          },
          {
            name: 'Aisyah Rahman',
            kind: 'human',
            chats: Math.round(t.activeChats * 0.45),
            replies: Math.round(t.messagesOut * 0.3),
            medianReplyMinutes: 6,
          },
          {
            name: 'Daniel Tan',
            kind: 'human',
            chats: Math.round(t.activeChats * 0.3),
            replies: Math.round(t.messagesOut * 0.17),
            medianReplyMinutes: 14,
          },
          {
            name: 'Mei Ling Wong',
            kind: 'human',
            chats: Math.round(t.activeChats * 0.12),
            replies: Math.round(t.messagesOut * 0.08),
            medianReplyMinutes: 38,
          },
        ],
  };
}

/** Mock-only routes: the report and the scenario switch (admins only, as the future page). */
export function registerReports(app: FastifyInstance, ctx: AppContext): void {
  let scenario: Scenario = 'normal';
  const timeZone = () => {
    const zone = ctx.settings.get<string>('ai_timezone', '');
    return zone || 'Asia/Kuala_Lumpur';
  };
  app.get('/api/mock/reports', { preHandler: requireAdmin(ctx) }, async (request) => {
    const { days } = z
      .object({
        days: z.coerce
          .number()
          .int()
          .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])),
      })
      .parse(request.query);
    if (scenario === 'error')
      throw new HttpError(503, 'reports_unavailable', 'Reports could not be counted.');
    if (scenario === 'slow') await new Promise((r) => setTimeout(r, 1500));
    return buildReport(days, timeZone(), Date.now(), scenario);
  });
  app.get('/api/mock/reports/scenario', { preHandler: requireAdmin(ctx) }, async () => ({
    scenario,
  }));
  app.put('/api/mock/reports/scenario', { preHandler: requireAdmin(ctx) }, async (request) => {
    scenario = z
      .object({ scenario: z.enum(['normal', 'short', 'empty', 'slow', 'error']) })
      .parse(request.body).scenario;
    return { scenario };
  });
}

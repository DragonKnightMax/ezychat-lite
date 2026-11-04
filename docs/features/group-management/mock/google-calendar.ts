import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';
import { parse } from '../../../../packages/server/src/http/errors.js';

/**
 * Proposed (google-calendar): stand-in for the built-in Google Calendar connector. Nothing calls
 * Google: "Sign in with Google" is a mock consent dialog, the calendars and busy times are canned.
 * Production plan: `GET/POST /api/integrations/google-calendar*` and per-agent booking settings on
 * `/api/ai/agents/:agentId/bookings` (see ../design.md).
 */
export type MockGoogleState = 'disconnected' | 'connected' | 'expired' | 'unavailable';

export interface MockCalendar {
  id: string;
  name: string;
  /** The account's own calendar. */
  primary: boolean;
  /** Google says we may only read it (e.g. public holidays): never offered for bookings. */
  readOnly: boolean;
}

const AgentBooking = z.object({
  calendarId: z.string().min(1).max(100),
  checkFree: z.boolean(),
  book: z.boolean(),
  title: z.string().trim().min(1).max(60),
  lengthMin: z.number().int().min(15).max(240),
  days: z.array(z.number().int().min(0).max(6)).max(7),
  from: z.string().regex(/^\d{2}:\d{2}$/),
  to: z.string().regex(/^\d{2}:\d{2}$/),
  gapMin: z.number().int().min(0).max(120),
  noticeHours: z.number().int().min(0).max(72),
  maxDays: z.number().int().min(1).max(90),
});
export type MockAgentBooking = z.infer<typeof AgentBooking>;

export interface MockBookingRecord {
  /** Baseline addition (PR #192 Bookings tab): the record id, the agent's name, the event link. */
  id: string;
  agentId: string;
  agentName: string;
  eventUrl: string;
  chatJid: string;
  customer: string;
  start: string;
  end: string;
  title: string;
}

/** One line of the connector's Activity tab (never the chat text). */
export interface MockCalendarActivity {
  at: number;
  kind: 'checked' | 'booked' | 'handed_over';
  agent: string;
  customer: string;
  /** booked: the event's start and end. */
  start?: string;
  end?: string;
}

export interface MockGoogleCalendarState {
  state: MockGoogleState;
  account: string | null;
  calendars: MockCalendar[];
  agents: Record<string, MockAgentBooking>;
  bookings: MockBookingRecord[];
  activity: MockCalendarActivity[];
}

const ACCOUNT = 'kopiapong.penang@gmail.com';
const CALENDARS: MockCalendar[] = [
  { id: 'bookings', name: 'Kopi Apong bookings', primary: false, readOnly: false },
  { id: 'primary', name: ACCOUNT, primary: true, readOnly: false },
  { id: 'holidays', name: 'Holidays in Malaysia', primary: false, readOnly: true },
];

export const DEFAULT_BOOKING: MockAgentBooking = {
  calendarId: 'bookings',
  checkFree: true,
  book: false,
  title: 'Table booking',
  lengthMin: 90,
  days: [1, 2, 3, 4, 5, 6],
  from: '10:00',
  to: '21:00',
  gapMin: 15,
  noticeHours: 2,
  maxDays: 14,
};

export function registerGoogleCalendar(app: FastifyInstance, ctx: AppContext) {
  // The seeded demo starts connected with booking on for agent 1, so the booked chat makes sense.
  const store: MockGoogleCalendarState = {
    state: 'connected',
    account: ACCOUNT,
    calendars: CALENDARS,
    agents: { a1: { ...DEFAULT_BOOKING, book: true } },
    bookings: demoBookings(),
    activity: demoActivity(),
  };
  const view = (): MockGoogleCalendarState => ({
    ...store,
    calendars: store.state === 'disconnected' ? [] : store.calendars,
    account: store.state === 'disconnected' ? null : store.account,
  });
  app.get('/api/mock/google-calendar', { preHandler: requireUser(ctx) }, async () => view());
  // Baseline addition (PR #192): the Bookings tab reads EzyChat's own records of the events the AI
  // added (no Google call), upcoming first, then the past 30 days; links to each event and the calendar.
  app.get('/api/mock/google-calendar/bookings', { preHandler: requireUser(ctx) }, async () => {
    const now = Date.now();
    const sorted = [...store.bookings].sort((a, b) => a.start.localeCompare(b.start));
    return {
      upcoming: sorted.filter((b) => Date.parse(b.end) >= now),
      past: sorted
        .filter((b) => Date.parse(b.end) < now && Date.parse(b.end) > now - 30 * 86_400_000)
        .reverse(),
      calendarUrl:
        store.state !== 'disconnected' && store.account ? googleCalendarUrl(store.account) : null,
    };
  });
  app.post(
    '/api/mock/google-calendar/connect',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const { account } = parse(z.object({ account: z.string().email() }), request.body ?? {});
      store.state = 'connected';
      store.account = account;
      return view();
    },
  );
  app.post('/api/mock/google-calendar/disconnect', { preHandler: requireAdmin(ctx) }, async () => {
    store.state = 'disconnected';
    // Booking settings stay; the AI stops checking and booking until it is connected again.
    return view();
  });
  // Mock only: show the sign-in-expired and Google-unavailable states.
  app.put('/api/mock/google-calendar/state', { preHandler: requireAdmin(ctx) }, async (request) => {
    const body = parse(
      z.object({ state: z.enum(['connected', 'expired', 'unavailable']) }),
      request.body ?? {},
    );
    if (store.state !== 'disconnected') store.state = body.state;
    return view();
  });
  app.put<{ Params: { agentId: string } }>(
    '/api/mock/google-calendar/agents/:agentId',
    { preHandler: requireAdmin(ctx) },
    async (request) => {
      const id = z.string().min(1).max(40).parse(request.params.agentId);
      store.agents[id] = parse(AgentBooking, request.body ?? {});
      return view();
    },
  );
  return {
    record(booking: MockBookingRecord) {
      store.bookings.push(booking);
    },
  };
}

/** As `googleCalendarUrl` in packages/shared (PR #192): the account's calendar in the browser. */
export function googleCalendarUrl(account: string): string {
  return `https://calendar.google.com/calendar/r?authuser=${encodeURIComponent(account)}`;
}

/** Demo bookings: four upcoming (the booked chat first) and two in the past 30 days. */
function demoBookings(): MockBookingRecord[] {
  // Malaysia time (UTC+8), like the seeded shop.
  const at = (offsetDays: number, hour: number, minute: number) => {
    const d = new Date();
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays, hour - 8, minute),
    ).toISOString();
  };
  const friday = (5 - new Date().getUTCDay() + 7) % 7 || 7;
  const rows: Array<[string, string, number, number, number]> = [
    ['60124448899@s.whatsapp.net', 'Lim Mei Ying', friday, 19, 30],
    ['60126677889@s.whatsapp.net', 'Nurul Huda', friday + 1, 12, 0],
    ['60129001234@s.whatsapp.net', 'Jason Lim', friday + 3, 18, 0],
    ['60123110021@s.whatsapp.net', 'Farah Aziz', friday + 6, 10, 30],
    ['60125550142@s.whatsapp.net', 'Ahmad Zulkifli', -3, 13, 0],
    ['60128814455@s.whatsapp.net', 'Priya Nair', -9, 20, 0],
  ];
  return rows.map(([chatJid, customer, offsetDays, hour, minute], i) => {
    const start = at(offsetDays, hour, minute);
    return {
      id: `booking-${i + 1}`,
      agentId: 'a1',
      agentName: 'Aina',
      eventUrl: `https://calendar.google.com/calendar/event?eid=mock-${i + 1}`,
      chatJid,
      customer,
      start,
      end: new Date(Date.parse(start) + 90 * 60_000).toISOString(),
      title: 'Table booking',
    };
  });
}

/** Demo Activity: the booked chat of the seed (Lim Mei Ying) and two earlier lines. */
function demoActivity(): MockCalendarActivity[] {
  const now = Date.now();
  const friday = new Date(now);
  friday.setUTCDate(friday.getUTCDate() + ((5 - friday.getUTCDay() + 7) % 7 || 7));
  const start = new Date(
    Date.UTC(friday.getUTCFullYear(), friday.getUTCMonth(), friday.getUTCDate(), 11, 30),
  );
  const end = new Date(start.getTime() + 90 * 60_000);
  return [
    {
      at: now - 60_000,
      kind: 'booked',
      agent: 'Aina',
      customer: 'Lim Mei Ying',
      start: start.toISOString(),
      end: end.toISOString(),
    },
    { at: now - 120_000, kind: 'checked', agent: 'Aina', customer: 'Lim Mei Ying' },
    { at: now - 26 * 3_600_000, kind: 'handed_over', agent: 'Aina', customer: 'Farah Aziz' },
  ];
}

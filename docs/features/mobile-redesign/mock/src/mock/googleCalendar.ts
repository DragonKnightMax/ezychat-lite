import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Proposed (google-calendar): mirrors ../../google-calendar.ts (the mock's stand-in routes). */
export type GoogleState = 'disconnected' | 'connected' | 'expired' | 'unavailable';

export interface GoogleCalendar {
  id: string;
  name: string;
  primary: boolean;
  readOnly: boolean;
}

export interface AgentBooking {
  calendarId: string;
  /** "Check free times": the AI may read busy times of the chosen calendar. */
  checkFree: boolean;
  /** "Book appointments": the AI may add an event after the customer confirms a time. */
  book: boolean;
  title: string;
  lengthMin: number;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  from: string;
  to: string;
  gapMin: number;
  noticeHours: number;
  maxDays: number;
}

export interface CalendarActivity {
  at: number;
  kind: 'checked' | 'booked' | 'handed_over';
  agent: string;
  customer: string;
  start?: string;
  end?: string;
}

export interface GoogleCalendarState {
  state: GoogleState;
  account: string | null;
  calendars: GoogleCalendar[];
  agents: Record<string, AgentBooking>;
  activity: CalendarActivity[];
}

export const DEFAULT_BOOKING: AgentBooking = {
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

export const googleCalendarKey = ['mock', 'googleCalendar'] as const;

export function useGoogleCalendar() {
  return useQuery({
    queryKey: googleCalendarKey,
    queryFn: () => api<GoogleCalendarState>('/mock/google-calendar'),
  });
}

/** Baseline addition (PR #192 Bookings tab): one event the AI added (EzyChat's own record). */
export interface CalendarBooking {
  id: string;
  agentId: string;
  agentName: string;
  chatJid: string;
  customer: string;
  start: string;
  end: string;
  eventUrl: string;
}

export interface CalendarBookings {
  upcoming: CalendarBooking[];
  past: CalendarBooking[];
  /** "Open Google Calendar": null while no account is connected. */
  calendarUrl: string | null;
}

export function useCalendarBookings() {
  return useQuery({
    queryKey: [...googleCalendarKey, 'bookings'],
    queryFn: () => api<CalendarBookings>('/mock/google-calendar/bookings'),
  });
}

/** As `googleCalendarUrl` in packages/shared (PR #192): the account's calendar in the browser. */
export function googleCalendarUrl(account: string): string {
  return `https://calendar.google.com/calendar/r?authuser=${encodeURIComponent(account)}`;
}

export function useGoogleCalendarAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { kind: 'connect'; account: string }
        | { kind: 'disconnect' }
        | { kind: 'state'; state: 'connected' | 'expired' | 'unavailable' }
        | { kind: 'agent'; agentId: string; booking: AgentBooking },
    ) => {
      if (action.kind === 'connect')
        return api<GoogleCalendarState>('/mock/google-calendar/connect', {
          method: 'POST',
          body: { account: action.account },
        });
      if (action.kind === 'disconnect')
        return api<GoogleCalendarState>('/mock/google-calendar/disconnect', { method: 'POST' });
      if (action.kind === 'state')
        return api<GoogleCalendarState>('/mock/google-calendar/state', {
          method: 'PUT',
          body: { state: action.state },
        });
      return api<GoogleCalendarState>(
        `/mock/google-calendar/agents/${encodeURIComponent(action.agentId)}`,
        {
          method: 'PUT',
          body: action.booking,
        },
      );
    },
    onSuccess: (data) => {
      client.setQueryData(googleCalendarKey, data);
      void client.invalidateQueries({ queryKey: [...googleCalendarKey, 'bookings'] });
    },
  });
}

export function bookingFor(state: GoogleCalendarState | undefined, agentId: string): AgentBooking {
  return state?.agents[agentId] ?? DEFAULT_BOOKING;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Demo free times for Try it: the first 3 openings from tomorrow that fit the booking length inside
 * the opening hours. The mock pretends 12:00–14:00 is busy every day (the "lunch rush" event).
 */
export function demoFreeSlots(booking: AgentBooking, now = new Date()): Date[] {
  const slots: Date[] = [];
  const from = toMinutes(booking.from);
  const to = toMinutes(booking.to);
  const step = booking.lengthMin + booking.gapMin;
  for (let day = 1; day <= booking.maxDays && slots.length < 3; day++) {
    const date = new Date(now);
    date.setDate(now.getDate() + day);
    if (!booking.days.includes(date.getDay())) continue;
    for (let start = from; start + booking.lengthMin <= to && slots.length < 3; start += step) {
      const end = start + booking.lengthMin;
      if (start < 14 * 60 && end > 12 * 60) continue;
      const slot = new Date(date);
      slot.setHours(Math.floor(start / 60), start % 60, 0, 0);
      slots.push(slot);
    }
  }
  return slots;
}

/**
 * Google Calendar connector (core; design docs/features/google-calendar/design.md). One Google
 * account per install: tokens only in an encrypted setting, refreshed before expiry. Per AI agent
 * booking settings; the AI tools (tools.ts) read free times and, when allowed, book.
 *
 * Logs carry counts, ids and states only: never tokens, codes, URLs with codes, event text, names
 * or phone numbers.
 */
import { createHash } from 'node:crypto';
import {
  BookingSettings,
  googleCalendarUrl,
  type CalendarActivity,
  type CalendarBooking,
  type CalendarBookingList,
  type Chat,
  type GoogleCalendarItem,
  type GoogleCalendarStatus,
} from '@ezychat/shared';
import { agentById } from '../../ai/agents.js';
import { AI_TIMEZONE_SETTING, resolveAiTimeZone } from '../../ai/prompt.js';
import type { AppContext } from '../../context.js';
import { createGoogleAccount } from '../google-account.js';
import { audit } from '../../db/audit.js';
import { HttpError, errors } from '../../http/errors.js';
import { getChats } from '../../wa-bridge/index.js';
import {
  eventDescription,
  resolveContact,
  type BookingContact,
  type ContactField,
} from './contact.js';
import { FAKE_GOOGLE_APP, FAKE_GOOGLE_ENDPOINTS, FakeGoogle } from './fake.js';
import {
  GOOGLE_ENDPOINTS,
  GOOGLE_SCOPES,
  GoogleClient,
  REQUIRED_SCOPES,
  type GoogleCalendarEntry,
} from './google.js';
import {
  addActivity,
  bookedSince,
  customerRepliedSince,
  customerTexts,
  findOffers,
  handedOverSince,
  hasBooking,
  insertBooking,
  lastOffer,
  listActivity,
  listBookings,
  readSettings,
  type BookingRow,
  recordOffers,
  writeSettings,
} from './repo.js';
import {
  bookingWindow,
  freeSlots,
  isBusy,
  withinRules,
  type Interval,
  type LocalDate,
} from './slots.js';

declare module '../../context.js' {
  interface Services {
    googleCalendar?: GoogleCalendarService;
  }
}

export const TOKENS_SETTING = 'google_calendar_tokens';
export const PROBLEM_SETTING = 'google_calendar_problem';
export { CONNECT_TTL_MS, type CallbackPage } from '../google-account.js';
const CALENDARS_TTL_MS = 5 * 60_000;

export type BookResult =
  | { ok: true; start: number; end: number; already: boolean }
  | {
      ok: false;
      reason: 'not_offered' | 'no_reply_since' | 'outside_rules' | 'busy' | 'invalid_email';
    }
  | { ok: false; reason: 'missing_details'; missing: ContactField[] }
  | { ok: false; reason: 'not_from_customer'; field: ContactField };

const WRITABLE = new Set(['owner', 'writer']);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Google Calendar's link to one event: `eid` is base64url("<event id> <calendar id>"), the form of
 * the event's `htmlLink`; `authuser` picks the account when the browser has several.
 */
export function googleEventUrl(
  eventId: string,
  calendarId: string,
  account: string | null,
): string {
  const eid = Buffer.from(`${eventId} ${calendarId}`).toString('base64url');
  const user = account ? `&authuser=${encodeURIComponent(account)}` : '';
  return `https://calendar.google.com/calendar/event?eid=${eid}${user}`;
}

export function toItem(entry: GoogleCalendarEntry): GoogleCalendarItem {
  return {
    id: entry.id,
    name: entry.name,
    primary: entry.primary,
    readOnly: !WRITABLE.has(entry.accessRole),
  };
}

export interface GoogleCalendarServiceOptions {
  /** Overrides the client (tests); default from the build's Google app, or the fake with --fake-wa. */
  client?: GoogleClient | null;
  fake?: FakeGoogle | null;
  now?: () => number;
}

export function createGoogleCalendarService(
  ctx: AppContext,
  options: GoogleCalendarServiceOptions = {},
) {
  const log = ctx.log.child({ mod: 'google-calendar' });
  const now = options.now ?? Date.now;
  // The fake replaces Google only with --fake-wa (never in service mode: parseArgs refuses it) and
  // no Google app configured: a Dev Build with GOOGLE_OAUTH_CLIENT_ID/_SECRET talks to real Google.
  const fake =
    options.fake !== undefined
      ? options.fake
      : ctx.config.fakeWa && ctx.config.mode !== 'service' && !ctx.config.googleOAuth
        ? new FakeGoogle()
        : null;
  const client: GoogleClient | null =
    options.client !== undefined
      ? options.client
      : fake
        ? new GoogleClient(FAKE_GOOGLE_APP, FAKE_GOOGLE_ENDPOINTS, fake.fetch)
        : ctx.config.googleOAuth
          ? new GoogleClient(ctx.config.googleOAuth, GOOGLE_ENDPOINTS)
          : null;

  const account = createGoogleAccount(ctx, {
    key: 'google_calendar',
    label: 'Google Calendar',
    tokensSetting: TOKENS_SETTING,
    problemSetting: PROBLEM_SETTING,
    scopes: GOOGLE_SCOPES,
    requiredScopes: REQUIRED_SCOPES,
    client,
    fake,
    fakeConsentPath: '/api/dev/fake-google/consent',
    now,
  });
  let calendars: { at: number; list: GoogleCalendarEntry[] } | null = null;
  account.onChange(() => {
    calendars = null;
  });
  const loadTokens = account.tokens;
  const withToken = account.withToken;
  const state = account.state;
  const configured = account.configured;

  async function loadCalendars(force = false): Promise<GoogleCalendarEntry[]> {
    if (!force && calendars && now() - calendars.at < CALENDARS_TTL_MS) return calendars.list;
    const list = await withToken((token) => client!.calendarList(token));
    calendars = { at: now(), list };
    return list;
  }

  function timeZone(): string {
    return resolveAiTimeZone(ctx.settings.get<unknown>(AI_TIMEZONE_SETTING, null));
  }

  /** The agent's settings when its calendar tools may be offered now, else null. */
  function usable(agentId: number | undefined | null): BookingSettings | null {
    if (agentId === undefined || agentId === null) return null;
    const current = state();
    if (current !== 'connected' && current !== 'unavailable') return null;
    if (!agentById(ctx.db, agentId)) return null;
    const settings = readSettings(ctx.db, agentId);
    return settings.checkFree && settings.calendarId ? settings : null;
  }

  async function busyTimes(
    settings: BookingSettings,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<Interval[]> {
    const gap = settings.gapMin * 60_000;
    return withToken((token) =>
      client!.freeBusy(token, settings.calendarId!, from - gap, to + gap, signal),
    );
  }

  const onHandoff = (chat: Chat) => {
    try {
      const offer = lastOffer(ctx.db, chat.jid, now());
      if (!offer) return;
      if (bookedSince(ctx.db, chat.jid, offer.offeredAt)) return;
      if (handedOverSince(ctx.db, chat.jid, offer.offeredAt)) return;
      addActivity(
        ctx.db,
        { kind: 'handed_over', agentId: offer.agentId, chatJid: chat.jid },
        now(),
      );
    } catch (error) {
      log.warn(
        { event: 'google_calendar_handoff_failed', errName: (error as Error)?.name },
        'Calendar hand-over line failed',
      );
    }
  };
  ctx.bus.on('ai:handoff', onHandoff);

  const service = {
    fake,
    configured,
    timeZone,
    usable,

    async status(): Promise<GoogleCalendarStatus> {
      const tokens = configured() ? loadTokens() : null;
      let list: GoogleCalendarEntry[] = [];
      if (tokens && account.state() !== 'expired') {
        try {
          list = await loadCalendars();
        } catch {
          list = calendars?.list ?? [];
        }
      }
      const current = state();
      return {
        state: current,
        account: tokens?.account ?? null,
        calendars: current === 'not_configured' || !tokens ? [] : list.map((c) => toItem(c)),
        connectedAt: tokens?.connectedAt ?? null,
        problemSince: account.problemSince(),
      };
    },

    startConnect: account.startConnect,
    progress: account.progress,
    callback: account.callback,
    fakeConsent: account.fakeConsent,
    disconnect: account.disconnect,

    getSettings(agentId: number): BookingSettings {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      return readSettings(ctx.db, agentId);
    },

    async putSettings(
      agentId: number,
      next: BookingSettings,
      actor: { userId: number; ip: string | null },
    ): Promise<BookingSettings> {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      const parsed = BookingSettings.parse(next);
      const current = state();
      if (parsed.calendarId && (current === 'connected' || current === 'unavailable')) {
        let list: GoogleCalendarEntry[];
        try {
          list = await loadCalendars(true);
        } catch {
          throw new HttpError(503, 'google_unavailable', 'Google Calendar could not be reached');
        }
        const chosen = list.find((c) => c.id === parsed.calendarId);
        if (!chosen || !WRITABLE.has(chosen.accessRole))
          throw errors.validation('Choose a calendar you can add events to');
      }
      const before = readSettings(ctx.db, agentId);
      const fields = (Object.keys(parsed) as Array<keyof BookingSettings>).filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(parsed[key]),
      );
      writeSettings(ctx.db, agentId, parsed, now());
      if (fields.length)
        audit(ctx.db, {
          userId: actor.userId,
          action: 'google_calendar.agent_settings',
          ip: actor.ip,
          meta: { agentId, fields },
        });
      return parsed;
    },

    activity(): CalendarActivity[] {
      return listActivity(ctx.db);
    },

    /**
     * Bookings tab: EzyChat's own records of the events the AI added (no Google call). Links open
     * the connected account (`authuser`); after a disconnect the event links stay, without it.
     */
    bookings(): CalendarBookingList {
      const account = (configured() ? loadTokens()?.account : null) ?? null;
      const toBooking = (row: BookingRow): CalendarBooking => ({
        id: row.id,
        agentId: row.agentId,
        agentName: row.agentName,
        chatJid: row.chatJid,
        customer: row.customer,
        start: new Date(row.start).toISOString(),
        end: new Date(row.end).toISOString(),
        createdAt: row.createdAt,
        eventUrl: googleEventUrl(row.eventId, row.calendarId, account),
      });
      const { upcoming, past } = listBookings(ctx.db, now());
      return {
        upcoming: upcoming.map(toBooking),
        past: past.map(toBooking),
        calendarUrl: account ? googleCalendarUrl(account) : null,
      };
    },

    /** Re-reads the account (dev route: after the fake's state changed). */
    async refreshStatus(): Promise<GoogleCalendarStatus> {
      if (loadTokens()) await loadCalendars(true).catch(() => undefined);
      return service.status();
    },

    /** Free times within the agent's rules, minus Google's busy times. */
    async freeTimes(
      settings: BookingSettings,
      date: LocalDate | null,
      signal?: AbortSignal,
    ): Promise<Interval[]> {
      const at = now();
      const window = bookingWindow(settings, at);
      const busy = await busyTimes(
        settings,
        window.start,
        window.end + settings.lengthMin * 60_000,
        signal,
      );
      return freeSlots({ rules: settings, timeZone: timeZone(), now: at, busy, date });
    },

    recordOffers(agentId: number, chatJid: string, slots: readonly Interval[]) {
      recordOffers(ctx.db, agentId, chatJid, slots, now());
    },

    addActivity(row: Parameters<typeof addActivity>[1]) {
      addActivity(ctx.db, row, now());
    },

    /**
     * The contact a booking would get without asking: the team's saved name and email, else the
     * WhatsApp name; the WhatsApp number (the saved other phone only without one).
     */
    savedContact(chatJid: string): BookingContact {
      const chat = getChats(ctx).get(chatJid);
      // A WhatsApp group is not one customer: no saved contact (and the AI never books there).
      if (chat?.type === 'group') return { name: null, email: null, phone: null };
      const profile = ctx.services.customers?.profile(chatJid).profile ?? null;
      // A chat named after its number has no real name.
      const named = (value: string | null | undefined) =>
        value?.trim() && /\p{L}/u.test(value) ? value.trim() : null;
      const whatsapp =
        chat?.phone ?? (chat?.waJid.endsWith('@s.whatsapp.net') ? chat.waJid.split('@')[0]! : null);
      const other = profile?.otherPhone?.replace(/\D/g, '') || null;
      return {
        name: named(profile?.name) ?? named(chat?.name) ?? named(chat?.whatsappName),
        email: profile?.email?.trim() || null,
        phone: whatsapp ?? other,
      };
    },

    /**
     * Books `start` for this chat. Guards: it was offered in this chat in the last 24 h, the
     * customer wrote after that offer, the rules still allow it, the booking has a name, email and
     * phone (saved, or written by the customer in this chat: `given`), Google still shows it free,
     * and the same chat and time is never booked twice. Google errors are thrown (the tool hands over).
     */
    async book(
      agentId: number,
      chatJid: string,
      start: number,
      given: Partial<Record<ContactField, string>> = {},
      signal?: AbortSignal,
    ): Promise<BookResult> {
      const settings = usable(agentId);
      if (!settings?.book) return { ok: false, reason: 'outside_rules' };
      const at = now();
      const offers = findOffers(ctx.db, agentId, chatJid, start, at);
      if (!offers.length) return { ok: false, reason: 'not_offered' };
      const slot = { start, end: start + settings.lengthMin * 60_000 };
      if (hasBooking(ctx.db, chatJid, slot.start)) return { ok: true, ...slot, already: true };
      // The customer must have written after one of the offers of this time (not only after the
      // newest: the AI may re-check free times in the same turn, after the customer's answer).
      if (!offers.some((offer) => customerRepliedSince(ctx.db, chatJid, offer.offeredAt)))
        return { ok: false, reason: 'no_reply_since' };
      if (!withinRules(slot, settings, timeZone(), at))
        return { ok: false, reason: 'outside_rules' };
      // Name, email and phone: saved, or written by the customer in this chat.
      const saved = service.savedContact(chatJid);
      const resolved = resolveContact(saved, given, customerTexts(ctx.db, chatJid));
      if (!resolved.ok) return resolved;
      const eventId = sha(`${agentId}|${chatJid}|${slot.start}`);
      const calendarId = settings.calendarId!;
      const ours = async () => {
        const status = await withToken((token) =>
          client!.eventStatus(token, calendarId, eventId, signal),
        );
        return status !== null && status !== 'cancelled';
      };
      const record = (created: boolean): BookResult => {
        insertBooking(ctx.db, { agentId, chatJid, eventId, calendarId, ...slot }, now());
        addActivity(ctx.db, { kind: 'booked', agentId, chatJid, ...slot }, now());
        log.info(
          { event: 'google_calendar_booked', agentId, created },
          'AI booked a calendar event',
        );
        return { ok: true, ...slot, already: false };
      };
      const busy = await busyTimes(settings, slot.start, slot.end, signal);
      // A retry after a lost answer: the busy time may be our own event (same id) already in Google.
      if (isBusy(slot, busy, settings.gapMin))
        return (await ours()) ? record(false) : { ok: false, reason: 'busy' };
      const { contact } = resolved;
      const chat = getChats(ctx).get(chatJid);
      const whatsapp =
        chat?.phone ?? (chat?.waJid.endsWith('@s.whatsapp.net') ? chat.waJid.split('@')[0]! : null);
      const zone = timeZone();
      const created = await withToken((token) =>
        client!.insertEvent(
          token,
          calendarId,
          {
            id: eventId,
            summary: `${settings.title} · ${contact.name}`.slice(0, 200),
            description: eventDescription(contact, whatsapp),
            start: slot.start,
            end: slot.end,
            timeZone: zone,
          },
          signal,
        ),
      );
      // Our own id exists already (a retry): confirm it is still there.
      if (!created && !(await ours())) return { ok: false, reason: 'busy' };
      return record(created);
    },

    shutdown() {
      ctx.bus.off('ai:handoff', onHandoff);
      account.shutdown();
    },
  };
  return service;
}

export type GoogleCalendarService = ReturnType<typeof createGoogleCalendarService>;

export function initGoogleCalendar(ctx: AppContext) {
  ctx.services.googleCalendar = createGoogleCalendarService(ctx);
}

export function getGoogleCalendar(ctx: AppContext): GoogleCalendarService {
  const service = ctx.services.googleCalendar;
  if (!service) throw new Error('Google Calendar service not initialised');
  return service;
}

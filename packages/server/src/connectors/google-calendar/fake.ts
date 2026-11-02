/**
 * In-process stand-in for Google (sign-in and Calendar), used ONLY when the server runs with
 * `--fake-wa` (tests, e2e, Dev Builds). Nothing here touches the network: `fetch` answers the same
 * requests GoogleClient sends to the fake base URLs.
 */
import { FakeGoogleAuth, fakeJson as json, type FakeGoogleMode } from '../google-fake-auth.js';
import { GOOGLE_SCOPES, type GoogleEndpoints } from './google.js';

const BASE = 'https://fake-google.invalid';
export const FAKE_GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: `${BASE}/o/oauth2/v2/auth`,
  token: `${BASE}/token`,
  api: `${BASE}/calendar/v3`,
  revoke: `${BASE}/revoke`,
};
export const FAKE_GOOGLE_APP = { clientId: 'fake-client', clientSecret: 'fake-secret' };
export const FAKE_GOOGLE_ACCOUNT = 'demo.bookings@example.com';

export type { FakeGoogleMode };

export interface FakeGoogleEvent {
  calendarId: string;
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
}

const CALENDARS = [
  {
    id: 'primary-demo@example.com',
    summary: FAKE_GOOGLE_ACCOUNT,
    primary: true,
    accessRole: 'owner',
  },
  { id: 'bookings-demo@group.calendar.google.com', summary: 'Bookings', accessRole: 'owner' },
  {
    id: 'en.malaysia#holiday@group.v.calendar.google.com',
    summary: 'Holidays in Malaysia',
    accessRole: 'reader',
  },
];

export class FakeGoogle extends FakeGoogleAuth {
  busy: Array<{ start: string; end: string }> = [];
  readonly events: FakeGoogleEvent[] = [];

  constructor() {
    super(FAKE_GOOGLE_ACCOUNT, GOOGLE_SCOPES.join(' '));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    if (url.origin !== BASE) throw new TypeError('fake Google: unknown host');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body;
    const denied = this.authorize(url.pathname, init);
    if (denied) return denied;
    const path = url.pathname.replace('/calendar/v3', '');
    if (method === 'GET' && path === '/users/me/calendarList') {
      this.calls.push('calendarList');
      return json(200, { items: CALENDARS });
    }
    if (method === 'POST' && path === '/freeBusy') {
      this.calls.push('freeBusy');
      const request = JSON.parse(String(body)) as { items: Array<{ id: string }> };
      const calendars: Record<string, unknown> = {};
      for (const item of request.items)
        calendars[item.id] = CALENDARS.some((c) => c.id === item.id)
          ? {
              // Like Google: events in the calendar (also the ones we added) count as busy.
              busy: [
                ...this.busy,
                ...this.events
                  .filter((e) => e.calendarId === item.id)
                  .map((e) => ({ start: e.start, end: e.end })),
              ],
            }
          : { errors: [{ reason: 'notFound' }], busy: [] };
      return json(200, { calendars });
    }
    const events = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (events) {
      const calendarId = decodeURIComponent(events[1]!);
      const calendar = CALENDARS.find((c) => c.id === calendarId);
      if (!calendar) return json(404, { error: { code: 404 } });
      if (method === 'POST' && !events[2]) {
        this.calls.push('insertEvent');
        if (calendar.accessRole === 'reader') return json(403, { error: { code: 403 } });
        const event = JSON.parse(String(body)) as {
          id: string;
          summary: string;
          description: string;
          start: { dateTime: string; timeZone: string };
          end: { dateTime: string };
        };
        if (this.events.some((e) => e.calendarId === calendarId && e.id === event.id))
          return json(409, { error: { code: 409 } });
        this.events.push({
          calendarId,
          id: event.id,
          summary: event.summary,
          description: event.description,
          start: event.start.dateTime,
          end: event.end.dateTime,
          timeZone: event.start.timeZone,
        });
        return json(200, { id: event.id, status: 'confirmed' });
      }
      if (method === 'GET' && events[2]) {
        this.calls.push('getEvent');
        const id = decodeURIComponent(events[2]);
        const found = this.events.find((e) => e.calendarId === calendarId && e.id === id);
        return found ? json(200, { id, status: 'confirmed' }) : json(404, { error: { code: 404 } });
      }
    }
    return json(404, { error: { code: 404 } });
  };
}

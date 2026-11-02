import { afterEach, describe, expect, it } from 'vitest';
import { CalendarBookingList, DEFAULT_BOOKING_SETTINGS, googleCalendarUrl } from '@ezychat/shared';
import { listAgents } from '../src/ai/agents.js';
import {
  createGoogleCalendarService,
  TOKENS_SETTING,
} from '../src/connectors/google-calendar/service.js';
import { FakeGoogle } from '../src/connectors/google-calendar/fake.js';
import { addActivity, insertBooking } from '../src/connectors/google-calendar/repo.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import {
  CALENDAR_PATHS,
  connectThroughFake,
  expectAdminOnly,
  expectCallbackHostOnly,
} from './google-connector-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const BOOKINGS = 'bookings-demo@group.calendar.google.com';
const HOLIDAYS = 'en.malaysia#holiday@group.v.calendar.google.com';

async function setUp(options: Parameters<typeof makeTestApp>[0] = {}, clock?: { now: number }) {
  t = await makeTestApp({
    ...options,
    beforeBuild: clock
      ? (ctx) => {
          ctx.services.googleCalendar!.shutdown();
          ctx.services.googleCalendar = createGoogleCalendarService(ctx, {
            fake: new FakeGoogle(),
            now: () => clock.now,
          });
        }
      : undefined,
  });
  const admin = await createUserAndLogin(t, { role: 'admin' });
  const agent = await createUserAndLogin(t, { role: 'agent' });
  t.ctx.services.ai!.saveMember(
    { displayName: 'Aina', enabled: false, instructions: '' },
    { userId: admin.user.id, ip: null },
  );
  return { admin: admin.cookie, agent: agent.cookie, agentId: listAgents(t.ctx.db)[0]!.id };
}

const get = (url: string, cookie: string) =>
  t.app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, cookie: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, headers: authHeaders(cookie), payload: payload as object });
const put = (url: string, cookie: string, payload: unknown) =>
  t.app.inject({ method: 'PUT', url, headers: authHeaders(cookie), payload: payload as object });

const connect = (cookie: string, choice: 'allow' | 'cancel' = 'allow') =>
  connectThroughFake(t, CALENDAR_PATHS, cookie, choice);

describe('Google Calendar routes', () => {
  it('are admin only', async () => {
    const { agent, agentId } = await setUp();
    await expectAdminOnly(t, agent, [
      ['GET', '/api/connectors/google-calendar'],
      ['POST', '/api/connectors/google-calendar/connect'],
      ['GET', '/api/connectors/google-calendar/connect/0123456789abcdef01234567'],
      ['POST', '/api/connectors/google-calendar/disconnect'],
      ['GET', `/api/connectors/google-calendar/agents/${agentId}`],
      ['PUT', `/api/connectors/google-calendar/agents/${agentId}`],
      ['GET', '/api/connectors/google-calendar/activity'],
      ['GET', '/api/connectors/google-calendar/bookings'],
      ['POST', '/api/dev/fake-google-calendar'],
    ]);
  });

  it('connects through the fake Google, lists calendars and shows the account', async () => {
    const { admin } = await setUp();
    const before = await get('/api/connectors/google-calendar', admin);
    expect(before.json()).toEqual({
      state: 'disconnected',
      account: null,
      calendars: [],
      connectedAt: null,
      problemSince: null,
    });
    const { requestId, callback } = await connect(admin);
    expect(callback.statusCode).toBe(200);
    expect(callback.headers['content-type']).toContain('text/html');
    expect(callback.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(callback.body).toContain('Google Calendar connected');
    expect(
      (await get(`/api/connectors/google-calendar/connect/${requestId}`, admin)).json(),
    ).toEqual({ status: 'done', error: null });
    const status = (await get('/api/connectors/google-calendar', admin)).json();
    expect(status).toMatchObject({
      state: 'connected',
      account: 'demo.bookings@example.com',
      problemSince: null,
    });
    expect(status.calendars).toEqual([
      {
        id: 'primary-demo@example.com',
        name: 'demo.bookings@example.com',
        primary: true,
        readOnly: false,
      },
      { id: BOOKINGS, name: 'Bookings', primary: false, readOnly: false },
      { id: HOLIDAYS, name: 'Holidays in Malaysia', primary: false, readOnly: true },
    ]);
    // tokens never reach the browser and are stored encrypted
    expect(JSON.stringify(status)).not.toContain('fake-access');
    const raw = t.ctx.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(TOKENS_SETTING) as { value: string };
    expect(raw.value).not.toContain('fake-refresh');
    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'google_calendar.connect'")
      .all();
    expect(audit).toHaveLength(1);
  });

  it('records a Cancel at Google as denied', async () => {
    const { admin } = await setUp();
    const { requestId, callback } = await connect(admin, 'cancel');
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain('Sign-in cancelled');
    expect(
      (await get(`/api/connectors/google-calendar/connect/${requestId}`, admin)).json(),
    ).toEqual({ status: 'failed', error: 'denied' });
    expect((await get('/api/connectors/google-calendar', admin)).json().state).toBe('disconnected');
  });

  it('answers the callback only on this computer, never via LAN or tunnel', async () => {
    const { admin } = await setUp();
    const start = (await post('/api/connectors/google-calendar/connect', admin)).json() as {
      authorizationUrl: string;
    };
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await expectCallbackHostOnly(
      t,
      `/api/connectors/google-calendar/callback?state=${state}&code=x`,
    );
  });

  it('refuses unknown, reused and PKCE-mismatched callbacks', async () => {
    const { admin } = await setUp();
    const unknown = await t.app.inject({
      method: 'GET',
      url: '/api/connectors/google-calendar/callback?state=nope&code=x',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain('Sign-in link expired');
    const noState = await t.app.inject({
      method: 'GET',
      url: '/api/connectors/google-calendar/callback',
    });
    expect(noState.statusCode).toBe(400);

    // A code issued for another PKCE challenge: Google (the fake) refuses the verifier.
    const start = (await post('/api/connectors/google-calendar/connect', admin)).json() as {
      requestId: string;
      authorizationUrl: string;
    };
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const code = t.ctx.services.googleCalendar!.fake!.issueCode('other-challenge', 'openid');
    const bad = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-calendar/callback?state=${state}&code=${code}`,
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await get(`/api/connectors/google-calendar/connect/${start.requestId}`, admin)).json(),
    ).toEqual({ status: 'failed', error: 'error' });
    // the state is one-time
    const again = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-calendar/callback?state=${state}&code=${code}`,
    });
    expect(again.body).toContain('Sign-in link expired');

    const missingCode = (await post('/api/connectors/google-calendar/connect', admin)).json() as {
      requestId: string;
      authorizationUrl: string;
    };
    const state2 = new URL(missingCode.authorizationUrl).searchParams.get('state')!;
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-calendar/callback?state=${state2}`,
    });
    expect(res.statusCode).toBe(400);
    expect(
      (await get('/api/connectors/google-calendar/connect/aaaaaaaaaaaaaaaaaaaaaaaa', admin))
        .statusCode,
    ).toBe(404);
    expect((await get('/api/connectors/google-calendar/connect/not-hex', admin)).statusCode).toBe(
      400,
    );
  });

  it('refuses a sign-in where the calendar permissions were unticked', async () => {
    const { admin } = await setUp();
    const start = (await post('/api/connectors/google-calendar/connect', admin)).json() as {
      requestId: string;
      authorizationUrl: string;
    };
    const url = new URL(start.authorizationUrl);
    const fake = t.ctx.services.googleCalendar!.fake!;
    const code = fake.issueCode(url.searchParams.get('code_challenge')!, 'openid email');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-calendar/callback?state=${url.searchParams.get('state')}&code=${code}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Calendar access was not allowed');
    expect(fake.calls).toContain('revoke');
    expect((await get('/api/connectors/google-calendar', admin)).json().state).toBe('disconnected');
  });

  it('lets a sign-in expire after 10 minutes', async () => {
    const clock = { now: Date.now() };
    const { admin } = await setUp({}, clock);
    const start = (await post('/api/connectors/google-calendar/connect', admin)).json() as {
      requestId: string;
      authorizationUrl: string;
    };
    clock.now += 11 * 60_000;
    expect(
      (await get(`/api/connectors/google-calendar/connect/${start.requestId}`, admin)).json(),
    ).toEqual({ status: 'failed', error: 'expired' });
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const late = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-calendar/callback?state=${state}&code=x`,
    });
    expect(late.body).toContain('Sign-in link expired');
  });

  it('refreshes the access token, and shows expired and unavailable sign-ins', async () => {
    const clock = { now: Date.now() };
    const { admin } = await setUp({}, clock);
    await connect(admin);
    const fake = t.ctx.services.googleCalendar!.fake!;
    // two hours later the access token is old: the next call refreshes first
    clock.now += 2 * 3_600_000;
    fake.expireAccessTokens();
    const calls = fake.calls.length;
    const fresh = await post('/api/dev/fake-google-calendar', admin, {});
    expect(fresh.json().state).toBe('connected');
    expect(fake.calls.slice(calls)).toEqual(['token', 'calendarList']);

    // A token Google drops early (401): refresh once, then retry.
    fake.expireAccessTokens();
    const retried = await post('/api/dev/fake-google-calendar', admin, {});
    expect(retried.json().state).toBe('connected');

    const down = (
      await post('/api/dev/fake-google-calendar', admin, { state: 'unavailable' })
    ).json();
    expect(down).toMatchObject({ state: 'unavailable', problemSince: clock.now });
    clock.now += 1000;
    // still unavailable: the first time it stopped working is kept
    expect((await post('/api/dev/fake-google-calendar', admin, {})).json().problemSince).toBe(
      clock.now - 1000,
    );
    expect(
      (await post('/api/dev/fake-google-calendar', admin, { state: 'ok' })).json(),
    ).toMatchObject({ state: 'connected', problemSince: null });

    clock.now += 2 * 3_600_000;
    const expired = (
      await post('/api/dev/fake-google-calendar', admin, { state: 'expired' })
    ).json();
    expect(expired).toMatchObject({
      state: 'expired',
      problemSince: clock.now,
      account: 'demo.bookings@example.com',
    });
    // unavailable never hides an expired sign-in
    expect(
      (await post('/api/dev/fake-google-calendar', admin, { state: 'unavailable' })).json().state,
    ).toBe('expired');
    expect((await get('/api/connectors/google-calendar', admin)).json().state).toBe('expired');
    // signing in again fixes it
    fake.mode = 'ok';
    await connect(admin);
    expect((await get('/api/connectors/google-calendar', admin)).json()).toMatchObject({
      state: 'connected',
      problemSince: null,
    });
  });

  it('disconnects (revoking at Google) and keeps the booking settings', async () => {
    const { admin, agentId } = await setUp();
    await connect(admin);
    const saved = await put(`/api/connectors/google-calendar/agents/${agentId}`, admin, {
      ...DEFAULT_BOOKING_SETTINGS,
      calendarId: BOOKINGS,
    });
    expect(saved.statusCode).toBe(200);
    const fake = t.ctx.services.googleCalendar!.fake!;
    const res = await post('/api/connectors/google-calendar/disconnect', admin);
    expect(res.json()).toMatchObject({ state: 'disconnected', account: null, calendars: [] });
    expect(fake.calls).toContain('revoke');
    expect(t.ctx.settings.getSecret(TOKENS_SETTING)).toBeNull();
    expect(
      (await get(`/api/connectors/google-calendar/agents/${agentId}`, admin)).json().calendarId,
    ).toBe(BOOKINGS);
    expect(
      t.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'google_calendar.disconnect'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it('reads and saves booking settings per agent, checking the calendar can be written', async () => {
    const { admin, agentId } = await setUp();
    const url = `/api/connectors/google-calendar/agents/${agentId}`;
    expect((await get(url, admin)).json()).toEqual(DEFAULT_BOOKING_SETTINGS);
    expect((await get('/api/connectors/google-calendar/agents/999', admin)).statusCode).toBe(404);
    expect(
      (await put('/api/connectors/google-calendar/agents/999', admin, DEFAULT_BOOKING_SETTINGS))
        .statusCode,
    ).toBe(404);
    expect((await get('/api/connectors/google-calendar/agents/abc', admin)).statusCode).toBe(400);
    // book needs checkFree; from before to
    expect(
      (await put(url, admin, { ...DEFAULT_BOOKING_SETTINGS, checkFree: false, book: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (await put(url, admin, { ...DEFAULT_BOOKING_SETTINGS, from: '18:00', to: '10:00' }))
        .statusCode,
    ).toBe(400);
    // not connected: any calendar id is kept as is
    expect(
      (await put(url, admin, { ...DEFAULT_BOOKING_SETTINGS, calendarId: 'someday' })).statusCode,
    ).toBe(200);
    await connect(admin);
    const readOnly = await put(url, admin, { ...DEFAULT_BOOKING_SETTINGS, calendarId: HOLIDAYS });
    expect(readOnly.statusCode).toBe(400);
    expect(readOnly.json().error.message).toContain('Choose a calendar you can add events to');
    expect(
      (await put(url, admin, { ...DEFAULT_BOOKING_SETTINGS, calendarId: 'unknown' })).statusCode,
    ).toBe(400);
    const body = {
      ...DEFAULT_BOOKING_SETTINGS,
      calendarId: BOOKINGS,
      book: true,
      title: '  Table booking ',
      gapMin: 15,
    };
    const ok = await put(url, admin, body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ...body, title: 'Table booking' });
    expect((await get(url, admin)).json()).toEqual({ ...body, title: 'Table booking' });
    const rows = t.ctx.db
      .prepare(
        "SELECT meta FROM audit_log WHERE action = 'google_calendar.agent_settings' ORDER BY id",
      )
      .all() as Array<{ meta: string }>;
    expect(JSON.parse(rows.at(-1)!.meta)).toEqual({
      agentId,
      fields: ['calendarId', 'book', 'title', 'gapMin'],
    });
    // no change, no audit row
    await put(url, admin, body);
    expect(
      t.ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'google_calendar.agent_settings'",
        )
        .get(),
    ).toEqual({ n: rows.length });
    // Google down while saving a calendar: 503, nothing saved
    t.ctx.services.googleCalendar!.fake!.mode = 'unavailable';
    const down = await put(url, admin, { ...body, calendarId: 'primary-demo@example.com' });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe('google_unavailable');
  });

  it('lists activity newest first with agent and customer names, never chat text', async () => {
    const { admin, agentId } = await setUp();
    const jid = '60123456789@s.whatsapp.net';
    t.ctx.services.chats!.upsertFromWa({ jid, type: 'dm', name: 'Mei Ying' });
    addActivity(t.ctx.db, { kind: 'checked', agentId, chatJid: jid }, 1000);
    addActivity(t.ctx.db, { kind: 'booked', agentId, chatJid: jid, start: 5000, end: 6000 }, 2000);
    addActivity(t.ctx.db, { kind: 'failed', agentId: null, chatJid: null }, 3000);
    const { activity } = (await get('/api/connectors/google-calendar/activity', admin)).json();
    expect(activity.map((a: { kind: string }) => a.kind)).toEqual(['failed', 'booked', 'checked']);
    expect(activity[1]).toMatchObject({
      agentId,
      agentName: 'Aina',
      chatJid: jid,
      customer: 'Mei Ying',
      start: new Date(5000).toISOString(),
      end: new Date(6000).toISOString(),
    });
    expect(activity[0]).toMatchObject({ agentName: '', customer: '', start: null });
  });

  it('lists the bookings: upcoming soonest first, the past 30 days newest first, with Google links', async () => {
    const DAY = 86_400_000;
    const clock = { now: Date.UTC(2026, 9, 27, 6) };
    const { admin, agentId } = await setUp({}, clock);
    const url = '/api/connectors/google-calendar/bookings';
    expect((await get(url, admin)).json()).toEqual({ upcoming: [], past: [], calendarUrl: null });

    const jid = '60123456789@s.whatsapp.net';
    t.ctx.services.chats!.upsertFromWa({ jid, type: 'dm', name: 'Mei Ying' });
    const add = (eventId: string, start: number) =>
      insertBooking(
        t.ctx.db,
        { agentId, chatJid: jid, eventId, calendarId: BOOKINGS, start, end: start + 3_600_000 },
        clock.now - DAY,
      );
    add('later', clock.now + 2 * DAY);
    add('soon', clock.now + 3_600_000);
    add('now', clock.now - 1_800_000); // still running: upcoming
    add('yesterday', clock.now - DAY);
    add('lastWeek', clock.now - 7 * DAY);
    add('tooOld', clock.now - 31 * DAY);

    const list = CalendarBookingList.parse((await get(url, admin)).json());
    const ids = (rows: typeof list.upcoming) =>
      rows.map((b) =>
        Buffer.from(new URL(b.eventUrl).searchParams.get('eid')!, 'base64url').toString(),
      );
    expect(ids(list.upcoming)).toEqual([
      `now ${BOOKINGS}`,
      `soon ${BOOKINGS}`,
      `later ${BOOKINGS}`,
    ]);
    expect(ids(list.past)).toEqual([`yesterday ${BOOKINGS}`, `lastWeek ${BOOKINGS}`]);
    expect(list.upcoming[0]).toMatchObject({
      agentId,
      agentName: 'Aina',
      chatJid: jid,
      customer: 'Mei Ying',
      start: new Date(clock.now - 1_800_000).toISOString(),
      createdAt: clock.now - DAY,
    });
    // not connected: no account to open, so the links carry no authuser
    expect(list.calendarUrl).toBeNull();
    expect(new URL(list.upcoming[0]!.eventUrl).searchParams.has('authuser')).toBe(false);

    await connect(admin);
    const connected = CalendarBookingList.parse((await get(url, admin)).json());
    const account = (await get('/api/connectors/google-calendar', admin)).json().account as string;
    expect(connected.calendarUrl).toBe(googleCalendarUrl(account));
    expect(new URL(connected.past[0]!.eventUrl).searchParams.get('authuser')).toBe(account);
  });
});

describe('without the fake Google', () => {
  it('is not configured without a Google app, and has no dev routes', async () => {
    t = await makeTestApp({ config: { fakeWa: false } });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    expect((await get('/api/connectors/google-calendar', admin.cookie)).json()).toMatchObject({
      state: 'not_configured',
      calendars: [],
    });
    const res = await post('/api/connectors/google-calendar/connect', admin.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_configured');
    expect((await post('/api/dev/fake-google-calendar', admin.cookie, {})).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/dev/fake-google/consent?state=x' }))
        .statusCode,
    ).toBe(404);
  });

  it('sends the admin to Google with this server as the redirect', async () => {
    t = await makeTestApp({
      config: {
        fakeWa: false,
        port: 7420,
        googleOAuth: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' },
      },
    });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    expect((await get('/api/connectors/google-calendar', admin.cookie)).json().state).toBe(
      'disconnected',
    );
    const start = (await post('/api/connectors/google-calendar/connect', admin.cookie)).json();
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:7420/api/connectors/google-calendar/callback',
    );
    expect(url.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(start.authorizationUrl).not.toContain('shh');
  });

  it('uses real Google with --fake-wa when a Google app is configured (Dev Build)', async () => {
    t = await makeTestApp({
      config: {
        fakeWa: true,
        port: 7420,
        googleOAuth: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' },
      },
    });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const start = (await post('/api/connectors/google-calendar/connect', admin.cookie)).json();
    expect(new URL(start.authorizationUrl).origin).toBe('https://accounts.google.com');
    expect((await post('/api/dev/fake-google-calendar', admin.cookie, {})).statusCode).toBe(404);
  });
});

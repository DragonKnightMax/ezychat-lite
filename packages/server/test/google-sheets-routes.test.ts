import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHEETS_SETTINGS } from '@ezychat/shared';
import { FAKE_SPREADSHEET_ID } from '../src/connectors/google-sheets/fake.js';
import { SheetsClient } from '../src/connectors/google-sheets/sheets.js';
import {
  TOKENS_SETTING,
  createGoogleSheetsService,
} from '../src/connectors/google-sheets/service.js';
import {
  SHEETS_PATHS,
  connectorRequests,
  connectorTestApp,
  connectThroughFake,
  expectAdminOnly,
  expectCallbackHostOnly,
  expectPickerHostOnly,
} from './google-connector-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const LINK = `https://docs.google.com/spreadsheets/d/${FAKE_SPREADSHEET_ID}/edit#gid=0`;

async function setUp() {
  const app = await connectorTestApp();
  t = app.t;
  return app;
}

const get = (url: string, cookie: string) => connectorRequests(t).get(url, cookie);
const post = (url: string, cookie: string, payload: unknown = {}) =>
  connectorRequests(t).post(url, cookie, payload);
const put = (url: string, cookie: string, payload: unknown) =>
  connectorRequests(t).put(url, cookie, payload);

const connect = (cookie: string, choice: 'allow' | 'cancel' = 'allow') =>
  connectThroughFake(t, SHEETS_PATHS, cookie, choice);

describe('Google Sheets routes', () => {
  it('are admin only', async () => {
    const { agent, agentId } = await setUp();
    await expectAdminOnly(t, agent, [
      ['GET', '/api/connectors/google-sheets'],
      ['POST', '/api/connectors/google-sheets/connect'],
      ['GET', '/api/connectors/google-sheets/connect/0123456789abcdef01234567'],
      ['POST', '/api/connectors/google-sheets/disconnect'],
      ['POST', '/api/connectors/google-sheets/spreadsheet'],
      ['POST', '/api/connectors/google-sheets/picker'],
      ['GET', '/api/connectors/google-sheets/picker/0123456789abcdef01234567'],
      ['GET', `/api/connectors/google-sheets/agents/${agentId}`],
      ['PUT', `/api/connectors/google-sheets/agents/${agentId}`],
      ['POST', `/api/connectors/google-sheets/agents/${agentId}/refresh`],
      ['POST', `/api/connectors/google-sheets/agents/${agentId}/create`],
      ['GET', '/api/connectors/google-sheets/activity'],
      ['GET', '/api/dev/fake-google-sheets'],
      ['POST', '/api/dev/fake-google-sheets'],
    ]);
  });

  it('connects through the fake Google, keeps tokens encrypted and disconnects', async () => {
    const { admin } = await setUp();
    expect((await get('/api/connectors/google-sheets', admin)).json()).toEqual({
      state: 'disconnected',
      account: null,
      connectedAt: null,
      problemSince: null,
    });
    const { requestId, callback } = await connect(admin);
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('Google Sheets connected');
    expect(callback.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect((await get(`/api/connectors/google-sheets/connect/${requestId}`, admin)).json()).toEqual(
      { status: 'done', error: null },
    );
    const status = (await get('/api/connectors/google-sheets', admin)).json();
    expect(status).toMatchObject({ state: 'connected', account: 'demo.sheets@example.com' });
    const raw = t.ctx.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(TOKENS_SETTING) as { value: string };
    expect(raw.value).not.toContain('fake-refresh');
    // Google Calendar keeps its own sign-in.
    expect((await get('/api/connectors/google-calendar', admin)).json().state).toBe('disconnected');

    const out = await post('/api/connectors/google-sheets/disconnect', admin);
    expect(out.json().state).toBe('disconnected');
    expect(t.ctx.services.googleSheets!.fake!.calls).toContain('revoke');
    const actions = (
      t.ctx.db
        .prepare("SELECT action FROM audit_log WHERE action LIKE 'google_sheets.%' ORDER BY id")
        .all() as Array<{ action: string }>
    ).map((r) => r.action);
    expect(actions).toEqual(['google_sheets.connect', 'google_sheets.disconnect']);
  });

  it('records Cancel, refuses a sign-in without the Sheets permission and stale callbacks', async () => {
    const { admin } = await setUp();
    const cancelled = await connect(admin, 'cancel');
    expect(cancelled.callback.statusCode).toBe(400);
    expect(
      (await get(`/api/connectors/google-sheets/connect/${cancelled.requestId}`, admin)).json(),
    ).toEqual({ status: 'failed', error: 'denied' });

    const start = (await post('/api/connectors/google-sheets/connect', admin)).json() as {
      authorizationUrl: string;
    };
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const fake = t.ctx.services.googleSheets!.fake!;
    // No PKCE challenge of this sign-in: Google (the fake) refuses the exchange.
    const wrong = fake.issueCode('other', 'openid');
    const bad = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-sheets/callback?state=${state}&code=${wrong}`,
    });
    expect(bad.statusCode).toBe(400);
    const reused = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-sheets/callback?state=${state}&code=${wrong}`,
    });
    expect(reused.body).toContain('Sign-in link expired');

    // A consent where the person unticked the Sheets permission: refused and revoked.
    const second = (await post('/api/connectors/google-sheets/connect', admin)).json() as {
      authorizationUrl: string;
    };
    const url = new URL(second.authorizationUrl);
    const code = fake.issueCode(url.searchParams.get('code_challenge')!, 'openid email');
    const unticked = await t.app.inject({
      method: 'GET',
      url: `/api/connectors/google-sheets/callback?state=${url.searchParams.get('state')}&code=${code}`,
    });
    expect(unticked.statusCode).toBe(400);
    expect(unticked.body).toContain('Google Sheets access was not allowed');
    expect(fake.calls).toContain('revoke');
    expect((await get('/api/connectors/google-sheets', admin)).json().state).toBe('disconnected');
  });

  it('answers the callback only on this computer', async () => {
    const { admin } = await setUp();
    const start = (await post('/api/connectors/google-sheets/connect', admin)).json() as {
      authorizationUrl: string;
    };
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await expectCallbackHostOnly(t, `/api/connectors/google-sheets/callback?state=${state}&code=x`);
  });

  it('finds a spreadsheet from its link and saves per-agent settings checked with Google', async () => {
    const { admin, agentId } = await setUp();
    const url = `/api/connectors/google-sheets/agents/${agentId}`;
    expect((await get(url, admin)).json()).toEqual(DEFAULT_SHEETS_SETTINGS);
    // Not connected yet.
    expect(
      (await post('/api/connectors/google-sheets/spreadsheet', admin, { link: LINK })).statusCode,
    ).toBe(409);
    await connect(admin);
    // drive.file: a sheet nobody picked cannot be opened.
    const unpicked = await post('/api/connectors/google-sheets/spreadsheet', admin, { link: LINK });
    expect(unpicked.statusCode).toBe(400);
    expect(unpicked.body).toContain('Choose it again with Choose a sheet');
    t.ctx.services.googleSheets!.fake!.grant(FAKE_SPREADSHEET_ID);

    const info = await post('/api/connectors/google-sheets/spreadsheet', admin, { link: LINK });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({
      id: FAKE_SPREADSHEET_ID,
      name: 'Demo price list',
      tabs: [
        { title: 'Prices', rows: 1000, columns: ['Item', 'Price (RM)', 'In stock', 'Notes'] },
        {
          title: 'Leads',
          rows: 1000,
          columns: ['Date', 'Name', 'WhatsApp', 'Email', 'Request', 'AI agent'],
        },
        {
          title: 'Claims',
          rows: 1000,
          columns: [
            'Date',
            'Name',
            'WhatsApp',
            'Group',
            'Policy no',
            'Amount',
            'What happened',
            'Source',
          ],
        },
        { title: 'Notes', rows: 1000, columns: [] },
      ],
      checkedAt: expect.any(Number),
      url: `https://docs.google.com/spreadsheets/d/${FAKE_SPREADSHEET_ID}/edit`,
    });
    const notALink = await post('/api/connectors/google-sheets/spreadsheet', admin, {
      link: 'https://example.com/x',
    });
    expect(notALink.statusCode).toBe(400);
    const unknown = await post('/api/connectors/google-sheets/spreadsheet', admin, {
      link: 'unknown-sheet-00000000000000000000',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain('cannot open this spreadsheet');

    const base = {
      ...DEFAULT_SHEETS_SETTINGS,
      spreadsheetId: FAKE_SPREADSHEET_ID,
      tabs: [{ title: 'Prices', access: 'read' }],
    };
    // A tab listed twice and an unknown access are refused.
    expect(
      (
        await put(url, admin, {
          ...base,
          tabs: [
            { title: 'Prices', access: 'read' },
            { title: 'Prices', access: 'add' },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await put(url, admin, { ...base, tabs: [{ title: 'Prices', access: 'write' }] })).statusCode,
    ).toBe(400);
    // A tab Google no longer lists loses its access on Save.
    const saved = await put(url, admin, {
      ...base,
      tabs: [
        { title: 'Prices', access: 'read' },
        { title: 'Claims', access: 'add' },
        { title: 'Gone', access: 'add' },
      ],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      spreadsheetId: FAKE_SPREADSHEET_ID,
      spreadsheetName: 'Demo price list',
      tabs: [
        { title: 'Prices', access: 'read' },
        { title: 'Claims', access: 'add' },
      ],
    });
    expect((await get(url, admin)).json()).toEqual(saved.json());
    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'google_sheets.agent_settings'")
      .get() as { meta: string };
    expect(JSON.parse(audit.meta)).toEqual({
      agentId,
      fields: ['spreadsheetId', 'tabs'],
      droppedTabs: 1,
    });

    // The permission switches: kept only on Add rows, audited before/after per tab.
    const switched = await put(url, admin, {
      ...base,
      tabs: [
        { title: 'Prices', access: 'read', aiValues: true, formulas: true },
        { title: 'Claims', access: 'add', aiValues: true, formulas: true },
      ],
    });
    expect(switched.json()).toMatchObject({
      tabs: [
        { title: 'Prices', access: 'read' },
        { title: 'Claims', access: 'add', aiValues: true, formulas: true },
      ],
    });
    expect((switched.json() as { tabs: object[] }).tabs[0]).toEqual({
      title: 'Prices',
      access: 'read',
    });
    await put(url, admin, {
      ...base,
      tabs: [
        { title: 'Prices', access: 'read' },
        { title: 'Claims', access: 'add', aiValues: true },
      ],
    });
    const metas = (
      t.ctx.db
        .prepare(
          "SELECT meta FROM audit_log WHERE action = 'google_sheets.agent_settings' ORDER BY id",
        )
        .all() as Array<{ meta: string }>
    ).map((row) => JSON.parse(row.meta) as Record<string, unknown>);
    expect(metas.at(-2)!.permissions).toEqual([
      { tab: 'Claims', switch: 'aiValues', before: false, after: true },
      { tab: 'Claims', switch: 'formulas', before: false, after: true },
    ]);
    expect(metas.at(-1)!.permissions).toEqual([
      { tab: 'Claims', switch: 'formulas', before: true, after: false },
    ]);

    // Clearing the spreadsheet clears the tabs.
    const cleared = await put(url, admin, { ...(saved.json() as object), spreadsheetId: null });
    expect(cleared.json()).toEqual(DEFAULT_SHEETS_SETTINGS);
    expect((await get('/api/connectors/google-sheets/agents/999', admin)).statusCode).toBe(404);
  });

  it('refreshes the tabs and columns from Google at most once in 10 seconds', async () => {
    const { admin, agentId } = await setUp();
    const refresh = (id = agentId) =>
      post(`/api/connectors/google-sheets/agents/${id}/refresh`, admin);
    expect((await refresh(999)).statusCode).toBe(404);
    // No spreadsheet chosen yet.
    expect((await refresh()).statusCode).toBe(400);
    await connect(admin);
    const svc = t.ctx.services.googleSheets!;
    svc.fake!.grant(FAKE_SPREADSHEET_ID);
    await put(`/api/connectors/google-sheets/agents/${agentId}`, admin, {
      ...DEFAULT_SHEETS_SETTINGS,
      spreadsheetId: FAKE_SPREADSHEET_ID,
      tabs: [{ title: 'Claims', access: 'add' }],
    });
    // The AI reads the columns once (cached), then a column is added in Google.
    expect(
      (await svc.columns(agentId, FAKE_SPREADSHEET_ID, ['Claims'])).get('Claims'),
    ).toHaveLength(8);
    svc.fake!.rows(FAKE_SPREADSHEET_ID, 'Claims')[0]!.push('Branch');
    expect(
      (await svc.columns(agentId, FAKE_SPREADSHEET_ID, ['Claims'])).get('Claims'),
    ).toHaveLength(8);
    svc.fake!.sheets.get(FAKE_SPREADSHEET_ID)!.tabs.set('New tab', [['A']]);

    const first = await refresh();
    expect(first.statusCode).toBe(200);
    const info = first.json() as {
      tabs: Array<{ title: string; columns: string[] }>;
      checkedAt: number;
    };
    expect(info.tabs.find((tab) => tab.title === 'Claims')!.columns.at(-1)).toBe('Branch');
    expect(info.tabs.map((tab) => tab.title)).toContain('New tab');
    expect(info.checkedAt).toEqual(expect.any(Number));
    // The AI's next turn sees the new column without another read.
    const batches = svc.fake!.calls.filter((c) => c === 'batchGet').length;
    expect((await svc.columns(agentId, FAKE_SPREADSHEET_ID, ['Claims'])).get('Claims')).toContain(
      'Branch',
    );
    expect(svc.fake!.calls.filter((c) => c === 'batchGet')).toHaveLength(batches);

    const again = await refresh();
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('rate_limited');
    // Signed out: nothing to read.
    await post('/api/connectors/google-sheets/disconnect', admin);
    expect((await refresh()).statusCode).toBe(409);
  });

  it('shows Google problems as states and recovers', async () => {
    const { admin } = await setUp();
    await connect(admin);
    const fake = t.ctx.services.googleSheets!.fake!;
    fake.grant(FAKE_SPREADSHEET_ID);
    await post('/api/dev/fake-google-sheets', admin, { state: 'unavailable' });
    expect(
      (await post('/api/connectors/google-sheets/spreadsheet', admin, { link: LINK })).statusCode,
    ).toBe(503);
    expect((await get('/api/connectors/google-sheets', admin)).json()).toMatchObject({
      state: 'unavailable',
    });
    fake.mode = 'expired';
    fake.expireAccessTokens();
    await post('/api/connectors/google-sheets/spreadsheet', admin, { link: LINK });
    const expired = (await get('/api/connectors/google-sheets', admin)).json();
    expect(expired.state).toBe('expired');
    expect(expired.problemSince).toEqual(expect.any(Number));
    fake.mode = 'ok';
    await connect(admin);
    expect((await get('/api/connectors/google-sheets', admin)).json().state).toBe('connected');
    const dev = (await get('/api/dev/fake-google-sheets', admin)).json();
    expect(dev.sheets[0].tabs.Prices[0]).toEqual(['Item', 'Price (RM)', 'In stock', 'Notes']);
  });
});

describe('Google Sheets: create a new sheet', () => {
  const LAYOUT = {
    name: 'Claims 2026',
    tabs: [
      {
        title: 'Claims',
        columns: ['Date', 'Name', 'Policy no', 'Amount', '=Total'],
        access: 'add',
        formulas: [{ cell: 'F2', formula: '=SUM(D2:D1000)' }],
      },
      { title: 'Rates', columns: ['Plan', 'Rate'], access: 'read' },
      { title: 'Notes', columns: ['Note'] },
    ],
  };

  it('creates the tabs, writes the column names and formulas, and saves it for the agent', async () => {
    const { admin, agentId } = await setUp();
    const url = `/api/connectors/google-sheets/agents/${agentId}/create`;
    // Not connected yet.
    expect((await post(url, admin, LAYOUT)).statusCode).toBe(409);
    await connect(admin);
    const fake = t.ctx.services.googleSheets!.fake!;
    const res = await post(url, admin, LAYOUT);
    expect(res.statusCode).toBe(200);
    const saved = res.json() as { spreadsheetId: string; spreadsheetName: string; tabs: object[] };
    expect(saved.spreadsheetName).toBe('Claims 2026');
    expect(saved.tabs).toEqual([
      { title: 'Claims', access: 'add' },
      { title: 'Rates', access: 'read' },
    ]);
    expect((await get(`/api/connectors/google-sheets/agents/${agentId}`, admin)).json()).toEqual(
      saved,
    );
    const claims = fake.rows(saved.spreadsheetId, 'Claims');
    // A column name that looks like a formula stays text; the layout's formula is written as typed.
    expect(claims[0]).toEqual(['Date', 'Name', 'Policy no', 'Amount', "'=Total"]);
    expect(claims[1]).toEqual(['', '', '', '', '', '=SUM(D2:D1000)']);
    expect(fake.rows(saved.spreadsheetId, 'Notes')).toEqual([['Note']]);
    expect(fake.valueInputs).toEqual(['USER_ENTERED']);
    const audits = t.ctx.db
      .prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'google_sheets.%' ORDER BY id")
      .all() as Array<{ action: string; meta: string }>;
    const created = audits.find((a) => a.action === 'google_sheets.spreadsheet_created')!;
    expect(JSON.parse(created.meta)).toEqual({
      agentId,
      spreadsheetId: saved.spreadsheetId,
      tabs: 3,
      formulas: 1,
    });
    expect(created.meta).not.toContain('Claims');
    expect(audits.map((a) => a.action)).toContain('google_sheets.agent_settings');
  });

  it('refuses a formula that reaches outside the sheet, a bad layout and an unknown agent', async () => {
    const { admin, agentId } = await setUp();
    await connect(admin);
    const fake = t.ctx.services.googleSheets!.fake!;
    const url = `/api/connectors/google-sheets/agents/${agentId}/create`;
    for (const formula of ['=IMPORTRANGE("x","A1")', '=A1&"https://x.example"']) {
      const res = await post(url, admin, {
        name: 'X',
        tabs: [{ title: 'T', columns: ['A'], formulas: [{ cell: 'B2', formula }] }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'formula_blocked' } });
    }
    expect(fake.calls).not.toContain('create');
    for (const bad of [
      { name: 'X', tabs: [] },
      { name: 'X', tabs: [{ title: 'T', columns: [] }] },
      {
        name: 'X',
        tabs: [
          { title: 'T', columns: ['A'] },
          { title: 'T', columns: ['B'] },
        ],
      },
      {
        name: 'X',
        tabs: [{ title: 'T', columns: ['A'], formulas: [{ cell: 'A1', formula: '=1' }] }],
      },
      {
        name: 'X',
        tabs: [{ title: 'T', columns: ['A'], formulas: [{ cell: 'B2', formula: '1' }] }],
      },
    ])
      expect((await post(url, admin, bad)).statusCode).toBe(400);
    expect(
      (await post('/api/connectors/google-sheets/agents/999/create', admin, LAYOUT)).statusCode,
    ).toBe(404);
    // Google out of reach: 503, nothing saved.
    await post('/api/dev/fake-google-sheets', admin, { state: 'unavailable' });
    expect((await post(url, admin, LAYOUT)).statusCode).toBe(503);
    expect(
      (await get(`/api/connectors/google-sheets/agents/${agentId}`, admin)).json().spreadsheetId,
    ).toBeNull();
  });
});

describe('Google Sheets file picker', () => {
  const pick = async (admin: string) => {
    const start = await post('/api/connectors/google-sheets/picker', admin);
    expect(start.statusCode).toBe(200);
    const { requestId, pickerUrl } = start.json() as { requestId: string; pickerUrl: string };
    const url = new URL(pickerUrl);
    expect(url.pathname).toBe('/api/dev/fake-google-sheets/picker');
    return { requestId, token: url.searchParams.get('token')!, url };
  };
  const progress = async (admin: string, requestId: string) =>
    (await get(`/api/connectors/google-sheets/picker/${requestId}`, admin)).json();

  it('needs a connected account, then gives the picked sheet with its tabs', async () => {
    const { admin } = await setUp();
    expect((await post('/api/connectors/google-sheets/picker', admin)).statusCode).toBe(409);
    await connect(admin);
    const { requestId, url } = await pick(admin);
    expect(await progress(admin, requestId)).toEqual({ status: 'pending', sheet: null });
    const page = await t.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Demo price list');
    const href = /class="sheet" href="([^"]+)"/.exec(page.body)![1]!.replaceAll('&#38;', '&');
    expect((await t.app.inject({ method: 'GET', url: href })).statusCode).toBe(200);
    const done = await progress(admin, requestId);
    expect(done.status).toBe('done');
    expect(done.sheet).toMatchObject({ id: FAKE_SPREADSHEET_ID, name: 'Demo price list' });
    // One-time: the same page and its result never work twice.
    expect((await t.app.inject({ method: 'GET', url: href })).statusCode).toBe(400);
    expect(
      (await get(`/api/connectors/google-sheets/picker/${'a'.repeat(24)}`, admin)).statusCode,
    ).toBe(404);
  });

  it('records Cancel, and serves the page, script and token only on this computer', async () => {
    const { admin } = await setUp();
    await connect(admin);
    const { requestId, token, url } = await pick(admin);
    await expectPickerHostOnly(
      t,
      '/api/connectors/google-sheets',
      token,
      url.pathname + url.search,
    );
    // The access token goes to the page once.
    const config = await get(`/api/connectors/google-sheets/picker-config?token=${token}`, '');
    expect(config.json()).toMatchObject({ developerKey: 'fake-key', appId: '0' });
    expect(config.json().oauthToken).toMatch(/^fake-access-/);
    expect(config.headers['cache-control']).toBe('no-store');
    expect(
      (await get(`/api/connectors/google-sheets/picker-config?token=${token}`, '')).statusCode,
    ).toBe(404);
    const cancel = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-sheets/picker-result',
      headers: { origin: 'http://localhost', host: 'localhost' },
      payload: { token, cancelled: true },
    });
    expect(cancel.statusCode).toBe(200);
    expect(await progress(admin, requestId)).toEqual({ status: 'cancelled', sheet: null });
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-sheets/picker-result',
      headers: { origin: 'http://localhost', host: 'localhost' },
      payload: { token, id: FAKE_SPREADSHEET_ID },
    });
    expect(again.statusCode).toBe(400);
  });

  it('marks a sheet Google will not open as failed', async () => {
    const { admin } = await setUp();
    await connect(admin);
    const { requestId, token } = await pick(admin);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-sheets/picker-result',
      headers: { origin: 'http://localhost', host: 'localhost' },
      payload: { token, id: 'not-a-demo-sheet-000000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect((await progress(admin, requestId)).status).toBe('failed');
  });
});

describe('Google Sheets without the fake Google', () => {
  it('is not available without the file picker key, and waits for a sign-in with it', async () => {
    t = await makeTestApp();
    const client = new SheetsClient({ clientId: 'id', clientSecret: 'secret' });
    const without = createGoogleSheetsService(t.ctx, { fake: null, client });
    expect(without.status().state).toBe('not_configured');
    without.shutdown();
    t.ctx.config.googlePicker = { apiKey: 'key', appId: '123' };
    const withKey = createGoogleSheetsService(t.ctx, { fake: null, client });
    expect(withKey.status().state).toBe('disconnected');
    expect(() => withKey.startPicker('http://127.0.0.1:7420', { userId: 1 })).toThrow(
      'Connect a Google account first',
    );
    withKey.shutdown();
  });
});

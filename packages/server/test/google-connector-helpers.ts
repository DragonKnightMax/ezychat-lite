import { expect } from 'vitest';
import { listAgents } from '../src/ai/agents.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

/** One core Google connector's sign-in paths (Google Calendar, Google Sheets). */
export interface GooglePaths {
  connect: string;
  consent: string;
  callback: string;
}

export const CALENDAR_PATHS: GooglePaths = {
  connect: '/api/connectors/google-calendar/connect',
  consent: '/api/dev/fake-google/consent',
  callback: '/api/connectors/google-calendar/callback',
};

export const SHEETS_PATHS: GooglePaths = {
  connect: '/api/connectors/google-sheets/connect',
  consent: '/api/dev/fake-google-sheets/consent',
  callback: '/api/connectors/google-sheets/callback',
};

export const DRIVE_PATHS: GooglePaths = {
  connect: '/api/connectors/google-drive/connect',
  consent: '/api/dev/fake-google-drive/consent',
  callback: '/api/connectors/google-drive/callback',
};

/** Runs the whole sign-in on the fake: connect, the consent page's Allow or Cancel, Google's redirect. */
export async function connectThroughFake(
  t: TestApp,
  paths: GooglePaths,
  cookie: string,
  choice: 'allow' | 'cancel' = 'allow',
) {
  const start = await t.app.inject({
    method: 'POST',
    url: paths.connect,
    headers: authHeaders(cookie),
    payload: {},
  });
  expect(start.statusCode).toBe(200);
  const { requestId, authorizationUrl } = start.json() as {
    requestId: string;
    authorizationUrl: string;
  };
  const consentUrl = new URL(authorizationUrl);
  expect(consentUrl.pathname).toBe(paths.consent);
  const consent = await t.app.inject({
    method: 'GET',
    url: consentUrl.pathname + consentUrl.search,
  });
  expect(consent.statusCode).toBe(200);
  const href = new RegExp(`id="${choice}" href="([^"]+)"`)
    .exec(consent.body)![1]!
    .replaceAll('&#38;', '&');
  const target = new URL(href);
  expect(target.pathname).toBe(paths.callback);
  const callback = await t.app.inject({ method: 'GET', url: target.pathname + target.search });
  return { requestId, callback, target };
}

/** Every route answers 401 without a session and 403 for a team member (agent). */
export async function expectAdminOnly(
  t: TestApp,
  agentCookie: string,
  urls: ReadonlyArray<readonly ['GET' | 'POST' | 'PUT', string]>,
) {
  for (const [method, url] of urls) {
    const payload = method === 'GET' ? undefined : {};
    const anonymous = await t.app.inject({
      method,
      url,
      headers: { origin: 'http://localhost', host: 'localhost' },
      payload,
    });
    expect(anonymous.statusCode, url).toBe(401);
    const asAgent = await t.app.inject({ method, url, headers: authHeaders(agentCookie), payload });
    expect(asAgent.statusCode, url).toBe(403);
  }
}

/** The callback answers only on this computer: never via the LAN or the tunnel. */
export async function expectCallbackHostOnly(t: TestApp, url: string) {
  expect(
    (await t.app.inject({ method: 'GET', url, remoteAddress: '192.168.1.20' })).statusCode,
  ).toBe(403);
  expect(
    (await t.app.inject({ method: 'GET', url, headers: { 'cf-connecting-ip': '203.0.113.9' } }))
      .statusCode,
  ).toBe(403);
  expect(
    (await t.app.inject({ method: 'GET', url, headers: { host: '192.168.1.2:7420' } })).statusCode,
  ).toBe(403);
}

/** A test app with an admin, a team member (agent role) and one AI agent "Aina". */
export async function connectorTestApp() {
  const t = await makeTestApp();
  const admin = await createUserAndLogin(t, { role: 'admin' });
  const agent = await createUserAndLogin(t, { role: 'agent' });
  t.ctx.services.ai!.saveMember(
    { displayName: 'Aina', enabled: false, instructions: '' },
    { userId: admin.user.id, ip: null },
  );
  return { t, admin: admin.cookie, agent: agent.cookie, agentId: listAgents(t.ctx.db)[0]!.id };
}

/** Signed-in requests for one test app. */
export function connectorRequests(t: TestApp) {
  return {
    get: (url: string, cookie: string) => t.app.inject({ method: 'GET', url, headers: { cookie } }),
    post: (url: string, cookie: string, payload: unknown = {}) =>
      t.app.inject({
        method: 'POST',
        url,
        headers: authHeaders(cookie),
        payload: payload as object,
      }),
    put: (url: string, cookie: string, payload: unknown) =>
      t.app.inject({
        method: 'PUT',
        url,
        headers: authHeaders(cookie),
        payload: payload as object,
      }),
  };
}

/**
 * A Google file picker's page, script and token answer only this computer (never the LAN or the
 * tunnel); the real page has its own CSP (Google's picker only) and no inline script.
 */
export async function expectPickerHostOnly(
  t: TestApp,
  base: string,
  token: string,
  fakePage: string,
) {
  for (const path of [
    fakePage,
    `${base}/picker-page?token=${token}`,
    `${base}/picker-config?token=${token}`,
    `${base}/picker.js`,
  ]) {
    const lan = await t.app.inject({ method: 'GET', url: path, remoteAddress: '192.168.1.20' });
    expect(lan.statusCode, path).not.toBe(200);
    const tunnel = await t.app.inject({
      method: 'GET',
      url: path,
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(tunnel.statusCode, path).not.toBe(200);
  }
  const page = await t.app.inject({ method: 'GET', url: `${base}/picker-page?token=${token}` });
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-security-policy']).toContain(
    "script-src 'self' https://apis.google.com",
  );
  expect(page.body).not.toMatch(/<script>/);
  const script = await t.app.inject({ method: 'GET', url: `${base}/picker.js` });
  expect(script.headers['content-type']).toContain('javascript');
  return script.body;
}

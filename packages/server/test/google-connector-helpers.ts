import { expect } from 'vitest';
import { authHeaders } from './auth-helpers.js';
import type { TestApp } from './helpers.js';

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

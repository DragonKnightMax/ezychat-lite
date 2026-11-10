import { afterEach, describe, expect, it } from 'vitest';
import {
  GitHubActivityList,
  GitHubAgentView,
  GitHubDeviceProgress,
  GitHubDeviceStart,
  GitHubRepoList,
  GitHubStatus,
} from '@ezychat/shared';
import { FAKE_GITHUB_PAT, FAKE_PUBLIC_REPO } from '../src/connectors/github/fake.js';
import {
  connectorRequests,
  connectorTestApp,
  expectAdminOnly,
} from './google-connector-helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function setUp() {
  const app = await connectorTestApp();
  t = app.t;
  t.ctx.services.github!.fake!.interval = 0;
  return app;
}

const get = (url: string, cookie: string) => connectorRequests(t).get(url, cookie);
const post = (url: string, cookie: string, payload: unknown = {}) =>
  connectorRequests(t).post(url, cookie, payload);
const put = (url: string, cookie: string, payload: unknown) =>
  connectorRequests(t).put(url, cookie, payload);
const BASE = '/api/connectors/github';
const HELPDESK = { id: 9001, fullName: 'acme/helpdesk', private: true };
const errorCode = (res: { json(): unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

/** The whole App sign-in through the routes and the fake's dev route. */
async function signIn(admin: string) {
  const start = await post(`${BASE}/device`, admin);
  expect(start.statusCode).toBe(200);
  const { requestId } = GitHubDeviceStart.parse(start.json());
  expect(start.body).not.toMatch(/device_code|deviceCode/);
  expect(
    GitHubDeviceProgress.parse((await get(`${BASE}/device/${requestId}`, admin)).json()),
  ).toEqual({
    status: 'pending',
    github: null,
  });
  expect((await post('/api/dev/fake-github/device', admin, { action: 'approve' })).statusCode).toBe(
    200,
  );
  const done = GitHubDeviceProgress.parse((await get(`${BASE}/device/${requestId}`, admin)).json());
  expect(done).toMatchObject({ status: 'done', github: { state: 'connected', method: 'app' } });
  return requestId;
}

describe('GitHub routes', () => {
  it('are admin only', async () => {
    const { agent, agentId } = await setUp();
    await expectAdminOnly(t, agent, [
      ['GET', BASE],
      ['POST', `${BASE}/device`],
      ['GET', `${BASE}/device/0123456789abcdef01234567`],
      ['POST', `${BASE}/device/0123456789abcdef01234567/cancel`],
      ['POST', `${BASE}/token`],
      ['POST', `${BASE}/check`],
      ['POST', `${BASE}/disconnect`],
      ['GET', `${BASE}/repos`],
      ['GET', `${BASE}/agents/${agentId}`],
      ['PUT', `${BASE}/agents/${agentId}`],
      ['GET', `${BASE}/activity`],
      ['GET', '/api/dev/fake-github'],
      ['POST', '/api/dev/fake-github'],
      ['POST', '/api/dev/fake-github/device'],
    ]);
  });

  it('signs in with the App, lists repos, saves agent settings and disconnects', async () => {
    const { admin, agentId } = await setUp();
    expect(GitHubStatus.parse((await get(BASE, admin)).json())).toMatchObject({
      state: 'not_connected',
    });
    // Nothing to list before a sign-in.
    const early = await get(`${BASE}/repos`, admin);
    expect([early.statusCode, errorCode(early)]).toEqual([409, 'not_connected']);
    const earlyPut = await put(`${BASE}/agents/${agentId}`, admin, { repos: [HELPDESK] });
    expect([earlyPut.statusCode, errorCode(earlyPut)]).toEqual([409, 'not_connected']);

    await signIn(admin);
    const repos = GitHubRepoList.parse((await get(`${BASE}/repos?refresh=1`, admin)).json());
    expect(repos.repos.map((r) => r.fullName)).toEqual([
      'acme/helpdesk',
      'acme/mobile-app',
      'acme/website',
    ]);
    // The public repo outside the install is never offered, nor can it be saved.
    const refused = await put(`${BASE}/agents/${agentId}`, admin, {
      repos: [{ id: 9100, fullName: FAKE_PUBLIC_REPO, private: false }],
    });
    expect([refused.statusCode, errorCode(refused)]).toEqual([400, 'repo_not_accessible']);
    expect((await put(`${BASE}/agents/${agentId}`, admin, { repos: 'x' })).statusCode).toBe(400);
    expect((await get(`${BASE}/agents/9999`, admin)).statusCode).toBe(404);
    expect((await put(`${BASE}/agents/9999`, admin, {})).statusCode).toBe(404);

    expect(GitHubAgentView.parse((await get(`${BASE}/agents/${agentId}`, admin)).json())).toEqual({
      settings: { repos: [], issues: true, pulls: true },
      unavailableRepoIds: [],
    });
    // GitHub's name wins over what the page sent.
    const saved = await put(`${BASE}/agents/${agentId}`, admin, {
      repos: [{ ...HELPDESK, fullName: 'old/name' }],
      pulls: false,
    });
    expect(saved.statusCode).toBe(200);
    expect(GitHubAgentView.parse(saved.json())).toEqual({
      settings: { repos: [HELPDESK], issues: true, pulls: false },
      unavailableRepoIds: [],
    });
    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'github.agent_settings'")
      .all() as Array<{ meta: string }>;
    expect(audit.map((a) => JSON.parse(a.meta))).toEqual([{ agentId, fields: ['repos', 'pulls'] }]);

    // A repo GitHub stopped sharing stays chosen, marked, and may be saved again.
    t.ctx.services.github!.fake!.repos.find((r) => r.id === HELPDESK.id)!.installed = false;
    expect((await post(`${BASE}/check`, admin)).json()).toMatchObject({ state: 'connected' });
    expect((await get(`${BASE}/agents/${agentId}`, admin)).json()).toMatchObject({
      unavailableRepoIds: [HELPDESK.id],
    });
    const again = await put(`${BASE}/agents/${agentId}`, admin, { repos: [HELPDESK], pulls: true });
    expect(again.json()).toMatchObject({ unavailableRepoIds: [HELPDESK.id] });

    expect(GitHubActivityList.parse((await get(`${BASE}/activity`, admin)).json())).toEqual({
      activity: [],
    });

    // Disconnect keeps the agent settings.
    expect((await post(`${BASE}/disconnect`, admin)).json()).toMatchObject({
      state: 'not_connected',
    });
    expect((await get(`${BASE}/agents/${agentId}`, admin)).json()).toMatchObject({
      settings: { repos: [HELPDESK] },
      unavailableRepoIds: [],
    });
  });

  it('answers a cancelled, denied and unknown device sign-in', async () => {
    const { admin } = await setUp();
    const { requestId } = (await post(`${BASE}/device`, admin)).json() as { requestId: string };
    expect((await post(`${BASE}/device/${requestId}/cancel`, admin)).statusCode).toBe(204);
    expect((await get(`${BASE}/device/${requestId}`, admin)).statusCode).toBe(404);
    expect((await get(`${BASE}/device/not-an-id`, admin)).statusCode).toBe(400);
    const denied = (await post(`${BASE}/device`, admin)).json() as { requestId: string };
    await post('/api/dev/fake-github/device', admin, { action: 'deny' });
    expect((await get(`${BASE}/device/${denied.requestId}`, admin)).json()).toEqual({
      status: 'denied',
      github: null,
    });
    // GitHub down: 503 on start, and the fake's switch is admin-visible.
    expect((await post('/api/dev/fake-github', admin, { mode: 'unavailable' })).statusCode).toBe(
      200,
    );
    expect((await get('/api/dev/fake-github', admin)).json()).toMatchObject({
      mode: 'unavailable',
    });
    expect((await post(`${BASE}/device`, admin)).statusCode).toBe(503);
  });

  it('shows the install step until the App is installed', async () => {
    const { admin } = await setUp();
    await post('/api/dev/fake-github', admin, { installed: false });
    const { requestId } = (await post(`${BASE}/device`, admin)).json() as { requestId: string };
    await post('/api/dev/fake-github/device', admin, { action: 'approve' });
    expect((await get(`${BASE}/device/${requestId}`, admin)).json()).toMatchObject({
      status: 'done',
      github: { state: 'no_installation' },
    });
    await post('/api/dev/fake-github', admin, { installed: true });
    expect((await post(`${BASE}/check`, admin)).json()).toMatchObject({ state: 'connected' });
    // GitHub down while listing: 503 and the state says so.
    await post('/api/dev/fake-github', admin, { mode: 'unavailable' });
    expect((await get(`${BASE}/repos?refresh=1`, admin)).statusCode).toBe(503);
    expect((await get(BASE, admin)).json()).toMatchObject({ state: 'unavailable' });
  });

  it('signs in with a fine-grained token and refuses the others', async () => {
    const { admin } = await setUp();
    for (const [token, code] of [
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'classic'],
      ['github_pat_11UNKNOWN0000000000000000000000', 'invalid'],
      ['github_pat_11FAKE0000demo0000empty000demo', 'no_repos'],
    ] as const) {
      const res = await post(`${BASE}/token`, admin, { token });
      expect([res.statusCode, errorCode(res)], token).toEqual([400, code]);
    }
    expect((await post(`${BASE}/token`, admin, {})).statusCode).toBe(400);
    const ok = await post(`${BASE}/token`, admin, { token: `  ${FAKE_GITHUB_PAT}  ` });
    expect(GitHubStatus.parse(ok.json())).toMatchObject({ state: 'connected', method: 'token' });
    expect(ok.body).not.toContain(FAKE_GITHUB_PAT);
    expect((await get(BASE, admin)).body).not.toContain('github_pat_');
  });
});

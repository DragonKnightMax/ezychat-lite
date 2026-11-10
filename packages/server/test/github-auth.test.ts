import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_SETTING,
  REFRESH_EARLY_MS,
  TokenRefused,
  parseTokenExpiry,
  type StoredGitHubAuth,
} from '../src/connectors/github/auth.js';
import { GitHubClient, GitHubError } from '../src/connectors/github/client.js';
import {
  FAKE_GITHUB_LOGIN,
  FAKE_GITHUB_PAT,
  FAKE_GITHUB_PAT_NO_REPOS,
} from '../src/connectors/github/fake.js';
import { connectorTestApp } from './google-connector-helpers.js';
import { adminActor, githubOnClock, signInApp, tokenPosts } from './github-helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function setUp() {
  const app = await connectorTestApp();
  t = app.t;
  return { ...githubOnClock(t.ctx), actor: adminActor(t.ctx) };
}

const stored = () => JSON.parse(t.ctx.settings.getSecret(AUTH_SETTING)!) as StoredGitHubAuth;
const audits = (action: string) =>
  (
    t.ctx.db.prepare('SELECT meta FROM audit_log WHERE action = ?').all(action) as Array<{
      meta: string;
    }>
  ).map((r) => JSON.parse(r.meta) as unknown);

describe('GitHub sign-in: device flow', () => {
  it('shows a code, polls GitHub once per interval, and signs in when approved', async () => {
    const { svc, fake, clock, actor } = await setUp();
    expect(svc.status()).toMatchObject({ state: 'not_connected', method: null, login: null });
    const start = await svc.startDevice(actor);
    // The device code never leaves the server.
    expect(Object.keys(start).sort()).toEqual([
      'expiresAt',
      'requestId',
      'userCode',
      'verificationUri',
    ]);
    expect(start.verificationUri).toBe('https://github.com/login/device');
    expect(start.expiresAt).toBe(clock.now + 900_000);
    // Not before GitHub's interval.
    expect(await svc.auth.deviceStatus(start.requestId)).toBe('pending');
    expect(tokenPosts(fake)).toBe(0);
    clock.now += 5_000;
    expect(await svc.auth.deviceStatus(start.requestId)).toBe('pending'); // authorization_pending
    expect(await svc.auth.deviceStatus(start.requestId)).toBe('pending');
    expect(tokenPosts(fake)).toBe(1);
    fake.answerDevice('approve');
    clock.now += 5_000;
    expect(await svc.deviceProgress(start.requestId)).toMatchObject({
      status: 'done',
      github: { state: 'connected', method: 'app', login: FAKE_GITHUB_LOGIN },
    });
    expect(stored()).toMatchObject({
      method: 'app',
      login: FAKE_GITHUB_LOGIN,
      accessExpiresAt: clock.now + 28_800_000,
      refreshExpiresAt: clock.now + 15_638_400_000,
    });
    expect(audits('github.connect')).toEqual([{ method: 'app' }]);
    expect(svc.status().manageUrl).toContain('/apps/ezychat-by-anchor-sprint/');
    expect(await svc.deviceProgress('f'.repeat(24))).toBeNull();
  });

  it('slows down by 5 s when GitHub asks', async () => {
    const { svc, fake, clock, actor } = await setUp();
    const start = await svc.startDevice(actor);
    fake.slowDowns = 1;
    clock.now += 5_000;
    expect(await svc.auth.deviceStatus(start.requestId)).toBe('pending');
    expect(tokenPosts(fake)).toBe(1);
    fake.answerDevice('approve');
    clock.now += 5_000; // the interval is 10 s now
    expect(await svc.auth.deviceStatus(start.requestId)).toBe('pending');
    expect(tokenPosts(fake)).toBe(1);
    clock.now += 5_000;
    expect(await svc.auth.deviceStatus(start.requestId)).toBe('done');
  });

  it('ends on a cancel on GitHub, an expired code, a cancel here, or GitHub failing', async () => {
    const { svc, fake, clock, actor } = await setUp();
    const denied = await svc.startDevice(actor);
    fake.answerDevice('deny');
    clock.now += 5_000;
    expect(await svc.deviceProgress(denied.requestId)).toEqual({ status: 'denied', github: null });

    const expired = await svc.startDevice(actor);
    fake.answerDevice('expire');
    clock.now += 5_000;
    expect(await svc.auth.deviceStatus(expired.requestId)).toBe('expired');

    // Our own clock: no poll once the code ran out.
    const late = await svc.startDevice(actor);
    const before = tokenPosts(fake);
    clock.now += 901_000;
    expect(await svc.auth.deviceStatus(late.requestId)).toBe('expired');
    expect(tokenPosts(fake)).toBe(before);

    const cancelled = await svc.startDevice(actor);
    expect(svc.cancelDevice(cancelled.requestId)).toBe(true);
    expect(await svc.auth.deviceStatus(cancelled.requestId)).toBeNull();

    // GitHub unavailable while polling: still pending, asked again next interval.
    const flaky = await svc.startDevice(actor);
    fake.mode = 'unavailable';
    clock.now += 5_000;
    expect(await svc.auth.deviceStatus(flaky.requestId)).toBe('pending');
    fake.mode = 'ok';
    fake.answerDevice('approve');
    clock.now += 5_000;
    expect(await svc.auth.deviceStatus(flaky.requestId)).toBe('done');

    // Starting while GitHub is down: 503.
    fake.mode = 'unavailable';
    await expect(svc.startDevice(actor)).rejects.toMatchObject({ status: 503 });
    expect(svc.status().state).toBe('connected');
  });

  it('says to install the App when it is installed nowhere, until Check again finds it', async () => {
    const { svc, fake, clock, actor } = await setUp();
    fake.installed = false;
    await signInApp(svc, actor, clock);
    expect(svc.status().state).toBe('no_installation');
    fake.installed = true;
    expect((await svc.check()).state).toBe('connected');
    fake.mode = 'unavailable';
    expect(await svc.check()).toMatchObject({ state: 'unavailable', problemSince: clock.now });
    fake.mode = 'ok';
    expect((await svc.check()).state).toBe('connected');
  });
});

describe('GitHub sign-in: refresh', () => {
  it('refreshes once for concurrent calls near expiry and saves the new pair first', async () => {
    const { svc, fake, clock, actor } = await setUp();
    await signInApp(svc, actor, clock);
    const first = stored();
    const posts = tokenPosts(fake);
    clock.now = first.accessExpiresAt! - REFRESH_EARLY_MS + 1;
    const used: string[] = [];
    const call = () =>
      svc.auth.withToken(async (token) => {
        used.push(token);
        return (await new GitHubClient(fake.fetch).get<{ login: string }>(token, '/user')).data
          .login;
      });
    expect(await Promise.all([call(), call(), call()])).toEqual(Array(3).fill(FAKE_GITHUB_LOGIN));
    expect(tokenPosts(fake) - posts).toBe(1);
    const next = stored();
    expect(next.accessToken).not.toBe(first.accessToken);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(new Set(used)).toEqual(new Set([next.accessToken]));
    // The old pair is dead on GitHub (single-use refresh, old access revoked).
    expect(fake.access.has(first.accessToken)).toBe(false);
    expect(fake.refreshTokens.has(first.refreshToken!)).toBe(false);
    expect(svc.status().state).toBe('connected');
  });

  it('retries a 401 once: with the newest token when another call refreshed, else after a refresh', async () => {
    const { svc, fake, clock, actor } = await setUp();
    await signInApp(svc, actor, clock);
    const client = new GitHubClient(fake.fetch);
    const login = (token: string) => client.get<{ login: string }>(token, '/user');

    // GitHub dropped the token: one refresh, then the call works.
    fake.access.delete(stored().accessToken);
    let posts = tokenPosts(fake);
    expect((await svc.auth.withToken(login)).data.login).toBe(FAKE_GITHUB_LOGIN);
    expect(tokenPosts(fake) - posts).toBe(1);

    // Another call refreshed while this one ran (its token is revoked): newest token, no refresh.
    posts = tokenPosts(fake);
    let first = true;
    const result = await svc.auth.withToken(async (token) => {
      if (first) {
        first = false;
        const issued = fake.issueAppTokens();
        fake.access.delete(token);
        t.ctx.settings.setSecret(
          AUTH_SETTING,
          JSON.stringify({ ...stored(), accessToken: issued.access, refreshToken: issued.refresh }),
        );
      }
      return login(token);
    });
    expect(result.data.login).toBe(FAKE_GITHUB_LOGIN);
    expect(tokenPosts(fake)).toBe(posts);
  });

  it('asks to sign in again when the refresh is refused or the token keeps failing', async () => {
    const { svc, fake, clock, actor } = await setUp();
    await signInApp(svc, actor, clock);
    const login = (token: string) => new GitHubClient(fake.fetch).get(token, '/user');
    fake.access.delete(stored().accessToken);
    fake.refreshTokens.clear();
    await expect(svc.auth.withToken(login)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(svc.status()).toMatchObject({ state: 'expired', problemSince: clock.now });
    // "Sign in again" stays: GitHub being unavailable later does not hide it.
    svc.auth.setProblem('unavailable');
    expect(svc.status().state).toBe('expired');
    // A new sign-in clears it.
    await signInApp(svc, actor, clock);
    expect(svc.status().state).toBe('connected');
    // A 401 even after a good refresh: expired.
    await expect(
      svc.auth.withToken(() => Promise.reject(new GitHubError('unauthorized', 401))),
    ).rejects.toThrow();
    expect(svc.status().state).toBe('expired');
  });

  it('lets a disconnect during a refresh win', async () => {
    const { svc, clock, actor } = await setUp();
    await signInApp(svc, actor, clock);
    clock.now = stored().accessExpiresAt!;
    const pending = svc.auth.withToken(async (token) => token);
    svc.disconnect(actor);
    await pending;
    expect(t.ctx.settings.getSecret(AUTH_SETTING)).toBeNull();
    expect(svc.status().state).toBe('not_connected');
    expect(audits('github.disconnect')).toHaveLength(1);
    await expect(svc.auth.withToken(async (token) => token)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });
});

describe('GitHub sign-in: fine-grained token', () => {
  it('refuses classic, odd, unknown and repo-less tokens', async () => {
    const { svc, fake, actor } = await setUp();
    for (const [token, reason] of [
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'classic'],
      ['gho_abcdefghijklmnopqrstuvwxyz0123456789', 'classic'],
      ['not-a-token', 'invalid'],
      ['github_pat_short', 'invalid'],
      ['github_pat_11UNKNOWN0000000000000000000000', 'invalid'],
      [FAKE_GITHUB_PAT_NO_REPOS, 'no_repos'],
    ] as const)
      await expect(svc.connectToken(token, actor), token).rejects.toMatchObject({
        status: 400,
        code: reason,
      });
    await expect(svc.auth.checkToken('ghs_x')).rejects.toBeInstanceOf(TokenRefused);
    expect(svc.status().state).toBe('not_connected');
    fake.mode = 'unavailable';
    await expect(svc.connectToken(FAKE_GITHUB_PAT, actor)).rejects.toMatchObject({ status: 503 });
    expect(fake.requests.some((r) => r.includes('ghp_'))).toBe(false);
  });

  it('signs in, warns within 7 days of the expiry and stops after it', async () => {
    const { svc, fake, clock, actor } = await setUp();
    fake.tokenExpiry = '2026-12-01 00:00:00 +0800';
    const status = await svc.connectToken(FAKE_GITHUB_PAT, actor);
    const expiresAt = Date.UTC(2026, 10, 30, 16);
    expect(status).toMatchObject({
      state: 'connected',
      method: 'token',
      login: FAKE_GITHUB_LOGIN,
      tokenExpiresAt: expiresAt,
      manageUrl: 'https://github.com/settings/personal-access-tokens',
    });
    expect(audits('github.connect')).toEqual([{ method: 'token' }]);
    // Already read with the token: no second list.
    expect((await svc.repoList(false)).repos.map((r) => r.fullName)).toEqual([
      'acme/helpdesk',
      'acme/website',
    ]);
    clock.now = expiresAt - 7 * 24 * 60 * 60_000;
    expect(svc.status().state).toBe('expiring');
    clock.now = expiresAt;
    expect(svc.status()).toMatchObject({ state: 'expired', problemSince: expiresAt });
    await expect(svc.auth.withToken(async (token) => token)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('marks a revoked token expired at its first 401', async () => {
    const { svc, fake, actor } = await setUp();
    await svc.connectToken(FAKE_GITHUB_PAT, actor);
    fake.access.delete(FAKE_GITHUB_PAT);
    await expect(svc.repoList(true)).rejects.toMatchObject({ status: 409 });
    expect(svc.status().state).toBe('expired');
  });

  it("reads GitHub's expiry header", () => {
    expect(parseTokenExpiry('2026-12-01 00:00:00 UTC')).toBe(Date.UTC(2026, 11, 1));
    expect(parseTokenExpiry('2026-12-01 00:00:00 -0700')).toBe(Date.UTC(2026, 11, 1, 7));
    expect(parseTokenExpiry(null)).toBeNull();
    expect(parseTokenExpiry('tomorrow')).toBeNull();
  });
});

import { expect } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { Actor } from '../src/connectors/github/auth.js';
import { FakeGitHub } from '../src/connectors/github/fake.js';
import { createGitHubService, type GitHubService } from '../src/connectors/github/service.js';

/** The first admin of the test app, as the actor of audit rows. */
export function adminActor(ctx: AppContext): Actor {
  const row = ctx.db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id").get() as {
    id: number;
  };
  return { userId: row.id, ip: null };
}

/** A GitHub service on its own fake and clock (tests move `clock.now`). */
export function githubOnClock(ctx: AppContext, start = Date.UTC(2026, 10, 10)) {
  const clock = { now: start };
  const fake = new FakeGitHub();
  fake.interval = 5;
  const svc = createGitHubService(ctx, { fake, now: () => clock.now });
  return { svc, fake, clock };
}

/**
 * Signs in with the App through the fake device flow. With a clock it moves past GitHub's
 * interval; without one GitHub's interval is made 0 first.
 */
export async function signInApp(svc: GitHubService, actor: Actor, clock?: { now: number }) {
  const fake = svc.fake!;
  if (!clock) fake.interval = 0;
  const start = await svc.startDevice(actor);
  fake.answerDevice('approve');
  if (clock) clock.now += fake.interval * 1000;
  expect(await svc.auth.deviceStatus(start.requestId)).toBe('done');
  return start;
}

/** POSTs to GitHub's token endpoint so far (device polls and refreshes). */
export const tokenPosts = (fake: FakeGitHub) =>
  fake.requests.filter((r) => r === 'POST github.com/login/oauth/access_token').length;

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsSchema, UsageEvent } from '@ezychat/shared';
import { FakeWaAdapter } from '@ezychat/wa';
import type { AppContext } from '../src/context.js';
import {
  createUsageService,
  setUsageStats,
  USAGE_INSTALL_ID_KEY,
  USAGE_PORTAL_URL,
  USAGE_SENT_KEY,
  USAGE_STATS_KEY,
  USAGE_URL_ENV,
  usageOs,
  usageProduct,
  usageStatsEnabled,
  type UsageService,
} from '../src/usage/service.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let service: UsageService | undefined;
afterEach(async () => {
  service?.shutdown();
  service = undefined;
  await t?.close();
});

/** A fake licence portal: records every body, answers `status` (default 204). */
function fakePortal(status: number | (() => number | Promise<never>) = 204) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const s = typeof status === 'function' ? await status() : status;
    return new Response(null, { status: s });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

type Config = Partial<AppContext['config']>;

/** The test app runs `--mode dev --fake-wa` (its own usage service never sends); this one acts as a real install. */
async function setUp(
  opts: {
    config?: Config;
    edition?: string;
    portal?: ReturnType<typeof fakePortal>;
    env?: NodeJS.ProcessEnv;
    day?: string;
  } = {},
) {
  const portal = opts.portal ?? fakePortal();
  t = await makeTestApp({
    config: { version: '0.1.76' },
    edition: opts.edition,
    wa: new FakeWaAdapter({ autoOpen: false }),
  });
  const clock = { day: opts.day ?? '2026-11-04' };
  const ctx: AppContext = {
    ...t.ctx,
    config: { ...t.ctx.config, mode: 'standalone', fakeWa: false, ...opts.config },
  };
  service = createUsageService(ctx, {
    fetch: portal.fetch,
    timer: false,
    platform: 'win32',
    env: opts.env ?? {},
    now: () => new Date(`${clock.day}T09:00:00Z`),
  });
  return { portal, ctx, clock };
}

const events = (portal: ReturnType<typeof fakePortal>) => portal.calls.map((c) => c.body.event);

describe('usage stats', () => {
  it('sends app_installed and app_active once, exactly in the portal contract and nothing else', async () => {
    const { portal } = await setUp();
    await service!.check();
    expect(events(portal)).toEqual(['app_installed', 'app_active']);
    for (const call of portal.calls) {
      expect(call.url).toBe(USAGE_PORTAL_URL);
      expect(call.init.method).toBe('POST');
      expect(call.init.redirect).toBe('error');
      expect(call.init.headers).toEqual({ 'content-type': 'application/json' });
      expect(Object.keys(call.body).sort()).toEqual([
        'event',
        'installId',
        'mode',
        'os',
        'product',
        'version',
      ]);
      expect(UsageEvent.parse(call.body)).toEqual(call.body);
      expect(call.body).toMatchObject({
        product: 'EZC-LITE',
        version: '0.1.76',
        os: 'windows',
        mode: 'standalone',
      });
    }
    const id = t.ctx.settings.get<string>(USAGE_INSTALL_ID_KEY, '');
    expect(portal.calls.every((c) => c.body.installId === id)).toBe(true);
    // A restart (or another check) sends nothing again the same day.
    await service!.check();
    expect(portal.calls).toHaveLength(2);
  });

  it('sends each milestone once when the app reaches it, and app_active once a day', async () => {
    const { portal, clock } = await setUp();
    await service!.check();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    (t.ctx.wa as FakeWaAdapter).simulateStatus({ state: 'open' });
    await service!.check();
    expect(events(portal)).toEqual(['app_installed', 'app_active', 'admin_created', 'wa_linked']);

    // A team message that went out.
    t.ctx.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, from_me, sent_by_user_id, type, body, status, timestamp, created_at)
         VALUES ('m1', '60123456789@s.whatsapp.net', 1, ?, 'text', 'Hello Aisyah', 'sent', 1, 1)`,
      )
      .run(admin.user.id);
    clock.day = '2026-11-05';
    await service!.check();
    expect(events(portal).slice(4)).toEqual(['first_message_sent', 'app_active']);
    // Nothing personal ever leaves: no message text, number or user name.
    const all = JSON.stringify(portal.calls.map((c) => c.body));
    for (const leak of ['Aisyah', '60123456789', admin.user.username])
      expect(all).not.toContain(leak);
    await service!.check();
    expect(portal.calls).toHaveLength(6);
  });

  it('counts an AI agent as on only while its user is enabled, and the AI connection only when ready', async () => {
    const { portal, ctx } = await setUp();
    const ai = { connectionReady: vi.fn(() => false) };
    Object.assign(ctx.services, {
      ai: { ...t.ctx.services.ai, connectionReady: ai.connectionReady },
    });
    await service!.check();
    expect(events(portal)).not.toContain('ai_connected');
    ai.connectionReady.mockReturnValue(true);
    t.ctx.bus.emit('ai:connection-changed');
    await vi.waitFor(() => expect(events(portal)).toContain('ai_connected'));
    expect(events(portal)).not.toContain('ai_agent_on');
    // An AI agent that is still off (its user disabled), then switched on.
    const userId = Number(
      t.ctx.db
        .prepare(
          `INSERT INTO users (username, display_name, password_hash, role, kind, disabled_at, created_at)
           VALUES ('ai-sales', 'Sales', '!', 'agent', 'ai', 1, 1)`,
        )
        .run().lastInsertRowid,
    );
    t.ctx.db
      .prepare(
        'INSERT INTO ai_agents (user_id, inbox_id, created_at, updated_at) VALUES (?, 1, 1, 1)',
      )
      .run(userId);
    await service!.check();
    expect(events(portal)).not.toContain('ai_agent_on');
    const agentUser = { id: userId };
    expect(agentUser).toBeDefined();
    t.ctx.db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(agentUser!.id);
    await service!.check();
    expect(events(portal)).toContain('ai_agent_on');
  });

  it('sends nothing while the switch is off, and stops a round when it goes off', async () => {
    const { portal } = await setUp();
    t.ctx.settings.set(USAGE_STATS_KEY, false);
    await service!.check();
    expect(portal.calls).toHaveLength(0);
    t.ctx.settings.set(USAGE_STATS_KEY, true);
    // Turned off while the first event is on its way: the rest of the round is not sent.
    let first = true;
    const slow = fakePortal(() => {
      if (first) t.ctx.settings.set(USAGE_STATS_KEY, false);
      first = false;
      return 204;
    });
    service!.shutdown();
    service = createUsageService(
      { ...t.ctx, config: { ...t.ctx.config, mode: 'standalone', fakeWa: false } },
      { fetch: slow.fetch, timer: false, env: {} },
    );
    await service.check();
    expect(slow.calls).toHaveLength(1);
  });

  it('never sends from fake WhatsApp, from dev mode, or from an unknown edition', async () => {
    for (const config of [
      { fakeWa: true },
      { mode: 'dev' as const, fakeWa: false },
      { mode: 'dev' as const, fakeWa: true },
    ]) {
      const { portal } = await setUp({
        config,
        env: { [USAGE_URL_ENV]: 'http://127.0.0.1:9/v1/usage' },
      });
      await service!.check();
      // Only dev + fake WhatsApp may use the override; the others send nothing at all.
      if (config.mode === 'dev' && config.fakeWa) {
        expect(portal.calls[0]!.url).toBe('http://127.0.0.1:9/v1/usage');
        expect(portal.calls[0]!.body.mode).toBe('standalone');
      } else expect(portal.calls).toHaveLength(0);
      service!.shutdown();
      service = undefined;
      await t.close();
    }
    const dev = await setUp({ config: { mode: 'dev', fakeWa: true } });
    await service!.check();
    expect(dev.portal.calls).toHaveLength(0);
    service!.shutdown();
    service = undefined;
    await t.close();
    const other = await setUp({ edition: 'pro' });
    await service!.check();
    expect(other.portal.calls).toHaveLength(0);
  });

  it('names the Enterprise product and the service mode', async () => {
    const { portal } = await setUp({ edition: 'enterprise', config: { mode: 'service' } });
    await service!.check();
    expect(portal.calls[0]!.body).toMatchObject({ product: 'EZC-ENT', mode: 'service' });
  });

  it('pauses while the access gate is closed and sends again when it opens', async () => {
    const { portal } = await setUp();
    t.ctx.access.close({ code: 'license_required' });
    await service!.check();
    expect(portal.calls).toHaveLength(0);
    t.ctx.access.open();
    await vi.waitFor(() => expect(portal.calls.length).toBeGreaterThan(0));
  });

  it('retries a failed send later, but never retries a refusal (4xx)', async () => {
    let answer: number | 'throw' = 'throw';
    const portal = fakePortal(() =>
      answer === 'throw' ? Promise.reject(new TypeError('fetch failed')) : answer,
    );
    await setUp({ portal });
    await service!.check();
    expect(t.ctx.settings.get(USAGE_SENT_KEY, null)).toBeNull();
    answer = 503;
    await service!.check();
    expect(t.ctx.settings.get(USAGE_SENT_KEY, null)).toBeNull();
    answer = 429;
    await service!.check();
    expect(t.ctx.settings.get(USAGE_SENT_KEY, null)).toBeNull();
    answer = 400;
    await service!.check();
    expect(t.ctx.settings.get(USAGE_SENT_KEY, null)).toEqual({
      events: ['app_installed'],
      activeDay: '2026-11-04',
    });
    const n = portal.calls.length;
    await service!.check();
    expect(portal.calls).toHaveLength(n);
  });

  it('skips a version that is not semver and reads a damaged record as nothing sent', async () => {
    const { portal } = await setUp({ config: { version: 'dev-build' } });
    await service!.check();
    expect(portal.calls).toHaveLength(0);
    t.ctx.settings.set(USAGE_SENT_KEY, { events: ['nope', 'app_installed'], activeDay: 7 });
    service!.shutdown();
    const fresh = fakePortal();
    service = createUsageService(
      {
        ...t.ctx,
        config: { ...t.ctx.config, mode: 'standalone', fakeWa: false, version: '0.1.76' },
      },
      { fetch: fresh.fetch, timer: false, env: {} },
    );
    await service.check();
    expect(events(fresh)).toEqual(['app_active']);
  });

  it('maps the OS and edition', () => {
    expect(usageOs('win32')).toBe('windows');
    expect(usageOs('darwin')).toBe('mac');
    expect(usageOs('linux')).toBe('linux');
    expect(usageProduct('lite')).toBe('EZC-LITE');
    expect(usageProduct('enterprise')).toBe('EZC-ENT');
    expect(usageProduct('pro')).toBeNull();
  });
});

describe('usage stats switch', () => {
  it('is on by default, shown in GET /api/settings, admin-only, and audited with before/after', async () => {
    t = await makeTestApp();
    expect(usageStatsEnabled(t.ctx.settings)).toBe(true);
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const agent = await createUserAndLogin(t, { role: 'agent' });

    const get = await t.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: authHeaders(admin.cookie),
    });
    expect(SettingsSchema.parse(get.json()).usageStats).toBe(true);

    const denied = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(agent.cookie),
      payload: { usageStats: false },
    });
    expect(denied.statusCode).toBe(403);
    expect(usageStatsEnabled(t.ctx.settings)).toBe(true);

    const off = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(admin.cookie),
      payload: { usageStats: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().settings.usageStats).toBe(false);
    // Another setting saved later leaves the switch alone.
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(admin.cookie),
      payload: { historyDays: 5 },
    });
    expect(usageStatsEnabled(t.ctx.settings)).toBe(false);

    const entries = t.ctx.db
      .prepare("SELECT user_id AS userId, meta FROM audit_log WHERE action = 'usage_stats.update'")
      .all() as { userId: number | null; meta: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe(admin.user.id);
    expect(JSON.parse(entries[0]!.meta)).toEqual({ before: true, after: false });

    // Saving the same value again is not a change.
    setUsageStats(t.ctx, false, { userId: admin.user.id, ip: null });
    const again = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(admin.cookie),
      payload: { usageStats: true },
    });
    expect(again.json().settings.usageStats).toBe(true);
  });
});

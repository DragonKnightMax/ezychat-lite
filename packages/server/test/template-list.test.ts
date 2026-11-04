import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTemplateCatalog, TEMPLATE_SIGNING_CONTEXT } from '@ezychat/shared';
import type { AppContext } from '../src/context.js';
import {
  createTemplateListService,
  LIST_FILE,
  LIST_MAX_BYTES,
  LIST_URL_ENV,
  REFRESH_MIN_INTERVAL_MS,
  SIG_FILE,
  TEST_KEY_ENV,
  templateListSource,
  type TemplateListOptions,
} from '../src/templates/service.js';
import { TEMPLATE_LIST_BASE_URL } from '../src/templates/keys.js';
import { REFRESH_WAIT_MS } from '../src/routes/ai-templates.js';
import type { TemplateListService } from '../src/templates/types.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { keyPair } from './connector-list-fixtures.js';
import { makeTestApp, type TestApp } from './helpers.js';

const BASE = 'https://list.test/templates/';
const main = keyPair();
const stranger = keyPair();

let t: TestApp;
const services: TemplateListService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) s.shutdown();
  vi.unstubAllEnvs();
  await t?.close();
});

const texts = (name: string) => ({
  agentName: `${name} assistant`,
  name,
  description: `Answers for a ${name}.`,
  keywords: 'venue hall',
  focus: `BUSINESS\nYou answer for a ${name}.`,
  handoffRules: '- The customer is upset',
  contextName: `${name} details`,
  contextText: 'Name:\nAddress:',
});

function tpl(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    version: 2,
    schemaVersion: 1,
    minAppVersion: '0.1.0',
    editions: ['lite', 'enterprise'],
    category: 'events',
    icon: 'party-popper',
    preset: 'sales',
    texts: { en: texts(`Venue ${id}`) },
    ...extra,
  };
}

/** Serves templates-v1.json and its signature from memory; records every request and its init. */
class FakeTemplateServer {
  files = new Map<string, Buffer>();
  calls: Array<{ url: string; init?: RequestInit }> = [];
  offline = false;
  headers = new Map<string, Record<string, string>>();
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    this.calls.push({ url, init });
    if (this.offline) throw new TypeError('fetch failed');
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const body = this.files.get(path);
    if (!body) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(body), { status: 200, headers: this.headers.get(path) });
  }) as typeof fetch;

  publish(options: {
    sequence: number;
    entries: unknown[];
    categories?: unknown[];
    key?: KeyObject;
    /** Signs the bare bytes like the connector list (no domain prefix). */
    noContext?: boolean;
    raw?: Buffer;
  }): Buffer {
    const bytes =
      options.raw ??
      Buffer.from(
        JSON.stringify({
          format: 1,
          catalog: 'templates',
          generatedAt: '2026-11-04T10:00:00.000Z',
          sequence: options.sequence,
          categories: options.categories ?? [{ id: 'events', name: { en: 'Events' } }],
          entries: options.entries,
        }),
      );
    const signed = options.noContext
      ? bytes
      : Buffer.concat([Buffer.from(TEMPLATE_SIGNING_CONTEXT), bytes]);
    this.files.set(LIST_FILE, bytes);
    this.files.set(
      SIG_FILE,
      Buffer.from(sign(null, signed, options.key ?? main.privateKey).toString('base64') + '\n'),
    );
    return bytes;
  }
}

async function setUp(config: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp({ ...config, config: { version: '0.1.75', ...config.config } });
  t.ctx.services.templateList?.shutdown();
  return t.ctx;
}

function create(
  ctx: AppContext,
  server: FakeTemplateServer,
  clock = { now: 0 },
  options: TemplateListOptions = {},
) {
  const service = createTemplateListService(ctx, {
    fetch: server.fetch,
    now: () => clock.now,
    keys: [main.publicKey],
    baseUrl: BASE,
    ...options,
  });
  services.push(service);
  return service;
}

/** A context whose logger records every line (object + message). */
function recording(ctx: AppContext) {
  const lines: Array<{ level: string; obj: unknown; msg: string }> = [];
  const log: Record<string, unknown> = {};
  for (const level of ['info', 'warn', 'error', 'debug'])
    log[level] = (obj: unknown, msg: string) => lines.push({ level, obj, msg });
  log.child = () => log;
  return { ctx: { ...ctx, log } as unknown as AppContext, lines };
}

describe('template list service', () => {
  it('starts with no list templates (the app shows its own) until a signed list is loaded', async () => {
    const ctx = await setUp();
    const server = new FakeTemplateServer();
    server.publish({ sequence: 3, entries: [tpl('venue'), tpl('florist')] });
    const service = create(ctx, server);
    expect(service.catalog()).toMatchObject({ status: { state: 'builtin' }, templates: [] });

    const catalog = AgentTemplateCatalog.parse(await service.refresh());
    expect(catalog.status).toMatchObject({ state: 'loaded', sequence: 3 });
    expect(catalog.templates.map((c) => c.entry.id)).toEqual(['venue', 'florist']);
    expect(catalog.categories).toEqual([{ id: 'events', name: { en: 'Events' } }]);
    // Saved as the exact checked bytes.
    const dir = join(ctx.config.dataDir, 'templates');
    expect(readFileSync(join(dir, LIST_FILE))).toEqual(server.files.get(LIST_FILE));
    // Fixed host, no redirects, no cache.
    expect(server.calls.map((c) => c.url)).toEqual([BASE + LIST_FILE, BASE + SIG_FILE]);
    for (const call of server.calls) {
      expect(call.init?.redirect).toBe('error');
      expect(call.init?.headers).toEqual({ 'cache-control': 'no-cache' });
    }
  });

  it('leaves out entries this app or edition cannot use and bad or repeated entries', async () => {
    const ctx = await setUp();
    const server = new FakeTemplateServer();
    server.publish({
      sequence: 1,
      entries: [
        tpl('ok'),
        tpl('newer-app', { minAppVersion: '9.0.0' }),
        tpl('enterprise-only', { editions: ['enterprise'] }),
        tpl('future', { schemaVersion: 2 }),
        tpl('ok'),
        tpl('Bad Id'),
        tpl('no-english', { texts: { ms: texts('x') } }),
        tpl('too-long', { texts: { en: { ...texts('x'), focus: 'x'.repeat(4001) } } }),
        tpl('bad-preset', { preset: 'claims' }),
        'not an object',
      ],
    });
    const catalog = await create(ctx, server).refresh();
    expect(catalog.templates.map((c) => c.entry.id)).toEqual(['ok']);
  });

  it('removes control, bidi and byte-order-mark characters from every text', async () => {
    const ctx = await setUp();
    const server = new FakeTemplateServer();
    const hidden = 'Never \u202Edeifitrec\u202C diagnose\u0007\u200F\uFEFF.\r\nNext line';
    server.publish({
      sequence: 1,
      entries: [
        tpl('venue', {
          texts: { en: { ...texts('Venue'), focus: hidden, name: '\u2066Venue\u2069' } },
        }),
        // A required text that is only unsafe characters is empty after cleaning: dropped.
        tpl('empty', { texts: { en: { ...texts('Empty'), name: '\u202E\u202C' } } }),
      ],
    });
    const [venue, ...rest] = (await create(ctx, server).refresh()).templates;
    expect(rest).toEqual([]);
    expect(venue!.entry.texts.en.focus).toBe('Never deifitrec diagnose.\nNext line');
    expect(venue!.entry.texts.en.name).toBe('Venue');
  });

  it('rejects a list signed without the template prefix (a connector list signature never fits)', async () => {
    const ctx = await setUp();
    const server = new FakeTemplateServer();
    server.publish({ sequence: 1, entries: [tpl('venue')], noContext: true });
    const service = create(ctx, server);
    const catalog = await service.refresh();
    expect(catalog.status.state).toBe('rejected');
    expect(catalog.templates).toEqual([]);
    expect(existsSync(join(ctx.config.dataDir, 'templates', LIST_FILE))).toBe(false);
  });

  it('rejects a stranger key, a broken signature and a file that is not a template list', async () => {
    const ctx = await setUp();
    const clock = { now: 0 };
    const server = new FakeTemplateServer();
    const service = create(ctx, server, clock);
    server.publish({ sequence: 1, entries: [tpl('venue')], key: stranger.privateKey });
    expect((await service.refresh()).status.state).toBe('rejected');

    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.publish({ sequence: 1, entries: [tpl('venue')] });
    server.files.set(SIG_FILE, Buffer.from('not base64 !'));
    expect((await service.refresh()).status.state).toBe('rejected');

    // Signed correctly, but a connector list (no `catalog: "templates"`).
    clock.now += REFRESH_MIN_INTERVAL_MS;
    const connectorList = Buffer.from(
      JSON.stringify({
        format: 1,
        generatedAt: '2026-11-04T10:00:00.000Z',
        sequence: 5,
        entries: [],
      }),
    );
    server.publish({ sequence: 5, entries: [], raw: connectorList });
    expect((await service.refresh()).status.state).toBe('rejected');

    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.publish({ sequence: 1, entries: [], raw: Buffer.from('{not json') });
    expect((await service.refresh()).status.state).toBe('rejected');
  });

  it('never goes back to a lower sequence and keeps the last good copy', async () => {
    const ctx = await setUp();
    const clock = { now: 0 };
    const server = new FakeTemplateServer();
    const service = create(ctx, server, clock);
    server.publish({ sequence: 5, entries: [tpl('venue', { version: 3 })] });
    await service.refresh();

    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.publish({ sequence: 4, entries: [tpl('venue', { version: 1 })] });
    const rolledBack = await service.refresh();
    expect(rolledBack.status).toMatchObject({ state: 'rejected', sequence: 5 });
    expect(rolledBack.templates[0]!.entry.version).toBe(3);

    // Same sequence again: unchanged, nothing written.
    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.publish({ sequence: 5, entries: [tpl('venue', { version: 3 })] });
    expect((await service.refresh()).status.state).toBe('loaded');
  });

  it('refuses a list larger than the cap (declared or streamed)', async () => {
    const ctx = await setUp();
    const clock = { now: 0 };
    const server = new FakeTemplateServer();
    const service = create(ctx, server, clock);
    server.publish({ sequence: 1, entries: [tpl('venue')] });
    server.headers.set(LIST_FILE, { 'content-length': String(LIST_MAX_BYTES + 1) });
    expect((await service.refresh()).status.state).toBe('rejected');

    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.headers.clear();
    server.publish({ sequence: 1, entries: [], raw: Buffer.alloc(LIST_MAX_BYTES + 1, 32) });
    expect((await service.refresh()).status.state).toBe('rejected');
  });

  it('offline: nothing saved stays builtin; a saved copy stays in use as offline', async () => {
    const ctx = await setUp();
    const clock = { now: 0 };
    const server = new FakeTemplateServer();
    const service = create(ctx, server, clock);
    server.offline = true;
    expect((await service.refresh()).status.state).toBe('builtin');

    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.offline = false;
    server.publish({ sequence: 2, entries: [tpl('venue')] });
    await service.refresh();

    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.offline = true;
    const offline = await service.refresh();
    expect(offline.status.state).toBe('offline');
    expect(offline.templates).toHaveLength(1);

    // A 404 counts as unreachable too.
    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.offline = false;
    server.files.clear();
    expect((await service.refresh()).status.state).toBe('offline');
  });

  it('reloads the saved copy at start and ignores a saved copy that fails its checks', async () => {
    const ctx = await setUp();
    const server = new FakeTemplateServer();
    server.publish({ sequence: 7, entries: [tpl('venue')] });
    await create(ctx, server).refresh();

    const offline = new FakeTemplateServer();
    offline.offline = true;
    const restarted = create(ctx, offline);
    expect(restarted.catalog()).toMatchObject({ status: { state: 'loaded', sequence: 7 } });
    expect(restarted.catalog().templates).toHaveLength(1);

    const file = join(ctx.config.dataDir, 'templates', LIST_FILE);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Venue venue', 'Hacked venue'));
    const tampered = create(ctx, offline);
    expect(tampered.catalog()).toMatchObject({ status: { state: 'builtin' }, templates: [] });
  });

  it('downloads at most once per interval and shares one download between callers', async () => {
    const ctx = await setUp();
    const clock = { now: 0 };
    const server = new FakeTemplateServer();
    server.publish({ sequence: 1, entries: [tpl('venue')] });
    const service = create(ctx, server, clock);
    await Promise.all([service.refresh(), service.refresh()]);
    await service.refresh();
    expect(server.calls).toHaveLength(2);
    clock.now += REFRESH_MIN_INTERVAL_MS;
    await service.refresh();
    expect(server.calls).toHaveLength(4);
  });

  it('names the recommended connectors the connector list knows', async () => {
    const ctx = await setUp();
    const server = new FakeTemplateServer();
    server.publish({
      sequence: 1,
      entries: [tpl('venue', { recommendedConnectors: ['google-sheets', 'unknown-thing'] })],
    });
    const [venue] = (await create(ctx, server).refresh()).templates;
    expect(venue!.connectors).toEqual([{ id: 'google-sheets', name: 'Google Sheets' }]);
  });

  it('logs counts and reasons only, never template texts or ids', async () => {
    const base = await setUp();
    const { ctx, lines } = recording(base);
    const clock = { now: 0 };
    const server = new FakeTemplateServer();
    server.publish({ sequence: 1, entries: [tpl('secretvenue'), tpl('bad', { version: 0 })] });
    const service = create(ctx, server, clock);
    await service.refresh();
    clock.now += REFRESH_MIN_INTERVAL_MS;
    server.publish({ sequence: 2, entries: [], noContext: true });
    await service.refresh();
    const text = JSON.stringify(lines);
    expect(lines.map((l) => l.msg)).toEqual(['template list loaded', 'template list rejected']);
    expect(lines[0]!.obj).toMatchObject({ sequence: 1, entries: 1, skipped: 1 });
    expect(lines[1]!.obj).toMatchObject({ reason: 'signature' });
    expect(text).not.toContain('secretvenue');
    expect(text).not.toContain('BUSINESS');
  });
});

describe('template list source', () => {
  it('a real install uses dl.ezychat.ai and only the built-in keys', async () => {
    const ctx = await setUp();
    vi.stubEnv(LIST_URL_ENV, 'http://127.0.0.1:9/');
    vi.stubEnv(TEST_KEY_ENV, stranger.publicKey);
    const real = { ...ctx, config: { ...ctx.config, fakeWa: false, mode: 'standalone' } };
    const source = templateListSource(real as AppContext);
    expect(source.baseUrl).toBe(TEMPLATE_LIST_BASE_URL);
    expect(source.keys).not.toContain(stranger.publicKey);
    // Fake WhatsApp outside dev mode never downloads and ignores the switches.
    const fake = { ...ctx, config: { ...ctx.config, fakeWa: true, mode: 'standalone' } };
    expect(templateListSource(fake as AppContext)).toMatchObject({ baseUrl: null });
    expect(templateListSource(fake as AppContext).keys).not.toContain(stranger.publicKey);
  });

  it('dev with fake WhatsApp reads the URL and the test key from the environment', async () => {
    const ctx = await setUp();
    const dev = { ...ctx, config: { ...ctx.config, fakeWa: true, mode: 'dev' } } as AppContext;
    expect(templateListSource(dev, { env: {} })).toMatchObject({ baseUrl: null });
    const source = templateListSource(dev, {
      env: { [LIST_URL_ENV]: 'http://127.0.0.1:7600/', [TEST_KEY_ENV]: stranger.publicKey },
    });
    expect(source.baseUrl).toBe('http://127.0.0.1:7600/');
    expect(source.keys).toContain(stranger.publicKey);
  });
});

describe('template list routes', () => {
  async function app() {
    const server = new FakeTemplateServer();
    server.publish({ sequence: 4, entries: [tpl('venue')] });
    t = await makeTestApp({
      config: { version: '0.1.75' },
      beforeBuild: (ctx) => {
        ctx.services.templateList!.shutdown();
        ctx.services.templateList = createTemplateListService(ctx, {
          fetch: server.fetch,
          keys: [main.publicKey],
          baseUrl: BASE,
        });
      },
    });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const agent = await createUserAndLogin(t, { role: 'agent' });
    return { admin: admin.cookie, agent: agent.cookie, server };
  }

  it('GET and refresh are admin only and answer the catalog', async () => {
    const { admin, agent } = await app();
    for (const cookie of [agent]) {
      const get = await t.app.inject({
        method: 'GET',
        url: '/api/ai/templates',
        headers: { cookie },
      });
      expect(get.statusCode).toBe(403);
      const post = await t.app.inject({
        method: 'POST',
        url: '/api/ai/templates/refresh',
        headers: authHeaders(cookie),
        payload: {},
      });
      expect(post.statusCode).toBe(403);
    }
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/ai/templates' });
    expect(anonymous.statusCode).toBe(401);

    const refreshed = await t.app.inject({
      method: 'POST',
      url: '/api/ai/templates/refresh',
      headers: authHeaders(admin),
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const body = AgentTemplateCatalog.parse(refreshed.json());
    expect(body.templates.map((c) => c.entry.id)).toEqual(['venue']);
    const get = await t.app.inject({
      method: 'GET',
      url: '/api/ai/templates',
      headers: { cookie: admin },
    });
    expect(AgentTemplateCatalog.parse(get.json()).status.sequence).toBe(4);
  });

  it('allows 10 refreshes a minute per admin', async () => {
    const { admin } = await app();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/ai/templates/refresh',
        headers: authHeaders(admin),
        payload: {},
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('answers within the wait limit even when the download hangs', async () => {
    let calls = 0;
    t = await makeTestApp({
      beforeBuild: (ctx) => {
        ctx.services.templateList!.shutdown();
        ctx.services.templateList = createTemplateListService(ctx, {
          fetch: (() => {
            calls++;
            return new Promise<Response>(() => {});
          }) as typeof fetch,
          keys: [main.publicKey],
          baseUrl: BASE,
        });
      },
    });
    const { cookie } = await createUserAndLogin(t, { role: 'admin' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = t.app.inject({
        method: 'POST',
        url: '/api/ai/templates/refresh',
        headers: authHeaders(cookie),
        payload: {},
      });
      await vi.waitFor(() => expect(calls).toBe(2));
      await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json().status.state).toBe('builtin');
    } finally {
      vi.useRealTimers();
    }
  });
});

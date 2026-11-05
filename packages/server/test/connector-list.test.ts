import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorEntry, ConnectorGallery, connectorFit } from '@ezychat/shared';
import type { AppContext } from '../src/context.js';
import { BUILTIN_CONNECTOR_LIST } from '../src/connectors/list/builtin-list.js';
import { CONNECTOR_LIST_BASE_URL } from '../src/connectors/list/keys.js';
import {
  createConnectorListService,
  LIST_MAX_BYTES,
  LIST_URL_ENV,
  listSource,
  REFRESH_MIN_INTERVAL_MS,
  TEST_KEY_ENV,
  type ConnectorListOptions,
  type ConnectorListServiceImpl,
} from '../src/connectors/list/service.js';
import type { ConnectorConnectionsPort } from '../src/connectors/list/types.js';
import {
  BASE,
  entry,
  FakeListServer,
  iconRef,
  keyPair,
  PNG,
  SVG,
} from './connector-list-fixtures.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
const services: ConnectorListServiceImpl[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) s.shutdown();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await t?.close();
});

const main = keyPair();
const next = keyPair();
const stranger = keyPair();

async function setUp(config: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp({ ...config, config: { version: '0.1.62', ...config.config } });
  return t.ctx;
}

function create(
  ctx: AppContext,
  server: FakeListServer,
  clock: { now: number },
  options: ConnectorListOptions = {},
) {
  const service = createConnectorListService(ctx, {
    fetch: server.fetch,
    now: () => clock.now,
    keys: [main.publicKey, next.publicKey],
    baseUrl: BASE,
    ...options,
  });
  services.push(service);
  return service;
}

const listDir = (ctx: AppContext) => join(ctx.config.dataDir, 'connectors');
const ids = (s: ConnectorListServiceImpl) => s.gallery().connectors.map((c) => c.entry.id);

describe('connector list', () => {
  it('starts on the built-in list when nothing was saved', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    const s = create(ctx, server, { now: 1000 }, { baseUrl: null });
    expect(s.status()).toEqual({
      state: 'builtin',
      generatedAt: null,
      sequence: null,
      checkedAt: null,
      appVersion: '0.1.62',
      hidden: 0,
    });
    await s.refresh();
    expect(server.calls).toEqual([]);
    expect(ConnectorGallery.parse(s.gallery()).connectors).toHaveLength(16);
    expect(s.entry('google-calendar')?.kind).toBe('builtin');
    expect(s.entry('hitpay')?.kind).toBe('coming_soon');
    expect(s.entry('custom-mcp')).toBeNull();
    expect(s.icon('google-calendar.svg')).toBeNull();
  });

  it('ships every entry of today’s gallery in three languages, valid and without icons', () => {
    const entries = BUILTIN_CONNECTOR_LIST.entries.map((e) => ConnectorEntry.parse(e));
    expect(entries.map((e) => e.id)).toEqual([
      'google-calendar',
      'google-sheets',
      'google-drive',
      'hitpay',
      'shopify',
      'autocount',
      'sql-account',
      'bukku',
      'xero',
      'zoho-books',
      'zoho-crm',
      'hubspot',
      'woocommerce',
      'easystore',
      'storehub',
      'billplz',
    ]);
    for (const e of entries) {
      expect(e.icon).toBeUndefined();
      // Shipped inside the app, so it fits every version (also the unit-test and dev versions).
      expect(e.minAppVersion).toBe('0.0.0');
      expect(connectorFit(e, { version: '0.0.0-test', edition: 'lite' })).not.toBe('needsUpdate');
      for (const texts of [e.summary, e.description, e.privacy!])
        expect(Object.keys(texts).sort()).toEqual(['en', 'ms', 'zh-CN']);
      expect(JSON.stringify(e)).not.toContain('{{');
      if (e.kind === 'coming_soon') expect(e.vote?.en).toContain(e.name);
    }
    expect(entries[0]).toMatchObject({ kind: 'builtin', builtinId: 'google-calendar' });
    // Beta while Google reviews the sign-in app: the badge and notice come from the list.
    expect(entries[0]).toMatchObject({ stage: 'beta' });
    expect(Object.keys(entries[0]!.notice!).sort()).toEqual(['en', 'ms', 'zh-CN']);
    expect(entries[1]).toMatchObject({ kind: 'builtin', builtinId: 'google-sheets' });
    expect(entries.filter((e) => e.stage === 'beta').map((e) => e.id)).toEqual([
      'google-calendar',
      'google-sheets',
      'google-drive',
    ]);
  });

  it('downloads, checks and saves a good list with its icons', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    const svg = SVG();
    server.publish({
      sequence: 5,
      key: main.privateKey,
      entries: [
        entry('alpha', { icon: iconRef('alpha.svg', svg) }),
        entry('beta', { icon: iconRef('beta.png', PNG) }),
      ],
      icons: { 'alpha.svg': svg, 'beta.png': PNG },
    });
    const clock = { now: 50_000 };
    const s = create(ctx, server, clock);
    const gallery = await s.refresh();
    expect(gallery.status).toMatchObject({
      state: 'loaded',
      sequence: 5,
      generatedAt: '2026-10-27T10:00:00.000Z',
      checkedAt: 50_000,
      hidden: 0,
    });
    expect(gallery.connectors.map((c) => [c.entry.id, c.fit, c.delisted, c.connection])).toEqual([
      ['alpha', 'ok', false, null],
      ['beta', 'ok', false, null],
    ]);
    expect(server.calls).toContain(`${BASE}list-v1.json`);
    expect(server.calls).toContain(`${BASE}list-v1.json.sig`);
    expect(readFileSync(join(listDir(ctx), 'list-v1.json'))).toEqual(
      server.files.get('list-v1.json'),
    );
    expect(readdirSync(join(listDir(ctx), 'icons')).sort()).toEqual(['alpha.svg', 'beta.png']);
    expect(s.icon('alpha.svg')).toEqual({ bytes: svg, contentType: 'image/svg+xml' });
    expect(s.icon('beta.png')?.contentType).toBe('image/png');
    expect(s.icon('gamma.svg')).toBeNull();
    expect(s.entry('alpha')?.name).toBe('Name alpha');
    // The built-in list is gone: any downloaded list replaces it.
    expect(s.entry('google-calendar')).toBeNull();
  });

  it('accepts a list signed with the next key', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({ sequence: 1, key: next.privateKey, entries: [entry('alpha')] });
    const s = create(ctx, server, { now: 1 });
    expect((await s.refresh()).status.state).toBe('loaded');
  });

  it('rejects a bad signature and keeps the last good copy', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({ sequence: 1, key: main.privateKey, entries: [entry('alpha')] });
    const clock = { now: 0 };
    const s = create(ctx, server, clock);
    await s.refresh();
    const saved = readFileSync(join(listDir(ctx), 'list-v1.json'));

    server.publish({ sequence: 2, key: stranger.privateKey, entries: [entry('evil')] });
    clock.now += REFRESH_MIN_INTERVAL_MS;
    const gallery = await s.refresh();
    expect(gallery.status).toMatchObject({ state: 'rejected', sequence: 1 });
    expect(ids(s)).toEqual(['alpha']);
    expect(readFileSync(join(listDir(ctx), 'list-v1.json'))).toEqual(saved);

    // A signature that is not even base64 of the right length.
    server.files.set('list-v1.json.sig', Buffer.from('not a signature'));
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status.state).toBe('rejected');
  });

  it('rejects a lower sequence; the same sequence is unchanged', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    const svg = SVG();
    server.publish({
      sequence: 10,
      key: main.privateKey,
      entries: [entry('alpha', { icon: iconRef('alpha.svg', svg) })],
      icons: { 'alpha.svg': svg },
    });
    const clock = { now: 0 };
    const s = create(ctx, server, clock);
    await s.refresh();
    expect(server.iconCalls()).toBe(1);

    server.publish({ sequence: 9, key: main.privateKey, entries: [entry('old')] });
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status).toMatchObject({ state: 'rejected', sequence: 10 });

    server.publish({
      sequence: 10,
      key: main.privateKey,
      entries: [entry('alpha', { icon: iconRef('alpha.svg', svg) })],
    });
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status).toMatchObject({ state: 'loaded', sequence: 10 });
    expect(server.iconCalls()).toBe(1);
  });

  it('rejects an unknown list format or broken JSON', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({ sequence: 3, key: main.privateKey, entries: [], format: 2 });
    const clock = { now: 0 };
    const s = create(ctx, server, clock);
    expect((await s.refresh()).status.state).toBe('rejected');
    server.publish({ sequence: 3, key: main.privateKey, entries: [], raw: Buffer.from('{oops') });
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status).toMatchObject({ state: 'rejected', sequence: null });
    // Still the built-in list.
    expect(s.entry('google-calendar')).not.toBeNull();
  });

  it('hides newer schema versions, skips bad or repeated entries and keeps the rest', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({
      sequence: 4,
      key: main.privateKey,
      entries: [
        entry('alpha'),
        { ...entry('future'), schemaVersion: 2, whatever: { new: true } },
        entry('broken', { kind: 'mcp' }), // mcp without mcp/auth/tools
        entry('Bad Id'),
        'not an object',
        entry('alpha', { name: 'Second alpha' }),
        entry('beta'),
      ],
    });
    const s = create(ctx, server, { now: 0 });
    const gallery = await s.refresh();
    expect(gallery.status).toMatchObject({ state: 'loaded', hidden: 1 });
    expect(ids(s)).toEqual(['alpha', 'beta']);
    expect(s.entry('alpha')?.name).toBe('Name alpha');
    expect(s.entry('future')).toBeNull();
  });

  it('shows entries that need a newer app or Enterprise, but entry() gives only usable ones', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({
      sequence: 4,
      key: main.privateKey,
      entries: [
        entry('newer', { minAppVersion: '0.2.0' }),
        entry('ent', { editions: ['enterprise'] }),
        entry('both'),
      ],
    });
    const s = create(ctx, server, { now: 0 });
    const gallery = await s.refresh();
    expect(gallery.connectors.map((c) => [c.entry.id, c.fit])).toEqual([
      ['newer', 'needsUpdate'],
      ['ent', 'enterprise'],
      ['both', 'ok'],
    ]);
    expect(s.entry('newer')).toBeNull();
    expect(s.entry('ent')).toBeNull();
    expect(s.entry('both')).not.toBeNull();

    ctx.edition = 'enterprise';
    expect(s.entry('ent')?.id).toBe('ent');
    expect(s.gallery().connectors.find((c) => c.entry.id === 'ent')?.fit).toBe('ok');
  });

  it.each([
    ['a changed hash', (svg: Buffer) => ({ file: SVG('red'), ref: iconRef('alpha.svg', svg) })],
    [
      'a script in the SVG',
      () => {
        const bad = Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
        );
        return { file: bad, ref: iconRef('alpha.svg', bad) };
      },
    ],
    [
      'an event handler',
      () => {
        const bad = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>');
        return { file: bad, ref: iconRef('alpha.svg', bad) };
      },
    ],
    [
      'a javascript: link',
      () => {
        const bad = Buffer.from('<svg><a href="javascript:x()"><path d="M1 1"/></a></svg>');
        return { file: bad, ref: iconRef('alpha.svg', bad) };
      },
    ],
    ['a PNG named .svg', () => ({ file: PNG, ref: iconRef('alpha.svg', PNG) })],
    [
      'an icon larger than declared',
      (svg: Buffer) => ({ file: Buffer.concat([svg, svg]), ref: iconRef('alpha.svg', svg) }),
    ],
  ])('rejects the whole list for %s', async (_name, make) => {
    const ctx = await setUp();
    const server = new FakeListServer();
    const { file, ref } = make(SVG());
    server.publish({
      sequence: 2,
      key: main.privateKey,
      entries: [entry('alpha', { icon: ref }), entry('beta')],
      icons: { 'alpha.svg': file },
    });
    const s = create(ctx, server, { now: 0 });
    expect((await s.refresh()).status).toMatchObject({ state: 'rejected', sequence: null });
    expect(existsSync(join(listDir(ctx), 'list-v1.json'))).toBe(false);
    expect(s.entry('beta')).toBeNull();
  });

  it('rejects two entries naming one icon file with different hashes', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    const svg = SVG();
    server.publish({
      sequence: 2,
      key: main.privateKey,
      entries: [
        entry('alpha', { icon: iconRef('shared.svg', svg) }),
        entry('beta', { icon: iconRef('shared.svg', SVG('red')) }),
      ],
      icons: { 'shared.svg': svg },
    });
    const s = create(ctx, server, { now: 0 });
    expect((await s.refresh()).status.state).toBe('rejected');
  });

  it('rejects a list or signature above the size caps', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({ sequence: 2, key: main.privateKey, entries: [entry('alpha')] });
    server.headers.set('list-v1.json', { 'content-length': String(LIST_MAX_BYTES + 1) });
    const clock = { now: 0 };
    const s = create(ctx, server, clock);
    expect((await s.refresh()).status.state).toBe('rejected');

    server.headers.clear();
    server.files.set('list-v1.json.sig', Buffer.alloc(2000, 'A'));
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status.state).toBe('rejected');
  });

  it('keeps the last copy when offline or the server fails', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.offline = true;
    const clock = { now: 0 };
    const s = create(ctx, server, clock);
    // Nothing saved yet: still the built-in list.
    expect((await s.refresh()).status).toMatchObject({ state: 'builtin', checkedAt: 0 });

    server.offline = false;
    server.publish({ sequence: 1, key: main.privateKey, entries: [entry('alpha')] });
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status.state).toBe('loaded');

    server.offline = true;
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status).toMatchObject({
      state: 'offline',
      sequence: 1,
      checkedAt: clock.now,
    });
    expect(ids(s)).toEqual(['alpha']);

    server.offline = false;
    server.status = 503;
    clock.now += REFRESH_MIN_INTERVAL_MS;
    expect((await s.refresh()).status.state).toBe('offline');
  });

  it('a missing icon on the server counts as offline', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({
      sequence: 1,
      key: main.privateKey,
      entries: [entry('alpha', { icon: iconRef('alpha.svg', SVG()) })],
    });
    const s = create(ctx, server, { now: 0 });
    expect((await s.refresh()).status.state).toBe('builtin');
  });

  it('reloads the saved copy after a restart and re-checks it', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    const svg = SVG();
    server.publish({
      sequence: 7,
      key: main.privateKey,
      entries: [entry('alpha', { icon: iconRef('alpha.svg', svg) })],
      icons: { 'alpha.svg': svg },
    });
    await create(ctx, server, { now: 0 }).refresh();

    const restarted = create(ctx, new FakeListServer(), { now: 0 }, { baseUrl: null });
    expect(restarted.status()).toMatchObject({ state: 'loaded', sequence: 7, checkedAt: null });
    expect(ids(restarted)).toEqual(['alpha']);
    expect(restarted.icon('alpha.svg')?.bytes).toEqual(svg);

    // A changed icon file on disk is not served.
    writeFileSync(join(listDir(ctx), 'icons', 'alpha.svg'), SVG('red'));
    expect(restarted.icon('alpha.svg')).toBeNull();

    // A saved list changed on disk fails its signature: the built-in list again.
    const path = join(listDir(ctx), 'list-v1.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('Name alpha', 'Name evil'));
    const tampered = create(ctx, new FakeListServer(), { now: 0 }, { baseUrl: null });
    expect(tampered.status().state).toBe('builtin');
    expect(tampered.entry('google-calendar')).not.toBeNull();
  });

  it('downloads icons only when new or changed and deletes icons no longer named', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    const a = SVG();
    const b = SVG('blue');
    server.publish({
      sequence: 1,
      key: main.privateKey,
      entries: [
        entry('alpha', { icon: iconRef('alpha.svg', a) }),
        entry('beta', { icon: iconRef('beta.svg', b) }),
      ],
      icons: { 'alpha.svg': a, 'beta.svg': b },
    });
    const clock = { now: 0 };
    const s = create(ctx, server, clock);
    await s.refresh();
    expect(server.iconCalls()).toBe(2);

    const a2 = SVG('green');
    server.publish({
      sequence: 2,
      key: main.privateKey,
      entries: [entry('alpha', { icon: iconRef('alpha.svg', a2) })],
      icons: { 'alpha.svg': a2 },
    });
    clock.now += REFRESH_MIN_INTERVAL_MS;
    await s.refresh();
    expect(server.iconCalls()).toBe(3);
    expect(readdirSync(join(listDir(ctx), 'icons'))).toEqual(['alpha.svg']);
    expect(s.icon('alpha.svg')?.bytes).toEqual(a2);
    expect(s.icon('beta.svg')).toBeNull();

    // Same sequence but the icon file went missing: downloaded again.
    const restarted = create(ctx, server, { now: 0 });
    expect(restarted.icon('alpha.svg')).not.toBeNull();
    writeFileSync(join(listDir(ctx), 'icons', 'alpha.svg'), 'gone');
    const again = create(ctx, server, { now: 0 });
    await again.refresh();
    expect(server.iconCalls()).toBe(4);
    expect(again.icon('alpha.svg')?.bytes).toEqual(a2);
  });

  it('downloads at most once per 30 s and shares a running download', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({ sequence: 1, key: main.privateKey, entries: [entry('alpha')] });
    const clock = { now: 0 };
    const s = create(ctx, server, clock);
    server.hold();
    const first = s.refresh();
    const second = s.refresh();
    server.release();
    await Promise.all([first, second]);
    expect(server.calls.length).toBe(2);

    clock.now += REFRESH_MIN_INTERVAL_MS - 1;
    expect((await s.refresh()).status.state).toBe('loaded');
    expect(server.calls.length).toBe(2);

    clock.now += 1;
    await s.refresh();
    expect(server.calls.length).toBe(4);
  });

  it('stops quietly on shutdown during a download', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({ sequence: 1, key: main.privateKey, entries: [entry('alpha')] });
    const s = create(ctx, server, { now: 0 });
    server.hold();
    const pending = s.refresh();
    s.shutdown();
    server.release();
    await pending;
    expect(s.status().state).toBe('builtin');
    expect(existsSync(join(listDir(ctx), 'list-v1.json'))).toBe(false);
    await s.refresh();
    expect(server.calls.length).toBe(2);
  });

  it('keeps a connected connector that left the list, flagged delisted', async () => {
    const ctx = await setUp();
    const server = new FakeListServer();
    server.publish({
      sequence: 1,
      key: main.privateKey,
      entries: [entry('alpha'), { ...entry('later'), schemaVersion: 3 }],
    });
    const view = {
      state: 'connected' as const,
      account: null,
      keyEnd: 'x1y2',
      connectedAt: 5,
      fields: {},
    };
    const port: ConnectorConnectionsPort = {
      view: (id) => (id === 'gone' || id === 'alpha' || id === 'later' ? view : null),
      saved: () => [
        { id: 'alpha', entry: ConnectorEntry.parse(entry('alpha', { name: 'Old alpha' })) },
        { id: 'gone', entry: ConnectorEntry.parse(entry('gone')) },
        { id: 'later', entry: ConnectorEntry.parse(entry('later')) },
      ],
    };
    ctx.services.connectorConnections = port;
    const s = create(ctx, server, { now: 0 });
    const gallery = ConnectorGallery.parse(await s.refresh());
    expect(
      gallery.connectors.map((c) => [c.entry.id, c.entry.name, c.delisted, !!c.connection]),
    ).toEqual([
      ['alpha', 'Name alpha', false, true],
      ['gone', 'Name gone', true, true],
      ['later', 'Name later', true, true],
    ]);
    // entry() is the list only: a delisted connector has no current entry.
    expect(s.entry('gone')).toBeNull();
  });
});

describe('connector list source', () => {
  it('a real install uses dl.ezychat.ai and the built-in keys, never the dev switches', async () => {
    // A copy of the context (makeTestApp itself always runs dev + fake WhatsApp, so its own start
    // never goes to the internet).
    const base = await setUp();
    const ctx = { ...base, config: { ...base.config, fakeWa: false, mode: 'standalone' as const } };
    const env = { [LIST_URL_ENV]: 'http://127.0.0.1:1/', [TEST_KEY_ENV]: next.publicKey };
    const source = listSource(ctx, { env });
    expect(source.baseUrl).toBe(CONNECTOR_LIST_BASE_URL);
    expect(source.keys).not.toContain(next.publicKey);
    expect(source.keys.length).toBe(2);

    const server = new FakeListServer();
    const s = createConnectorListService(ctx, { fetch: server.fetch, env, now: () => 0 });
    services.push(s);
    await s.refresh();
    expect(server.calls.sort()).toEqual([
      `${CONNECTOR_LIST_BASE_URL}list-v1.json`,
      `${CONNECTOR_LIST_BASE_URL}list-v1.json.sig`,
    ]);
  });

  it('fake WhatsApp outside dev mode never downloads nor reads the switches', async () => {
    const base = await setUp();
    const ctx = { ...base, config: { ...base.config, mode: 'standalone' as const } };
    const env = { [LIST_URL_ENV]: 'http://127.0.0.1:1/', [TEST_KEY_ENV]: next.publicKey };
    expect(listSource(ctx, { env })).toEqual({ baseUrl: null, keys: expect.any(Array) });
    expect(listSource(ctx, { env }).keys).not.toContain(next.publicKey);
  });

  it('dev mode with fake WhatsApp reads the switches; without a URL it never downloads', async () => {
    const ctx = await setUp();
    expect(listSource(ctx, { env: {} }).baseUrl).toBeNull();
    const source = listSource(ctx, {
      env: { [LIST_URL_ENV]: ' http://127.0.0.1:7000/c ', [TEST_KEY_ENV]: stranger.publicKey },
    });
    expect(source.baseUrl).toBe('http://127.0.0.1:7000/c');
    expect(source.keys).toContain(stranger.publicKey);
  });

  it('the server start downloads once from the dev list server with the test key', async () => {
    const server = new FakeListServer();
    server.publish({ sequence: 9, key: stranger.privateKey, entries: [entry('local-test')] });
    vi.stubEnv(LIST_URL_ENV, BASE.slice(0, -1));
    vi.stubEnv(TEST_KEY_ENV, stranger.publicKey);
    vi.stubGlobal('fetch', server.fetch);
    const ctx = await setUp();
    await vi.waitFor(() => expect(ctx.services.connectorList!.status().state).toBe('loaded'));
    expect(ctx.services.connectorList!.entry('local-test')).not.toBeNull();
    expect(server.calls.length).toBe(2);
  });
});

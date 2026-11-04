import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
import { makeTestApp } from '../../test/helpers.js';
import { createUserAndLogin } from '../../test/auth-helpers.js';
import { CSP } from './security-headers.js';
import { staticCacheControl } from './cache.js';

const JS = 'export const label = "WA Team Inbox";\n'.repeat(200);
const CSS = '.message { color: var(--foreground); padding: 12px; }\n'.repeat(200);
const HTML = '<!doctype html><html><body>WA Team Inbox</body></html>'.repeat(30);
const GZIP = gzipSync(JS);
const BROTLI = brotliCompressSync(JS);
let dir: string;
let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const JID = '60100000000@s.whatsapp.net';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wati-web-cache-'));
  mkdirSync(join(dir, 'assets'));
  for (const [file, body] of [
    ['assets/index-Abc123_4.js', JS],
    ['assets/index-Abc123_4.css', CSS],
    ['assets/latest.js', JS],
    ['index.html', HTML],
    ['sw.js', JS],
    ['manifest.webmanifest', '{"name":"WA Team Inbox"}'],
    ['icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ] as const) {
    writeFileSync(join(dir, file), body);
    writeFileSync(join(dir, `${file}.gz`), gzipSync(body));
    writeFileSync(join(dir, `${file}.br`), brotliCompressSync(body));
  }
  // An already-compressed binary without sidecars must retain its ordinary bytes.
  writeFileSync(join(dir, 'icon.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  t = await makeTestApp({ config: { webDistDir: dir } });
  ({ cookie } = await createUserAndLogin(t));
  t.ctx.services.chats!.upsertFromWa({
    jid: JID,
    type: 'dm',
    name: 'Sensitive customer name '.repeat(100),
  });
});

afterAll(async () => {
  await t?.close();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('static HTTP representations and cache policy', () => {
  it.each([
    ['assets/index-Abc123_4.js', true],
    ['assets/index-Abc123_4.css.br', true],
    ['assets\\font-Abc123_4.woff2.gz', true],
    ['assets/latest.js', false],
    ['assets/nested/latest.js', false],
    ['assets/index-short.js', false],
    ['assets/index-Abc123_4.js.map', false],
    ['index.html.gz', false],
    ['sw.js.br', false],
    ['manifest.webmanifest', false],
    ['../assets/index-Abc123_4.js', false],
  ])('sets immutable caching only for fingerprinted assets: %s', (file, immutable) => {
    expect(staticCacheControl(file)).toBe(
      immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
  });

  it('serves gzip with the original MIME, security headers and smaller transfer bytes', async () => {
    const response = await t.app.inject({
      url: '/assets/index-Abc123_4.js',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers.vary).toBe('accept-encoding');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['content-security-policy']).toBe(CSP);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.rawPayload.length).toBe(GZIP.length);
    expect(gunzipSync(response.rawPayload).toString()).toBe(JS);
    expect(response.rawPayload.length).toBeLessThan(Buffer.byteLength(JS));
  });

  it('negotiates Brotli or gzip according to client quality values', async () => {
    const br = await t.app.inject({
      url: '/assets/index-Abc123_4.js',
      headers: { 'accept-encoding': 'gzip, br' },
    });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.rawPayload.length).toBe(BROTLI.length);
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(JS);
    const gzip = await t.app.inject({
      url: '/assets/index-Abc123_4.js',
      headers: { 'accept-encoding': 'br;q=0, gzip;q=1' },
    });
    expect(gzip.headers['content-encoding']).toBe('gzip');
  });

  it.each([undefined, 'identity', 'gzip;q=0, br;q=0'])(
    'serves identity with Vary when Accept-Encoding is %s',
    async (encoding) => {
      const response = await t.app.inject({
        url: '/assets/index-Abc123_4.js',
        headers: encoding ? { 'accept-encoding': encoding } : {},
      });
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers.vary).toBe('accept-encoding');
      expect(response.body).toBe(JS);
    },
  );

  it('uses representation-specific ETags and preserves conditional 304 responses', async () => {
    const identity = await t.app.inject({ url: '/assets/index-Abc123_4.js' });
    const gzip = await t.app.inject({
      url: '/assets/index-Abc123_4.js',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(identity.headers.etag).toBeTruthy();
    expect(gzip.headers.etag).toBeTruthy();
    expect(gzip.headers.etag).not.toBe(identity.headers.etag);
    const cached = await t.app.inject({
      url: '/assets/index-Abc123_4.js',
      headers: { 'accept-encoding': 'gzip', 'if-none-match': String(gzip.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.rawPayload.length).toBe(0);
    expect(cached.headers.vary).toBe('accept-encoding');
    expect(cached.headers['cache-control']).toContain('immutable');
    const different = await t.app.inject({
      url: '/assets/index-Abc123_4.js',
      headers: { 'if-none-match': String(gzip.headers.etag) },
    });
    expect(different.statusCode).toBe(200);
    expect(different.body).toBe(JS);
  });

  it.each([
    '/index.html',
    '/',
    '/admin/settings',
    '/sw.js',
    '/manifest.webmanifest',
    '/icon.svg',
    '/assets/latest.js',
  ])('revalidates unversioned or entry content at %s even when compressed', async (url) => {
    const response = await t.app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.etag).toBeTruthy();
  });

  it('returns HEAD metadata without a body', async () => {
    const response = await t.app.inject({
      method: 'HEAD',
      url: '/assets/index-Abc123_4.js',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(Number(response.headers['content-length'])).toBe(GZIP.length);
    expect(response.rawPayload.length).toBe(0);
  });

  it('preserves byte-range semantics for both identity and encoded representations', async () => {
    for (const encoding of [undefined, 'gzip']) {
      const response = await t.app.inject({
        url: '/assets/index-Abc123_4.js',
        headers: { range: 'bytes=0-9', ...(encoding ? { 'accept-encoding': encoding } : {}) },
      });
      const bytes = encoding ? GZIP : Buffer.from(JS);
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe(`bytes 0-9/${bytes.length}`);
      expect(Number(response.headers['content-length'])).toBe(10);
      expect(response.rawPayload).toEqual(bytes.subarray(0, 10));
    }
  });

  it('falls back to original bytes when a supported encoded sibling does not exist', async () => {
    const response = await t.app.inject({
      url: '/icon.png',
      headers: { 'accept-encoding': 'gzip, br' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.rawPayload).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(response.headers.vary).toBe('accept-encoding');
  });

  it('does not expose compressed siblings as standalone file routes', async () => {
    const response = await t.app.inject({ url: '/assets/index-Abc123_4.js.gz' });
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body).toBe(HTML);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/api/health', '/api/chats', '/api/media/no-such-message', '/api/no-such-route'])(
    'never compresses or publicly caches API content at %s',
    async (url) => {
      const response = await t.app.inject({ url, headers: { 'accept-encoding': 'br, gzip' } });
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      if (url !== '/api/health')
        expect(response.statusCode).toBe(url === '/api/no-such-route' ? 404 : 401);
    },
  );

  it('keeps successful customer API responses uncompressed and noncacheable', async () => {
    const response = await t.app.inject({
      url: '/api/chats',
      headers: { cookie, 'accept-encoding': 'br, gzip' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Sensitive customer name');
    expect(response.rawPayload.length).toBeGreaterThan(1024);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('preserves authenticated profile-image private caching', async () => {
    const response = await t.app.inject({
      url: `/api/chats/${encodeURIComponent(JID)}/avatar`,
      headers: { cookie, 'accept-encoding': 'gzip' },
    });
    expect(response.statusCode).toBe(204);
    // a known "no photo" (the fake phone has none) is kept privately for a day
    expect(response.headers['cache-control']).toBe('private, max-age=86400');
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('retains Origin rejection and private error-cache policy', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'http://attacker.example', 'accept-encoding': 'gzip' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('continues to reject an untrusted Host before serving compressed assets', async () => {
    const response = await t.app.inject({
      url: '/assets/index-Abc123_4.js',
      headers: { host: 'attacker.example', 'accept-encoding': 'gzip' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});

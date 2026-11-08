import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activateLocale } from '@/i18n';
import { stubXhr } from '../test/fake-xhr';
import { ApiError, api, apiUpload, errorMessage } from './client';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api()', () => {
  it('throws ApiError with code and message from the JSON error body', async () => {
    mockFetch(409, { error: { code: 'conflict', message: 'Username taken' } });
    const err = await api('/users', { method: 'POST', body: { username: 'x' } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('conflict');
    expect((err as ApiError).message).toBe('Username taken');
  });

  it('prefixes /api, sends JSON and same-origin credentials', async () => {
    const fn = mockFetch(200, { ok: true });
    await api('/auth/login', { method: 'POST', body: { username: 'a', password: 'b' } });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ username: 'a', password: 'b' }));
  });

  it('validates the response with a schema when given', async () => {
    mockFetch(200, { needsSetup: true });
    const res = await api('/setup/status', { schema: z.object({ needsSetup: z.boolean() }) });
    expect(res.needsSetup).toBe(true);
  });

  it('dispatches wati:unauthorized on 401', async () => {
    mockFetch(401, { error: { code: 'unauthorized', message: 'Login required' } });
    const listener = vi.fn();
    window.addEventListener('wati:unauthorized', listener);
    await expect(api('/me')).rejects.toBeInstanceOf(ApiError);
    window.removeEventListener('wati:unauthorized', listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic error when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 502 })),
    );
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe('http_502');
  });

  it('returns undefined for 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

describe('errorMessage (translated)', () => {
  afterEach(async () => {
    await activateLocale('en');
  });

  it('translates known server messages and generic codes, keeps specific ones', async () => {
    await activateLocale('ms');
    expect(errorMessage(new ApiError(401, 'unauthorized', 'Invalid username or password'))).toBe(
      'Nama pengguna atau kata laluan tidak sah',
    );
    expect(errorMessage(new ApiError(0, 'network', 'Cannot reach the server.'))).toBe(
      'Tidak dapat menghubungi pelayan. Semak sambungan anda.',
    );
    expect(errorMessage(new ApiError(409, 'conflict', 'Shortcut "/hi" already exists'))).toBe(
      'Shortcut "/hi" already exists',
    );
    await activateLocale('en');
    expect(errorMessage(new ApiError(429, 'rate_limited', 'Too many attempts, retry in 5s'))).toBe(
      'Too many attempts. Try again in 5 s.',
    );
    expect(errorMessage(new ApiError(429, 'rate_limited', ''))).toBe(
      'Too many attempts. Please wait and try again.',
    );
  });
});

describe('apiUpload()', () => {
  it('reports progress, answers the JSON body, and throws ApiError like api()', async () => {
    const uploads = stubXhr(({ form }) =>
      form.get('fail')
        ? { status: 413, body: { error: { code: 'too_large_for_whatsapp', message: 'Too big' } } }
        : { status: 201, body: { id: 'M1' } },
    );
    const shares: number[] = [];
    const ok = new FormData();
    expect(await apiUpload('/chats/a/media', ok, (s) => shares.push(s))).toEqual({ id: 'M1' });
    expect(uploads[0]!.url).toBe('/api/chats/a/media');
    expect(shares).toEqual([0.5, 1]);
    const bad = new FormData();
    bad.append('fail', '1');
    const err = await apiUpload('/chats/a/media', bad, () => undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 413, code: 'too_large_for_whatsapp', message: 'Too big' });
  });

  it('a body that is not ours keeps its status; a network failure is "network"', async () => {
    stubXhr(() => ({ status: 413, body: '<html>Request Entity Too Large</html>' }));
    const html = await apiUpload('/x', new FormData(), () => undefined).catch((e: unknown) => e);
    expect(html).toMatchObject({ status: 413, code: 'http_413' });
    stubXhr(() => 'network-error');
    const down = await apiUpload('/x', new FormData(), () => undefined).catch((e: unknown) => e);
    expect(down).toMatchObject({ status: 0, code: 'network' });
  });
});

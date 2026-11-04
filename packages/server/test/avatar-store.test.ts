import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/db/migrate.js';
import type { DB } from '../src/db/index.js';
import { silentLogger } from '../src/logger.js';
import { createAvatarStore, safePhotoUrl, type AvatarStore } from '../src/avatars/store.js';

const URL1 = 'https://pps.whatsapp.net/v/t61/profile.jpg?oh=1';
const URL2 = 'https://pps.whatsapp.net/v/t61/profile-new.jpg?oh=2';
const jpeg = (fill: number, size = 64) => {
  const b = Buffer.alloc(size, fill);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
};
const shortHash = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const ok = (body: Buffer, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-type': 'image/jpeg', ...headers },
  });

let db: DB;
let dir: string;
let now: number;
let fetchMock: ReturnType<typeof vi.fn>;
let store: AvatarStore;

beforeEach(() => {
  db = new Database(':memory:') as DB;
  migrate(db);
  dir = mkdtempSync(join(tmpdir(), 'wati-avatars-'));
  now = 1_800_000_000_000;
  fetchMock = vi.fn();
  store = createAvatarStore({
    db,
    dir: join(dir, 'avatars'),
    log: silentLogger(),
    fetch: fetchMock as unknown as typeof fetch,
    now: () => now,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('avatar store', () => {
  it('downloads a photo once, stores the bytes under the data dir and hashes them', async () => {
    const body = jpeg(1);
    fetchMock.mockResolvedValue(ok(body));
    const lookup = vi.fn().mockResolvedValue(URL1);
    const r = await store.get('60111@s.whatsapp.net', lookup);
    expect(r).toEqual({ kind: 'photo', hash: shortHash(body), bytes: body });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      URL1,
      expect.objectContaining({ redirect: 'error' }),
    );
    // a file named after the key (never the key itself), inside the avatars folder only
    const files = readdirSync(join(dir, 'avatars'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.jpg$/);
    expect(store.hashes(['60111@s.whatsapp.net', 'other'])).toEqual(
      new Map([['60111@s.whatsapp.net', shortHash(body)]]),
    );

    // within 24 h: neither WhatsApp nor the CDN is asked again
    now += 24 * 3_600_000 - 1;
    expect(await store.get('60111@s.whatsapp.net', lookup)).toMatchObject({ kind: 'photo' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes after 24 h and picks up a changed photo', async () => {
    const first = jpeg(1);
    const second = jpeg(2);
    fetchMock.mockResolvedValueOnce(ok(first)).mockResolvedValueOnce(ok(second));
    const lookup = vi.fn().mockResolvedValueOnce(URL1).mockResolvedValueOnce(URL2);
    await store.get('k', lookup);
    now += 24 * 3_600_000;
    const r = await store.get('k', lookup);
    expect(r).toEqual({ kind: 'photo', hash: shortHash(second), bytes: second });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(readdirSync(join(dir, 'avatars'))).toHaveLength(1);
  });

  it('keeps the last good photo when a refresh fails (lookup or download)', async () => {
    const body = jpeg(1);
    fetchMock.mockResolvedValueOnce(ok(body));
    await store.get('k', vi.fn().mockResolvedValue(URL1));
    now += 25 * 3_600_000;
    const failedLookup = await store.get('k', vi.fn().mockRejectedValue(new Error('offline')));
    expect(failedLookup).toEqual({ kind: 'photo', hash: shortHash(body), bytes: body });
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const failedDownload = await store.get('k', vi.fn().mockResolvedValue(URL2));
    expect(failedDownload).toMatchObject({ kind: 'photo', hash: shortHash(body) });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await store.get('k', vi.fn().mockResolvedValue(URL2))).toMatchObject({
      kind: 'photo',
    });
    // a failure does not reset the age: the next request asks again
    fetchMock.mockResolvedValueOnce(ok(jpeg(3)));
    expect(await store.get('k', vi.fn().mockResolvedValue(URL2))).toMatchObject({
      hash: shortHash(jpeg(3)),
    });
  });

  it('answers failed (not "no photo") when the first lookup fails', async () => {
    expect(await store.get('k', vi.fn().mockRejectedValue(new Error('offline')))).toEqual({
      kind: 'failed',
    });
    expect(store.hashes(['k']).size).toBe(0);
    expect(await store.stored('k')).toEqual({ kind: 'failed' });
  });

  it('remembers "no photo" for 24 h and removes the old file', async () => {
    fetchMock.mockResolvedValueOnce(ok(jpeg(1)));
    const lookup = vi.fn().mockResolvedValueOnce(URL1).mockResolvedValue(null);
    await store.get('k', lookup);
    now += 24 * 3_600_000;
    expect(await store.get('k', lookup)).toEqual({ kind: 'none' });
    expect(readdirSync(join(dir, 'avatars'))).toHaveLength(0);
    expect(store.hashes(['k']).size).toBe(0);
    now += 1000;
    expect(await store.get('k', lookup)).toEqual({ kind: 'none' });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('refuses a photo above the size cap, by header or by streamed length', async () => {
    const big = jpeg(1, 1024 * 1024 + 1);
    fetchMock.mockResolvedValueOnce(ok(big, { 'content-length': String(big.length) }));
    expect(await store.get('a', vi.fn().mockResolvedValue(URL1))).toEqual({ kind: 'failed' });
    // no length header: the body is cut off at the cap while reading
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(big));
            c.close();
          },
        }),
        { status: 200 },
      ),
    );
    expect(await store.get('b', vi.fn().mockResolvedValue(URL1))).toEqual({ kind: 'failed' });
    expect(existsSync(join(dir, 'avatars')) ? readdirSync(join(dir, 'avatars')) : []).toEqual([]);
  });

  it('refuses bytes that are not a JPEG image', async () => {
    fetchMock.mockResolvedValueOnce(ok(Buffer.from('<html>nope</html>')));
    expect(await store.get('k', vi.fn().mockResolvedValue(URL1))).toEqual({ kind: 'failed' });
  });

  it('never downloads from a host that is not WhatsApp, and treats it as no photo', async () => {
    for (const url of [
      'http://pps.whatsapp.net/profile.jpg',
      'https://example.com/profile.jpg',
      'https://whatsapp.net.evil.example/profile.jpg',
      'https://evilwhatsapp.net/profile.jpg',
      'https://pps.whatsapp.net@evil.example/profile.jpg',
      'https://user:secret@pps.whatsapp.net/profile.jpg',
      'https://pps.whatsapp.net:8443/profile.jpg',
      'https://127.0.0.1/profile.jpg',
      'data:image/png;base64,AAAA',
      '/relative-photo.jpg',
      'not a URL',
    ]) {
      expect(safePhotoUrl(url), url).toBeNull();
      expect(await store.get(`k${url}`, vi.fn().mockResolvedValue(url)), url).toEqual({
        kind: 'none',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(safePhotoUrl(URL1)).toBe(URL1);
  });

  it('coalesces concurrent requests for one key into one lookup and one download', async () => {
    let finish!: (url: string) => void;
    const lookup = vi.fn().mockReturnValue(new Promise<string>((r) => (finish = r)));
    fetchMock.mockResolvedValue(ok(jpeg(1)));
    const a = store.get('k', lookup);
    const b = store.get('k', lookup);
    finish(URL1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ kind: 'photo' });
    expect(rb).toEqual(ra);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds refreshes in flight: beyond the limit it serves what it has, or failed', async () => {
    const small = createAvatarStore({
      db,
      dir: join(dir, 'avatars'),
      log: silentLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
      maxInFlight: 1,
    });
    let finish!: (url: string | null) => void;
    const slow = vi.fn().mockReturnValue(new Promise<string | null>((r) => (finish = r)));
    const first = small.get('a', slow);
    const other = vi.fn().mockResolvedValue(URL1);
    expect(await small.get('b', other)).toEqual({ kind: 'failed' });
    expect(other).not.toHaveBeenCalled();
    finish(null);
    expect(await first).toEqual({ kind: 'none' });
    fetchMock.mockResolvedValueOnce(ok(jpeg(1)));
    expect(await small.get('b', other)).toMatchObject({ kind: 'photo' });
  });

  it('stored() serves the kept photo without asking anyone, and drop() forgets a key', async () => {
    const body = jpeg(1);
    fetchMock.mockResolvedValueOnce(ok(body));
    await store.get('k', vi.fn().mockResolvedValue(URL1));
    now += 30 * 24 * 3_600_000; // stale is fine when nobody can be asked
    expect(await store.stored('k')).toEqual({ kind: 'photo', hash: shortHash(body), bytes: body });
    store.drop('k');
    expect(await store.stored('k')).toEqual({ kind: 'failed' });
    expect(readdirSync(join(dir, 'avatars'))).toHaveLength(0);
  });

  it('asks again when the stored file went missing', async () => {
    fetchMock.mockImplementation(async () => ok(jpeg(1)));
    const lookup = vi.fn().mockResolvedValue(URL1);
    await store.get('k', lookup);
    rmSync(join(dir, 'avatars'), { recursive: true, force: true });
    expect(await store.get('k', lookup)).toMatchObject({ kind: 'photo' });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

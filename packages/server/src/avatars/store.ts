import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { DB } from '../db/index.js';
import { avatarHashes } from './sql.js';

/** What the store knows about one photo key. */
export type AvatarResult =
  /** The photo bytes (JPEG) and their short sha256. */
  | { kind: 'photo'; hash: string; bytes: Buffer }
  /** WhatsApp says there is no photo (or it is private). */
  | { kind: 'none' }
  /** Nothing known and the lookup failed: answer "unknown", never cache it. */
  | { kind: 'failed' };

export interface AvatarStore {
  /**
   * The photo of `key`. Asks `lookup` (the WhatsApp URL of the photo, or null for none) when the key is
   * unknown or older than the refresh age, coalesced per key and bounded in total. A failed refresh keeps
   * what was stored before.
   */
  get(key: string, lookup: () => Promise<string | null>): Promise<AvatarResult>;
  /** What is stored for `key`, however old, without asking anyone (WhatsApp offline). */
  stored(key: string): Promise<AvatarResult>;
  /** Short hashes of the stored photos among `keys` (one query; keys without a photo are absent). */
  hashes(keys: readonly string[]): Map<string, string>;
  /** Forgets a key and its file (its photo changed). */
  drop(key: string): void;
}

export const AVATAR_MAX_AGE_MS = 24 * 3_600_000;
export const AVATAR_MAX_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

interface Row {
  key: string;
  has_photo: 0 | 1;
  hash: string | null;
  fetched_at: number;
}

/**
 * The URL itself when it is an https URL on WhatsApp's own hosts (no credentials, no port), else null.
 * Nothing else is ever downloaded (SSRF guard).
 */
export function safePhotoUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.whatsapp.net') ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    return null;
  return parsed.href;
}

const shortHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

class DownloadError extends Error {}

/**
 * WhatsApp profile photos kept on this computer (`<data>/avatars/`), so a browser can cache them by
 * content hash instead of following a short-lived WhatsApp link. Logs carry no keys, numbers or URLs.
 */
export function createAvatarStore(opts: {
  db: DB;
  /** `<data>/avatars`: the only folder written. */
  dir: string;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  maxAgeMs?: number;
  maxBytes?: number;
  /** Most refreshes running at once (default 32). */
  maxInFlight?: number;
}): AvatarStore {
  const { db, dir, log } = opts;
  const now = opts.now ?? (() => Date.now());
  // read at call time, so a test can stub the global
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxAge = opts.maxAgeMs ?? AVATAR_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? AVATAR_MAX_BYTES;
  const maxInFlight = opts.maxInFlight ?? 32;
  const inFlight = new Map<string, Promise<AvatarResult>>();

  const selectRow = db.prepare('SELECT * FROM avatars WHERE key = ?');
  const upsert = db.prepare(
    `INSERT INTO avatars (key, has_photo, hash, fetched_at) VALUES (@key, @has_photo, @hash, @fetched_at)
     ON CONFLICT(key) DO UPDATE SET has_photo = excluded.has_photo, hash = excluded.hash,
       fetched_at = excluded.fetched_at`,
  );
  const remove = db.prepare('DELETE FROM avatars WHERE key = ?');

  const fileOf = (key: string) =>
    join(dir, `${createHash('sha256').update(key).digest('hex')}.jpg`);

  async function fromRow(row: Row | undefined): Promise<AvatarResult | null> {
    if (!row) return null;
    if (!row.has_photo || !row.hash) return { kind: 'none' };
    const bytes = await readFile(fileOf(row.key)).catch(() => null);
    return bytes ? { kind: 'photo', hash: row.hash, bytes } : null;
  }

  async function download(url: string): Promise<Buffer> {
    const res = await doFetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (res.status !== 200 || !res.body) throw new DownloadError(`status ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (declared > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new DownloadError('too large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError('too large');
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    if (!isJpeg(bytes)) throw new DownloadError('not a JPEG');
    return bytes;
  }

  async function refresh(
    key: string,
    lookup: () => Promise<string | null>,
    previous: AvatarResult | null,
  ): Promise<AvatarResult> {
    const started = now();
    const kept = previous ?? { kind: 'failed' as const };
    let url: string | null;
    try {
      url = await lookup();
    } catch {
      // not "no photo": keep what we had and ask again on the next request
      log.debug('Profile photo lookup failed');
      return kept;
    }
    const safe = url ? safePhotoUrl(url) : null;
    if (url && !safe) log.warn('Rejected profile photo destination');
    if (!safe) {
      upsert.run({ key, has_photo: 0, hash: null, fetched_at: started });
      await rm(fileOf(key), { force: true }).catch(() => undefined);
      return { kind: 'none' };
    }
    let bytes: Buffer;
    try {
      bytes = await download(safe);
    } catch (err) {
      log.debug(
        { reason: err instanceof DownloadError ? err.message : (err as Error)?.name },
        'Profile photo download failed',
      );
      return kept;
    }
    const hash = shortHash(bytes);
    if (previous?.kind !== 'photo' || previous.hash !== hash) {
      mkdirSync(dir, { recursive: true });
      const file = fileOf(key);
      const tmp = `${file}.${process.pid}.${started}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    }
    upsert.run({ key, has_photo: 1, hash, fetched_at: started });
    return { kind: 'photo', hash, bytes };
  }

  return {
    async get(key, lookup) {
      const running = inFlight.get(key);
      if (running) return running;
      const row = selectRow.get(key) as Row | undefined;
      const current = await fromRow(row);
      if (current && row && now() - row.fetched_at < maxAge) return current;
      // a refresh may have started while the file was read
      const again = inFlight.get(key);
      if (again) return again;
      if (inFlight.size >= maxInFlight) return current ?? { kind: 'failed' };
      const job = refresh(key, lookup, current)
        .catch((err: unknown) => {
          log.warn({ err: (err as Error)?.name }, 'Profile photo store failed');
          return current ?? ({ kind: 'failed' } as const);
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job;
    },

    async stored(key) {
      return (await fromRow(selectRow.get(key) as Row | undefined)) ?? { kind: 'failed' };
    },

    hashes(keys) {
      return avatarHashes(db, keys);
    },

    drop(key) {
      remove.run(key);
      rmSync(fileOf(key), { force: true });
    },
  };
}

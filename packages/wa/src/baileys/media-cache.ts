import { statSync } from 'node:fs';
import type { CacheStore } from 'baileys';

/** How long an uploaded file's WhatsApp media reference is re-used (Baileys' `mediaCache`). */
export const MEDIA_CACHE_TTL_MS = 60 * 60 * 1000;
/** Entries kept at most (each is a small encoded message, not the file). */
export const MEDIA_CACHE_MAX_ENTRIES = 200;

/**
 * Baileys' `mediaCache` (design docs/features/forward-message/design.md → Large files): Baileys asks it
 * with `<media type>:<url>` before uploading a file given as `{ url: path }`, and stores the uploaded
 * message after. Each forwarded copy has its own file (a hard link of the same file), so the key is
 * rewritten to the file's identity on disk (device, inode, size, change time): five copies of one 70 MB
 * video on the same number are uploaded once. A copied file (no hard link) is simply uploaded again.
 * Kept in memory with a time limit; anything that is not a readable local path is never cached.
 */
export class MediaCache implements CacheStore {
  private readonly entries = new Map<string, { value: unknown; expires: number }>();

  constructor(
    private readonly ttlMs = MEDIA_CACHE_TTL_MS,
    private readonly maxEntries = MEDIA_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /** `<type>:<path>` → `<type>:<dev>:<ino>:<size>:<ctime>`, or null for anything else. */
  static fileKey(key: string): string | null {
    const i = key.indexOf(':');
    if (i <= 0) return null;
    const type = key.slice(0, i);
    const path = key.slice(i + 1);
    if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null; // a web address
    try {
      const st = statSync(path);
      if (!st.isFile()) return null;
      return `${type}:${st.dev}:${st.ino}:${st.size}:${st.ctimeMs}`;
    } catch {
      return null;
    }
  }

  get<T>(key: string): T | undefined {
    const k = MediaCache.fileKey(key);
    if (!k) return undefined;
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.entries.delete(k);
      return undefined;
    }
    return e.value as T;
  }

  set<T>(key: string, value: T): boolean {
    const k = MediaCache.fileKey(key);
    if (!k) return false;
    this.entries.delete(k);
    this.entries.set(k, { value, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  del(key: string): boolean {
    const k = MediaCache.fileKey(key);
    return k ? this.entries.delete(k) : false;
  }

  flushAll(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

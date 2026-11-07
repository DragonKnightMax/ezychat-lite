import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaCache } from './media-cache.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function folder() {
  const d = mkdtempSync(join(tmpdir(), 'media-cache-'));
  dirs.push(d);
  return d;
}

describe('MediaCache', () => {
  it('re-uses one upload for hard links of the same file, per media type', () => {
    const d = folder();
    const a = join(d, 'a.mp4');
    const b = join(d, 'b.mp4');
    const c = join(d, 'c.mp4');
    writeFileSync(a, 'video bytes');
    linkSync(a, b);
    writeFileSync(c, 'video bytes'); // a copy: another file
    const cache = new MediaCache();
    expect(cache.set(`video:${a}`, 'uploaded')).toBe(true);
    expect(cache.get(`video:${b}`)).toBe('uploaded');
    expect(cache.get(`document:${b}`)).toBeUndefined();
    expect(cache.get(`video:${c}`)).toBeUndefined();
    expect(cache.del(`video:${b}`)).toBe(true);
    expect(cache.get(`video:${a}`)).toBeUndefined();
  });

  it('never caches web addresses, folders or missing files', () => {
    const d = folder();
    const cache = new MediaCache();
    expect(cache.set('image:https://example.com/a.jpg', 'x')).toBe(false);
    expect(cache.set(`image:${d}`, 'x')).toBe(false);
    expect(cache.set(`image:${join(d, 'missing.jpg')}`, 'x')).toBe(false);
    expect(cache.set('nocolon', 'x')).toBe(false);
    expect(cache.set('image:', 'x')).toBe(false);
    expect(cache.get('image:https://example.com/a.jpg')).toBeUndefined();
    expect(cache.del('image:https://example.com/a.jpg')).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('forgets entries after their time and keeps at most maxEntries', () => {
    const d = folder();
    let now = 1_000;
    const cache = new MediaCache(100, 2, () => now);
    const files = ['1', '2', '3'].map((n) => {
      const p = join(d, `${n}.jpg`);
      writeFileSync(p, n);
      return p;
    });
    for (const f of files) cache.set(`image:${f}`, f);
    expect(cache.size).toBe(2);
    expect(cache.get(`image:${files[0]}`)).toBeUndefined();
    expect(cache.get(`image:${files[2]}`)).toBe(files[2]);
    now += 100;
    expect(cache.get(`image:${files[2]}`)).toBeUndefined();
    cache.flushAll();
    expect(cache.size).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createWaVersionSource, type WaVersion } from './wa-version.js';

const V: WaVersion = [2, 3000, 1];
const V2: WaVersion = [2, 3000, 2];

describe('createWaVersionSource', () => {
  it('has no version before a lookup finishes, so a connect uses the bundled one at once', async () => {
    let resolve!: (v: { version: WaVersion }) => void;
    const src = createWaVersionSource({
      fetchLatest: () => new Promise((r) => (resolve = r)),
    });
    const pending = src.refresh();
    expect(src.current()).toBeUndefined();
    resolve({ version: V });
    expect(await pending).toEqual({ version: V });
    expect(src.current()).toEqual(V);
  });

  it('gives up on a lookup that never answers and lets the next one try later', async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const fetchLatest = vi
        .fn<() => Promise<{ version: WaVersion }>>()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue({ version: V });
      const src = createWaVersionSource({
        fetchLatest,
        timeoutMs: 10_000,
        failureTtlMs: 600_000,
        now: () => t,
      });
      const pending = src.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await pending;
      expect(r.version).toBeUndefined();
      expect(String(r.error)).toMatch(/timed out after 10000 ms/);
      t = 599_999;
      await src.refresh();
      expect(fetchLatest).toHaveBeenCalledTimes(1);
      t = 600_000;
      expect(await src.refresh()).toEqual({ version: V });
      expect(src.current()).toEqual(V);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a fetched version until it expires, then looks again', async () => {
    let t = 0;
    const fetchLatest = vi
      .fn<() => Promise<{ version: WaVersion }>>()
      .mockResolvedValueOnce({ version: V })
      .mockResolvedValue({ version: V2 });
    const src = createWaVersionSource({ fetchLatest, ttlMs: 1_000, now: () => t });
    await src.refresh();
    t = 999;
    expect(await src.refresh()).toEqual({ version: V });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    t = 1_000;
    await src.refresh();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(src.current()).toEqual(V2);
  });

  it('shares one lookup between concurrent connects', async () => {
    let resolve!: (v: { version: WaVersion }) => void;
    const fetchLatest = vi.fn(() => new Promise<{ version: WaVersion }>((r) => (resolve = r)));
    const src = createWaVersionSource({ fetchLatest });
    const a = src.refresh();
    const b = src.refresh();
    resolve({ version: V });
    expect(await a).toEqual({ version: V });
    expect(await b).toEqual({ version: V });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good version when a later lookup fails', async () => {
    let t = 0;
    const fetchLatest = vi
      .fn<() => Promise<{ version: WaVersion }>>()
      .mockResolvedValueOnce({ version: V })
      .mockRejectedValue(new Error('offline'));
    const src = createWaVersionSource({ fetchLatest, ttlMs: 10, now: () => t });
    await src.refresh();
    t = 10;
    const failed = await src.refresh();
    expect(failed.version).toEqual(V);
    expect((failed.error as Error).message).toBe('offline');
    expect(src.current()).toEqual(V);
  });
});

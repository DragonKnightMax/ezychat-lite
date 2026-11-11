import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from './random-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID where the page is a secure context', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(randomUuid()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  // A LAN address over plain http (http://192.168.x.x:7420) is not a secure context: browsers leave
  // crypto.randomUUID out there, but getRandomValues stays. The server checks these ids with z.uuid().
  it('builds a v4 UUID from getRandomValues on a plain-http LAN page', () => {
    const real = globalThis.crypto;
    const getRandomValues = vi.fn((a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a));
    vi.stubGlobal('crypto', { getRandomValues });
    const ids = new Set(Array.from({ length: 200 }, () => randomUuid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalledTimes(200);
  });

  it('sets the version and variant bits whatever the random bytes are', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(0xff) });
    expect(randomUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(0) });
    expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000');
  });
});

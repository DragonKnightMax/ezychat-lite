import { describe, expect, it } from 'vitest';
import { boundedMediaBuffer, validateMediaDownloadOptions } from './media-download.js';
import { WaMediaDownloadLimitError } from './index.js';
describe('public bounded media options', () => {
  it('requires a positive safe integer and honors pre-aborted signals', () => {
    for (const maxBytes of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => validateMediaDownloadOptions({ maxBytes })).toThrow(RangeError);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      validateMediaDownloadOptions({ maxBytes: 1, signal: controller.signal }),
    ).toThrow();
  });
  it('keeps fake buffers within bounds without copying and exposes a recognizable safe error', () => {
    const fixture = Buffer.from('fake');
    expect(boundedMediaBuffer(fixture, { maxBytes: 4 })).toBe(fixture);
    expect(() => boundedMediaBuffer(fixture, { maxBytes: 3 })).toThrow(WaMediaDownloadLimitError);
    const error = new WaMediaDownloadLimitError(3);
    expect(error).toMatchObject({
      name: 'WaMediaDownloadLimitError',
      code: 'media_too_large',
      maxBytes: 3,
    });
    expect(error.message).not.toContain('fake');
  });
});

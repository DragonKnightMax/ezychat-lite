import { WaMediaDownloadLimitError, type WaMediaDownloadOptions } from './types.js';

/** Validate before opening a stream: an invalid limit must never start a download. */
export function validateMediaDownloadOptions(options: WaMediaDownloadOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    throw new RangeError('maxBytes must be a positive safe integer');
  options.signal?.throwIfAborted();
}

/** Used only by the fake adapter, whose input is already an in-memory test fixture. */
export function boundedMediaBuffer(buffer: Buffer, options: WaMediaDownloadOptions): Buffer {
  validateMediaDownloadOptions(options);
  if (buffer.byteLength > options.maxBytes) throw new WaMediaDownloadLimitError(options.maxBytes);
  return buffer;
}

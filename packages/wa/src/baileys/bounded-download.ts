import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertMediaContent,
  extractMessageContent,
  getContentType,
  getMediaKeys,
  type WAMessage,
} from 'baileys';
import type { WaMediaDownloadOptions } from '../types.js';
import { WaMediaDownloadLimitError } from '../types.js';
import { validateMediaDownloadOptions } from '../media-download.js';

interface DownloadContext {
  reuploadRequest: (message: WAMessage) => Promise<WAMessage>;
}
class MediaHttpError extends Error {
  constructor(readonly status: number) {
    super('Media download request failed');
  }
}
function mediaUrl(media: ReturnType<typeof assertMediaContent>): URL {
  const original = media.url ? new URL(media.url) : new URL('https://mmg.whatsapp.net');
  const allowed =
    original.hostname === 'whatsapp.net' ||
    original.hostname.endsWith('.whatsapp.net') ||
    original.hostname === 'whatsapp.com' ||
    original.hostname.endsWith('.whatsapp.com');
  if (
    original.protocol !== 'https:' ||
    original.username ||
    original.password ||
    original.port ||
    !allowed
  )
    throw new Error('Unsupported media origin');
  if (media.directPath) {
    if (
      !media.directPath.startsWith('/') ||
      media.directPath.startsWith('//') ||
      media.directPath.includes('\\') ||
      /\p{Cc}/u.test(media.directPath)
    )
      throw new Error('Invalid media path');
    const resolved = new URL(media.directPath, original.origin);
    if (resolved.origin !== original.origin) throw new Error('Invalid media path');
    return resolved;
  }
  if (!media.url) throw new Error('Missing media URL');
  return original;
}
function mediaType(raw: WAMessage): 'image' | 'video' | 'audio' | 'document' | 'sticker' {
  const content = extractMessageContent(raw.message);
  const kind = content ? getContentType(content) : undefined;
  const mediaTypes = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    stickerMessage: 'sticker',
  } as const;
  if (!kind || !Object.hasOwn(mediaTypes, kind)) throw new Error('Unsupported media type');
  return mediaTypes[kind as keyof typeof mediaTypes];
}
function verifyHash(expected: Uint8Array | null | undefined, actual: Buffer): void {
  if (expected && (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)))
    throw new Error('Invalid media integrity');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/**
 * Baileys' current getHttpStream drops RequestInit.signal. Use its public key derivation and
 * the same AES-CBC/HMAC wire format with native fetch, keeping cancellation end to end.
 */
async function fetchBounded(
  raw: WAMessage,
  options: WaMediaDownloadOptions,
  controller: AbortController,
): Promise<Buffer> {
  const media = assertMediaContent(raw.message!);
  const url = mediaUrl(media);
  const { iv, cipherKey, macKey } = await getMediaKeys(media.mediaKey!, mediaType(raw));
  if (!macKey) throw new Error('Missing media authentication key');
  controller.signal.throwIfAborted();
  const response = await fetch(url, {
    signal: controller.signal,
    redirect: 'error',
    headers: { Origin: 'https://web.whatsapp.com' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new MediaHttpError(response.status);
  }
  if (!response.body) throw new Error('Missing media body');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener('abort', cancel, { once: true });
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  const hmac = createHmac('sha256', macKey).update(iv);
  const encryptedHash = createHash('sha256'),
    plainHash = createHash('sha256');
  const chunks: Buffer[] = [];
  let tail = Buffer.alloc(0),
    size = 0,
    encodedSize = 0;
  const encodedLimit = options.maxBytes + 26; // one padding block plus the ten-byte MAC
  const retain = (chunk: Buffer) => {
    if (chunk.byteLength > options.maxBytes - size)
      throw new WaMediaDownloadLimitError(options.maxBytes);
    size += chunk.byteLength;
    plainHash.update(chunk);
    chunks.push(chunk);
  };
  try {
    while (true) {
      const next = await reader.read();
      controller.signal.throwIfAborted();
      if (next.done) break;
      if (next.value.byteLength > encodedLimit - encodedSize)
        throw new WaMediaDownloadLimitError(options.maxBytes);
      encodedSize += next.value.byteLength;
      const incoming = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      encryptedHash.update(incoming);
      const bytes = tail.length ? Buffer.concat([tail, incoming]) : incoming;
      const split = Math.max(0, bytes.length - 10);
      const encrypted = bytes.subarray(0, split);
      tail = Buffer.from(bytes.subarray(split));
      hmac.update(encrypted);
      retain(decipher.update(encrypted));
    }
    if (tail.byteLength !== 10 || !timingSafeEqual(tail, hmac.digest().subarray(0, 10)))
      throw new Error('Invalid media integrity');
    retain(decipher.final());
    verifyHash(media.fileEncSha256, encryptedHash.digest());
    verifyHash(media.fileSha256, plainHash.digest());
    return Buffer.concat(chunks, size);
  } finally {
    decipher.destroy();
    hmac.destroy();
    plainHash.destroy();
    encryptedHash.destroy();
    controller.signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    controller.abort();
  }
}

/** Optional methods, rather than ignored legacy arguments, make the bound feature-detectable. */
export async function downloadBoundedMessage(
  raw: WAMessage,
  options: WaMediaDownloadOptions,
  context?: DownloadContext,
): Promise<Buffer> {
  validateMediaDownloadOptions(options);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    try {
      return await fetchBounded(raw, options, controller);
    } catch (error) {
      if (!(error instanceof MediaHttpError) || ![404, 410].includes(error.status) || !context)
        throw error;
      const refreshed = await abortable(context.reuploadRequest(raw), controller.signal);
      controller.signal.throwIfAborted();
      return await fetchBounded(refreshed, options, controller);
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

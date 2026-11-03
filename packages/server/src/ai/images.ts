import { readFileSync, statSync } from 'node:fs';
import type { AiPromptImage } from './provider-types.js';

/** At most this many customer images (the newest in the batch) go to one answer. */
export const AI_MAX_IMAGES = 3;
/** An agent that records rows from photos (a tab on Add rows) reads up to this many per turn. */
export const AI_MAX_RECORD_IMAGES = 10;
/** Larger images are skipped (the request would be slow and costly). */
export const AI_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** How long an answer waits for a live image that is still downloading from WhatsApp. */
export const AI_IMAGE_WAIT_MS = 20_000;
/** A pending image older than this is imported history (downloaded only on demand), not a live download. */
export const AI_LIVE_MEDIA_MS = 2 * 60_000;

/**
 * The image type from the file's own bytes, never from the sender's declared type. Only JPEG, PNG
 * and WebP are sent: GIF is excluded (WhatsApp "GIFs" are videos; animated files are not
 * guaranteed to be read).
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * A stored image as a prompt image, or null when it is too large, unreadable or not JPEG/PNG/WebP.
 * Synchronous like the media store: at most AI_MAX_IMAGES files of at most 5 MB per answer.
 */
export function readPromptImage(path: string): AiPromptImage | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0 || info.size > AI_MAX_IMAGE_BYTES) return null;
    const bytes = readFileSync(path);
    if (bytes.length > AI_MAX_IMAGE_BYTES) return null;
    const mime = sniffImageMime(bytes);
    return mime ? { mime, base64: bytes.toString('base64') } : null;
  } catch {
    return null;
  }
}

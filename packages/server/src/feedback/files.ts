/** The attachment types a report may carry, read from the bytes (never from the name). */
export type FeedbackFileType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | 'text/plain' | 'video/mp4';

const EXTENSION: Record<FeedbackFileType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
};

const startsWith = (buf: Buffer, bytes: number[], at = 0) =>
  buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf: Buffer, at: number, text: string) =>
  buf.length >= at + text.length && buf.toString('latin1', at, at + text.length) === text;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Plain UTF-8 text without NUL or other binary control bytes (tab, newlines and CR are fine). */
function isText(buf: Buffer): boolean {
  for (const b of buf)
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return false;
  try {
    utf8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real type of an attachment, or null when it is not one the portal accepts. Text needs a
 * `.txt`/`.log` name as well (text has no signature); QuickTime `ftypqt` is not MP4.
 */
export function feedbackFileType(buf: Buffer, fileName: string): FeedbackFileType | null {
  if (buf.length === 0) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'image/webp';
  if (ascii(buf, 0, '%PDF-')) return 'application/pdf';
  if (ascii(buf, 4, 'ftyp') && !ascii(buf, 8, 'qt  ')) return 'video/mp4';
  if (/\.(txt|log)$/i.test(fileName) && isText(buf)) return 'text/plain';
  return null;
}

/**
 * A safe name for the portal: the base name without control characters or path parts, at most
 * 100 characters, ending in the extension of the real type.
 */
export function feedbackFileName(fileName: string, type: FeedbackFileType): string {
  const base = (fileName.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .trim();
  const stem = base.replace(/\.[^.]*$/, '').slice(0, 90) || 'attachment';
  const ext = EXTENSION[type];
  const keep = type === 'text/plain' && /\.log$/i.test(base) ? 'log' : ext;
  return `${stem}.${keep}`;
}

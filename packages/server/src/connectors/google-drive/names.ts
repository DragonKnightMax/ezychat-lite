/**
 * Names EzyChat gives what it saves (never the sender's own file name, which can carry anything),
 * sub-folder names the agent passes, and the read kind of a Drive file.
 */
import { randomBytes } from 'node:crypto';
import type { DriveFileKind } from '@ezychat/shared';

export const SUBFOLDER_CHARACTERS = 80;

/** Extensions by the stored media type (sniffed at ingest); anything else keeps none. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

const LABELS: Record<string, string> = {
  image: 'Photo',
  sticker: 'Sticker',
  video: 'Video',
  audio: 'Voice note',
  document: 'Document',
};

/** `2026-11-05 1432` in `timeZone`. */
export function localStamp(at: number, timeZone: string): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}${parts.minute}`,
  };
}

/** `2026-11-05 1432 Photo 7F3A.jpg`: date and time the file was sent, its kind, a short reference. */
export function savedFileName(
  input: { type: string; mime: string | null; sentAt: number },
  timeZone: string,
  ref: string = randomBytes(2).toString('hex').toUpperCase(),
): string {
  const { day, time } = localStamp(input.sentAt, timeZone);
  const mime = (input.mime ?? '').toLowerCase().split(';')[0]!.trim();
  const ext = EXTENSIONS[mime] ?? EXTENSIONS[(input.mime ?? '').toLowerCase()];
  const label = LABELS[input.type] ?? 'File';
  const suffix = ext ? '.' + ext : '';
  return `${day} ${time} ${label} ${ref}${suffix}`;
}

/**
 * A sub-folder name the agent passed: one level, no path separators, control, bidi or other
 * format characters, at most 80 characters; null when nothing usable is left.
 */
export function cleanSubfolder(name: string | undefined | null): string | null {
  if (!name) return null;
  const cleaned = name
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
    .slice(0, SUBFOLDER_CHARACTERS)
    .trim();
  return cleaned || null;
}

/** How the AI reads a Drive file of this type. */
export function driveFileKind(mimeType: string): DriveFileKind {
  const mime = mimeType.toLowerCase();
  if (mime === 'application/vnd.google-apps.document') return 'doc';
  if (mime === 'application/vnd.google-apps.presentation') return 'doc';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'sheet';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return 'word';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

/** The export type of a Google Docs file of this kind (null: downloaded as it is). */
export function exportMime(mimeType: string): string | null {
  switch (mimeType.toLowerCase()) {
    case 'application/vnd.google-apps.document':
    case 'application/vnd.google-apps.presentation':
      return 'text/plain';
    case 'application/vnd.google-apps.spreadsheet':
      return 'text/csv';
    default:
      return null;
  }
}

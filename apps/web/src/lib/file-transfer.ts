// Files moving into the app (drop, paste) and out of it (drag a media file to the desktop).
import { TUNNEL_UPLOAD_LIMIT_BYTES } from '@ezychat/shared';

/** Files one send takes at most, as WhatsApp's own picker. */
export const MAX_ATTACHMENTS = 10;

/** A drag that carries files from the OS (not text or a link from inside the page). */
export function hasFiles(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * The files of a drop or paste. A screenshot pasted from the clipboard has no useful name
 * ("image.png" or none), so it is named after the time it was pasted.
 */
export function filesFromTransfer(
  dt: Pick<DataTransfer, 'files'> | null | undefined,
  now: () => Date = () => new Date(),
): File[] {
  const files = Array.from(dt?.files ?? []);
  return files.map((f) => {
    if (f.name && f.name !== 'image.png') return f;
    const ext = EXT[f.type] ?? 'bin';
    return new File([f], `pasted-${stamp(now())}.${ext}`, {
      type: f.type,
      lastModified: f.lastModified,
    });
  });
}

export type RejectedFile = {
  file: File;
  /** `tunnel_limit`: above what the Cloudflare tunnel passes (it works on this PC or the LAN). */
  reason: 'too_large' | 'empty' | 'too_many' | 'tunnel_limit';
  /** The limit a `too_large` file went over, in bytes. */
  limit?: number;
};

/** What a chat's WhatsApp number takes, per kind of file (`InboxCapabilities.mediaLimits`). */
export type MediaLimits = Partial<Record<'video' | 'image' | 'audio' | 'document', number>>;

/**
 * The largest file of this type the chat's number takes (`mediaLimits`), or undefined when it knows
 * none: the app has no size cap of its own. A video is checked against the document limit only:
 * above the video limit it goes as a file (`videoNeedsFile`).
 */
export function uploadLimitFor(mime: string, limits?: MediaLimits | null): number | undefined {
  const kind = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'audio'
      : 'document';
  return limits?.[kind] || undefined;
}

/** A video above the number's video limit (it can still go as a file, up to the document limit). */
export function videoNeedsFile(file: File, limits?: MediaLimits | null): boolean {
  return file.type.startsWith('video/') && !!limits?.video && file.size > limits.video;
}

const PRIVATE_V4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * The app is open through the internet address (the Cloudflare tunnel), not on this computer or the
 * local network: loopback, private IPv4, IPv6 literals, single-label and `.local` names are local.
 */
export function isTunnelHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.includes(':') || PRIVATE_V4.test(host)) return false;
  if (!host.includes('.') || host.endsWith('.local')) return false;
  return !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/** Splits files into the ones that can be sent and the ones refused before any upload. */
export function checkAttachments(
  files: readonly File[],
  alreadyQueued: number,
  limits?: MediaLimits | null,
  opts: { tunnel?: boolean } = {},
): { accepted: File[]; rejected: RejectedFile[] } {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    const limit = uploadLimitFor(file.type, limits);
    if (file.size === 0) rejected.push({ file, reason: 'empty' });
    else if (limit !== undefined && file.size > limit)
      rejected.push({ file, reason: 'too_large', limit });
    else if (opts.tunnel && file.size > TUNNEL_UPLOAD_LIMIT_BYTES)
      rejected.push({ file, reason: 'tunnel_limit', limit: TUNNEL_UPLOAD_LIMIT_BYTES });
    else if (alreadyQueued + accepted.length >= MAX_ATTACHMENTS)
      rejected.push({ file, reason: 'too_many' });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** "1.2 MB" style size for the attachment tray. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** The sender chose the type: only a plain `type/subtype` goes into the drag, else a neutral one. */
export function safeMime(mime: string | null): string {
  return mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

/**
 * The sender chose the name: no control characters, nothing a desktop forbids in a file name
 * (`<>:"/\|?*`; a colon would also end the drag's name field early) and no leading dots.
 */
export function safeFileName(name: string): string {
  const cleaned = Array.from(name, (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || '<>:"/\\|?*'.includes(c) ? '_' : c,
  )
    .join('')
    .replace(/^[.\s]+/, '')
    .trim();
  return cleaned || 'file';
}

/**
 * Lets a media file be dragged out of the app onto the desktop or a folder (Chromium browsers and
 * the desktop app): the `DownloadURL` drag type is `mime:name:absolute-url`, saved like a download.
 */
export function setDownloadDrag(
  dt: DataTransfer,
  file: { url: string; name: string; mime: string | null },
): void {
  const absolute = new URL(file.url, window.location.href).href;
  dt.effectAllowed = 'copy';
  dt.setData('DownloadURL', `${safeMime(file.mime)}:${safeFileName(file.name)}:${absolute}`);
  dt.setData('text/uri-list', absolute);
}

/**
 * A file dropped where nothing takes it would make the browser open it in place of the app (or,
 * in the desktop window, try to navigate to it). Refuse such drops page-wide; drop zones call
 * `preventDefault` first and keep working. Returns the uninstall function.
 */
export function installFileDropGuard(target: Window = window): () => void {
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (e: DragEvent) => {
    if (hasFiles(e.dataTransfer)) e.preventDefault();
  };
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('drop', onDrop);
  };
}

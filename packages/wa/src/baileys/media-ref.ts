import { normalizeMessageContent, type WAMessage } from 'baileys';

const MEDIA_TYPES = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const REF_VERSION = 1;

interface MediaRef {
  v: typeof REF_VERSION;
  key: { remoteJid: string; id: string; fromMe: boolean; participant: string | null };
  type: MediaType;
  url: string | null;
  directPath: string | null;
  mimetype: string | null;
  mediaKeyTimestamp: number | null;
  /** base64 */
  mediaKey: string;
  fileSha256: string | null;
  fileEncSha256: string | null;
}

const toBase64 = (bytes: Uint8Array | null | undefined): string | null =>
  bytes?.length ? Buffer.from(bytes).toString('base64') : null;

const fromBase64 = (text: string | null): Buffer | null =>
  text ? Buffer.from(text, 'base64') : null;

/**
 * What a later download of this message needs, as a string the server stores (`WaAdapter.downloadMedia`).
 * Only these fields: no caption, quote or thumbnail, and undefined when the message has no media key.
 */
export function encodeMediaRef(msg: WAMessage): string | undefined {
  const { key } = msg;
  const content = normalizeMessageContent(msg.message);
  const type = MEDIA_TYPES.find((t) => content?.[t]);
  const media = type ? content?.[type] : null;
  const mediaKey = toBase64(media?.mediaKey);
  if (!type || !media || !mediaKey || !key?.remoteJid || !key.id) return undefined;
  const timestamp = media.mediaKeyTimestamp;
  const ref: MediaRef = {
    v: REF_VERSION,
    key: {
      remoteJid: key.remoteJid,
      id: key.id,
      fromMe: !!key.fromMe,
      participant: key.participant ?? null,
    },
    type,
    url: media.url ?? null,
    directPath: media.directPath ?? null,
    mimetype: media.mimetype ?? null,
    mediaKeyTimestamp: timestamp == null ? null : Number(timestamp),
    mediaKey,
    fileSha256: toBase64(media.fileSha256),
    fileEncSha256: toBase64(media.fileEncSha256),
  };
  return JSON.stringify(ref);
}

/** The message `encodeMediaRef` described, ready for Baileys' download; null when it cannot be read. */
export function decodeMediaRef(text: string): WAMessage | null {
  let ref: MediaRef;
  try {
    ref = JSON.parse(text) as MediaRef;
  } catch {
    return null;
  }
  if (ref?.v !== REF_VERSION || !MEDIA_TYPES.includes(ref.type) || !ref.mediaKey || !ref.key?.id)
    return null;
  return {
    key: {
      remoteJid: ref.key.remoteJid,
      id: ref.key.id,
      fromMe: ref.key.fromMe,
      participant: ref.key.participant,
    },
    message: {
      [ref.type]: {
        // Baileys tells a media message by the presence of `url`, also when it is empty.
        url: ref.url,
        directPath: ref.directPath,
        mimetype: ref.mimetype,
        mediaKeyTimestamp: ref.mediaKeyTimestamp,
        mediaKey: fromBase64(ref.mediaKey),
        fileSha256: fromBase64(ref.fileSha256),
        fileEncSha256: fromBase64(ref.fileEncSha256),
      },
    },
  } as WAMessage;
}

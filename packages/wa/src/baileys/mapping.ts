import { downloadMediaMessage, normalizeMessageContent, type proto, type WAMessage } from 'baileys';
import type { MessageType } from '@ezychat/shared';
import type { WaIncomingMessage, WaReaction } from '../types.js';
import { normalizeContactJid } from './contact-aliases.js';
import { encodeMediaRef } from './media-ref.js';

export type JidKind = 'dm' | 'group' | 'other';

export function jidType(jid: string): JidKind {
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return 'dm';
  // status@broadcast, @broadcast lists, @newsletter channels, anything unknown
  return 'other';
}

type LongLike = { toNumber(): number } | { low: number; high: number };

/** Convert a protobuf timestamp (number | Long | null) in seconds to epoch ms. */
export function toMs(ts: number | LongLike | null | undefined, fallback = Date.now()): number {
  if (ts == null) return fallback;
  if (typeof ts === 'number') return ts * 1000;
  if ('toNumber' in ts && typeof ts.toNumber === 'function') return ts.toNumber() * 1000;
  if ('low' in ts) return ((ts.high >>> 0) * 2 ** 32 + (ts.low >>> 0)) * 1000;
  return fallback;
}

/** A protobuf millisecond timestamp (number | Long | null) as epoch ms, or `fallback`. */
function msToNumber(ts: number | LongLike | null | undefined, fallback: number): number {
  if (ts == null) return fallback;
  if (typeof ts === 'number') return ts;
  if ('toNumber' in ts && typeof ts.toNumber === 'function') return ts.toNumber();
  if ('low' in ts) return (ts.high >>> 0) * 2 ** 32 + (ts.low >>> 0);
  return fallback;
}

/** Who reacted, from the reaction's own message key (group participant, DM partner or us). */
function reactor(
  key: proto.IMessageKey,
  chatJid: string,
): Pick<WaReaction, 'senderJid' | 'senderJidAlt' | 'fromMe'> {
  const fromMe = !!key.fromMe;
  if (fromMe) return { senderJid: null, senderJidAlt: null, fromMe };
  if (jidType(chatJid) !== 'group')
    return { senderJid: normalizeContactJid(chatJid) ?? chatJid, senderJidAlt: null, fromMe };
  return {
    senderJid: normalizeContactJid(key.participant),
    senderJidAlt: normalizeContactJid((key as WAMessage['key']).participantAlt),
    fromMe,
  };
}

/**
 * A live or history reaction message (`reactionMessage`): who reacted with which emoji to which
 * message. Empty text = the reaction was removed. Null for anything else, for reactions without a
 * target or reactor, and for status/broadcast/newsletter chats. Encrypted reactions
 * (`encReactionMessage`, community announcements) are not read.
 */
export function mapWAReaction(msg: proto.IWebMessageInfo): WaReaction | null {
  const key = msg.key;
  const chatJid = key?.remoteJid;
  if (!key || !chatJid || jidType(chatJid) === 'other') return null;
  const reaction = normalizeMessageContent(msg.message)?.reactionMessage;
  const targetId = reaction?.key?.id;
  if (!reaction || !targetId) return null;
  const who = reactor(key, chatJid);
  if (!who.fromMe && !who.senderJid) return null;
  const isGroup = jidType(chatJid) === 'group';
  const alt = isGroup ? null : normalizeContactJid((key as WAMessage['key']).remoteJidAlt);
  return {
    targetId,
    chatJid,
    chatJidAlt: alt && alt.endsWith('@lid') !== chatJid.endsWith('@lid') ? alt : null,
    ...who,
    senderName: who.fromMe ? null : (msg.pushName ?? null),
    emoji: reaction.text ?? '',
    timestamp: msToNumber(
      reaction.senderTimestampMs as number | LongLike | null | undefined,
      toMs(msg.messageTimestamp as number | LongLike | null | undefined),
    ),
  };
}

/**
 * Reactions WhatsApp attached to a stored message (history sync keeps them on the message itself,
 * `WebMessageInfo.reactions`, instead of separate reaction messages). Removed ones are skipped.
 */
export function mapStoredReactions(msg: proto.IWebMessageInfo): WaReaction[] {
  const chatJid = msg.key?.remoteJid;
  const targetId = msg.key?.id;
  if (!chatJid || !targetId || jidType(chatJid) === 'other' || !msg.reactions?.length) return [];
  const fallback = toMs(msg.messageTimestamp as number | LongLike | null | undefined);
  return msg.reactions.flatMap((r) => {
    if (!r.key || !r.text) return [];
    const who = reactor(r.key, chatJid);
    if (!who.fromMe && !who.senderJid) return [];
    return [
      {
        targetId,
        chatJid,
        chatJidAlt: null,
        ...who,
        senderName: null,
        emoji: r.text,
        timestamp: msToNumber(
          r.senderTimestampMs as number | LongLike | null | undefined,
          fallback,
        ),
      },
    ];
  });
}

/** Optional hook for media downloads that need a live socket (reupload of expired media). */
export type MediaDownloader = (msg: WAMessage) => Promise<Buffer>;

const defaultDownloader: MediaDownloader = async (msg) =>
  (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;

interface ContextCarrier {
  contextInfo?: proto.IContextInfo | null;
}

/**
 * Map a raw Baileys message to our adapter shape. Returns null for messages
 * that should not appear in the inbox (reactions — read by mapWAReaction —, protocol, key
 * distribution, status/newsletter/broadcast, empty).
 */
export function mapWAMessage(
  msg: proto.IWebMessageInfo,
  download: MediaDownloader = defaultDownloader,
): WaIncomingMessage | null {
  const key = msg.key;
  const chatJid = key?.remoteJid;
  const id = key?.id;
  if (!key || !chatJid || !id) return null;
  if (jidType(chatJid) === 'other') return null;

  const content = normalizeMessageContent(msg.message);
  if (!content) return null;

  const fromMe = !!key.fromMe;
  const isGroup = jidType(chatJid) === 'group';
  const senderJid = fromMe ? null : isGroup ? normalizeContactJid(key.participant) : chatJid;
  const senderJidAlt =
    !fromMe && isGroup ? normalizeContactJid((key as WAMessage['key']).participantAlt) : null;
  const senderName = fromMe ? null : (msg.pushName ?? null);
  const timestamp = toMs(msg.messageTimestamp as number | LongLike | null | undefined);

  let type: MessageType;
  let body: string | null = null;
  let ctx: ContextCarrier | null | undefined;
  let media: MappedMedia | null = null;

  if (content.conversation != null) {
    type = 'text';
    body = content.conversation;
  } else if (content.extendedTextMessage) {
    type = 'text';
    body = content.extendedTextMessage.text ?? '';
    ctx = content.extendedTextMessage;
  } else if (content.imageMessage) {
    const m = content.imageMessage;
    type = 'image';
    body = m.caption ?? null;
    ctx = m;
    media = {
      mime: m.mimetype ?? 'image/jpeg',
      fileName: null,
      ...imageSize(m),
      ...imageThumbnail(m),
    };
  } else if (content.videoMessage) {
    const m = content.videoMessage;
    type = 'video';
    body = m.caption ?? null;
    ctx = m;
    media = { mime: m.mimetype ?? 'video/mp4', fileName: null };
  } else if (content.audioMessage) {
    const m = content.audioMessage;
    type = 'audio';
    ctx = m;
    media = {
      mime: m.mimetype ?? (m.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
      fileName: null,
    };
  } else if (content.documentMessage) {
    const m = content.documentMessage;
    type = 'document';
    body = m.caption ?? null;
    ctx = m;
    media = {
      mime: m.mimetype ?? 'application/octet-stream',
      fileName: m.fileName ?? m.title ?? null,
    };
  } else if (content.stickerMessage) {
    const m = content.stickerMessage;
    type = 'sticker';
    ctx = m;
    media = { mime: m.mimetype ?? 'image/webp', fileName: null };
  } else {
    // reactionMessage, protocolMessage, senderKeyDistributionMessage, polls, calls, etc.
    return null;
  }

  const quotedId = ctx?.contextInfo?.stanzaId ?? null;
  const forwardingScore = forwardingScoreOf(ctx?.contextInfo);
  const raw = msg as WAMessage;

  // The same person's other address (PN for a LID chat or the reverse); only for direct chats.
  // remoteJidAlt is on Baileys' WAMessageKey, not on proto.IMessageKey.
  const alt = isGroup ? null : normalizeContactJid((key as WAMessage['key']).remoteJidAlt);
  const chatJidAlt = alt && alt.endsWith('@lid') !== chatJid.endsWith('@lid') ? alt : null;

  return {
    id,
    chatJid,
    chatJidAlt,
    senderJid,
    senderJidAlt,
    senderName,
    fromMe,
    type,
    body,
    mentionedJids: [
      ...new Set(
        (ctx?.contextInfo?.mentionedJid ?? []).flatMap((jid) => {
          const normalized = normalizeContactJid(jid);
          return normalized ? [normalized] : [];
        }),
      ),
    ],
    quotedId,
    ...(forwardingScore ? { forwardingScore } : {}),
    timestamp,
    media: media ? mediaOf(media, raw, download) : null,
  };
}

type MappedMedia = Omit<NonNullable<WaIncomingMessage['media']>, 'download' | 'ref'>;

/** Largest preview kept; WhatsApp's are far smaller, and anyone can send a message with a large one. */
export const MAX_THUMBNAIL_BYTES = 64 * 1024;

/** Only real JPEG bytes: the server serves them as an image on our origin. */
function imageThumbnail(m: proto.Message.IImageMessage): { thumbnail: Buffer } | object {
  const bytes = m.jpegThumbnail;
  if (!bytes || bytes.length > MAX_THUMBNAIL_BYTES) return {};
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return jpeg ? { thumbnail: Buffer.from(bytes) } : {};
}

function mediaOf(
  media: MappedMedia,
  raw: WAMessage,
  download: (raw: WAMessage) => Promise<Buffer>,
): NonNullable<WaIncomingMessage['media']> {
  const ref = encodeMediaRef(raw);
  return { ...media, download: () => download(raw), ...(ref ? { ref } : {}) };
}

/** Both sides or neither: a size WhatsApp reports as 0, or as absurdly large, is treated as unknown. */
function imageSize(m: proto.Message.IImageMessage): { width: number; height: number } | object {
  const { width, height } = m;
  const usable = (n: number | null | undefined): n is number =>
    typeof n === 'number' && n > 0 && n <= 65535;
  return usable(width) && usable(height) ? { width, height } : {};
}

/**
 * WhatsApp's forwarding score of a message (`contextInfo.isForwarded` / `forwardingScore`): at least 1
 * when it is marked forwarded, 0 when it is not.
 */
export function forwardingScoreOf(ctx: proto.IContextInfo | null | undefined): number {
  if (!ctx) return 0;
  const score = typeof ctx.forwardingScore === 'number' ? ctx.forwardingScore : 0;
  if (score > 0) return Math.floor(score);
  return ctx.isForwarded ? 1 : 0;
}

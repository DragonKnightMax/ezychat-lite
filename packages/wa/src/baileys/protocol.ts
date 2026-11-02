import { normalizeMessageContent, proto, type WAMessage } from 'baileys';
import type { WaMessageEdit, WaMessageRevoke } from '../types.js';
import { normalizeContactJid } from './contact-aliases.js';
import { jidType, toMs } from './mapping.js';

type LongLike = { toNumber(): number } | { low: number; high: number };

/** The text or caption of an edited message (what `MESSAGE_EDIT` carries), or null. */
function editedText(message: proto.IMessage | null | undefined): string | null {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  if (m.conversation != null) return m.conversation;
  return (
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

function millis(ts: number | LongLike | null | undefined): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  if ('toNumber' in ts && typeof ts.toNumber === 'function') return ts.toNumber();
  if ('low' in ts) return (ts.high >>> 0) * 2 ** 32 + (ts.low >>> 0);
  return null;
}

export type WaProtocolChange =
  { kind: 'edit'; edit: WaMessageEdit } | { kind: 'revoke'; revoke: WaMessageRevoke };

/**
 * An edit (`MESSAGE_EDIT`) or a delete for everyone (`REVOKE`) as WhatsApp delivers it: a
 * `protocolMessage` whose `key` names the changed message, sent by whoever changed it (the outer
 * key: the DM partner, a group participant or the linked number). Null for every other message,
 * for changes without a target or author, and for status/broadcast/newsletter chats.
 */
export function mapWAProtocol(msg: proto.IWebMessageInfo): WaProtocolChange | null {
  const key = msg.key;
  const chatJid = key?.remoteJid;
  if (!key || !chatJid || jidType(chatJid) === 'other') return null;
  const protocol = normalizeMessageContent(msg.message)?.protocolMessage;
  const targetId = protocol?.key?.id;
  if (!protocol || !targetId) return null;
  const isGroup = jidType(chatJid) === 'group';
  const fromMe = !!key.fromMe;
  const senderJid = fromMe
    ? null
    : isGroup
      ? normalizeContactJid(key.participant)
      : (normalizeContactJid(chatJid) ?? chatJid);
  if (!fromMe && !senderJid) return null;
  const senderJidAlt =
    !fromMe && isGroup ? normalizeContactJid((key as WAMessage['key']).participantAlt) : null;
  const alt = isGroup ? null : normalizeContactJid((key as WAMessage['key']).remoteJidAlt);
  const chatJidAlt = alt && alt.endsWith('@lid') !== chatJid.endsWith('@lid') ? alt : null;
  const sent = toMs(msg.messageTimestamp as number | LongLike | null | undefined);
  const base = { targetId, chatJid, chatJidAlt, senderJid, senderJidAlt, fromMe };
  if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE)
    return { kind: 'revoke', revoke: { ...base, timestamp: sent } };
  if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
    const body = editedText(protocol.editedMessage);
    if (body === null) return null;
    const at = millis(protocol.timestampMs as number | LongLike | null | undefined) ?? sent;
    return { kind: 'edit', edit: { ...base, body, timestamp: at } };
  }
  return null;
}

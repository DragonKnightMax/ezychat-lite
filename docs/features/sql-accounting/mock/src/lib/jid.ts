/** Helpers for WhatsApp JIDs (e.g. `60123456789@s.whatsapp.net`, `12345-678@g.us`). */
import type { Chat } from '@ezychat/shared';

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/** The user part before `@` and before any `:device` suffix. */
export function jidUser(jid: string): string {
  const at = jid.indexOf('@');
  const user = at === -1 ? jid : jid.slice(0, at);
  const colon = user.indexOf(':');
  return colon === -1 ? user : user.slice(0, colon);
}

/**
 * Human-readable phone (`+60123456789`) for phone-number JIDs; '' for a WhatsApp ID (`@lid`),
 * whose digits are never shown; 'Group' for groups; the raw user part for anything else.
 */
export function formatJid(jid: string): string {
  if (isGroupJid(jid)) return 'Group';
  if (jid.endsWith('@lid')) return ''; // opaque WhatsApp ID: never shown as a number
  const user = jidUser(jid);
  if (/^\d{5,}$/.test(user) && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')))
    return `+${user}`;
  return user;
}

/** `+<digits>` when WhatsApp has told us the chat's phone number, else null (WhatsApp ID only). */
export function formatPhone(chat: Pick<Chat, 'phone'>): string | null {
  return chat.phone ? `+${chat.phone}` : null;
}

/** For use in route paths: `/chats/${encodeJid(jid)}`. */
export function encodeJid(jid: string): string {
  return encodeURIComponent(jid);
}

export function decodeJid(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    return param;
  }
}

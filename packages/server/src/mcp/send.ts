import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { MCP_SEND_MAX_IMAGE_BYTES, normalizeNewChatPhone, type Message } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import type { ApiPrincipal } from '../api-tokens/index.js';
import {
  BlockedAddressError,
  ResponseTooLargeError,
  guardedFetch,
  type NetPolicy,
} from '../connectors/mcp/net.js';
import { audit } from '../db/audit.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { scopeFor, scopeIds } from '../inboxes/access.js';
import { chatKey, inboxOfKey } from '../inboxes/keys.js';
import { WINDOW_CLOSED } from '../inboxes/reply-window.js';
import { capabilitiesOf } from '../inboxes/types.js';
import { getChats, getMessages } from '../wa-bridge/index.js';
import { ambiguousChat, findChats } from './inbox.js';

/** Thrown for an expected failure of a send; its message is shown to the model. */
export class SendError extends Error {}

export interface SendResult {
  messageId: string;
  chatJid: string;
  status: Message['status'];
  /** WhatsApp is not connected: the send queue sends it when the link is back (or it expires). */
  queued: boolean;
  /** The same requestId was sent before: this is that message, nothing was sent again. */
  duplicate: boolean;
}

export interface NewNumberResult extends SendResult {
  /** True when this call created the chat; false when the number already had a chat in the inbox. */
  newChat: boolean;
  /** Shown to the model with every result, so it can pass the ban risk on to the user. */
  warning: string;
}

/**
 * The only write access MCP tools get: a text reply into an existing chat, as the token's owner, through
 * the normal message service (send queue, presence, retry, reply routing, moved-number guard, claim on
 * reply). Separate from InboxReadPort, so a read tool can never reach it; only `inbox:send` tools do.
 * `sendToNewNumber` (also scope `inbox:send_new`) first starts a chat with a number WhatsApp confirms.
 */
export interface InboxSendPort {
  sendText(
    principal: ApiPrincipal,
    input: { jid: string; text: string; requestId: string; quotedMessageId?: string },
  ): SendResult;
  sendToNewNumber(
    principal: ApiPrincipal,
    input: { phone: string; text: string; requestId: string; inboxId?: number },
  ): Promise<NewNumberResult>;
  /** An image (public https link or base64) with an optional caption into an existing chat. */
  sendImage(principal: ApiPrincipal, input: SendImageInput): Promise<SendResult>;
}

export interface SendImageInput {
  jid: string;
  imageUrl?: string;
  imageBase64?: string;
  caption?: string;
  fileName?: string;
  requestId: string;
  quotedMessageId?: string;
}

/** Image types WhatsApp shows as a photo; anything else is refused (checked on the bytes). */
export const MCP_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Downloads an image link; throws SendError with a message for the model. */
export type ImageFetcher = (url: string) => Promise<Buffer>;

/**
 * The default image download: https only, never this computer or a private network (checked on the
 * address actually connected to), same-origin redirects only, 10 s, at most 5 MB.
 */
export function guardedImageFetcher(policy?: Omit<NetPolicy, 'maxResponseBytes'>): ImageFetcher {
  const get = guardedFetch({
    allowLoopback: false,
    ...policy,
    maxResponseBytes: MCP_SEND_MAX_IMAGE_BYTES,
  });
  return async (url) => {
    let res: Response;
    try {
      res = await get(url, { method: 'GET', headers: { accept: 'image/*' } });
      if (!res.ok) throw new SendError(`The image link answered ${res.status}; check the link.`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof SendError) throw err;
      if (err instanceof BlockedAddressError)
        throw new SendError('The image link must be a public internet address.');
      if (err instanceof ResponseTooLargeError) throw new SendError(IMAGE_TOO_LARGE);
      if (err instanceof TypeError && err.message === 'url_not_https')
        throw new SendError('The image link must start with https://.');
      if (err instanceof TypeError && err.message === 'url_private')
        throw new SendError('The image link must be a public internet address.');
      throw new SendError('The image could not be downloaded from that link; check the link.');
    }
  };
}

const IMAGE_TOO_LARGE = `The image is larger than ${MCP_SEND_MAX_IMAGE_BYTES / 1024 / 1024} MB.`;

/** Bytes of a base64 image (a data: URL prefix and line breaks allowed), or a SendError. */
export function decodeImageBase64(raw: string): Buffer {
  const b64 = raw.replace(/^data:[\w.+-]+\/[\w.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1)
    throw new SendError('imageBase64 is not valid base64.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MCP_SEND_MAX_IMAGE_BYTES) throw new SendError(IMAGE_TOO_LARGE);
  return buf;
}

/** Per-token limits: a runaway assistant loop cannot flood customers. */
export const SEND_LIMITS = {
  perMinute: { windowMs: 60_000, max: 10 },
  perDay: { windowMs: 24 * 60 * 60_000, max: 100 },
  /** Number checks for new chats (each one asks WhatsApp about a stranger's number). */
  newNumbersPerDay: { windowMs: 24 * 60 * 60_000, max: 20 },
} as const;

export const NEW_NUMBER_WARNING =
  'This person may not expect a message from this WhatsApp number. WhatsApp can ban a number that ' +
  'messages people who did not ask for it. Tell the user this, and message new numbers only when the ' +
  'person agreed to be contacted.';

/** A message-service refusal as a SendError for the model; anything unexpected as it is. */
function sendFailure(err: unknown): unknown {
  if (err instanceof SendError) return err;
  if (err instanceof HttpError && err.code === WINDOW_CLOSED)
    return new SendError(
      "window_closed: this chat's reply window has closed (the customer has not written " +
        'recently), so WhatsApp allows only an approved template now; a person can send one ' +
        'from the inbox.',
    );
  // Expected checks of the message service (moved number, quote not in this chat, ...).
  if (err instanceof HttpError && err.status < 500) return new SendError(err.message);
  return err;
}

/** The message service's clientId for this token + requestId (≤ 64 chars, never reused by the inbox). */
export function sendClientId(tokenId: number, requestId: string): string {
  return 'mcp-' + createHash('sha256').update(`${tokenId}:${requestId}`).digest('hex').slice(0, 40);
}

export function createInboxSendPort(
  ctx: AppContext,
  deps?: { now?: () => number; fetchImage?: ImageFetcher },
): InboxSendPort {
  const fetchImage = deps?.fetchImage ?? guardedImageFetcher();
  const chats = getChats(ctx);
  const messages = getMessages(ctx);
  const log = ctx.log.child({ mod: 'mcp' });
  const limiters = [
    { limiter: new WindowLimiter({ ...SEND_LIMITS.perMinute, now: deps?.now }), what: 'a minute' },
    { limiter: new WindowLimiter({ ...SEND_LIMITS.perDay, now: deps?.now }), what: 'a day' },
  ];
  const newNumbers = new WindowLimiter({ ...SEND_LIMITS.newNumbersPerDay, now: deps?.now });

  /** The existing chat of a JID or chat key (phone number or WhatsApp ID), or null. */
  const existing = (jid: string) => chats.get(chats.resolveJid(jid));

  /**
   * The inbox a new number is messaged from: `inboxId` when the owner may open that active inbox,
   * else the only active inbox in scope; with several, the caller must choose (`inbox_required`).
   */
  function senderInbox(principal: ApiPrincipal, inboxId: number | undefined): number {
    const active = scopeIds(ctx, scopeFor(ctx, principal.user));
    const list = () =>
      active.map((id) => `${id} (${ctx.inboxes.repo.get(id)?.name ?? `inbox ${id}`})`).join(', ');
    if (inboxId !== undefined) {
      if (!active.includes(inboxId))
        throw new SendError(`No inbox ${inboxId} to send from. Inboxes: ${list()}.`);
      return inboxId;
    }
    if (active.length === 1) return active[0]!;
    throw new SendError(
      `inbox_required: this team has more than one WhatsApp number; pass inboxId to choose the ` +
        `one to send from. Inboxes: ${list()}.`,
    );
  }

  return {
    sendText(principal, input) {
      return send(principal, targetChat(principal, input.jid), input);
    },

    async sendImage(principal, input) {
      const chatJid = targetChat(principal, input.jid);
      if (Boolean(input.imageUrl) === Boolean(input.imageBase64))
        throw new SendError('Pass the image as imageUrl or imageBase64 (one of them).');
      const caption = input.caption?.trim() || undefined;
      const clientId = sendClientId(principal.tokenId, input.requestId);
      // A retried requestId returns the stored message: nothing is downloaded, sent or counted again.
      const before = messages.byClientId(clientId);
      if (before) {
        if (
          before.chatJid !== chatJid ||
          before.type !== 'image' ||
          (before.body ?? undefined) !== caption
        )
          throw new SendError(
            'This requestId was already used for a different message; use a new requestId.',
          );
        return result(before, true);
      }
      countSend(principal);
      const buffer = input.imageBase64
        ? decodeImageBase64(input.imageBase64)
        : await fetchImage(input.imageUrl!);
      if (!buffer.length) throw new SendError('The image is empty.');
      // Checked on the bytes, never the link, name or label.
      const type = await fileTypeFromBuffer(buffer).catch(() => undefined);
      if (!type || !MCP_IMAGE_TYPES.has(type.mime))
        throw new SendError('Only JPEG, PNG or WebP images can be sent.');
      const base = (input.fileName?.trim() || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '');
      let msg: Message;
      try {
        msg = await messages.sendMedia(
          chatJid,
          {
            buffer,
            fileName: `${base}.${type.ext}`,
            ...(caption ? { caption } : {}),
            ...(input.quotedMessageId ? { quotedId: input.quotedMessageId } : {}),
          },
          principal.user.id,
          clientId,
          { viaTokenId: principal.tokenId },
        );
      } catch (err) {
        throw sendFailure(err);
      }
      audit(ctx.db, {
        userId: principal.user.id,
        action: 'mcp.send',
        ip: null,
        // Never the caption or the image: which token sent which message into which chat.
        meta: { tokenId: principal.tokenId, chatJid, messageId: msg.id, type: 'image' },
      });
      return result(msg, false);
    },

    async sendToNewNumber(principal, input) {
      if (!principal.scopes.has('inbox:send') || !principal.scopes.has('inbox:send_new'))
        throw new SendError('This access token cannot message new numbers.');
      const phone = normalizeNewChatPhone(input.phone);
      if (!phone)
        throw new SendError(
          'Not a phone number. Use the full number with country code, for example 60123456789.',
        );
      const inboxId = senderInbox(principal, input.inboxId);
      const wa = ctx.inboxes.connections.adapter(inboxId);
      // A Business API number may start a chat only with an approved template (never sent here).
      if (capabilitiesOf(wa).replyWindowHours !== null)
        throw new SendError(
          'template_required: this inbox uses the WhatsApp Business API, where a new chat must start ' +
            'with an approved message template; a person can send one from the inbox.',
        );
      const jid = chatKey(inboxId, `${phone}@s.whatsapp.net`);
      // The number of any inbox (linked now or before) is the team's own, never a customer.
      const own = [...ctx.inboxes.connections.ownJids()].some((j) => j.split(/[:@]/)[0] === phone);
      if (own) throw new SendError('This is a linked WhatsApp number itself.');

      // A retry, or a number that already has a chat: an ordinary send, nothing new is created.
      const known = existing(jid);
      const before = messages.byClientId(sendClientId(principal.tokenId, input.requestId));
      if (before && before.chatJid !== known?.jid)
        throw new SendError(
          'This requestId was already used for a different message; use a new requestId.',
        );
      if (known)
        return {
          ...send(principal, known.jid, input),
          newChat: false,
          warning: NEW_NUMBER_WARNING,
        };

      if (wa.status.state !== 'open')
        throw new SendError(
          'WhatsApp is not connected, so the number cannot be checked. Try again when it is connected.',
        );
      // Counted before the check: every check asks WhatsApp about a stranger's number.
      const hit = newNumbers.hit(String(principal.tokenId));
      if (!hit.allowed)
        throw new SendError(
          `Too many new numbers from this token in a day; try again in ${hit.retryAfterSec} s.`,
        );
      const found = await wa.checkNumber(phone);
      if (!found) {
        log.info({ tokenId: principal.tokenId, found: false }, 'mcp new number check');
        throw new SendError('This number does not have WhatsApp.');
      }
      // The chat may have appeared while WhatsApp answered (an inbound message, another call).
      const raced = existing(chatKey(inboxId, found));
      const chat = raced ?? chats.upsertFromWa({ jid: found, type: 'dm', name: null }, inboxId);
      if (!raced)
        audit(ctx.db, {
          userId: principal.user.id,
          action: 'mcp.new_chat',
          ip: null,
          meta: { tokenId: principal.tokenId, chatJid: chat.jid },
        });
      return { ...send(principal, chat.jid, input), newChat: !raced, warning: NEW_NUMBER_WARNING };
    },
  };

  /**
   * The existing chat a send goes to. A chat of an inbox the token owner may not open is "not found",
   * never a hint it exists. A phone or JID with chats in several inboxes is never sent from a guessed
   * number.
   */
  function targetChat(principal: ApiPrincipal, jid: string): string {
    if (!principal.scopes.has('inbox:send'))
      throw new SendError('This access token cannot send messages.');
    const found = findChats(ctx, jid, principal.user);
    if (found.length > 1) throw new SendError(ambiguousChat(ctx, jid, found));
    const chat = found[0];
    if (!chat)
      throw new SendError(
        `No chat found for ${jid}. Only existing chats can receive a message` +
          (principal.scopes.has('inbox:send_new')
            ? '; use send_to_new_number for a number that is not in the inbox.'
            : '.'),
      );
    return chat.jid;
  }

  /** Counts one new message against the token's limits, or refuses it. */
  function countSend(principal: ApiPrincipal) {
    for (const { limiter, what } of limiters) {
      const hit = limiter.hit(String(principal.tokenId));
      if (!hit.allowed)
        throw new SendError(
          `Too many messages from this token in ${what}; try again in ${hit.retryAfterSec} s.`,
        );
    }
  }

  /** Sends into a chat that exists; idempotent per token + requestId; counted and audited. */
  function send(
    principal: ApiPrincipal,
    chatJid: string,
    input: { text: string; requestId: string; quotedMessageId?: string },
  ): SendResult {
    const clientId = sendClientId(principal.tokenId, input.requestId);
    let msg: Message;
    try {
      // A retried requestId returns the stored message without sending or counting it again.
      const before = messages.byClientId(clientId);
      if (!before) countSend(principal);
      msg = messages.sendText(
        chatJid,
        { text: input.text, clientId, quotedId: input.quotedMessageId },
        principal.user.id,
        { viaTokenId: principal.tokenId },
      );
      if (before) {
        if (msg.chatJid !== chatJid || msg.body !== input.text)
          throw new SendError(
            'This requestId was already used for a different message; use a new requestId.',
          );
        return result(msg, true);
      }
    } catch (err) {
      throw sendFailure(err);
    }
    audit(ctx.db, {
      userId: principal.user.id,
      action: 'mcp.send',
      ip: null,
      // Never the text: which token sent which message into which chat.
      meta: { tokenId: principal.tokenId, chatJid, messageId: msg.id },
    });
    return result(msg, false);
  }

  /** Connection state of an inbox; a removed one has no connection. */
  function inboxState(inboxId: number) {
    return ctx.inboxes.connections.statuses().get(inboxId)?.state ?? 'disconnected';
  }

  function result(msg: Message, duplicate: boolean): SendResult {
    return {
      messageId: msg.id,
      chatJid: msg.chatJid,
      status: msg.status,
      queued: inboxState(inboxOfKey(msg.chatJid)) !== 'open' && msg.status === 'pending',
      duplicate,
    };
  }
}

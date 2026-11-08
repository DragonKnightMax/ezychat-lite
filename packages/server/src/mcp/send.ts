import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import { MCP_SEND_MAX_BASE64_BYTES, normalizeNewChatPhone, type Message } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import type { ApiPrincipal } from '../api-tokens/index.js';
import {
  BlockedAddressError,
  LONG_TRANSFER_TIMEOUT_MS,
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
import { createNewChatService } from '../chats/new-chat.js';
import { ambiguousChat, findChats } from './inbox.js';
import { MCP_FILE_TYPES, MCP_IMAGE_TYPES, MCP_VIDEO_TYPES } from './media-types.js';
import { uploadStore, type McpUpload, type UploadStore } from '../uploads/store.js';
import { inboxMaxBytes } from '../inboxes/media-limits.js';

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
  /** send_video: whether it went as a video or as a file (document). */
  sentAs?: 'video' | 'file';
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
  /** A PDF or Word .docx document (public https link, base64 or upload) into an existing chat. */
  sendFile(principal: ApiPrincipal, input: SendFileInput): Promise<SendResult>;
  /** An MP4 video (link, base64 or upload), as a video or a file, into an existing chat. */
  sendVideo(principal: ApiPrincipal, input: SendVideoInput): Promise<SendResult>;
}

export interface SendFileInput {
  jid: string;
  fileUrl?: string;
  fileBase64?: string;
  uploadId?: string;
  fileName?: string;
  caption?: string;
  requestId: string;
  quotedMessageId?: string;
}

export interface SendImageInput {
  jid: string;
  imageUrl?: string;
  imageBase64?: string;
  uploadId?: string;
  caption?: string;
  fileName?: string;
  requestId: string;
  quotedMessageId?: string;
}

export interface SendVideoInput {
  jid: string;
  videoUrl?: string;
  videoBase64?: string;
  uploadId?: string;
  /** Omitted: a video, or a file when it is above the number's video limit. */
  sendAs?: 'video' | 'file';
  caption?: string;
  fileName?: string;
  requestId: string;
  quotedMessageId?: string;
}

export { MCP_FILE_TYPES, MCP_IMAGE_TYPES, MCP_VIDEO_TYPES } from './media-types.js';

/**
 * A file to send: small bytes (base64, a test fetcher) or a private file on disk (upload, link); an
 * upload carries the type read when it arrived.
 */
export type MediaSource = Buffer | { path: string; size: number; mime?: string; ext?: string };

/**
 * Downloads an image, file or video link for a token (its transfer slots), at most `maxBytes` (the
 * chat's WhatsApp number's largest file; absent = none known); throws SendError for the model.
 */
export type ImageFetcher = (
  url: string,
  tokenId: number,
  maxBytes?: number,
) => Promise<MediaSource>;

type Attachment = 'image' | 'file' | 'video';

const tooLarge = (what: Attachment, maxBytes: number) =>
  `The ${what} is larger than ${Math.floor((maxBytes / 1024 / 1024) * 10) / 10} MB.`;

/** A failed link download, worded for the model. */
function downloadFailure(err: unknown, what: Attachment): SendError {
  if (err instanceof SendError) return err;
  if (err instanceof HttpError) return new SendError(`${err.code}: ${err.message}.`);
  if (
    err instanceof BlockedAddressError ||
    (err instanceof TypeError && err.message === 'url_private')
  )
    return new SendError(`The ${what} link must be a public internet address.`);
  if (err instanceof TypeError && err.message === 'url_not_https')
    return new SendError(`The ${what} link must start with https://.`);
  return new SendError(`The ${what} could not be downloaded from that link; check the link.`);
}

/**
 * A guarded download into a private file of the upload store: https only, never this computer or a
 * private network (checked on the address actually connected to), same-origin redirects only, at
 * most the chat's WhatsApp number's largest file (`maxBytes`) and the free disk space, 60 s without
 * data. Streamed to disk, never held in memory.
 */
function guardedDownloader(
  what: Attachment,
  accept: string,
  store: UploadStore,
  policy: FetcherPolicy | undefined,
): ImageFetcher {
  const get = guardedFetch({
    allowLoopback: false,
    timeoutMs: LONG_TRANSFER_TIMEOUT_MS,
    ...policy,
    longTransfer: true,
    // the upload store counts the bytes against the WhatsApp number's limit and the disk
    maxResponseBytes: Number.MAX_SAFE_INTEGER,
  });
  return async (url, tokenId, maxBytes) => {
    try {
      const res = await get(url, { method: 'GET', headers: { accept } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new SendError(`The ${what} link answered ${res.status}; check the link.`);
      }
      if (!res.body) throw new SendError(`The ${what} is empty.`);
      const length = Number(res.headers.get('content-length') ?? Number.NaN);
      return await store.writeTemp(
        `token:${tokenId}`,
        Readable.fromWeb(res.body as WebReadableStream),
        {
          ...(maxBytes === undefined ? {} : { maxBytes }),
          ...(Number.isFinite(length) ? { declaredLength: length } : {}),
        },
      );
    } catch (err) {
      throw downloadFailure(err, what);
    }
  };
}

type FetcherPolicy = Omit<NetPolicy, 'maxResponseBytes'>;

/** The default image download (as large as the chat's WhatsApp number takes). */
export function guardedImageFetcher(store: UploadStore, policy?: FetcherPolicy): ImageFetcher {
  return guardedDownloader('image', 'image/*', store, policy);
}

/** The default file download for send_file (PDF or .docx). */
export function guardedFileFetcher(store: UploadStore, policy?: FetcherPolicy): ImageFetcher {
  return guardedDownloader(
    'file',
    [...MCP_FILE_TYPES.keys(), '*/*;q=0.1'].join(', '),
    store,
    policy,
  );
}

/** The default video download for send_video (MP4). */
export function guardedVideoFetcher(store: UploadStore, policy?: FetcherPolicy): ImageFetcher {
  return guardedDownloader('video', 'video/mp4, */*;q=0.1', store, policy);
}

function decodeBase64(raw: string, field: string, what: Attachment): Buffer {
  const b64 = raw.replace(/^data:[\w.+-]+\/[\w.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1)
    throw new SendError(`${field} is not valid base64.`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MCP_SEND_MAX_BASE64_BYTES)
    throw new SendError(
      `${tooLarge(what, MCP_SEND_MAX_BASE64_BYTES)} Send a larger ${what} with uploadId or a link.`,
    );
  return buf;
}

/** Bytes of a base64 image (a data: URL prefix and line breaks allowed), or a SendError. */
export function decodeImageBase64(raw: string): Buffer {
  return decodeBase64(raw, 'imageBase64', 'image');
}

/** Bytes of a base64 file for send_file, or a SendError. */
export function decodeFileBase64(raw: string): Buffer {
  return decodeBase64(raw, 'fileBase64', 'file');
}

/** Bytes of a base64 video for send_video, or a SendError. */
export function decodeVideoBase64(raw: string): Buffer {
  return decodeBase64(raw, 'videoBase64', 'video');
}

/** The type of a file to send: an upload's from when it arrived, else read from the bytes. */
function typeOf(source: MediaSource): Promise<{ mime: string; ext: string } | undefined> {
  if (Buffer.isBuffer(source)) return fileTypeFromBuffer(source).catch(() => undefined);
  if (source.mime && source.ext) return Promise.resolve({ mime: source.mime, ext: source.ext });
  return fileTypeFromFile(source.path).catch(() => undefined);
}

/** Per-token limits: a runaway assistant loop cannot flood customers. */
export const SEND_LIMITS = {
  perMinute: { windowMs: 60_000, max: 10 },
  perDay: { windowMs: 24 * 60 * 60_000, max: 100 },
  /** Number checks for new chats (each one asks WhatsApp about a stranger's number). */
  newNumbersPerDay: { windowMs: 24 * 60 * 60_000, max: 20 },
} as const;

/** New chat refusals worded for the model (the service's codes; its message where it says enough). */
const NEW_CHAT_REFUSALS: Record<string, ((message: string) => string) | undefined> = {
  own_number: () => 'This is a linked WhatsApp number itself.',
  wa_disconnected: () =>
    'WhatsApp is not connected, so the number cannot be checked. Try again when it is connected.',
  not_on_whatsapp: () => 'This number does not have WhatsApp.',
  new_chat_daily_limit: (message) =>
    `${message}; the team's daily limit of new chats protects the number from a WhatsApp ban. Try again tomorrow.`,
};

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
  // WhatsApp's per-number media limits, with Forward's codes.
  if (err instanceof HttpError && err.status === 413)
    return new SendError(`${err.code}: ${err.message}.`);
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
  deps?: {
    now?: () => number;
    fetchImage?: ImageFetcher;
    fetchFile?: ImageFetcher;
    fetchVideo?: ImageFetcher;
    uploads?: UploadStore;
  },
): InboxSendPort {
  const uploads = deps?.uploads ?? uploadStore(ctx);
  const fetchImage = deps?.fetchImage ?? guardedImageFetcher(uploads);
  const fetchFile = deps?.fetchFile ?? guardedFileFetcher(uploads);
  const fetchVideo = deps?.fetchVideo ?? guardedVideoFetcher(uploads);
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

  /** Where a send's file comes from; `upload` is taken out of the store until the send ends. */
  interface Source {
    /** The file for a send into `chatJid` (a link is downloaded up to that number's limit). */
    load: (chatJid: string) => Promise<MediaSource>;
    upload?: McpUpload;
    name?: string;
  }

  /**
   * The one source of a send (link, base64 or upload). An upload is taken here, after the retry
   * check and before the send is counted, and is "not found" unless this token uploaded it, it has
   * not expired and no other send has it.
   */
  function sourceOf(
    principal: ApiPrincipal,
    what: Attachment,
    fields: { url?: string; base64?: string; uploadId?: string; names: string },
    fromUrl: ImageFetcher,
    decode: (raw: string) => Buffer,
  ): () => Source {
    const given = [fields.url, fields.base64, fields.uploadId].filter(Boolean).length;
    if (given !== 1)
      throw new SendError(`Pass the ${what} as ${fields.names} (exactly one of them).`);
    const { url, base64, uploadId } = fields;
    if (uploadId) return () => uploadSource(principal, uploadId);
    if (base64) return () => ({ load: () => Promise.resolve(decode(base64)) });
    return () => ({
      load: (chatJid) => fromUrl(url!, principal.tokenId, inboxMaxBytes(ctx, inboxOfKey(chatJid))),
    });
  }

  function uploadSource(principal: ApiPrincipal, uploadId: string): Source {
    const upload = uploads.take(principal.tokenId, uploadId);
    if (!upload)
      throw new SendError(
        `No upload ${uploadId} from this token: it was already sent, it expired (uploads are kept 1 hour) or the id is wrong. Upload the file again.`,
      );
    const { path, size, mime, ext } = upload;
    return { load: () => Promise.resolve({ path, size, mime, ext }), upload, name: upload.name };
  }

  /** What a send of one attachment kind takes and how it is worded. */
  interface AttachmentKind {
    what: Attachment;
    /** Stored message types this send may have (a video sent as a file is a document). */
    types: ReadonlyArray<Message['type']>;
    /** Read after the retry check, so a retry never needs the (used up) upload again. */
    source: () => Source;
    /** The types this tool sends, with their extensions. */
    accepts: ReadonlyMap<string, string>;
    refused: string;
    defaultName: string;
    /** A file name must come from the caller or the upload (send_file). */
    needsName?: boolean;
    /** send_video: as a file always (`true`), never, or above the number's video limit. */
    asFile?: boolean | 'auto';
  }

  interface AttachmentInput {
    jid: string;
    caption?: string;
    fileName?: string;
    requestId: string;
    quotedMessageId?: string;
  }

  /** The message an earlier call with this requestId sent, or null; a mismatch is refused. */
  function retried(
    clientId: string,
    chatJid: string,
    caption: string | undefined,
    kind: AttachmentKind,
  ): Message | null {
    const before = messages.byClientId(clientId);
    if (!before) return null;
    if (
      before.chatJid !== chatJid ||
      !kind.types.includes(before.type) ||
      (before.body ?? undefined) !== caption
    )
      throw new SendError(
        'This requestId was already used for a different message; use a new requestId.',
      );
    return before;
  }

  /** The size and the extension to send with, or a SendError for an empty or refused file. */
  async function checkedFile(source: MediaSource, kind: AttachmentKind) {
    const size = Buffer.isBuffer(source) ? source.length : source.size;
    if (!size) throw new SendError(`The ${kind.what} is empty.`);
    const type = await typeOf(source);
    const ext = type ? kind.accepts.get(type.mime) : undefined;
    if (!ext) throw new SendError(kind.refused);
    return { size, ext };
  }

  /**
   * An image, document or video into an existing chat, through the message service like a text. The
   * type is checked on the bytes, never the link, name or label; the extension comes from that type.
   * A file on disk (upload or link download) is moved into the media store, never read into memory.
   */
  async function sendAttachment(
    principal: ApiPrincipal,
    input: AttachmentInput,
    kind: AttachmentKind,
  ): Promise<SendResult> {
    const chatJid = targetChat(principal, input.jid);
    const caption = input.caption?.trim() || undefined;
    const clientId = sendClientId(principal.tokenId, input.requestId);
    // A retried requestId returns the stored message: nothing is downloaded, sent or counted again.
    const before = retried(clientId, chatJid, caption, kind);
    if (before) return result(before, true);
    const from = kind.source();
    // A link download is this send's own temporary file, an upload goes back to the store: unless
    // the send moved the file into the message.
    let source: MediaSource | null = null;
    let moved = false;
    try {
      const name = input.fileName?.trim() || from.name;
      if (kind.needsName && !name)
        throw new SendError('fileName is required with a link or base64.');
      countSend(principal);
      source = await from.load(chatJid);
      const { size, ext } = await checkedFile(source, kind);
      const base = (name || kind.defaultName).replace(/\.[A-Za-z0-9]{1,5}$/, '');
      const msg = await messages
        .sendMedia(
          chatJid,
          {
            ...(Buffer.isBuffer(source) ? { buffer: source } : { path: source.path }),
            fileName: `${base || kind.defaultName}.${ext}`,
            ...(caption ? { caption } : {}),
            ...(input.quotedMessageId ? { quotedId: input.quotedMessageId } : {}),
            ...(kind.asFile ? { asFile: kind.asFile } : {}),
          },
          principal.user.id,
          clientId,
          { viaTokenId: principal.tokenId },
        )
        .catch((err: unknown) => {
          throw sendFailure(err);
        });
      moved = true;
      audit(ctx.db, {
        userId: principal.user.id,
        action: 'mcp.send',
        ip: null,
        // Never the caption, name or file: which token sent which message into which chat.
        meta: { tokenId: principal.tokenId, chatJid, messageId: msg.id, type: msg.type, size },
      });
      const sentAs = msg.type === 'document' ? ('file' as const) : ('video' as const);
      return { ...result(msg, false), ...(kind.what === 'video' ? { sentAs } : {}) };
    } finally {
      if (!moved) giveBack(from, source);
    }
  }

  /** A send that did not move its file: a link download is deleted, an upload goes back. */
  function giveBack(from: Source, source: MediaSource | null) {
    // A refused send keeps the upload for another try (until it expires).
    if (from.upload) uploads.restore(from.upload);
    else if (source && !Buffer.isBuffer(source)) uploads.discard(source.path);
  }

  return {
    sendText(principal, input) {
      return send(principal, targetChat(principal, input.jid), input);
    },

    async sendImage(principal, input) {
      return sendAttachment(principal, input, {
        what: 'image',
        types: ['image'],
        source: sourceOf(
          principal,
          'image',
          {
            url: input.imageUrl,
            base64: input.imageBase64,
            uploadId: input.uploadId,
            names: 'imageUrl, imageBase64 or uploadId',
          },
          fetchImage,
          decodeImageBase64,
        ),
        accepts: MCP_IMAGE_TYPES,
        refused: 'Only JPEG, PNG or WebP images can be sent.',
        defaultName: 'image',
      });
    },

    async sendFile(principal, input) {
      return sendAttachment(principal, input, {
        what: 'file',
        types: ['document'],
        source: sourceOf(
          principal,
          'file',
          {
            url: input.fileUrl,
            base64: input.fileBase64,
            uploadId: input.uploadId,
            names: 'fileUrl, fileBase64 or uploadId',
          },
          fetchFile,
          decodeFileBase64,
        ),
        accepts: MCP_FILE_TYPES,
        refused: 'Only PDF or Word (.docx) files can be sent.',
        defaultName: 'document',
        needsName: true,
      });
    },

    async sendVideo(principal, input) {
      return sendAttachment(principal, input, {
        what: 'video',
        types: ['video', 'document'],
        source: sourceOf(
          principal,
          'video',
          {
            url: input.videoUrl,
            base64: input.videoBase64,
            uploadId: input.uploadId,
            names: 'videoUrl, videoBase64 or uploadId',
          },
          fetchVideo,
          decodeVideoBase64,
        ),
        accepts: MCP_VIDEO_TYPES,
        refused: 'Only MP4 videos can be sent.',
        defaultName: 'video',
        // Omitted: a video above this number's video limit goes as a file (as Forward offers);
        // `video` asked explicitly is refused with too_large_as_video instead.
        asFile: input.sendAs ? input.sendAs === 'file' : 'auto',
      });
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
      // A retry, or a number that already has a chat: an ordinary send, nothing new is created.
      const known = existing(jid);
      const before = messages.byClientId(sendClientId(principal.tokenId, input.requestId));
      if (before && before.chatJid !== known?.jid)
        throw new SendError(
          'This requestId was already used for a different message; use a new requestId.',
        );
      // The shared New chat service: own number, existing chat, connection, the inbox's daily budget
      // (after this token's own limit), checkNumber, the chat and its `chat.new_number` audit.
      let opened: { chatJid: string; created: boolean };
      try {
        opened = await (ctx.services.newChat ??= createNewChatService(ctx)).openChecked(
          principal.user,
          inboxId,
          phone,
          { via: 'mcp', tokenId: principal.tokenId },
          {
            now: deps?.now?.(),
            // Counted before the check: every check asks WhatsApp about a stranger's number.
            beforeCount: () => {
              const hit = newNumbers.hit(String(principal.tokenId));
              if (!hit.allowed)
                throw new SendError(
                  `Too many new numbers from this token in a day; try again in ${hit.retryAfterSec} s.`,
                );
            },
          },
        );
      } catch (err) {
        if (err instanceof HttpError && NEW_CHAT_REFUSALS[err.code]) {
          log.info({ tokenId: principal.tokenId, refused: err.code }, 'mcp new number check');
          throw new SendError(NEW_CHAT_REFUSALS[err.code]!(err.message));
        }
        throw err;
      }
      return {
        ...send(principal, opened.chatJid, input),
        newChat: opened.created,
        warning: NEW_NUMBER_WARNING,
      };
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

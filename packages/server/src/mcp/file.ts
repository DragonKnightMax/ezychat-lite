import { readFileSync, statSync } from 'node:fs';
import {
  MCP_FILE_MAX_IMAGE_BYTES,
  MCP_FILE_MAX_SOURCE_BYTES,
  MCP_FILE_MAX_TEXT_CHARS,
  type MessageType,
} from '@ezychat/shared';
import type { ApiPrincipal } from '../api-tokens/index.js';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { sniffImageMime } from '../ai/images.js';
import { NO_READABLE_TEXT } from '../ai/knowledge.js';
import { extractKnowledgeIsolated } from '../ai/knowledge-worker.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { canOpen, scopeFor } from '../inboxes/access.js';
import { inboxOfKeyOrNull } from '../inboxes/service.js';
import { getMessages } from '../wa-bridge/index.js';
import { ToolError } from './tools.js';

/** Per-token limit of get_message_file (each call may download and parse a file). */
export const FILE_LIMITS = { perMinute: { windowMs: 60_000, max: 30 } } as const;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** What get_message_file returns for one message: an image, a document's text, or "not supported". */
export type MessageFile =
  | { kind: 'image'; messageId: string; mime: string; size: number; base64: string }
  | {
      kind: 'pdf' | 'docx';
      messageId: string;
      size: number;
      /** Null when the document has no text (a scanned PDF). */
      text: string | null;
      truncated: boolean;
    }
  | {
      kind: 'unsupported';
      messageId: string;
      type: MessageType;
      mime: string | null;
      reason: string;
    };

/**
 * The file of one message for the token owner's AI assistant (MCP `get_message_file`): a photo as
 * image content, the text of a PDF or Word file, never a link. Only messages of the owner's inboxes;
 * never a file WhatsApp Safety rated High (locked or not), nor one whose safety check is still running.
 */
export interface MessageFilePort {
  read(principal: ApiPrincipal, messageId: string): Promise<MessageFile>;
}

interface Row {
  id: string;
  chat_jid: string;
  type: MessageType;
  media_mime: string | null;
  deleted_at: number | null;
  hidden_at: number | null;
}

/** The candidate kind from what the message says it is; the bytes decide in the end. */
function declaredKind(r: Row): 'image' | 'document' | null {
  if (r.type === 'image' || r.type === 'sticker') return 'image';
  if (r.type !== 'document') return null;
  const mime = r.media_mime ?? '';
  if (mime === 'application/pdf' || mime === DOCX_MIME || mime.startsWith('image/'))
    return mime.startsWith('image/') ? 'image' : 'document';
  // Senders often declare documents as octet-stream: the bytes are checked after the download.
  return mime === '' || mime === 'application/octet-stream' ? 'document' : null;
}

/** PDF or Word from the bytes: `%PDF-`, or a ZIP holding `word/document.xml` (the reader checks it). */
function documentFormat(bytes: Buffer): 'pdf' | 'docx' | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  return zip && bytes.includes('word/document.xml', 0, 'latin1') ? 'docx' : null;
}

export function createMessageFilePort(
  ctx: AppContext,
  deps?: {
    now?: () => number;
    extract?: (name: string, bytes: Buffer) => Promise<string>;
  },
): MessageFilePort {
  const messages = getMessages(ctx);
  const log = ctx.log.child({ mod: 'mcp' });
  const limiter = new WindowLimiter({ ...FILE_LIMITS.perMinute, now: deps?.now });
  const extract = deps?.extract ?? extractKnowledgeIsolated;

  const unsupported = (r: Row, reason: string): MessageFile => ({
    kind: 'unsupported',
    messageId: r.id,
    type: r.type,
    mime: r.media_mime,
    reason,
  });

  function done(principal: ApiPrincipal, r: Row, file: MessageFile, size: number) {
    // Never the file name, text or bytes: which message, what kind and how large.
    log.info(
      { tokenId: principal.tokenId, messageId: r.id, kind: file.kind, size },
      'mcp message file read',
    );
    if (file.kind !== 'unsupported')
      audit(ctx.db, {
        userId: principal.user.id,
        action: 'mcp.read_file',
        ip: null,
        meta: { tokenId: principal.tokenId, messageId: r.id, kind: file.kind, size },
      });
    return file;
  }

  /** Fail closed: High (locked, released or deleted) and files the AI check may still raise. */
  function safetyRefusal(id: string): string | null {
    const safety = ctx.services.safety;
    if (!safety) return null;
    if (safety.levelOf(id) === 'high')
      return 'This file is locked by WhatsApp Safety and cannot be read through an AI assistant.';
    if (!safety.cacheable(id))
      return 'WhatsApp Safety flagged this file and has not finished checking it; open it in the app.';
    return null;
  }

  return {
    async read(principal, messageId) {
      const hit = limiter.hit(String(principal.tokenId));
      if (!hit.allowed)
        throw new ToolError(
          `Too many file reads from this token in a minute; try again in ${hit.retryAfterSec} s.`,
        );
      const r = ctx.db
        .prepare(
          'SELECT id, chat_jid, type, media_mime, deleted_at, hidden_at FROM messages WHERE id = ?',
        )
        .get(messageId) as Row | undefined;
      const inboxId = r ? inboxOfKeyOrNull(r.chat_jid) : null;
      // Another inbox, a hidden message and an unknown id all read the same: not found.
      if (
        !r ||
        r.hidden_at != null ||
        inboxId === null ||
        !canOpen(scopeFor(ctx, principal.user), inboxId)
      )
        throw new ToolError(`No message found for ${messageId}.`);
      if (r.deleted_at != null) throw new ToolError('This message was deleted; its file is gone.');
      if (r.type === 'text' || r.type === 'system')
        throw new ToolError('This message has no file.');

      const refused = safetyRefusal(r.id);
      if (refused) throw new ToolError(refused);
      const kind = declaredKind(r);
      if (!kind)
        return done(
          principal,
          r,
          unsupported(r, 'Only photos (JPEG, PNG, WebP), PDF and Word (.docx) files can be read.'),
          0,
        );

      // History media is downloaded on demand here, as when a teammate opens it in the app.
      const media = await messages.ensureMedia(r.id);
      if (media === 'unavailable')
        throw new ToolError('The file could not be downloaded from WhatsApp.');
      if (!media) throw new ToolError('This message has no stored file.');
      const size = statSync(media.path).size;
      if (size > MCP_FILE_MAX_SOURCE_BYTES)
        throw new ToolError(
          `The file is too large to read (${MB(size)}; the limit is ${MB(MCP_FILE_MAX_SOURCE_BYTES)}).`,
        );
      const bytes = readFileSync(media.path);

      const imageMime = sniffImageMime(bytes);
      if (imageMime) {
        if (size > MCP_FILE_MAX_IMAGE_BYTES)
          throw new ToolError(
            `The photo is too large to return (${MB(size)}; the limit is ${MB(MCP_FILE_MAX_IMAGE_BYTES)}). Open it in the app.`,
          );
        return done(
          principal,
          r,
          {
            kind: 'image',
            messageId: r.id,
            mime: imageMime,
            size,
            base64: bytes.toString('base64'),
          },
          size,
        );
      }
      const format = kind === 'document' ? documentFormat(bytes) : null;
      if (!format)
        return done(
          principal,
          r,
          unsupported(r, 'The file is not a photo (JPEG, PNG, WebP), PDF or Word (.docx) file.'),
          size,
        );
      let text: string;
      try {
        // A fixed name: the worker picks the reader by extension and never sees the sender's name.
        text = await extract(`file.${format}`, bytes);
      } catch (err) {
        const reason = err instanceof Error ? err.message : '';
        // A scan has no text: a result (text null), not an error.
        if (reason !== NO_READABLE_TEXT)
          throw new ToolError(
            `The ${format === 'pdf' ? 'PDF' : 'Word file'} could not be read` +
              (reason && err instanceof HttpError ? `: ${reason}` : '.'),
          );
        text = '';
      }
      text = text.replaceAll('\0', '').replace(/\r\n?/g, '\n').trim();
      const truncated = text.length > MCP_FILE_MAX_TEXT_CHARS;
      return done(
        principal,
        r,
        {
          kind: format,
          messageId: r.id,
          size,
          text: text ? text.slice(0, MCP_FILE_MAX_TEXT_CHARS) : null,
          truncated,
        },
        size,
      );
    },
  };
}

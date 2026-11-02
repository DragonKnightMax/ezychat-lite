import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DeleteMessageQuery,
  EditMessageBody,
  MessageListQuery,
  SendMediaFields,
  SendReactionBody,
  SendTextBody,
  type Message,
  type MessageEditsResponse,
  type SendReactionResponse,
} from '@ezychat/shared';
import { audit } from '../db/audit.js';
import { CHANGES_PER_MINUTE } from '../messages/changes.js';
import { requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { errors, parse } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { getChats, getMessages } from '../wa-bridge/index.js';
import { requireMessageAccess } from '../inboxes/service.js';
import { chatJidParam } from './chats.js';

const IdParams = z.object({ id: z.string().min(1).max(256) });

/** Reactions per user and minute: enough for real use, too few for a flood that risks the number. */
export const REACTIONS_PER_MINUTE = 30;

export default async function messagesRoutes(app: FastifyInstance, ctx: AppContext) {
  const messages = getMessages(ctx);
  const chats = getChats(ctx);
  app.addHook('preHandler', requireUser(ctx));
  const reactionLimiter = new WindowLimiter({ windowMs: 60_000, max: REACTIONS_PER_MINUTE });
  const changeLimiter = new WindowLimiter({ windowMs: 60_000, max: CHANGES_PER_MINUTE });
  const limitChange = (userId: number) => {
    const limited = changeLimiter.hit(String(userId));
    if (!limited.allowed) throw errors.rateLimited(limited.retryAfterSec);
  };

  app.get('/chats/:jid/messages', async (req) => {
    const jid = chatJidParam(ctx, req);
    if (!chats.get(jid)) throw errors.notFound('Chat');
    const q = parse(MessageListQuery, req.query);
    return messages.list(jid, q);
  });

  app.post('/chats/:jid/messages', async (req, reply) => {
    const jid = chatJidParam(ctx, req);
    const body = parse(SendTextBody, req.body);
    const msg = messages.sendText(jid, body, req.user!.id);
    return reply.status(201).send(msg);
  });

  app.post('/chats/:jid/media', async (req, reply) => {
    const jid = chatJidParam(ctx, req);
    if (!req.isMultipart()) throw errors.validation('Expected multipart/form-data');
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; fileName: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || file) {
          part.file.resume();
          continue;
        }
        file = { buffer: await part.toBuffer(), fileName: part.filename || 'file' };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
    if (!file) throw errors.validation('file is required');
    const f = parse(SendMediaFields, fields);
    if (f.voiceNote && f.caption) throw errors.validation('A voice note has no caption');
    const msg = await messages.sendMedia(
      jid,
      {
        buffer: file.buffer,
        fileName: file.fileName,
        ...(f.caption ? { caption: f.caption } : {}),
        ...(f.quotedId ? { quotedId: f.quotedId } : {}),
        ...(f.voiceNote ? { voiceNote: true } : {}),
      },
      req.user!.id,
      f.clientId,
    );
    return reply.status(201).send(msg);
  });

  app.post('/messages/:id/retry', async (req) => {
    const { id } = parse(IdParams, req.params);
    requireMessageAccess(ctx, req.user!, id);
    return messages.retry(id, req.user!.id);
  });

  app.put('/messages/:id/reaction', async (req): Promise<SendReactionResponse> => {
    const { id } = parse(IdParams, req.params);
    requireMessageAccess(ctx, req.user!, id);
    const { emoji } = parse(SendReactionBody, req.body);
    const limited = reactionLimiter.hit(String(req.user!.id));
    if (!limited.allowed) throw errors.rateLimited(limited.retryAfterSec);
    return { messageId: id, reactions: await messages.sendReaction(id, emoji, req.user!.id) };
  });

  // Edit a message the team sent (its teammate or an admin, within 15 minutes). Audit: ids only.
  app.patch('/messages/:id', async (req): Promise<Message> => {
    const { id } = parse(IdParams, req.params);
    requireMessageAccess(ctx, req.user!, id);
    const { text } = parse(EditMessageBody, req.body);
    limitChange(req.user!.id);
    const message = await messages.editMessage(id, text, req.user!);
    audit(ctx.db, {
      userId: req.user!.id,
      action: 'message.edit',
      ip: req.ip,
      meta: { messageId: id, chatJid: message.chatJid },
    });
    return message;
  });

  // Delete for everyone (its teammate or an admin, within 2 days) or for the team (admins).
  app.delete('/messages/:id', async (req): Promise<Message> => {
    const { id } = parse(IdParams, req.params);
    requireMessageAccess(ctx, req.user!, id);
    const { scope } = parse(DeleteMessageQuery, req.query);
    limitChange(req.user!.id);
    const message = await messages.deleteMessage(id, scope, req.user!);
    audit(ctx.db, {
      userId: req.user!.id,
      action: 'message.delete',
      ip: req.ip,
      meta: { messageId: id, chatJid: message.chatJid, scope },
    });
    return message;
  });

  app.get('/messages/:id/edits', async (req): Promise<MessageEditsResponse> => {
    const { id } = parse(IdParams, req.params);
    requireMessageAccess(ctx, req.user!, id);
    return messages.messageEdits(id, req.user!.role === 'admin');
  });
}

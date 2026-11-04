import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ChatListQuery, ChatPatchBody, ResolveAllChatsBody } from '@ezychat/shared';
import { requireAdmin, requireUser } from '../auth/guards.js';
import { clientIp } from '../http/client-ip.js';
import type { AppContext } from '../context.js';
import { errors, parse } from '../http/errors.js';
import { getChats } from '../wa-bridge/index.js';
import { profilePhotoLookup } from '../http/profile-images.js';
import { avatarStore, sendAvatar } from '../avatars/http.js';
import { scopeFor } from '../inboxes/access.js';
import { chatWaState, requireChatAccess } from '../inboxes/service.js';

export const JidParams = z.object({ jid: z.string().min(3).max(256) });

/**
 * Parses `:jid` into the chat key the signed-in user may open: a phone number re-keyed to its
 * WhatsApp ID opens that chat (old links, push); a missing chat, a malformed key and a chat of an
 * inbox the user may not open all answer 404.
 */
export function chatJidParam(ctx: AppContext, req: FastifyRequest): string {
  const { jid } = parse(JidParams, req.params);
  return requireChatAccess(ctx, req.user!, jid).jid;
}

export default async function chatsRoutes(app: FastifyInstance, ctx: AppContext) {
  const chats = getChats(ctx);
  app.addHook('preHandler', requireUser(ctx));
  app.get('/chats/open-count', { preHandler: requireAdmin(ctx) }, async () => ({
    openCount: chats.openCount(),
  }));
  app.post('/chats/resolve-all', { preHandler: requireAdmin(ctx) }, async (req) => {
    parse(ResolveAllChatsBody, req.body);
    const resolvedCount = chats.resolveAll(req.user!.id, clientIp(req));
    return { resolvedCount };
  });
  // Only visible image requests query WhatsApp; the store keeps the bytes for a day (bounded, coalesced).
  const photos = avatarStore(ctx);
  app.get('/chats/:jid/avatar', async (req, reply) => {
    const jid = chatJidParam(ctx, req);
    // the chat's own number looks the picture up; a removed inbox has none
    const state = chatWaState(ctx, jid);
    if (state === null) return reply.header('cache-control', 'no-store').code(204).send();
    // while disconnected, only what is already kept (a failed lookup is never cached by the browser)
    const photo =
      state === 'open'
        ? await photos.get(jid, profilePhotoLookup(ctx, jid))
        : await photos.stored(jid);
    return sendAvatar(req, reply, photo);
  });

  app.get('/chats', async (req) => {
    const q = parse(ChatListQuery, req.query);
    const scope = scopeFor(ctx, req.user!);
    // every inbox (removed ones too) for admins; an agent's own active inboxes otherwise
    const inboxIds = scope === 'all' ? undefined : [...scope];
    return chats.list(q, req.user!.id, { inboxIds, inbox: q.inbox });
  });

  app.get('/chats/:jid', async (req) => {
    const jid = chatJidParam(ctx, req);
    const chat = chats.get(jid);
    if (!chat) throw errors.notFound('Chat');
    return { chat, events: chats.events(jid) };
  });

  app.patch('/chats/:jid', async (req) => {
    const jid = chatJidParam(ctx, req);
    const body = parse(ChatPatchBody, req.body ?? {});
    return chats.patch(jid, body, req.user!.id);
  });

  app.post('/chats/:jid/read', async (req) => {
    const jid = chatJidParam(ctx, req);
    await chats.markRead(jid, req.user!.id);
    return { ok: true };
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ReplyCompleteBody,
  ReplyPhraseBody,
  ReplyPhraseFeedbackBody,
  ReplyPhraseRebuildBody,
  ReplySuggestionsBody,
  type ReplySuggestionsStatus,
} from '@ezychat/shared';
import {
  replySuggestionsEnabled,
  replySuggestionsUpgraded,
  setReplySuggestions,
  setReplySuggestionsModel,
} from '../ai/reply-suggestions-setting.js';
import { requireAdmin, requireUser } from '../auth/guards.js';
import { ChatRepo } from '../chats/repo.js';
import type { AppContext } from '../context.js';
import { clientIp } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { chatJidParam } from './chats.js';

/**
 * AI reply suggestions (design: docs/features/ai-reply-suggestions/design.md): the team-wide switch
 * (any user reads it at /api/reply-suggestions, admins change it at /api/ai/reply-suggestions) and the two per-chat calls. Per-chat routes answer 404
 * outside the caller's inboxes (`chatJidParam`) and work in direct chats and groups.
 */
export default async function replySuggestionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireUser(ctx));
  const ai = ctx.services.ai!;
  const chats = new ChatRepo(ctx.db);
  const suggestLimiter = new WindowLimiter({ windowMs: 60_000, max: 20 });
  const completeLimiter = new WindowLimiter({ windowMs: 60_000, max: 60 });
  const limit = (limiter: WindowLimiter, req: FastifyRequest) => {
    const result = limiter.hit(String(req.user!.id));
    if (!result.allowed) throw errors.rateLimited(result.retryAfterSec);
  };
  const status = (): ReplySuggestionsStatus => {
    const enabled = replySuggestionsEnabled(ctx.settings);
    const connection = ai.draftConnection();
    return {
      enabled,
      connected: connection === 'ready',
      state:
        !enabled || connection === 'none' ? 'off' : connection === 'ready' ? 'on' : 'unavailable',
      upgraded: replySuggestionsUpgraded(ctx.settings),
    };
  };
  /** A chat the caller may open; the model call stops when the client goes away. */
  const draftChat = (req: FastifyRequest, reply: FastifyReply) => {
    const jid = chatJidParam(ctx, req);
    const cancel = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) cancel.abort();
    });
    return { jid, signal: cancel.signal };
  };

  // Outside /api/ai on purpose: every /api/ai route is admin-only (ai-routes-access.test.ts).
  app.get('/reply-suggestions', async () => status());
  app.put('/ai/reply-suggestions', { preHandler: requireAdmin(ctx) }, async (req) => {
    const { enabled, model } = parse(ReplySuggestionsBody, req.body);
    if (model !== undefined && !ai.isSuggestModel(model))
      throw errors.validation('Choose Fast, Same as the AI agent or a model of this connection');
    const actor = { userId: req.user!.id, ip: clientIp(req) };
    if (enabled !== undefined) setReplySuggestions(ctx, enabled, actor);
    if (model !== undefined) setReplySuggestionsModel(ctx, model, actor);
    return status();
  });
  app.get('/ai/reply-suggestions/model', { preHandler: requireAdmin(ctx) }, async () =>
    ai.suggestModelInfo(),
  );

  // The phrase list (docs/features/ai-phrase-dictionary/design.md). Every composer loads its chat's
  // list and matches it locally; admins manage it under /api/ai/phrases.
  const phrases = () => ctx.services.phrases!;
  const feedbackLimiter = new WindowLimiter({ windowMs: 60_000, max: 120 });
  const PhraseId = z.object({ id: z.coerce.number().int().positive() });
  const AgentQuery = z.object({
    // `?agentId=` (empty) = the agent of inbox 1.
    agentId: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce.number().int().positive().optional(),
    ),
  });
  const actorOf = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });
  app.get('/chats/:jid/ai/phrases', async (req) => {
    const jid = chatJidParam(ctx, req);
    return { phrases: chats.get(jid)?.type === 'dm' ? phrases().forChat(jid) : [] };
  });
  app.post('/chats/:jid/ai/phrases/:id/feedback', async (req, reply) => {
    limit(feedbackLimiter, req);
    const jid = chatJidParam(ctx, req);
    const { id } = parse(PhraseId, req.params);
    const { accepted } = parse(ReplyPhraseFeedbackBody, req.body);
    phrases().feedback(jid, id, accepted);
    return reply.status(204).send();
  });
  app.get('/ai/phrases', { preHandler: requireAdmin(ctx) }, async (req) =>
    phrases().admin(parse(AgentQuery, req.query).agentId),
  );
  app.post('/ai/phrases', { preHandler: requireAdmin(ctx) }, async (req) =>
    phrases().add(parse(ReplyPhraseBody, req.body), actorOf(req)),
  );
  app.put('/ai/phrases/:id', { preHandler: requireAdmin(ctx) }, async (req) =>
    phrases().update(
      parse(PhraseId, req.params).id,
      parse(ReplyPhraseBody, req.body),
      actorOf(req),
    ),
  );
  app.delete('/ai/phrases/:id', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    phrases().remove(parse(PhraseId, req.params).id, actorOf(req));
    return reply.status(204).send();
  });
  app.post('/ai/phrases/rebuild', { preHandler: requireAdmin(ctx) }, async (req) =>
    phrases().rebuild(parse(ReplyPhraseRebuildBody, req.body ?? {}).agentId, actorOf(req)),
  );
  app.post('/chats/:jid/ai/suggestions', async (req, reply) => {
    limit(suggestLimiter, req);
    const { jid, signal } = draftChat(req, reply);
    return ai.draftReply(jid, { kind: 'suggest' }, signal);
  });
  app.post('/chats/:jid/ai/complete', async (req, reply) => {
    const { text } = parse(ReplyCompleteBody, req.body);
    limit(completeLimiter, req);
    const { jid, signal } = draftChat(req, reply);
    return ai.draftReply(jid, { kind: 'complete', typed: text }, signal);
  });
}

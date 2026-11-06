import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AskEzyRequest, type AskEzyEvent, type AskEzyStatus } from '@ezychat/shared';
import { requireAdmin, requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { clientIp } from '../http/client-ip.js';
import { HttpError, errors, parse } from '../http/errors.js';
import { chosenChats } from '../inboxes/access.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { createAskEzyService } from '../ask-ezy/service.js';

/** Questions a user may ask per minute (each one costs model usage). */
export const ASK_EZY_PER_MINUTE = 20;

/**
 * Ask Ezy (design: docs/features/ask-ezy/design.md). Every signed-in user asks; the answer streams as NDJSON
 * (`AskEzyEvent` per line) and stops when the client goes away. Changes Ezy proposed apply only through the
 * admin routes below.
 */
export default async function askEzyRoutes(app: FastifyInstance, ctx: AppContext) {
  const service = createAskEzyService(ctx);
  const limiter = new WindowLimiter({ windowMs: 60_000, max: ASK_EZY_PER_MINUTE });

  app.get('/ask-ezy/status', { preHandler: requireUser(ctx) }, async (): Promise<AskEzyStatus> =>
    service.status(),
  );

  app.post('/ask-ezy', { preHandler: requireUser(ctx) }, async (req, reply) => {
    const body = parse(AskEzyRequest, req.body);
    const user = req.user!;
    // Ask Ezy reads across chats: never for an agent limited to chosen chats
    if (chosenChats(ctx, user))
      throw new HttpError(403, 'chat_scope_limited', 'Ask Ezy is not available for this account');
    const hit = limiter.hit(String(user.id));
    if (!hit.allowed) throw errors.rateLimited(hit.retryAfterSec);
    const cancel = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) cancel.abort();
    });
    let started = false;
    const write = (event: AskEzyEvent) => {
      if (!started) {
        started = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
      }
      if (!reply.raw.writableEnded) reply.raw.write(JSON.stringify(event) + '\n');
    };
    // An error before the first line (no connection, unknown chat) is a normal JSON error answer.
    await service.ask(user, body, write, cancel.signal);
    if (!started) write({ type: 'error', code: 'ai_unavailable' });
    reply.raw.end();
  });

  const ChangeParams = z.object({
    id: z.string().min(1).max(64),
    action: z.enum(['apply', 'discard', 'undo']),
  });
  app.post('/ask-ezy/changes/:id/:action', { preHandler: requireAdmin(ctx) }, async (req) => {
    const { id, action } = parse(ChangeParams, req.params);
    const user = req.user!;
    const ip = clientIp(req);
    if (action === 'apply') return service.changes.apply(id, user, ip);
    if (action === 'discard') return service.changes.discard(id, user);
    return service.changes.undo(id, user, ip);
  });
}

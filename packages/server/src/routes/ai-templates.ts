import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { errors } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { getTemplateList } from '../templates/service.js';

/** Longest wait of `POST /ai/templates/refresh` (each download times out after 10 s). */
export const REFRESH_WAIT_MS = 12_000;

/**
 * AI agent template list (docs/features/template-store/design.md), admins only:
 * `GET /ai/templates` (the saved copy, no download) and `POST /ai/templates/refresh` (the gallery
 * calls it when it opens; one download per 30 s for the whole server, 10 calls a minute per admin).
 */
export default async function aiTemplateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireAdmin(ctx));
  const limiter = new WindowLimiter({ windowMs: 60_000, max: 10 });

  app.get('/ai/templates', async () => getTemplateList(ctx).catalog());

  app.post('/ai/templates/refresh', async (req) => {
    const hit = limiter.hit(String(req.user!.id));
    if (!hit.allowed) throw errors.rateLimited(hit.retryAfterSec);
    const list = getTemplateList(ctx);
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REFRESH_WAIT_MS);
      timer.unref();
    });
    try {
      await Promise.race([list.refresh(), wait]);
    } finally {
      clearTimeout(timer);
    }
    return list.catalog();
  });
}

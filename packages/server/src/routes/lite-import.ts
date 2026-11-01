import type { FastifyInstance } from 'fastify';
import { LiteImportNoticeUpdate, type LiteImportNotice } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { parse } from '../http/errors.js';
import { readNotice, updateNotice } from '../lite-import/notice.js';

/**
 * The after-import notice (admins): the team checklist after a merge and the "connect AI assistants
 * again" flag. Information only, so it is not host-only; the import itself runs from the desktop.
 */
export default async function liteImportRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/lite-import/notice', admin, async (): Promise<LiteImportNotice> =>
    readNotice(ctx.settings),
  );

  app.put('/lite-import/notice', admin, async (req): Promise<LiteImportNotice> => {
    const body = parse(LiteImportNoticeUpdate, req.body ?? {});
    return updateNotice(ctx.settings, body);
  });
}

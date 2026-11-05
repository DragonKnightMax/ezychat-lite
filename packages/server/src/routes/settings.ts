import type { FastifyInstance } from 'fastify';
import { SettingsPatchBody } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import { createSettingsService, type SettingsService } from '../admin/settings-service.js';
import { zipLogs } from '../admin/logs.js';
import { backupStamp } from '../backup/backup.js';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { clientIp } from '../http/client-ip.js';
import { parse } from '../http/errors.js';
import { setUsageStats } from '../usage/service.js';

function settingsService(ctx: AppContext): SettingsService {
  return (ctx.services.admin ??= createSettingsService(ctx));
}

/** Admin: GET/PATCH /api/settings, GET /api/logs/download. */
export default async function settingsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireAdmin(ctx));

  app.get('/settings', async () => settingsService(ctx).get());

  app.patch('/settings', async (req) => {
    const body = parse(SettingsPatchBody, req.body ?? {});
    // The usage stats switch has its own audit row (before/after); turning it on sends at once.
    if (body.usageStats !== undefined) {
      setUsageStats(ctx, body.usageStats, { userId: req.user?.id ?? null, ip: clientIp(req) });
      if (body.usageStats) void ctx.services.usage?.check();
    }
    const result = settingsService(ctx).patch(body);
    audit(ctx.db, {
      userId: req.user?.id ?? null,
      action: 'settings.update',
      ip: clientIp(req),
      meta: { changes: body, restartRequired: result.restartRequired },
    });
    return result;
  });

  app.get('/logs/download', async (req, reply) => {
    audit(ctx.db, { userId: req.user?.id ?? null, action: 'logs.download', ip: clientIp(req) });
    const zip = zipLogs(ctx.config.dataDir);
    zip.on('error', (err) => ctx.log.warn({ err }, 'logs zip failed'));
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="wa-team-inbox-logs-${backupStamp(new Date())}.zip"`)
      .header('cache-control', 'no-store')
      .send(zip);
  });
}

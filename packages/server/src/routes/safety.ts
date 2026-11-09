import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ReportQuery,
  SafetyAction,
  SafetyActionBody,
  SafetyChatAction,
  SafetyChatActionBody,
  SafetySettingsBody,
  type SafetyChatState,
  type SafetyReport,
  type SafetySettings,
  type SafetyState,
} from '@ezychat/shared';
import { AI_TIMEZONE_SETTING, resolveAiTimeZone } from '../ai/prompt.js';
import { requireAdmin, requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { errors, parse } from '../http/errors.js';
import { clientIp } from '../http/client-ip.js';
import { reportInboxScope } from '../reports/scope.js';
import { computeSafetyReport } from '../reports/safety.js';
import { chatJidParam } from './chats.js';

const ItemParams = z.object({ id: z.coerce.number().int().positive(), action: SafetyAction });
const ChatActionParams = z.object({ action: SafetyChatAction });

/**
 * WhatsApp Safety (docs/features/whatsapp-safety/design.md). Admins: the flagged messages, blocked
 * numbers, settings and actions (`/safety*`), and the Reports section (`/reports/safety`). Anyone
 * who may open a chat: its bar (`/safety/chats/:jid`).
 */
export default async function safetyRoutes(app: FastifyInstance, ctx: AppContext) {
  const safety = () => {
    const s = ctx.services.safety;
    if (!s) throw errors.notFound('WhatsApp Safety');
    return s;
  };

  app.get(
    '/safety/chats/:jid',
    { preHandler: requireUser(ctx) },
    async (req): Promise<SafetyChatState> => safety().chatState(chatJidParam(ctx, req)),
  );

  // Admins: block or unblock any direct chat's number, flagged or not (the Customer panel).
  app.post(
    '/safety/chats/:jid/:action',
    { preHandler: requireAdmin(ctx) },
    async (req): Promise<SafetyChatState> => {
      const { action } = parse(ChatActionParams, req.params);
      return safety().actOnChat(
        chatJidParam(ctx, req),
        action,
        parse(SafetyChatActionBody, req.body ?? {}),
        req.user!,
        clientIp(req),
      );
    },
  );

  app.get('/safety', { preHandler: requireAdmin(ctx) }, async (): Promise<SafetyState> =>
    safety().state(),
  );

  app.put(
    '/safety/settings',
    { preHandler: requireAdmin(ctx) },
    async (req): Promise<SafetySettings> =>
      safety().setSettings(parse(SafetySettingsBody, req.body ?? {}), req.user!.id, clientIp(req)),
  );

  app.post(
    '/safety/items/:id/:action',
    { preHandler: requireAdmin(ctx) },
    async (req): Promise<SafetyState> => {
      const { id, action } = parse(ItemParams, req.params);
      await safety().act(
        id,
        action,
        parse(SafetyActionBody, req.body ?? {}),
        req.user!,
        clientIp(req),
      );
      return safety().state();
    },
  );

  app.get(
    '/reports/safety',
    { preHandler: requireAdmin(ctx) },
    async (req): Promise<SafetyReport> => {
      const { days, inbox } = parse(ReportQuery, req.query ?? {});
      return computeSafetyReport(ctx.db, {
        days,
        inboxIds: reportInboxScope(ctx.db, inbox),
        timeZone: resolveAiTimeZone(ctx.settings.get<unknown>(AI_TIMEZONE_SETTING, null)),
        now: Date.now(),
        enabled: safety().settings().enabled,
      });
    },
  );
}

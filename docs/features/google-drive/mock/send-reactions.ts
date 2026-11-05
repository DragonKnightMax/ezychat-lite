import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { FakeWaAdapter } from '@ezychat/wa';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireUser } from '../../../../packages/server/src/auth/guards.js';
import { errors, parse } from '../../../../packages/server/src/http/errors.js';
import { parseChatKey } from '../../../../packages/server/src/inboxes/keys.js';

/** Who in the team sent the linked number's current reaction to a message (mock memory only). */
export interface TeamReaction {
  userId: number;
  name: string;
  emoji: string;
  /** The reaction's timestamp: a later phone reaction has another one, so the name no longer applies. */
  at: number;
}

const ReactBody = z.object({ messageId: z.string().min(1), emoji: z.string().max(16) });
const OfflineBody = z.object({ offline: z.boolean() });

/**
 * Proposed (send-reactions): stand-ins for the routes the app will add. `POST /api/mock/react`
 * makes the fake phone send the linked number's reaction (WhatsApp keeps one per number, so a new
 * emoji from any teammate replaces it and '' removes it) and remembers which teammate sent it.
 * `GET /api/mock/react` lists those names. `POST /api/mock/wa-offline` takes the fake phone
 * offline and back, to show the disabled state. Inbox 1 only, like the rest of this demo.
 */
export function registerSendReactions(
  app: FastifyInstance,
  ctx: AppContext,
  wa: FakeWaAdapter,
): void {
  const team = new Map<string, TeamReaction>();

  app.get('/api/mock/react', { preHandler: requireUser(ctx) }, async () =>
    Object.fromEntries(team),
  );

  app.post('/api/mock/react', { preHandler: requireUser(ctx) }, async (req) => {
    const body = parse(ReactBody, req.body ?? {});
    if (wa.status.state !== 'open') throw errors.waUnavailable();
    const message = ctx.db
      .prepare('SELECT chat_jid, wa_remote_jid FROM messages WHERE id = ?')
      .get(body.messageId) as { chat_jid: string; wa_remote_jid: string | null } | undefined;
    if (!message || body.messageId.startsWith('local-')) throw errors.notFound('Message');
    const reaction = wa.simulateReaction({
      chatJid: message.wa_remote_jid ?? parseChatKey(message.chat_jid).waJid,
      targetId: body.messageId,
      emoji: body.emoji,
      fromMe: true,
    });
    const user = req.user!;
    if (body.emoji)
      team.set(body.messageId, {
        userId: user.id,
        name: user.displayName,
        emoji: body.emoji,
        at: reaction.timestamp,
      });
    else team.delete(body.messageId);
    return { messageId: body.messageId, emoji: body.emoji, at: reaction.timestamp };
  });

  app.post('/api/mock/wa-offline', { preHandler: requireUser(ctx) }, async (req) => {
    const { offline } = parse(OfflineBody, req.body ?? {});
    wa.simulateStatus({ state: offline ? 'connecting' : 'open' });
    return { state: wa.status.state };
  });
}

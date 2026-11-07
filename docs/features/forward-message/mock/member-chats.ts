import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';

/**
 * Proposed (limited chat access; folder `partner-role`), mock only: an agent whose "Chats this member
 * can see" is **Only chosen chats** opens only the direct chats and groups an admin picked, and works
 * there exactly like any agent. Stand-in routes `/api/mock/member-chats*` keep each agent's choice in
 * memory; the web copy reads them to filter the chat list. Production (design.md): `users.chat_scope`
 * ('all' | 'chosen') + table `member_chats` (migration 036), the scope in `inboxes/access.ts`, 404
 * outside the chosen chats, per-chat socket rooms and filtered push.
 */

interface MemberChats {
  scope: 'all' | 'chosen';
  chats: Set<string>;
}

const state = new Map<number, MemberChats>();
const of = (userId: number): MemberChats => state.get(userId) ?? { scope: 'all', chats: new Set() };

export function registerMemberChats(app: FastifyInstance, ctx: AppContext): void {
  const view = (userId: number) => {
    const m = of(userId);
    return {
      userId,
      scope: m.scope,
      chats: [...m.chats].map((jid) => {
        const row = ctx.db.prepare('SELECT name, type FROM chats WHERE jid = ?').get(jid) as
          { name: string; type: 'dm' | 'group' } | undefined;
        return { jid, name: row?.name || jid, type: row?.type ?? 'dm' };
      }),
    };
  };

  /** Admins: every member's choice. Anyone else: their own (the web filters its list with it). */
  app.get('/api/mock/member-chats', { preHandler: requireUser(ctx) }, async (req) => {
    const me = req.user!;
    if (me.role !== 'admin') return { me: view(me.id) };
    const ids = (
      ctx.db
        .prepare("SELECT id FROM users WHERE kind = 'human' AND role = 'agent'")
        .all() as Array<{
        id: number;
      }>
    ).map((r) => r.id);
    return { me: view(me.id), members: ids.map(view) };
  });

  app.put('/api/mock/member-chats/:userId', { preHandler: requireAdmin(ctx) }, async (req) => {
    const { userId } = z.object({ userId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        scope: z.enum(['all', 'chosen']),
        chats: z.array(z.string().min(3).max(256)).max(2000),
      })
      .parse(req.body);
    // "All chats" keeps nothing: switching back never leaves a hidden list behind.
    state.set(userId, {
      scope: body.scope,
      chats: new Set(body.scope === 'chosen' ? body.chats : []),
    });
    return view(userId);
  });
}

/** Demo: Ravi sees 3 chosen chats, Sofia is limited with none chosen yet. */
export function seedMemberChats(ravi: number, sofia: number): void {
  state.set(ravi, {
    scope: 'chosen',
    chats: new Set([
      '60128814455@s.whatsapp.net', // Priya Nair
      '60129001234@s.whatsapp.net', // Jason Lim
      '120363025550002@g.us', // Kopi Lovers Club (group)
    ]),
  });
  state.set(sofia, { scope: 'chosen', chats: new Set() });
}

// Proposed (mobile-redesign, owner 2026-11-07): tags on WhatsApp GROUP chats, like on direct chats.
// Stand-in for the proposed `PUT /api/chats/:jid/tags` (direct chats and groups alike) and for the
// read model change (`rowToChat` returns a group's tags too). The tags go into the real
// `customer_tags` table (keyed by chat_jid, no foreign key, no type check), so the server's own tag
// filter, search and tag suggestions already include tagged groups; only the read model still hides
// them, so the client reads group tags from GET /api/mock/group-tags.
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { CUSTOMER_TAG_MAX_CHARS, customerTagKey, normalizeTag } from '@ezychat/shared';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireUser } from '../../../../packages/server/src/auth/guards.js';
import { audit } from '../../../../packages/server/src/db/audit.js';
import { CustomerRepo } from '../../../../packages/server/src/customers/repo.js';
import { chatJidParam } from '../../../../packages/server/src/routes/chats.js';

const TagsBody = z.object({
  tags: z
    .array(z.string().transform(normalizeTag).pipe(z.string().min(1).max(CUSTOMER_TAG_MAX_CHARS)))
    .max(10),
});

/** Seeded group tags: the wholesale partners group and the fan club. */
const SEED: Record<string, string[]> = {
  'Kopi Lovers Club': ['Community'],
  'Reseller Group Penang': ['Wholesale', 'VIP'],
};

export function registerGroupTags(app: FastifyInstance, ctx: AppContext): void {
  const log = ctx.log.child({ mod: 'mock-group-tags' });
  const repo = new CustomerRepo(ctx.db);
  let seeded = false;

  const write = (jid: string, tags: string[]) => {
    const canonical = repo.canonicalTags(tags, jid);
    const now = Date.now();
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM customer_tags WHERE chat_jid = ?').run(jid);
      const insert = ctx.db.prepare(
        'INSERT INTO customer_tags (chat_jid, tag, tag_key, created_at) VALUES (?, ?, ?, ?)',
      );
      canonical.forEach((tag, i) => insert.run(jid, tag, customerTagKey(tag), now + i));
    })();
    return canonical;
  };

  const groups = () =>
    ctx.db.prepare("SELECT jid, name FROM chats WHERE type = 'group'").all() as Array<{
      jid: string;
      name: string | null;
    }>;

  const seed = () => {
    if (seeded) return;
    seeded = true;
    for (const g of groups())
      for (const [prefix, tags] of Object.entries(SEED))
        if (g.name?.startsWith(prefix)) write(g.jid, tags);
  };

  /** Every group chat's tags (the app returns them on `Chat.tags`, filtered by access). */
  app.get('/api/mock/group-tags', { preHandler: requireUser(ctx) }, () => {
    seed();
    const out: Record<string, string[]> = {};
    for (const g of groups()) {
      const tags = repo.tags(g.jid);
      if (tags.length) out[g.jid] = tags;
    }
    return out;
  });

  /** Mock of `PUT /api/chats/:jid/tags` for a group (a direct chat keeps its profile route here). */
  app.put('/api/mock/group-tags/:jid', { preHandler: requireUser(ctx) }, (req, reply) => {
    seed();
    const jid = chatJidParam(ctx, req); // 404 outside the caller's inboxes / chosen chats
    const row = ctx.db.prepare('SELECT type FROM chats WHERE jid = ?').get(jid) as
      { type: string } | undefined;
    if (row?.type !== 'group')
      return reply
        .status(400)
        .send({ error: 'not_a_group', message: 'Use the customer profile for a direct chat' });
    const { tags } = TagsBody.parse(req.body);
    const before = repo.tags(jid);
    const saved = write(jid, tags);
    if (before.join('\u001f') !== saved.join('\u001f'))
      audit(ctx.db, {
        userId: req.user!.id,
        action: 'chat.tags',
        ip: req.ip,
        // Field names and ids only, never the tag text (same rule as customer profile audits).
        meta: { chatJid: jid, fields: ['tags'], count: saved.length },
      });
    log.info({ userId: req.user!.id, count: saved.length }, 'group tags saved');
    return { tags: saved };
  });
}

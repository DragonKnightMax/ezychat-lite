import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { FakeWaAdapter } from '@ezychat/wa';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireUser } from '../../../../packages/server/src/auth/guards.js';
import { audit } from '../../../../packages/server/src/db/audit.js';
import { errors, parse } from '../../../../packages/server/src/http/errors.js';

/** WhatsApp lets the sender edit a message for 15 minutes. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** WhatsApp lets the sender delete a message for everyone for about 2 days. */
export const DELETE_WINDOW_MS = 2 * 24 * 60 * 60_000;

type By = 'customer' | 'team' | 'phone';

/** One earlier version of an edited message. */
interface EditEntry {
  /** The text before this edit. */
  previous: string;
  at: number;
  by: By;
  /** The teammate who edited (team edits only). */
  name: string | null;
}

/** What the proposal adds to a stored message (the app keeps it in `messages` + `message_edits`). */
interface Change {
  /** Current text after the last edit. */
  body?: string;
  editedAt?: number;
  edits: EditEntry[];
  deletedAt?: number;
  deletedBy?: By;
  deletedByName?: string | null;
  /** The text before deletion: admins only ("Show original"). */
  original?: string | null;
  /** Delete for me: hidden for the whole team. */
  hiddenAt?: number;
}

interface Row {
  id: string;
  chat_jid: string;
  from_me: number;
  sent_by_user_id: number | null;
  type: string;
  body: string | null;
  timestamp: number;
  wa_remote_jid: string | null;
}

const EditBody = z.object({ text: z.string().trim().min(1).max(4096) });
const DeleteBody = z.object({ scope: z.enum(['everyone', 'me']) });
const SimulateBody = z.object({
  chatJid: z.string().min(1),
  action: z.enum(['customerEdit', 'customerDelete', 'phoneEdit', 'phoneDelete']),
});
const ClockBody = z.object({
  offsetMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 7),
});

const DEMO_CHAT = '60125550142@s.whatsapp.net';

let seedFn: (() => Promise<void>) | null = null;

/** Seeds the edit/delete demo in Ahmad Zulkifli's chat (Kopi Apong, a linked phone). */
export async function seedEditDelete(): Promise<void> {
  await seedFn?.();
}

/**
 * Proposed (message-edit-delete): stand-ins for `PATCH /api/messages/:id`,
 * `DELETE /api/messages/:id?scope=` and `GET /api/messages/:id/edits`, plus a simulator for
 * incoming edits and deletes (Baileys `MESSAGE_EDIT` / `REVOKE`). Changes live in mock memory and
 * are laid over the stored messages by the web; the real messages stay as the core stored them.
 */
export function registerEditDelete(app: FastifyInstance, ctx: AppContext, wa: FakeWaAdapter): void {
  const changes = new Map<string, Change>();
  let offsetMs = 0;
  const now = () => Date.now() + offsetMs;
  const change = (id: string) => {
    let c = changes.get(id);
    if (!c) changes.set(id, (c = { edits: [] }));
    return c;
  };
  const row = (id: string) =>
    ctx.db
      .prepare(
        'SELECT id, chat_jid, from_me, sent_by_user_id, type, body, timestamp, wa_remote_jid FROM messages WHERE id = ?',
      )
      .get(id) as Row | undefined;
  const nameOf = (userId: number) =>
    (
      ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
        { display_name: string } | undefined
    )?.display_name ?? null;

  /** Who may edit or delete for everyone: the teammate who sent it, or an admin (phone/AI: admins). */
  const mayChange = (r: Row, user: { id: number; role: string }) =>
    user.role === 'admin' || (r.sent_by_user_id !== null && r.sent_by_user_id === user.id);

  const requireOwnSendable = (r: Row | undefined, user: { id: number; role: string }) => {
    if (!r || r.id.startsWith('local-') || r.type === 'system') throw errors.notFound('Message');
    if (r.from_me !== 1) throw errors.validation('Only messages the team sent can be changed');
    if (changes.get(r.id)?.deletedAt) throw errors.conflict('This message was deleted');
    if (!mayChange(r, user)) throw errors.forbidden();
    if (wa.status.state !== 'open') throw errors.waUnavailable();
  };

  app.get('/api/mock/message-changes', { preHandler: requireUser(ctx) }, async (req) => {
    const admin = req.user!.role === 'admin';
    const out: Record<string, Change> = {};
    for (const [id, c] of changes) out[id] = admin ? c : { ...c, original: undefined };
    return { now: now(), offsetMinutes: Math.round(offsetMs / 60_000), changes: out };
  });

  app.patch('/api/mock/messages/:id', { preHandler: requireUser(ctx) }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { text } = parse(EditBody, req.body ?? {});
    const r = row(id);
    requireOwnSendable(r, req.user!);
    if (r!.type !== 'text' && !r!.body)
      throw errors.validation('Only text and captions can be edited');
    if (now() - r!.timestamp > EDIT_WINDOW_MS)
      throw errors.conflict('This message can no longer be edited (15 minutes after sending)');
    const c = change(id);
    const current = c.body ?? r!.body ?? '';
    if (text === current) return c;
    c.edits.push({ previous: current, at: now(), by: 'team', name: req.user!.displayName });
    c.body = text;
    c.editedAt = now();
    audit(ctx.db, {
      userId: req.user!.id,
      action: 'message.edit',
      ip: req.ip,
      meta: { messageId: id, chatJid: r!.chat_jid },
    });
    return c;
  });

  app.post('/api/mock/messages/:id/delete', { preHandler: requireUser(ctx) }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { scope } = parse(DeleteBody, req.body ?? {});
    const r = row(id);
    const user = req.user!;
    if (scope === 'me') {
      if (!r || r.type === 'system') throw errors.notFound('Message');
      if (user.role !== 'admin') throw errors.forbidden();
      if (wa.status.state !== 'open') throw errors.waUnavailable();
      change(id).hiddenAt = now();
    } else {
      requireOwnSendable(r, user);
      if (now() - r!.timestamp > DELETE_WINDOW_MS)
        throw errors.conflict('This message can no longer be deleted for everyone (2 days)');
      const c = change(id);
      c.original = c.body ?? r!.body;
      c.deletedAt = now();
      c.deletedBy = 'team';
      c.deletedByName = user.displayName;
    }
    audit(ctx.db, {
      userId: user.id,
      action: 'message.delete',
      ip: req.ip,
      meta: { messageId: id, chatJid: r!.chat_jid, scope },
    });
    return changes.get(id);
  });

  app.post('/api/mock/message-changes/simulate', { preHandler: requireUser(ctx) }, async (req) => {
    const { chatJid, action } = parse(SimulateBody, req.body ?? {});
    const fromMe = action.startsWith('phone') ? 1 : 0;
    const candidates = ctx.db
      .prepare(
        "SELECT id, chat_jid, from_me, sent_by_user_id, type, body, timestamp, wa_remote_jid FROM messages WHERE chat_jid = ? AND from_me = ? AND type <> 'system' AND id NOT LIKE 'local-%' ORDER BY timestamp DESC LIMIT 20",
      )
      .all(chatJid, fromMe) as Row[];
    const target = candidates.find((m) => !changes.get(m.id)?.deletedAt && m.body);
    if (!target) throw errors.notFound('Message');
    applyRemote(target, action.endsWith('Edit') ? 'edit' : 'delete', fromMe ? 'phone' : 'customer');
    return { messageId: target.id };
  });

  /** An edit or delete that WhatsApp reports (the customer, or the linked phone). */
  const applyRemote = (r: Row, kind: 'edit' | 'delete', by: By, text?: string) => {
    const c = change(r.id);
    const current = c.body ?? r.body ?? '';
    if (kind === 'edit') {
      c.edits.push({ previous: current, at: now(), by, name: null });
      c.body = text ?? `${current} (edited)`;
      c.editedAt = now();
    } else {
      c.original = current;
      c.deletedAt = now();
      c.deletedBy = by;
      c.deletedByName = null;
    }
  };

  app.post('/api/mock/message-changes/clock', { preHandler: requireUser(ctx) }, async (req) => {
    offsetMs = parse(ClockBody, req.body ?? {}).offsetMinutes * 60_000;
    return { offsetMinutes: offsetMs / 60_000 };
  });

  app.post('/api/mock/message-changes/reset', { preHandler: requireUser(ctx) }, async () => {
    changes.clear();
    offsetMs = 0;
    await seedFn?.();
    return { ok: true };
  });

  // ------------------------------------------------------------------ seed
  const seeded: Record<string, string> = {};
  const sendAs = async (userId: number, text: string, clientId: string) => {
    const existing = ctx.db.prepare('SELECT id FROM messages WHERE client_id = ?').get(clientId) as
      { id: string } | undefined;
    if (!existing) ctx.services.messages!.sendText(DEMO_CHAT, { text, clientId }, userId);
    for (let i = 0; i < 100; i++) {
      const m = ctx.db
        .prepare("SELECT id FROM messages WHERE client_id = ? AND id NOT LIKE 'local-%'")
        .get(clientId) as { id: string } | undefined;
      if (m) return m.id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`seed edit-delete: ${clientId} not sent`);
  };
  const incoming = (key: string, body: string, fromMe = false) => {
    if (!seeded[key])
      seeded[key] = wa.simulateIncoming({
        chatJid: DEMO_CHAT,
        body,
        fromMe,
        senderName: fromMe ? null : 'Ahmad Zulkifli',
      }).id;
    return seeded[key];
  };
  const user = (username: string) =>
    (ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;

  seedFn = async () => {
    const aisyah = user('aisyah');
    const daniel = user('daniel');
    const price = await sendAs(aisyah, 'Yes, we open 10am to 6pm on Hari Raya.', 'seed-edit-price');
    const order = incoming('order', 'Great, 3 Kopi Peng for pickup at 11am please.');
    const wrong = incoming('wrong', 'Sorry, wrong chat 🙈');
    const fee = await sendAs(daniel, 'Pickup is at the Jalan Burma branch.', 'seed-delete-fee');
    incoming('free', 'Pickup is at our Georgetown shop, see you then 👍', true);
    await sendAs(daniel, 'Your order is being prepared now!', 'seed-edit-recent');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const at = (minutesAgo: number) => now() - minutesAgo * 60_000;
    changes.set(price, {
      body: 'Yes, we open 10am to 4pm on Hari Raya.',
      editedAt: at(3),
      edits: [
        {
          previous: 'Yes, we open 10am to 6pm on Hari Raya.',
          at: at(3),
          by: 'team',
          name: 'Aisyah',
        },
      ],
    });
    changes.set(order, {
      body: 'Great, 4 Kopi Peng for pickup at 11.30am please.',
      editedAt: at(2),
      edits: [
        {
          previous: 'Great, 3 Kopi Peng for pickup at 11am please.',
          at: at(2),
          by: 'customer',
          name: null,
        },
      ],
    });
    changes.set(wrong, {
      edits: [],
      original: 'Sorry, wrong chat 🙈',
      deletedAt: at(1),
      deletedBy: 'customer',
      deletedByName: null,
    });
    changes.set(fee, {
      edits: [],
      original: 'Pickup is at the Jalan Burma branch.',
      deletedAt: at(1),
      deletedBy: 'team',
      deletedByName: nameOf(daniel),
    });
  };
}

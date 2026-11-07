import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin } from '../../../../packages/server/src/auth/guards.js';

/**
 * Proposed (scheduled-tasks), mock only. The task list, schedule and run history live in the browser
 * (src/mock/scheduledTasks.ts); this file only (1) seeds a staff group with yesterday's scheduled
 * message and (2) lets "Run now" put the agent's message into the real chat, so the chat view shows
 * it with the "Scheduled" mark. Production: `scheduled/` service + `ai_scheduled_tasks` tables, see
 * ../design.md. The mark is read from the message's clientId prefix here (`sched-<taskId>-…`);
 * production stores `messages.scheduled_task_id`.
 */
export const STAFF_GROUP = {
  jid: '120363025550005@g.us',
  name: 'Kopi Apong Staff',
  members: [
    { phone: '60127000201', name: 'Hafiz (shift lead)', role: 'admin' },
    { phone: '60127000202', name: 'Mei Ling' },
    { phone: '60127000203', name: 'Ravi' },
    { phone: '60127000204', name: 'Siti (kitchen)' },
  ],
} as const;

export const SEED_BOOKINGS_TEXT = [
  "Good morning team ☀️ Today's bookings (Thu 5 Nov):",
  '• 10:00 am – Farah Aziz, 4 pax, birthday cake',
  '• 12:30 pm – Anchor Sprint lunch, 12 pax (set B)',
  '• 7:30 pm – Tan Wei Jie, 2 pax, window seat',
  'Have a good shift!',
].join('\n');

const aiUser = (ctx: AppContext) =>
  ctx.db
    .prepare("SELECT id, display_name FROM users WHERE kind = 'ai' ORDER BY id LIMIT 1")
    .get() as { id: number; display_name: string } | undefined;

/** Sends one AI message as the agent with a `sched-` clientId; the chat keeps its assignee. */
async function aiSend(ctx: AppContext, jid: string, taskId: string, text: string, at?: number) {
  const ai = aiUser(ctx);
  if (!ai) throw new Error('No AI member');
  const before = (
    ctx.db.prepare('SELECT assigned_to FROM chats WHERE jid = ?').get(jid) as
      { assigned_to: number | null } | undefined
  )?.assigned_to;
  const clientId = `sched-${taskId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Owner for the instant of the send only (as the group mock does), so the send claims nothing.
  ctx.db.prepare('UPDATE chats SET assigned_to = ? WHERE jid = ?').run(ai.id, jid);
  try {
    ctx.services.messages!.sendText(jid, { text, clientId }, ai.id);
  } finally {
    ctx.db.prepare('UPDATE chats SET assigned_to = ? WHERE jid = ?').run(before ?? null, jid);
  }
  for (let i = 0; i < 60; i++) {
    const row = ctx.db.prepare('SELECT status FROM messages WHERE client_id = ?').get(clientId) as
      { status: string } | undefined;
    if (row && row.status !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Demo data: the seeded AI member may be off, which cancels its queued sends; show them as sent.
  ctx.db
    .prepare(
      "UPDATE messages SET status = 'sent', error = NULL WHERE client_id = ? AND status IN ('failed', 'pending')",
    )
    .run(clientId);
  if (at)
    ctx.db
      .prepare('UPDATE messages SET timestamp = ?, created_at = ? WHERE client_id = ?')
      .run(at, at, clientId);
  const chat = ctx.services.chats!.get(jid);
  if (chat) ctx.bus.emit('chat:updated', chat);
  return clientId;
}

/** "Aina looked up Bookings today (Google Calendar)": the existing ai_tool_used chat line. */
function lookedUp(ctx: AppContext, jid: string, title: string, sourceLabel: string, at: number) {
  const ai = aiUser(ctx);
  const payload = { title, sourceLabel };
  const row = ctx.db
    .prepare(
      "INSERT INTO chat_events (chat_jid, type, actor_id, payload, at) VALUES (?, 'ai_tool_used', ?, ?, ?)",
    )
    .run(jid, ai?.id ?? null, JSON.stringify(payload), at);
  ctx.bus.emit('chat:event', {
    id: Number(row.lastInsertRowid),
    chatJid: jid,
    type: 'ai_tool_used',
    actorId: ai?.id ?? null,
    payload,
    at,
  });
}

/** Seeds Kopi Apong Staff: a member's message and yesterday's 8:30 scheduled bookings message. */
export async function seedScheduledTasks(
  ctx: AppContext,
  call: (method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown) => Promise<unknown>,
): Promise<void> {
  await call('POST', '/dev/fake-group', {
    groupJid: STAFF_GROUP.jid,
    name: STAFF_GROUP.name,
    members: STAFF_GROUP.members.map((m) => ({ ...m, role: 'role' in m ? m.role : 'member' })),
  });
  // Yesterday 8:30 am in the business time zone (Asia/Kuala_Lumpur, UTC+8), whatever the host's zone.
  const yesterday = new Date(Date.now() + 8 * 3_600_000 - 86_400_000);
  yesterday.setUTCHours(0, 30, 0, 0);
  lookedUp(ctx, STAFF_GROUP.jid, 'Bookings today', 'Google Calendar', yesterday.getTime() - 4_000);
  await aiSend(ctx, STAFF_GROUP.jid, 'st-bookings', SEED_BOOKINGS_TEXT, yesterday.getTime());
}

/** Mock-only route behind Run now (admins): the browser built the text; this sends it as the agent. */
export function registerScheduledTasks(app: FastifyInstance, ctx: AppContext): void {
  const Body = z.object({
    chatJid: z.string().min(1).max(200),
    taskId: z.string().regex(/^[a-z0-9-]{1,40}$/),
    text: z.string().min(1).max(4000),
    lookup: z.object({ title: z.string().max(80), source: z.string().max(80) }).nullable(),
  });
  app.post('/api/mock/scheduled-tasks/send', { preHandler: requireAdmin(ctx) }, async (request) => {
    const body = Body.parse(request.body);
    if (!ctx.services.chats!.get(body.chatJid)) return { ok: false, reason: 'chat_missing' };
    if (body.lookup)
      lookedUp(ctx, body.chatJid, body.lookup.title, body.lookup.source, Date.now() - 1);
    const clientId = await aiSend(ctx, body.chatJid, body.taskId, body.text);
    return { ok: true, clientId };
  });
}

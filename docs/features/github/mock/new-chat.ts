import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';
import { audit } from '../../../../packages/server/src/db/audit.js';
import { HttpError, parse } from '../../../../packages/server/src/http/errors.js';
import { CustomerRepo } from '../../../../packages/server/src/customers/repo.js';
import { getChats, getMessages } from '../../../../packages/server/src/wa-bridge/index.js';

/**
 * Proposed (new-chat): start a chat with a number that is not in the inbox yet. Mock stand-in for
 * `POST /api/inboxes/:id/new-chat/check` and `POST /api/inboxes/:id/new-chat` (design.md). The mock keeps
 * the inboxes in the browser, so the browser sends the inbox's kind; the app reads it from the inbox's
 * `WaAdapter.capabilities` on the server and never trusts the client for it.
 *
 * Fixed demo rules: a number ending in 0 is not on WhatsApp; the linked numbers themselves are refused.
 */

/** Mock-only scenarios, switched from the dashed Mock only box in the dialog. */
type Scenario = 'normal' | 'disconnected' | 'daily_limit' | 'template_error';

const PER_USER_PER_HOUR = 5;
const OWN_NUMBERS = new Set(['60123456789', '60137770000', '60327855000', '60000000000']);

export interface MockNewChatState {
  /** Settings → General: team members (not only admins) may start new chats. Off by default. */
  staffEnabled: boolean;
  /** May the signed-in user start a new chat (admin, or the switch is on)? */
  allowed: boolean;
  scenario: Scenario;
  /** New numbers checked today per inbox (shared with the MCP tool in the app). */
  usedToday: Record<string, number>;
  /** perInboxPerDay: the admin's setting (default 20; 0 = no limit). Linked phones only. */
  limits: { perInboxPerDay: number; perUserPerHour: number };
}

const InboxKind = z.enum(['linked_phone', 'business_api']);
const CheckBody = z.object({
  inboxId: z.string().min(1).max(64),
  inboxKind: InboxKind,
  phone: z.string().max(40),
});
const CreateBody = CheckBody.extend({
  name: z.string().trim().max(100).optional(),
  template: z
    .object({
      name: z.string().min(1).max(512),
      language: z.string().min(1).max(15),
      params: z.array(z.string().trim().min(1).max(1024)).max(20),
      text: z.string().min(1).max(4096),
    })
    .optional(),
});

/**
 * Digits of an international number. Accepts `+60 12-345 6789`, `0060…`, `60…` and Malaysian local
 * `012-345 6789` (a leading 0 becomes +60, the default country). null: not a phone number.
 */
export function normalizePhone(raw: string, defaultCountry = '60'): string | null {
  const trimmed = raw.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    /* already international */
  } else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  // Malaysian mobiles: +60 1x, 9–10 digits after the country code.
  if (digits.startsWith('601') && (digits.length < 11 || digits.length > 12)) return null;
  return digits;
}

const fail = (status: number, code: string, message: string) =>
  new HttpError(status, code, message);

export function registerNewChat(app: FastifyInstance, ctx: AppContext): void {
  let staffEnabled = false;
  /** Settings → New chats per day, per WhatsApp number (0 = no limit). */
  let dailyLimit = 20;
  let scenario: Scenario = 'normal';
  const usedToday = new Map<string, number>();
  /** user id → timestamps of the last hour's checks. */
  const usedHour = new Map<number, number[]>();
  const chats = getChats(ctx);
  const messages = getMessages(ctx);
  const profiles = new CustomerRepo(ctx.db);
  const log = ctx.log.child({ mod: 'mock-new-chat' });

  const state = (user: { role: string }): MockNewChatState => ({
    staffEnabled,
    allowed: user.role === 'admin' || staffEnabled,
    scenario,
    usedToday: Object.fromEntries(usedToday),
    limits: { perInboxPerDay: dailyLimit, perUserPerHour: PER_USER_PER_HOUR },
  });

  const guard = (user: { role: string }) => {
    if (!state(user).allowed)
      throw fail(403, 'new_chat_not_allowed', 'Only admins can start new chats');
  };

  /** The read-only part: format, own number, an existing chat, what comes next. Never asks WhatsApp. */
  const precheck = (body: z.infer<typeof CheckBody>) => {
    const phone = normalizePhone(body.phone);
    if (!phone) throw fail(400, 'invalid_number', 'Not a phone number');
    if (OWN_NUMBERS.has(phone))
      throw fail(400, 'own_number', 'This is one of your own WhatsApp numbers');
    const existing = chats.get(`${phone}@s.whatsapp.net`);
    if (existing) return { phone, existing };
    if (scenario === 'disconnected')
      throw fail(503, 'wa_disconnected', 'This WhatsApp number is not connected');
    return { phone, existing: null };
  };

  app.get('/api/mock/new-chat', { preHandler: requireUser(ctx) }, (req) => state(req.user!));

  app.put('/api/mock/new-chat', { preHandler: requireAdmin(ctx) }, (req) => {
    const body = parse(
      z.object({
        staffEnabled: z.boolean().optional(),
        dailyLimit: z.number().int().min(0).max(1000).optional(),
      }),
      req.body,
    );
    if (body.staffEnabled !== undefined && body.staffEnabled !== staffEnabled) {
      audit(ctx.db, {
        userId: req.user!.id,
        action: 'settings.new_chat_staff',
        ip: req.ip,
        meta: { before: staffEnabled, after: body.staffEnabled },
      });
      staffEnabled = body.staffEnabled;
    }
    if (body.dailyLimit !== undefined && body.dailyLimit !== dailyLimit) {
      audit(ctx.db, {
        userId: req.user!.id,
        action: 'settings.new_chat_daily_limit',
        ip: req.ip,
        meta: { before: dailyLimit, after: body.dailyLimit },
      });
      dailyLimit = body.dailyLimit;
    }
    return state(req.user!);
  });

  // Mock only: the dashed box in the dialog switches the scenario (any signed-in user).
  app.put('/api/mock/new-chat/scenario', { preHandler: requireUser(ctx) }, (req) => {
    scenario = parse(
      z.object({ scenario: z.enum(['normal', 'disconnected', 'daily_limit', 'template_error']) }),
      req.body,
    ).scenario;
    if (scenario === 'normal') {
      usedToday.clear();
      usedHour.clear();
    }
    return state(req.user!);
  });

  /** Mock of `POST /api/inboxes/:id/new-chat/check`: no WhatsApp call, not counted. */
  app.post('/api/mock/new-chat/check', { preHandler: requireUser(ctx) }, (req) => {
    guard(req.user!);
    const body = parse(CheckBody, req.body);
    const { phone, existing } = precheck(body);
    if (existing) return { next: 'existing', phone, chatJid: existing.jid };
    return { next: body.inboxKind === 'business_api' ? 'template' : 'check', phone };
  });

  /** Mock of `POST /api/inboxes/:id/new-chat`: counted, then checked (linked phone) or template sent. */
  app.post('/api/mock/new-chat', { preHandler: requireUser(ctx) }, async (req, reply) => {
    const user = req.user!;
    guard(user);
    const body = parse(CreateBody, req.body);
    const { phone, existing } = precheck(body);
    if (existing) return reply.status(200).send({ chatJid: existing.jid, created: false });

    const api = body.inboxKind === 'business_api';
    if (api && !body.template)
      throw fail(400, 'template_required', 'A new chat on this number starts with a template');

    // Counted before WhatsApp is asked (every check asks about a stranger's number). The daily
    // limit is for linked phones only (owner 2026-11-06); a Business API inbox has only the hourly one.
    const today = usedToday.get(body.inboxId) ?? 0;
    if (!api && (scenario === 'daily_limit' || (dailyLimit > 0 && today >= dailyLimit)))
      throw fail(429, 'new_chat_daily_limit', `This number started ${dailyLimit} new chats today`);
    const hour = (usedHour.get(user.id) ?? []).filter((at) => at > Date.now() - 3_600_000);
    if (hour.length >= PER_USER_PER_HOUR)
      throw fail(429, 'new_chat_hourly_limit', 'You started 5 new chats in the last hour');
    if (!api) usedToday.set(body.inboxId, today + 1);
    usedHour.set(user.id, [...hour, Date.now()]);

    // Stand-in for WhatsApp answering (checkNumber / the template send).
    await new Promise((r) => setTimeout(r, 900));
    if (!api && phone.endsWith('0'))
      throw fail(404, 'not_on_whatsapp', 'This number is not on WhatsApp');
    if (api && scenario === 'template_error')
      throw fail(502, 'template_failed', 'WhatsApp did not accept the template');

    const chat = chats.upsertFromWa({ jid: `${phone}@s.whatsapp.net`, type: 'dm', name: null });
    if (body.name)
      profiles.save(
        chat.jid,
        { name: body.name, company: '', email: '', otherPhone: '', address: '' },
        [],
        user.id,
        Date.now(),
      );
    chats.patch(chat.jid, { assignedTo: user.id }, user.id);
    // The Business API's first message is the template (stored as its filled body, like the app).
    if (api && body.template)
      messages.sendText(
        chat.jid,
        { text: body.template.text, clientId: `new-chat-${randomUUID()}` },
        user.id,
      );
    audit(ctx.db, {
      userId: user.id,
      action: 'chat.new_number',
      ip: req.ip,
      meta: { inboxId: body.inboxId, chatJid: chat.jid, userId: user.id, via: 'app' },
    });
    log.info({ inboxId: body.inboxId, userId: user.id, api }, 'new chat started');
    return reply.status(201).send({ chatJid: chat.jid, created: true });
  });
}

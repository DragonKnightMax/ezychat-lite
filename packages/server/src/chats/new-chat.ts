import {
  NEW_CHAT_DEFAULT_DAILY_LIMIT,
  NEW_CHAT_FALLBACK_COUNTRY,
  NEW_CHAT_MAX_DAILY_LIMIT,
  NEW_CHAT_PER_USER_PER_HOUR,
  countryCodeOf,
  normalizeLocalPhone,
  type NewChatBody,
  type NewChatCheckResponse,
  type NewChatMode,
  type NewChatResponse,
  type NewChatSettingsBody,
  type NewChatStatus,
  type User,
} from '@ezychat/shared';
import type { WaAdapter } from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { HttpError, errors } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { canOpen, chosenChats, scopeFor, scopeIds } from '../inboxes/access.js';
import { chatKey } from '../inboxes/keys.js';
import { capabilitiesOf } from '../inboxes/types.js';
import { getChats, getMessages } from '../wa-bridge/index.js';

/**
 * New chat (design docs/features/new-chat/design.md): start a WhatsApp chat with a number that is not in
 * the inbox yet, one number at a time. The only way to create a chat with a stranger's number: the app
 * dialog (`/api/inboxes/:id/new-chat`) and MCP `send_to_new_number` both come through here.
 *
 * Who: admins always; agents while `new_chat_staff` is on, from inboxes they may open; never an agent
 * limited to chosen chats, the AI or any other role. How, from the connection's capabilities only: no
 * reply window → the number is checked on WhatsApp and an empty chat opens; a reply window with
 * templates → the first message is an approved template, and the chat exists only once it is sent.
 * Limits, counted before WhatsApp is asked: the admin's daily limit per linked phone (shared with MCP;
 * 0 = none) and 5 an hour per person. Audit `chat.new_number` and logs carry ids only.
 */

export const NEW_CHAT_STAFF_KEY = 'new_chat_staff';
export const NEW_CHAT_DAILY_LIMIT_KEY = 'new_chat_daily_limit';
const DAY_MS = 24 * 60 * 60_000;
const IDEMPOTENCY_MS = 10 * 60_000;

type Actor = Pick<User, 'id' | 'role' | 'kind'>;

/** Who started it: the inbox (app) or an AI assistant's access token (MCP). */
export type NewChatVia = { via: 'app'; ip: string | null } | { via: 'mcp'; tokenId: number };

export interface NewChatService {
  /** `GET /api/new-chat`: whether the user may start chats, the settings and their inboxes. */
  status(user: Actor): NewChatStatus;
  /** Admins: the switch and the daily limit, each audited with before/after when it changes. */
  updateSettings(body: NewChatSettingsBody, actor: { userId: number; ip: string | null }): void;
  /** Format, own number, existing chat (alias-aware), connection: never asks WhatsApp, not counted. */
  check(user: Actor, inboxId: number, phone: string): NewChatCheckResponse;
  /** The dialog's Start: counted, then checked (linked phone) or the template sent (Business API). */
  start(
    user: Actor,
    inboxId: number,
    body: NewChatBody,
    ip: string | null,
  ): Promise<NewChatResponse>;
  /**
   * MCP `send_to_new_number` (a linked phone, digits already normalised): the same own-number,
   * existing-chat and connection checks, the shared daily budget (after `beforeCount`, the token's own
   * limit), `checkNumber` and the chat. Throws HttpError; the caller words it for the model.
   */
  openChecked(
    user: Actor,
    inboxId: number,
    digits: string,
    via: NewChatVia,
    opts?: { beforeCount?: () => void; now?: number },
  ): Promise<NewChatResponse>;
}

declare module '../context.js' {
  interface Services {
    newChat?: NewChatService;
  }
}

/** Fixed 24-hour windows per inbox whose limit is read on every hit (the admin may change it). */
class DailyBudget {
  private readonly windows = new Map<number, { start: number; count: number }>();

  used(inboxId: number, now: number): number {
    const w = this.windows.get(inboxId);
    return w && now - w.start < DAY_MS ? w.count : 0;
  }

  /** Counts one new number; false (nothing counted) when the limit is reached. 0 = no limit. */
  hit(inboxId: number, limit: number, now: number): boolean {
    let w = this.windows.get(inboxId);
    if (!w || now - w.start >= DAY_MS) {
      w = { start: now, count: 0 };
      this.windows.set(inboxId, w);
    }
    if (limit > 0 && w.count >= limit) return false;
    w.count++;
    return true;
  }
}

const fail = (status: number, code: string, message: string) =>
  new HttpError(status, code, message);

export function createNewChatService(
  ctx: AppContext,
  deps?: { now?: () => number },
): NewChatService {
  const now = deps?.now ?? Date.now;
  const log = ctx.log.child({ mod: 'new-chat' });
  const chats = getChats(ctx);
  const messages = getMessages(ctx);
  const daily = new DailyBudget();
  const hourly = new WindowLimiter({
    windowMs: 60 * 60_000,
    max: NEW_CHAT_PER_USER_PER_HOUR,
    now: () => now(),
  });
  const requests = new Map<string, { at: number; result: Promise<NewChatResponse> }>();

  const staffEnabled = () => ctx.settings.get<boolean>(NEW_CHAT_STAFF_KEY, false) === true;
  const dailyLimit = () => {
    const v = ctx.settings.get<number>(NEW_CHAT_DAILY_LIMIT_KEY, NEW_CHAT_DEFAULT_DAILY_LIMIT);
    return Number.isInteger(v) && v >= 0 && v <= NEW_CHAT_MAX_DAILY_LIMIT
      ? v
      : NEW_CHAT_DEFAULT_DAILY_LIMIT;
  };

  /** Admins always; agents with the switch on, unless limited to chosen chats; nobody else. */
  const allowed = (user: Actor): boolean => {
    if (user.kind === 'ai') return false;
    if (user.role === 'admin') return true;
    if (user.role !== 'agent') return false;
    return staffEnabled() && chosenChats(ctx, user) === null;
  };

  const modeOf = (wa: WaAdapter): NewChatMode => {
    const caps = capabilitiesOf(wa);
    if (caps.replyWindowHours === null) return 'check';
    return caps.templates && wa.sendTemplate ? 'template' : 'unsupported';
  };

  /** The country a local number (leading 0) gets: the inbox's own number's, else Malaysia. */
  const countryOf = (inboxId: number, wa: WaAdapter): string => {
    const own = wa.status.me?.jid ?? ctx.inboxes.repo.get(inboxId)?.own_jid ?? '';
    const digits = own.split(/[:@]/)[0] ?? '';
    return (/^\d+$/.test(digits) && countryCodeOf(digits)) || NEW_CHAT_FALLBACK_COUNTRY;
  };

  /** The inbox the user may start from: 403 when not allowed, 404 outside their inboxes. */
  const inboxFor = (user: Actor, inboxId: number) => {
    if (!allowed(user)) throw fail(403, 'new_chat_not_allowed', 'You cannot start new chats');
    const row = ctx.inboxes.repo.get(inboxId);
    if (!row || !canOpen(scopeFor(ctx, user), inboxId)) throw errors.notFound('Inbox');
    if (row.removed_at !== null)
      throw fail(409, 'inbox_removed', 'This WhatsApp number was removed');
    const wa = ctx.inboxes.connections.adapter(inboxId);
    return { wa, mode: modeOf(wa) };
  };

  const ownNumber = (digits: string) =>
    [...ctx.inboxes.connections.ownJids()].some((j) => j.split(/[:@]/)[0] === digits);

  /** The chat this number already has in the inbox (phone JID or its LID), or null. */
  const existing = (inboxId: number, waJid: string) =>
    chats.get(chats.resolveJid(chatKey(inboxId, waJid)));

  /** Everything that needs no WhatsApp call: the normalised digits and an existing chat. */
  const precheck = (inboxId: number, wa: WaAdapter, mode: NewChatMode, phone: string) => {
    if (mode === 'unsupported')
      throw fail(409, 'new_chat_unsupported', 'This WhatsApp number cannot start new chats');
    const digits = normalizeLocalPhone(phone, countryOf(inboxId, wa));
    if (!digits) throw fail(400, 'invalid_number', 'Not a phone number');
    if (ownNumber(digits))
      throw fail(400, 'own_number', 'This is one of your own WhatsApp numbers');
    const chat = existing(inboxId, `${digits}@s.whatsapp.net`);
    if (!chat && wa.status.state !== 'open')
      throw fail(503, 'wa_disconnected', 'This WhatsApp number is not connected');
    return { digits, chat };
  };

  const record = (user: Actor, inboxId: number, chatJid: string, via: NewChatVia) => {
    audit(ctx.db, {
      userId: user.id,
      action: 'chat.new_number',
      ip: via.via === 'app' ? via.ip : null,
      meta: {
        inboxId,
        chatJid,
        userId: user.id,
        via: via.via,
        ...(via.via === 'mcp' ? { tokenId: via.tokenId } : {}),
      },
    });
  };

  /** Name (only into an empty profile name) and assignment of a chat this call created. */
  const adopt = (user: Actor, chatJid: string, name: string | undefined, ip: string | null) => {
    if (name && ctx.services.customers) {
      const current = ctx.services.customers.profile(chatJid).profile;
      if (!current.name)
        ctx.services.customers.save(
          chatJid,
          {
            name,
            company: current.company ?? '',
            email: current.email ?? '',
            otherPhone: current.otherPhone ?? '',
            address: current.address ?? '',
            tags: current.tags ?? [],
          },
          { userId: user.id, ip },
        );
    }
    if (chats.get(chatJid)?.assignedTo == null)
      chats.patch(chatJid, { assignedTo: user.id }, user.id);
  };

  const countHourly = (user: Actor) => {
    const hit = hourly.hit(String(user.id));
    if (!hit.allowed)
      throw new HttpError(
        429,
        'new_chat_hourly_limit',
        `You started ${NEW_CHAT_PER_USER_PER_HOUR} new chats in the last hour`,
        { 'retry-after': String(Math.max(1, hit.retryAfterSec)) },
      );
  };

  const countDaily = (inboxId: number, at: number) => {
    const limit = dailyLimit();
    if (!daily.hit(inboxId, limit, at))
      throw fail(
        429,
        'new_chat_daily_limit',
        `This WhatsApp number started ${limit} new chats today`,
      );
  };

  /** checkNumber, then the chat (or the one that appeared meanwhile). Counted by the caller. */
  const checked = async (user: Actor, inboxId: number, wa: WaAdapter, digits: string) => {
    let found: string | null;
    try {
      found = await wa.checkNumber(digits);
    } catch {
      throw fail(503, 'wa_disconnected', 'This WhatsApp number is not connected');
    }
    if (!found) throw fail(404, 'not_on_whatsapp', 'This number is not on WhatsApp');
    const raced = existing(inboxId, found);
    if (raced) return { chatJid: raced.jid, created: false };
    const chat = chats.upsertFromWa({ jid: found, type: 'dm', name: null }, inboxId);
    return { chatJid: chat.jid, created: true };
  };

  const service: NewChatService = {
    status(user) {
      const may = allowed(user);
      const t = now();
      const inboxes = may
        ? scopeIds(ctx, scopeFor(ctx, user))
            .filter((id) => ctx.inboxes.repo.get(id)?.removed_at === null)
            .map((inboxId) => {
              const wa = ctx.inboxes.connections.adapter(inboxId);
              const mode = modeOf(wa);
              return {
                inboxId,
                mode,
                usedToday: mode === 'check' ? daily.used(inboxId, t) : 0,
                countryCode: countryOf(inboxId, wa),
              };
            })
        : [];
      return {
        allowed: may,
        staffEnabled: staffEnabled(),
        dailyLimit: dailyLimit(),
        perUserPerHour: NEW_CHAT_PER_USER_PER_HOUR,
        inboxes,
      };
    },

    updateSettings(body, actor) {
      const change = (action: string, key: string, before: unknown, after: unknown) => {
        if (after === undefined || after === before) return;
        ctx.settings.set(key, after);
        audit(ctx.db, { userId: actor.userId, action, ip: actor.ip, meta: { before, after } });
      };
      change('settings.new_chat_staff', NEW_CHAT_STAFF_KEY, staffEnabled(), body.staffEnabled);
      change(
        'settings.new_chat_daily_limit',
        NEW_CHAT_DAILY_LIMIT_KEY,
        dailyLimit(),
        body.dailyLimit,
      );
    },

    check(user, inboxId, phone) {
      const { wa, mode } = inboxFor(user, inboxId);
      const { digits, chat } = precheck(inboxId, wa, mode, phone);
      if (chat) return { next: 'existing', phone: digits, chatJid: chat.jid };
      return { next: mode === 'template' ? 'template' : 'check', phone: digits };
    },

    start(user, inboxId, body, ip) {
      const key = `${user.id}:${body.clientRequestId}`;
      const t = now();
      for (const [k, v] of requests) if (t - v.at > IDEMPOTENCY_MS) requests.delete(k);
      const before = requests.get(key);
      if (before) return before.result;
      const result = (async (): Promise<NewChatResponse> => {
        const started = now();
        const { wa, mode } = inboxFor(user, inboxId);
        const { digits, chat } = precheck(inboxId, wa, mode, body.phone);
        if (chat) return { chatJid: chat.jid, created: false };
        if (mode === 'check' && body.template)
          throw errors.validation('This WhatsApp number does not use templates');
        if (mode === 'template' && !body.template)
          throw fail(400, 'template_required', 'A new chat on this number starts with a template');
        countHourly(user);
        let out: NewChatResponse;
        if (mode === 'check') {
          countDaily(inboxId, now());
          out = await checked(user, inboxId, wa, digits);
        } else {
          const waJid = `${digits}@s.whatsapp.net`;
          let created = false;
          const msg = await messages.sendFirstTemplate(
            inboxId,
            waJid,
            body.template!,
            user.id,
            () => {
              const raced = existing(inboxId, waJid);
              if (raced) return raced.jid;
              created = true;
              return chats.upsertFromWa({ jid: waJid, type: 'dm', name: null }, inboxId).jid;
            },
          );
          out = { chatJid: msg.chatJid, created };
        }
        if (out.created) {
          adopt(user, out.chatJid, body.name, ip);
          record(user, inboxId, out.chatJid, { via: 'app', ip });
        }
        log.info(
          { inboxId, userId: user.id, mode, created: out.created, ms: now() - started },
          'new chat started',
        );
        return out;
      })();
      requests.set(key, { at: t, result });
      // A failed start may be retried with the same id (nothing was created).
      result.catch(() => requests.delete(key));
      return result;
    },

    async openChecked(user, inboxId, digits, via, opts) {
      const wa = ctx.inboxes.connections.adapter(inboxId);
      if (ownNumber(digits))
        throw fail(400, 'own_number', 'This is a linked WhatsApp number itself');
      const chat = existing(inboxId, `${digits}@s.whatsapp.net`);
      if (chat) return { chatJid: chat.jid, created: false };
      if (wa.status.state !== 'open')
        throw fail(503, 'wa_disconnected', 'This WhatsApp number is not connected');
      opts?.beforeCount?.();
      countDaily(inboxId, opts?.now ?? now());
      const out = await checked(user, inboxId, wa, digits);
      // MCP's own send claims the chat for the token owner, like any reply.
      if (out.created) record(user, inboxId, out.chatJid, via);
      log.info(
        { inboxId, userId: user.id, via: via.via, created: out.created },
        'new chat checked',
      );
      return out;
    },
  };
  return service;
}

export function initNewChat(ctx: AppContext): void {
  ctx.services.newChat = createNewChatService(ctx);
}

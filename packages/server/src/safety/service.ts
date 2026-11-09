import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Message,
  MessageSafety,
  SafetyAction,
  SafetyActionBody,
  SafetyAiAnswer,
  SafetyBlockedNumber,
  SafetyChatAction,
  SafetyChatActionBody,
  SafetyChatState,
  SafetyItemView,
  SafetyLevel,
  SafetyRule,
  SafetySettings,
  SafetyState,
  SafetyStatus,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { HttpError } from '../http/errors.js';
import { capabilitiesOf } from '../inboxes/types.js';
import { MediaStore } from '../messages/media-store.js';
import { t } from '../i18n/messages.js';
import { safetyCheckInput } from './ai-check.js';
import { decide, shouldAutoBlock, type SafetyDecision } from './policy.js';
import { checkMessage } from './rules.js';
import { listZip } from './zip.js';

declare module '../context.js' {
  interface Services {
    safety?: SafetyService;
  }
}

/** Settings keys (missing = the default). */
export const SAFETY_ENABLED = 'safety_enabled';
export const SAFETY_AI = 'safety_ai';
export const SAFETY_AUTO_BLOCK = 'safety_auto_block';
export const SAFETY_DELETE_AFTER_DAYS = 'safety_delete_after_days';

/** Decisions delegated by the owner (design.md "Small decisions"). */
export const SAFETY_AI_DAILY_CAP = 200;
export const SAFETY_MAX_CHECK_BYTES = 25 * 1024 * 1024;
export const EXISTING_CUSTOMER_MS = 7 * 86_400_000;
export const ALERT_EVERY_MS = 60 * 60 * 1000;
/** A teammate re-opening the same file within this time counts once. */
const DOWNLOAD_DEDUPE_MS = 10 * 60 * 1000;

export interface InspectInput {
  messageId: string;
  /** Chat key. */
  chatJid: string;
  inboxId: number;
  /** The WhatsApp JID of the number that sent it (the chat's for a direct chat, the member's in a group). */
  senderWaJid: string | null;
  group: boolean;
  live: boolean;
  text: string | null;
  /** `rel`: the stored media path (null while not downloaded). */
  file: { name: string | null; mime: string; rel: string | null; bytes: Buffer | null } | null;
}

export interface SafetyService {
  settings(): SafetySettings;
  setSettings(patch: Partial<SafetySettings>, userId: number, ip: string | null): SafetySettings;
  /**
   * Runs the rules on a stored inbound message (message ingest calls it before presenting it):
   * stores the finding, locks a High-risk file, auto-blocks when allowed, alerts admins and starts
   * the AI check. Never throws: a failure only logs.
   */
  inspect(input: InspectInput): void;
  /** Attaches `safety` to inbound messages that have a finding (one batched query). */
  attach(list: Message[]): Message[];
  /** The message's level, `none` when nothing was found (the AI agent does not answer High). */
  levelOf(messageId: string): SafetyLevel;
  /** The media route: 'locked' for an agent while the file is locked; records each download. */
  checkDownload(messageId: string, user: { id: number; role: string }): 'ok' | 'locked' | 'flagged';
  /**
   * Whether a phone may keep the message's file (PWA cache): nothing was found, or the AI check that may
   * still raise it to High has answered. Until then the media route answers `no-store`.
   */
  cacheable(messageId: string): boolean;
  state(): SafetyState;
  chatState(chatJid: string): SafetyChatState;
  /**
   * Blocks or unblocks a direct chat's number on WhatsApp, from the chat itself (any chat, flagged or
   * not). `spam` also marks the number as spam. Throws 409 for a group or when the inbox cannot block now.
   */
  actOnChat(
    chatJid: string,
    action: SafetyChatAction,
    body: SafetyChatActionBody,
    user: { id: number },
    ip: string | null,
  ): Promise<SafetyChatState>;
  /** Whether this WhatsApp number is blocked on this inbox (the AI agent does not answer it there). */
  isBlocked(waJid: string | null | undefined, inboxId: number): boolean;
  act(
    itemId: number,
    action: SafetyAction,
    body: SafetyActionBody,
    user: { id: number },
    ip: string | null,
  ): Promise<void>;
  /** Deletes locked files older than the setting (hourly, and on start). */
  cleanup(now?: number): number;
  shutdown(): void;
}

interface ItemRow {
  id: number;
  message_id: string;
  chat_jid: string;
  inbox_id: number;
  rules: string;
  score: number;
  rule_level: SafetyLevel;
  critical: number;
  ai_level: SafetyLevel | null;
  ai_category: string | null;
  ai_reason: string | null;
  level: SafetyLevel;
  status: SafetyStatus;
  existing_customer: number;
  has_file: number;
  quarantined: number;
  released: number;
  deleted_by: number | null;
  deleted_at: number | null;
  auto_blocked: number;
  created_at: number;
  updated_at: number;
}

interface NumberRow {
  wa_jid: string;
  scam_by: number | null;
  scam_at: number | null;
  blocked_by: number | null;
  blocked_at: number | null;
  blocked_auto: number;
  trusted: string | null;
  /** The inbox that blocked it; null = every inbox (blocked before 041, or imported). */
  blocked_inbox_id: number | null;
}

/** Blocked for this inbox: WhatsApp blocks per WhatsApp number (inbox), not per customer. */
function blockedOn(n: NumberRow | null | undefined, inboxId: number): boolean {
  return n?.blocked_at != null && (n.blocked_inbox_id === null || n.blocked_inbox_id === inboxId);
}

export function readSafetySettings(ctx: AppContext): SafetySettings {
  const days = ctx.settings.get<number>(SAFETY_DELETE_AFTER_DAYS, 30);
  return {
    enabled: ctx.settings.get<boolean>(SAFETY_ENABLED, true) !== false,
    // Owner 2026-10-31: on by default; it only runs while an AI connection is ready.
    ai: ctx.settings.get<boolean>(SAFETY_AI, true) !== false,
    autoBlock: ctx.settings.get<boolean>(SAFETY_AUTO_BLOCK, false) === true,
    deleteAfterDays: days === 7 || days === 90 ? days : 30,
  };
}

const phoneOf = (waJid: string | null): string | null => {
  const m = waJid ? /^(\d{6,15})@s\.whatsapp\.net$/.exec(waJid) : null;
  return m ? m[1]! : null;
};

export function createSafetyService(
  ctx: AppContext,
  deps: { now?: () => number } = {},
): SafetyService {
  const db = ctx.db;
  const now = deps.now ?? Date.now;
  const log = ctx.log.child({ mod: 'safety' });
  const media = new MediaStore(join(ctx.config.dataDir, 'media'));
  const aborts = new AbortController();
  const aiCalls = new Map<string, number>();
  const lastAlert = new Map<string, number>();

  const q = {
    insert: db.prepare(
      `INSERT OR IGNORE INTO safety_items (message_id, chat_jid, inbox_id, rules, score, rule_level, critical,
         level, status, existing_customer, has_file, created_at, updated_at)
       VALUES (@message_id, @chat_jid, @inbox_id, @rules, @score, @rule_level, @critical, @level, @status,
         @existing_customer, @has_file, @at, @at)`,
    ),
    byId: db.prepare('SELECT * FROM safety_items WHERE id = ?'),
    byMessage: db.prepare('SELECT * FROM safety_items WHERE message_id = ?'),
    number: db.prepare('SELECT * FROM safety_numbers WHERE wa_jid = ?'),
    ensureNumber: db.prepare('INSERT OR IGNORE INTO safety_numbers (wa_jid) VALUES (?)'),
    userName: db.prepare('SELECT display_name FROM users WHERE id = ?'),
    teamReplied: db.prepare(
      'SELECT 1 FROM messages WHERE chat_jid = ? AND from_me = 1 AND id != ? LIMIT 1',
    ),
    profile: db.prepare('SELECT 1 FROM customer_profiles WHERE chat_jid = ?'),
    firstSeen: db.prepare('SELECT MIN(timestamp) AS t FROM messages WHERE chat_jid = ?'),
    earlierFile: db.prepare(
      `SELECT 1 FROM messages WHERE chat_jid = ? AND from_me = 0 AND id != ?
         AND type IN ('document', 'image', 'video') AND (? IS NULL OR sender_jid = ?) LIMIT 1`,
    ),
    message: db.prepare(
      'SELECT id, chat_jid, sender_jid, sender_name, body, media_path, media_name, media_mime, timestamp FROM messages WHERE id = ?',
    ),
    setMediaPath: db.prepare('UPDATE messages SET media_path = ? WHERE id = ?'),
    chat: db.prepare(
      `SELECT c.jid, c.type, c.name, c.phone, c.wa_jid, c.inbox_id, c.last_inbound_at, p.name AS profile_name
         FROM chats c LEFT JOIN customer_profiles p ON p.chat_jid = c.jid WHERE c.jid = ?`,
    ),
  };

  const userName = (id: number | null): string | null =>
    id === null
      ? null
      : ((q.userName.get(id) as { display_name: string } | undefined)?.display_name ?? null);

  const settings = () => readSafetySettings(ctx);

  const existingCustomer = (chatJid: string, messageId: string, group: boolean): boolean => {
    if (group) return true;
    if (q.teamReplied.get(chatJid, messageId)) return true;
    if (q.profile.get(chatJid)) return true;
    const first = (q.firstSeen.get(chatJid) as { t: number | null }).t;
    return first !== null && now() - first > EXISTING_CUSTOMER_MS;
  };

  const numberRow = (waJid: string | null): NumberRow | null =>
    waJid ? ((q.number.get(waJid) as NumberRow | undefined) ?? null) : null;

  /** Moves a High-risk file into media/quarantine with no real extension, so nothing can run it. */
  function quarantine(messageId: string, rel: string | null): boolean {
    if (!rel || rel.startsWith('quarantine/')) return Boolean(rel);
    try {
      const from = media.abs(rel);
      if (!existsSync(from)) return false;
      const qrel = `quarantine/${rel}.bin`;
      const to = media.abs(qrel);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      q.setMediaPath.run(qrel, messageId);
      return true;
    } catch (err) {
      log.warn({ err }, 'quarantine move failed');
      return false;
    }
  }

  async function block(
    inboxId: number,
    waJid: string,
    blocked: boolean,
  ): Promise<'done' | 'unsupported' | 'window'> {
    const wa = ctx.inboxes.connections.adapter(inboxId);
    const caps = capabilitiesOf(wa);
    if (!caps.block || !wa.setBlocked) return 'unsupported';
    await wa.setBlocked(waJid, blocked);
    return 'done';
  }

  const canBlockNow = (inboxId: number, lastInboundAt: number | null): boolean => {
    try {
      const wa = ctx.inboxes.connections.adapter(inboxId);
      const caps = capabilitiesOf(wa);
      if (!caps.block || !wa.setBlocked) return false;
      const hours = caps.blockWindowHours ?? null;
      return (
        hours === null || (lastInboundAt !== null && now() - lastInboundAt < hours * 3_600_000)
      );
    } catch {
      return false;
    }
  };

  function alertAdmins(name: string, waJid: string, autoBlocked: boolean): void {
    const key = waJid;
    if (now() - (lastAlert.get(key) ?? 0) < ALERT_EVERY_MS) return;
    lastAlert.set(key, now());
    ctx.services.push
      ?.notifyAdmins(
        (locale) => ({
          title: t(locale, 'push.safetyHigh.title'),
          body: t(locale, autoBlocked ? 'push.safetyHigh.blocked' : 'push.safetyHigh.body', {
            name,
          }),
        }),
        { url: '/admin/safety', tag: 'safety' },
      )
      .catch((err: unknown) => log.warn({ err }, 'safety alert failed'));
  }

  /** The chat shows the new finding (banner, lock) at once. */
  const emitUpdated = (messageId: string) => {
    const messages = ctx.services.messages;
    const row = messages ? db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) : null;
    if (messages && row) ctx.bus.emit('message:updated', messages.present(row as never));
  };

  function store(
    input: InspectInput,
    rules: SafetyRule[],
    decision: SafetyDecision,
    existing: boolean,
  ): ItemRow | null {
    const at = now();
    q.insert.run({
      message_id: input.messageId,
      chat_jid: input.chatJid,
      inbox_id: input.inboxId,
      rules: JSON.stringify(rules),
      score: decision.score,
      rule_level: decision.ruleLevel,
      critical: decision.critical ? 1 : 0,
      level: decision.level,
      status: decision.level === 'none' ? 'cleared' : 'open',
      existing_customer: existing ? 1 : 0,
      has_file: input.file ? 1 : 0,
      at,
    });
    return (q.byMessage.get(input.messageId) as ItemRow | undefined) ?? null;
  }

  function onHigh(item: ItemRow, input: InspectInput, decision: SafetyDecision, name: string) {
    let changed = false;
    if (input.file && !item.quarantined && quarantine(input.messageId, input.file.rel)) {
      db.prepare('UPDATE safety_items SET quarantined = 1 WHERE id = ?').run(item.id);
      changed = true;
    }
    if (!input.live) return changed;
    const s = settings();
    const auto =
      input.senderWaJid !== null &&
      shouldAutoBlock({
        enabled: s.autoBlock,
        decision,
        existingCustomer: item.existing_customer === 1,
        group: input.group,
        live: input.live,
      });
    if (auto) {
      const waJid = input.senderWaJid!;
      block(input.inboxId, waJid, true)
        .then((result) => {
          if (result !== 'done') return;
          q.ensureNumber.run(waJid);
          db.prepare(
            'UPDATE safety_numbers SET blocked_by = NULL, blocked_at = ?, blocked_auto = 1, blocked_inbox_id = ? WHERE wa_jid = ?',
          ).run(now(), input.inboxId, waJid);
          db.prepare(
            "UPDATE safety_items SET auto_blocked = 1, status = 'blocked', updated_at = ? WHERE id = ?",
          ).run(now(), item.id);
          audit(db, {
            userId: null,
            action: 'safety.auto_block',
            ip: null,
            meta: { itemId: item.id, chatJid: input.chatJid, rules: JSON.parse(item.rules) },
          });
          emitUpdated(input.messageId);
        })
        .catch((err: unknown) => log.warn({ err }, 'auto-block failed'));
    }
    if (input.senderWaJid) alertAdmins(name, input.senderWaJid, auto);
    return changed;
  }

  function startAiCheck(item: ItemRow, input: InspectInput, rules: SafetyRule[], name: string) {
    const ai = ctx.services.ai;
    if (!ai || !settings().ai || !input.live) return;
    const day = `${input.inboxId}:${new Date(now()).toISOString().slice(0, 10)}`;
    const used = aiCalls.get(day) ?? 0;
    if (used >= SAFETY_AI_DAILY_CAP) {
      log.info({ event: 'safety_ai_cap', inboxId: input.inboxId }, 'AI check daily cap reached');
      return;
    }
    aiCalls.set(day, used + 1);
    const inside =
      input.file?.bytes && listZip(input.file.bytes).ok
        ? listZip(input.file.bytes).entries.map((e) => e.name)
        : [];
    const payload = safetyCheckInput({
      text: input.text,
      file: input.file ? { name: input.file.name, mime: input.file.mime, inside } : null,
      existingCustomer: item.existing_customer === 1,
      firstFile: rules.includes('firstFile'),
      found: rules,
    });
    void ai
      .checkSafety(input.chatJid, payload, aborts.signal)
      .then((answer) => {
        if (!answer) return;
        applyAi(item.id, rules, answer, input, name);
      })
      .catch((err: unknown) => log.warn({ err }, 'AI check failed'));
  }

  function applyAi(
    itemId: number,
    rules: SafetyRule[],
    answer: SafetyAiAnswer,
    input: InspectInput,
    name: string,
  ) {
    const before = q.byId.get(itemId) as ItemRow | undefined;
    if (!before) return;
    const decision = decide(rules, answer);
    const status: SafetyStatus =
      before.status !== 'open' && before.status !== 'cleared'
        ? before.status
        : decision.level === 'none'
          ? 'cleared'
          : 'open';
    db.prepare(
      `UPDATE safety_items SET ai_level = ?, ai_category = ?, ai_reason = ?, level = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      answer.level,
      answer.category,
      answer.reason || null,
      decision.level,
      status,
      now(),
      itemId,
    );
    const after = q.byId.get(itemId) as ItemRow;
    if (decision.level === 'high' && before.level !== 'high') onHigh(after, input, decision, name);
    emitUpdated(input.messageId);
  }

  const service: SafetyService = {
    settings,

    setSettings(patch, userId, ip) {
      const before = settings();
      if (patch.enabled !== undefined) ctx.settings.set(SAFETY_ENABLED, patch.enabled);
      if (patch.ai !== undefined) ctx.settings.set(SAFETY_AI, patch.ai);
      if (patch.autoBlock !== undefined) ctx.settings.set(SAFETY_AUTO_BLOCK, patch.autoBlock);
      if (patch.deleteAfterDays !== undefined)
        ctx.settings.set(SAFETY_DELETE_AFTER_DAYS, patch.deleteAfterDays);
      const after = settings();
      audit(db, { userId, action: 'safety.settings', ip, meta: { before, after } });
      return after;
    },

    inspect(input) {
      try {
        const s = settings();
        if (!s.enabled) return;
        const number = numberRow(input.senderWaJid);
        const trusted = (number?.trusted ?? '').split(',');
        if (trusted.includes(input.file ? 'file' : 'text')) return;
        const bytes =
          input.file?.bytes && input.file.bytes.length <= SAFETY_MAX_CHECK_BYTES
            ? input.file.bytes
            : null;
        const firstFile =
          input.file !== null &&
          !q.earlierFile.get(input.chatJid, input.messageId, input.senderWaJid, input.senderWaJid);
        const rules = checkMessage({
          text: input.text,
          file: input.file ? { name: input.file.name, mime: input.file.mime, bytes } : null,
          firstFile,
          scamNumber: number?.scam_at != null,
        });
        if (rules.length === 0) return;
        const existing = existingCustomer(input.chatJid, input.messageId, input.group);
        const decision = decide(rules, null);
        const item = store(input, rules, decision, existing);
        if (!item) return;
        const chat = q.chat.get(input.chatJid) as
          { name: string; profile_name: string | null } | undefined;
        const name = chat?.profile_name || chat?.name || 'WhatsApp';
        if (decision.level === 'high') onHigh(item, input, decision, name);
        // History (before linking) is checked by the rules only, never by the AI.
        startAiCheck(
          item,
          { ...input, file: input.file ? { ...input.file, bytes } : null },
          rules,
          name,
        );
        // Counts and codes only: never the text, the file name or the number.
        log.info(
          { event: 'safety_flag', level: decision.level, rules, live: input.live },
          'message flagged',
        );
      } catch (err) {
        log.warn({ err }, 'safety check failed');
      }
    },

    attach(list) {
      const ids = list.filter((m) => !m.fromMe).map((m) => m.id);
      if (ids.length === 0) return list;
      const rows = db
        .prepare(
          `SELECT i.*, u.display_name AS deleted_name FROM safety_items i
             LEFT JOIN users u ON u.id = i.deleted_by
            WHERE i.message_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as Array<ItemRow & { deleted_name: string | null }>;
      if (rows.length === 0) return list;
      const byId = new Map(rows.map((r) => [r.message_id, r]));
      return list.map((m) => {
        const r = byId.get(m.id);
        if (!r || r.level === 'none') return m;
        const safety: MessageSafety = {
          itemId: r.id,
          level: r.level,
          rules: JSON.parse(r.rules) as SafetyRule[],
          aiReason: r.ai_level && r.ai_level !== 'none' ? r.ai_reason : null,
          locked:
            r.quarantined === 1 && r.released === 0 && r.status !== 'safe' && r.deleted_at === null,
          deletedBy: r.deleted_at !== null ? (r.deleted_name ?? '') : null,
          status: r.status,
        };
        return { ...m, safety };
      });
    },

    levelOf(messageId) {
      const r = q.byMessage.get(messageId) as ItemRow | undefined;
      return r && r.status !== 'safe' ? r.level : 'none';
    },

    cacheable(messageId) {
      const r = q.byMessage.get(messageId) as ItemRow | undefined;
      // A finding without an AI answer may still become High and locked (or never get one): no copies.
      return !r || r.ai_level !== null;
    },

    checkDownload(messageId, user) {
      const r = q.byMessage.get(messageId) as ItemRow | undefined;
      if (!r || r.level === 'none' || !r.has_file) return 'ok';
      const locked = r.quarantined === 1 && r.released === 0 && r.status !== 'safe';
      const allowed = !locked || user.role === 'admin';
      const recent = db
        .prepare(
          'SELECT 1 FROM safety_downloads WHERE item_id = ? AND user_id = ? AND allowed = ? AND at > ? LIMIT 1',
        )
        .get(r.id, user.id, allowed ? 1 : 0, now() - DOWNLOAD_DEDUPE_MS);
      if (!recent)
        db.prepare(
          'INSERT INTO safety_downloads (item_id, user_id, allowed, at) VALUES (?, ?, ?, ?)',
        ).run(r.id, user.id, allowed ? 1 : 0, now());
      return allowed ? 'flagged' : 'locked';
    },

    state() {
      const rows = db
        .prepare(
          `SELECT i.*, m.body, m.media_name, m.media_path, m.sender_jid, m.sender_name, c.type AS chat_type,
                  c.name AS chat_name, c.phone AS chat_phone, c.wa_jid AS chat_wa_jid, c.last_inbound_at,
                  p.name AS profile_name, du.display_name AS deleted_name
             FROM safety_items i
             LEFT JOIN messages m ON m.id = i.message_id
             LEFT JOIN chats c ON c.jid = i.chat_jid
             LEFT JOIN customer_profiles p ON p.chat_jid = i.chat_jid
             LEFT JOIN users du ON du.id = i.deleted_by
            ORDER BY i.created_at DESC, i.id DESC LIMIT 300`,
        )
        .all() as Array<
        ItemRow & {
          body: string | null;
          media_name: string | null;
          media_path: string | null;
          sender_jid: string | null;
          sender_name: string | null;
          chat_type: string | null;
          chat_name: string | null;
          chat_phone: string | null;
          chat_wa_jid: string | null;
          last_inbound_at: number | null;
          profile_name: string | null;
          deleted_name: string | null;
        }
      >;
      const downloads = db
        .prepare(
          `SELECT d.item_id, d.allowed, d.at, u.display_name FROM safety_downloads d
             JOIN users u ON u.id = d.user_id ORDER BY d.at`,
        )
        .all() as Array<{ item_id: number; allowed: number; at: number; display_name: string }>;
      const byItem = new Map<number, SafetyItemView['downloads']>();
      for (const d of downloads)
        byItem.set(d.item_id, [
          ...(byItem.get(d.item_id) ?? []),
          { name: d.display_name, at: d.at, allowed: d.allowed === 1 },
        ]);
      const items: SafetyItemView[] = rows.map((r) => {
        const group = r.chat_type === 'group';
        const senderWaJid = group ? r.sender_jid : r.chat_wa_jid;
        const number = numberRow(senderWaJid);
        const inside =
          r.has_file && r.media_path
            ? (() => {
                try {
                  const p = media.abs(r.media_path);
                  if (!existsSync(p)) return [];
                  const listing = listZip(readHead(p));
                  return listing.ok ? listing.entries.map((e) => e.name).slice(0, 50) : [];
                } catch {
                  return [];
                }
              })()
            : [];
        return {
          id: r.id,
          messageId: r.message_id,
          chatJid: r.chat_jid,
          inboxId: r.inbox_id,
          senderName: group
            ? (r.sender_name ?? phoneOf(r.sender_jid) ?? 'WhatsApp')
            : r.profile_name || r.chat_name || 'WhatsApp',
          phone: group ? phoneOf(r.sender_jid) : (r.chat_phone ?? phoneOf(r.chat_wa_jid)),
          group,
          at: r.created_at,
          text: r.body,
          file: r.has_file ? { name: r.media_name, inside } : null,
          rules: JSON.parse(r.rules) as SafetyRule[],
          score: r.score,
          ruleLevel: r.rule_level,
          critical: r.critical === 1,
          ai: r.ai_level
            ? {
                level: r.ai_level,
                category: (r.ai_category ?? 'none') as SafetyAiAnswer['category'],
                reason: r.ai_reason ?? '',
              }
            : null,
          level: r.level,
          status: r.status,
          existingCustomer: r.existing_customer === 1,
          quarantined: r.quarantined === 1,
          released: r.released === 1,
          deleted: r.deleted_at !== null ? { by: r.deleted_name ?? '', at: r.deleted_at } : null,
          autoBlocked: r.auto_blocked === 1,
          scam: number?.scam_at != null,
          blocked: number?.blocked_at != null,
          canBlock: !group && senderWaJid !== null && canBlockNow(r.inbox_id, r.last_inbound_at),
          downloads: byItem.get(r.id) ?? [],
        };
      });
      const blockedRows = db
        .prepare(
          'SELECT * FROM safety_numbers WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC',
        )
        .all() as NumberRow[];
      const blocked: SafetyBlockedNumber[] = blockedRows.map((n) => {
        const item = items.find(
          (i) => !i.group && (i.phone === phoneOf(n.wa_jid) || i.chatJid === n.wa_jid),
        );
        const chat = db
          .prepare(
            `SELECT c.name, p.name AS profile_name FROM chats c LEFT JOIN customer_profiles p ON p.chat_jid = c.jid
              WHERE c.wa_jid = ? LIMIT 1`,
          )
          .get(n.wa_jid) as { name: string; profile_name: string | null } | undefined;
        return {
          waJid: n.wa_jid,
          phone: phoneOf(n.wa_jid),
          name: chat?.profile_name || chat?.name || phoneOf(n.wa_jid) || 'WhatsApp',
          by: n.blocked_auto ? null : userName(n.blocked_by),
          at: n.blocked_at!,
          auto: n.blocked_auto === 1,
          itemId: item?.id ?? null,
        };
      });
      return {
        settings: settings(),
        aiReady: ctx.services.ai?.draftConnection() === 'ready',
        items,
        blocked,
      };
    },

    chatState(chatJid) {
      const chat = q.chat.get(chatJid) as
        | { type: string; wa_jid: string | null; inbox_id: number; last_inbound_at: number | null }
        | undefined;
      const enabled = settings().enabled;
      const empty = {
        enabled,
        scam: false,
        blocked: null,
        maybeHacked: false,
        itemId: null,
        canBlock: false,
      };
      if (!chat || chat.type === 'group') return empty;
      const number = numberRow(chat.wa_jid);
      const latest = db
        .prepare(
          'SELECT * FROM safety_items WHERE chat_jid = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        )
        .get(chatJid) as ItemRow | undefined;
      return {
        enabled,
        scam: number?.scam_at != null,
        blocked:
          number && blockedOn(number, chat.inbox_id)
            ? {
                by: number.blocked_auto ? null : userName(number.blocked_by),
                at: number.blocked_at!,
                auto: number.blocked_auto === 1,
              }
            : null,
        maybeHacked:
          latest !== undefined &&
          latest.existing_customer === 1 &&
          latest.level === 'high' &&
          latest.status === 'open',
        itemId: latest?.id ?? null,
        // Blocked on another inbox: unblock it there first (one block per number is recorded).
        canBlock:
          chat.wa_jid !== null &&
          number?.blocked_at == null &&
          canBlockNow(chat.inbox_id, chat.last_inbound_at),
      };
    },

    async actOnChat(chatJid, action, body, user, ip) {
      const chat = q.chat.get(chatJid) as
        | { type: string; wa_jid: string | null; inbox_id: number; last_inbound_at: number | null }
        | undefined;
      if (!chat) throw new HttpError(404, 'not_found', 'Chat not found');
      if (chat.type === 'group' || !chat.wa_jid)
        throw new HttpError(409, 'cannot_block', 'Only a direct chat can be blocked');
      const jid = chat.wa_jid;
      const at = now();
      q.ensureNumber.run(jid);
      const number = numberRow(jid);
      // The chat's flagged items follow the number, as with Block and Unblock in Admin → Safety.
      const items = db
        .prepare('SELECT id, message_id FROM safety_items WHERE chat_jid = ? AND status = ?')
        .all(chatJid, action === 'block' ? 'open' : 'blocked') as Array<{
        id: number;
        message_id: string;
      }>;
      if (action === 'block') {
        if (number?.blocked_at != null || !canBlockNow(chat.inbox_id, chat.last_inbound_at))
          throw new HttpError(409, 'cannot_block', 'This number cannot be blocked now');
        await block(chat.inbox_id, jid, true);
        db.prepare(
          'UPDATE safety_numbers SET blocked_by = ?, blocked_at = ?, blocked_auto = 0, blocked_inbox_id = ? WHERE wa_jid = ?',
        ).run(user.id, at, chat.inbox_id, jid);
        if (body.spam)
          db.prepare(
            'UPDATE safety_numbers SET scam_by = ?, scam_at = COALESCE(scam_at, ?) WHERE wa_jid = ?',
          ).run(user.id, at, jid);
        for (const item of items)
          db.prepare("UPDATE safety_items SET status = 'blocked', updated_at = ? WHERE id = ?").run(
            at,
            item.id,
          );
      } else {
        // Only where it is blocked: unblocking from another inbox's chat would leave the real block in place.
        if (!blockedOn(number, chat.inbox_id))
          throw new HttpError(409, 'not_blocked', 'This number is not blocked on this inbox');
        const result = await block(chat.inbox_id, jid, false);
        if (result !== 'done')
          throw new HttpError(409, 'cannot_block', 'This number cannot be unblocked here');
        db.prepare(
          'UPDATE safety_numbers SET blocked_by = NULL, blocked_at = NULL, blocked_auto = 0, blocked_inbox_id = NULL WHERE wa_jid = ?',
        ).run(jid);
        const reported = numberRow(jid)?.scam_at != null;
        for (const item of items)
          db.prepare('UPDATE safety_items SET status = ?, updated_at = ? WHERE id = ?').run(
            reported ? 'reported' : 'open',
            at,
            item.id,
          );
      }
      for (const item of items) emitUpdated(item.message_id);
      // Which chat and what was done (like ai.handoff); never message text.
      audit(db, {
        userId: user.id,
        action: `safety.chat.${action}`,
        ip,
        meta: { chatJid, spam: action === 'block' && body.spam === true },
      });
      return this.chatState(chatJid);
    },

    isBlocked(waJid, inboxId) {
      return waJid ? blockedOn(numberRow(waJid), inboxId) : false;
    },

    async act(itemId, action, body, user, ip) {
      const item = q.byId.get(itemId) as ItemRow | undefined;
      if (!item) throw new HttpError(404, 'not_found', 'Safety item not found');
      const msg = q.message.get(item.message_id) as
        { sender_jid: string | null; media_path: string | null } | undefined;
      const chat = q.chat.get(item.chat_jid) as
        { type: string; wa_jid: string | null; last_inbound_at: number | null } | undefined;
      const group = chat?.type === 'group';
      const waJid = group ? (msg?.sender_jid ?? null) : (chat?.wa_jid ?? null);
      const at = now();
      const setStatus = (status: SafetyStatus) =>
        db
          .prepare('UPDATE safety_items SET status = ?, updated_at = ? WHERE id = ?')
          .run(status, at, itemId);
      const needNumber = () => {
        if (!waJid) throw new HttpError(409, 'no_number', 'This message has no number to act on');
        q.ensureNumber.run(waJid);
        return waJid;
      };
      const doBlock = async () => {
        const jid = needNumber();
        if (group || !canBlockNow(item.inbox_id, chat?.last_inbound_at ?? null))
          throw new HttpError(409, 'cannot_block', 'This number cannot be blocked now');
        await block(item.inbox_id, jid, true);
        db.prepare(
          'UPDATE safety_numbers SET blocked_by = ?, blocked_at = ?, blocked_auto = 0, blocked_inbox_id = ? WHERE wa_jid = ?',
        ).run(user.id, at, item.inbox_id, jid);
      };
      switch (action) {
        case 'safe': {
          setStatus('safe');
          db.prepare('UPDATE safety_items SET released = 1 WHERE id = ?').run(itemId);
          if (body.trust && waJid) {
            q.ensureNumber.run(waJid);
            const n = numberRow(waJid)!;
            const kinds = new Set((n.trusted ?? '').split(',').filter(Boolean));
            kinds.add(item.has_file ? 'file' : 'text');
            db.prepare('UPDATE safety_numbers SET trusted = ? WHERE wa_jid = ?').run(
              [...kinds].join(','),
              waJid,
            );
          }
          break;
        }
        case 'release':
          db.prepare('UPDATE safety_items SET released = 1, updated_at = ? WHERE id = ?').run(
            at,
            itemId,
          );
          break;
        case 'delete': {
          if (!item.has_file || item.deleted_at !== null)
            throw new HttpError(409, 'no_file', 'This message has no file to delete');
          if (msg?.media_path) {
            try {
              const p = media.abs(msg.media_path);
              if (existsSync(p)) unlinkSync(p);
            } catch (err) {
              log.warn({ err }, 'locked file delete failed');
            }
          }
          db.prepare(
            "UPDATE messages SET media_path = NULL, media_status = 'failed' WHERE id = ?",
          ).run(item.message_id);
          db.prepare(
            'UPDATE safety_items SET deleted_by = ?, deleted_at = ?, quarantined = 0, updated_at = ? WHERE id = ?',
          ).run(user.id, at, at, itemId);
          break;
        }
        case 'report': {
          const jid = needNumber();
          db.prepare('UPDATE safety_numbers SET scam_by = ?, scam_at = ? WHERE wa_jid = ?').run(
            user.id,
            at,
            jid,
          );
          setStatus('reported');
          if (body.block) {
            await doBlock();
            setStatus('blocked');
          }
          break;
        }
        case 'block':
          await doBlock();
          setStatus('blocked');
          break;
        case 'unblock': {
          const jid = needNumber();
          const result = await block(numberRow(jid)?.blocked_inbox_id ?? item.inbox_id, jid, false);
          if (result !== 'done')
            throw new HttpError(409, 'cannot_block', 'This number cannot be unblocked here');
          db.prepare(
            'UPDATE safety_numbers SET blocked_by = NULL, blocked_at = NULL, blocked_auto = 0, blocked_inbox_id = NULL WHERE wa_jid = ?',
          ).run(jid);
          db.prepare(
            "UPDATE safety_items SET status = CASE WHEN ? THEN 'reported' ELSE 'open' END, updated_at = ? WHERE id = ? AND status = 'blocked'",
          ).run(numberRow(jid)?.scam_at != null ? 1 : 0, at, itemId);
          break;
        }
      }
      // Ids and the action only: never the number or the text.
      audit(db, {
        userId: user.id,
        action: `safety.${action}`,
        ip,
        meta: {
          itemId,
          chatJid: item.chat_jid,
          ...(body.trust ? { trust: true } : {}),
          ...(body.block ? { block: true } : {}),
        },
      });
      emitUpdated(item.message_id);
    },

    cleanup(at = now()) {
      const days = settings().deleteAfterDays;
      const old = db
        .prepare(
          `SELECT i.id, i.message_id, m.media_path FROM safety_items i JOIN messages m ON m.id = i.message_id
            WHERE i.quarantined = 1 AND i.deleted_at IS NULL AND i.created_at < ?`,
        )
        .all(at - days * 86_400_000) as Array<{
        id: number;
        message_id: string;
        media_path: string | null;
      }>;
      for (const r of old) {
        try {
          if (r.media_path) {
            const p = media.abs(r.media_path);
            if (existsSync(p)) unlinkSync(p);
          }
        } catch (err) {
          log.warn({ err }, 'locked file cleanup failed');
        }
        db.prepare(
          "UPDATE messages SET media_path = NULL, media_status = 'failed' WHERE id = ?",
        ).run(r.message_id);
        db.prepare(
          'UPDATE safety_items SET quarantined = 0, deleted_at = ?, updated_at = ? WHERE id = ?',
        ).run(at, at, r.id);
      }
      if (old.length)
        log.info({ event: 'safety_cleanup', files: old.length }, 'locked files deleted');
      return old.length;
    },

    shutdown() {
      aborts.abort();
      clearInterval(timer);
    },
  };

  const timer = setInterval(() => service.cleanup(), 60 * 60 * 1000);
  timer.unref();
  return service;
}

/** A ZIP's directory is at its end: the file is read only when it is small enough to check. */
function readHead(path: string): Buffer {
  return statSync(path).size <= SAFETY_MAX_CHECK_BYTES ? readFileSync(path) : Buffer.alloc(0);
}

export function initSafety(ctx: AppContext): void {
  const service = createSafetyService(ctx);
  ctx.services.safety = service;
  service.cleanup();
}

import { MISSED_LEAD_MS, type Report, type ReportPeriod, type ReportTotals } from '@ezychat/shared';
import type { DB } from '../db/index.js';
import { computeInboxActivity, type InboxActivity } from '../chats/activity.js';
import { inboxCondition, localClock, localDate, localMidnight } from '../chats/stats.js';
import { inboxOfKey } from '../inboxes/keys.js';

/**
 * Admin → Reports (design: docs/features/reports/design.md). Everything is counted from the local
 * database on request; direct chats only (groups are not customers). Wait and reply times reuse
 * `computeInboxActivity` (MCP `get_activity`), so both read the same numbers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Messages that reached (or came from) the customer: no system lines, no failed or unsent replies. */
const COUNTED = `m.type != 'system' AND NOT (m.from_me = 1 AND m.status IN ('failed', 'pending'))`;

interface Options {
  /** The page asks for 7, 30 or 90; MCP `get_stats` for any 1–90. */
  days: number;
  timeZone: string;
  now: number;
  /** Only chats of these inboxes; omitted = every inbox. */
  inboxIds?: readonly number[];
}

/** Local midnights of the `days` days ending today, oldest first, plus the next midnight. */
function dayStarts(days: number, timeZone: string, now: number): number[] {
  const today = localMidnight(localDate(now, timeZone), timeZone);
  const starts = [today];
  // Local days are 23–25 h long: half a day off a midnight always lands inside the day before.
  for (let i = 1; i < days; i++)
    starts.unshift(localMidnight(localDate(starts[0]! - DAY_MS / 2, timeZone), timeZone));
  starts.push(localMidnight(localDate(today + DAY_MS * 1.5, timeZone), timeZone));
  return starts;
}

export function computeReport(db: DB, opts: Options): Report {
  const days = opts.days as ReportPeriod;
  const { timeZone, now } = opts;
  const scope = inboxCondition('c', opts.inboxIds);
  const starts = dayStarts(days, timeZone, now);
  const from = starts[0]!;
  const previousFrom = localMidnight(
    localDate(from - days * DAY_MS + DAY_MS / 2, timeZone),
    timeZone,
  );

  // WhatsApp was linked when the first message was stored (the history import comes right then):
  // a chat whose first message is older than that is a customer from before, not a new one.
  const linkedAt = new Map(
    (
      db
        .prepare(
          `SELECT c.inbox_id AS inbox, MIN(m.created_at) AS at FROM messages m
           JOIN chats c ON c.jid = m.chat_jid WHERE c.type = 'dm' AND ${scope} GROUP BY c.inbox_id`,
        )
        .all() as Array<{ inbox: number; at: number }>
    ).map((r) => [r.inbox, r.at]),
  );
  const first = db
    .prepare(
      `SELECT MIN(m.timestamp) AS at FROM messages m JOIN chats c ON c.jid = m.chat_jid
       WHERE c.type = 'dm' AND ${scope} AND ${COUNTED}`,
    )
    .get() as { at: number | null };
  const firstAt = first.at;
  const linked = linkedAt.size ? Math.min(...linkedAt.values()) : null;

  const messages = db
    .prepare(
      `SELECT m.chat_jid AS chat, m.from_me AS fromMe, m.timestamp AS at FROM messages m
       JOIN chats c ON c.jid = m.chat_jid
       WHERE c.type = 'dm' AND ${scope} AND ${COUNTED} AND m.timestamp >= ? AND m.timestamp <= ?`,
    )
    .all(previousFrom, now) as Array<{ chat: string; fromMe: 0 | 1; at: number }>;

  // Each chat's first message and the first reply after it, for chats that started in either period.
  // A chat that started in either period has messages in them, so only those chats are looked up,
  // each through the (chat_jid, timestamp) index instead of a pass over the whole history.
  const firstMessage = db.prepare(
    `SELECT c.inbox_id AS inbox, m.from_me AS fromMe, m.timestamp AS at
     FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE m.chat_jid = ? AND ${COUNTED} ORDER BY m.timestamp, m.rowid LIMIT 1`,
  );
  const firstReply = db.prepare(
    `SELECT MIN(m.timestamp) AS at FROM messages m
     WHERE m.chat_jid = ? AND m.from_me = 1 AND ${COUNTED} AND m.timestamp >= ?`,
  );
  const starters: Array<{ chat: string; at: number; repliedAt: number | null }> = [];
  for (const chat of new Set(messages.map((m) => m.chat))) {
    const first = firstMessage.get(chat) as { inbox: number; fromMe: 0 | 1; at: number };
    if (
      first.fromMe !== 0 ||
      first.at < previousFrom ||
      first.at < (linkedAt.get(first.inbox) ?? Infinity)
    )
      continue;
    const reply = firstReply.get(chat, first.at) as { at: number | null };
    starters.push({ chat, at: first.at, repliedAt: reply.at });
  }

  const aiReplies = db.prepare(
    `SELECT COUNT(DISTINCT m.chat_jid) AS n FROM messages m JOIN chats c ON c.jid = m.chat_jid
     WHERE c.type = 'dm' AND ${scope} AND m.from_me = 1 AND m.timestamp >= ? AND m.timestamp < ?
       AND m.sent_by_user_id IN (SELECT id FROM users WHERE kind = 'ai')`,
  );
  const only = opts.inboxIds ? new Set(opts.inboxIds) : null;
  const auditRows = (action: string, start: number, end: number) =>
    (
      db
        .prepare('SELECT meta, at FROM audit_log WHERE action = ? AND at >= ? AND at < ?')
        .all(action, start, end) as Array<{ meta: string; at: number }>
    ).flatMap((row) => {
      try {
        const meta = JSON.parse(row.meta) as { chatJid?: unknown; reason?: unknown };
        if (typeof meta.chatJid !== 'string') return [];
        if (only && !only.has(inboxOfKey(meta.chatJid))) return [];
        return [{ chatJid: meta.chatJid, reason: meta.reason, at: row.at }];
      } catch {
        return [];
      }
    });

  const totalsOf = (start: number, end: number, medianFirstReplyMinutes: number | null) => {
    const window = messages.filter((m) => m.at >= start && m.at < end);
    const newOnes = starters.filter((s) => s.at >= start && s.at < end);
    return {
      newCustomers: newOnes.length,
      messagesIn: window.filter((m) => m.fromMe === 0).length,
      messagesOut: window.filter((m) => m.fromMe === 1).length,
      activeChats: new Set(window.map((m) => m.chat)).size,
      medianFirstReplyMinutes,
      missedLeads: newOnes.filter((s) =>
        s.repliedAt === null ? now - s.at > MISSED_LEAD_MS : s.repliedAt - s.at > MISSED_LEAD_MS,
      ).length,
      aiAnswered: (aiReplies.get(start, end) as { n: number }).n,
      aiResolved: auditRows('ai.resolve', start, end).length,
      aiHandoffs: auditRows('ai.handoff', start, end).length,
    } satisfies ReportTotals;
  };

  const activity = computeInboxActivity(db, { days, timeZone, now, inboxIds: opts.inboxIds });
  const totals = totalsOf(from, now + 1, activity.firstReply.median);
  const previous =
    firstAt !== null && firstAt < from
      ? totalsOf(
          previousFrom,
          from,
          computeInboxActivity(db, { days, timeZone, now: from - 1, inboxIds: opts.inboxIds })
            .firstReply.median,
        )
      : null;

  const reasons = new Map<string, number>();
  for (const h of auditRows('ai.handoff', from, now + 1)) {
    const reason = typeof h.reason === 'string' ? h.reason : 'unknown';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  return {
    days,
    inboxId: opts.inboxIds?.length === 1 ? opts.inboxIds[0]! : null,
    timeZone,
    firstDate: firstAt === null ? null : localDate(firstAt, timeZone),
    linkedDate: linked === null ? null : localDate(linked, timeZone),
    totals,
    previous,
    waitingAfterHandoff: waitingAfterHandoff(db, scope, only),
    ...dayBuckets(starts, firstAt, timeZone, messages, starters),
    handoffReasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    team: teamRows(db, activity.responders),
  };
}

/** How long a counted report is reused: opening Reports or asking `get_stats` again costs nothing. */
export const REPORT_CACHE_MS = 60_000;
const reportCache = new WeakMap<DB, Map<string, { at: number; report: Report }>>();

/**
 * `computeReport` with a short cache per database, period, time zone and inbox scope. Counting reads
 * the whole period on the server's only thread, so repeated views within a minute reuse the result.
 */
export function cachedReport(db: DB, opts: Options, ttlMs = REPORT_CACHE_MS): Report {
  let byKey = reportCache.get(db);
  if (!byKey) {
    byKey = new Map();
    reportCache.set(db, byKey);
  }
  const scope = opts.inboxIds ? [...opts.inboxIds].sort((a, b) => a - b).join(',') : '*';
  const key = `${opts.days}|${opts.timeZone}|${scope}`;
  const hit = byKey.get(key);
  if (hit && opts.now - hit.at >= 0 && opts.now - hit.at < ttlMs) return hit.report;
  const report = computeReport(db, opts);
  // Drop expired entries so the cache never holds more than the reports of the last minute.
  for (const [k, entry] of byKey) if (opts.now - entry.at >= ttlMs) byKey.delete(k);
  byKey.set(key, { at: opts.now, report });
  return report;
}

/**
 * The days shown (from the period start or the first stored message, whichever is later), with
 * messages, new customers and active chats per day; per weekday and hour the average messages from
 * customers over the days of that weekday shown.
 */
function dayBuckets(
  starts: readonly number[],
  firstAt: number | null,
  timeZone: string,
  messages: ReadonlyArray<{ chat: string; fromMe: 0 | 1; at: number }>,
  starters: ReadonlyArray<{ at: number }>,
): Pick<Report, 'daily' | 'weekdays' | 'hours'> {
  let shownFrom = starts.length - 1; // no messages yet: no days
  if (firstAt !== null) {
    shownFrom = 0;
    while (shownFrom < starts.length - 2 && starts[shownFrom + 1]! <= firstAt) shownFrom++;
  }
  const shown = starts.slice(shownFrom, -1);
  /** Index of the shown day that holds `t` (binary search; `t` is never before the first day). */
  const dayIndex = (t: number) => {
    let lo = 0;
    let hi = shown.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (shown[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const local = localClock(timeZone);
  const daily = shown.map((start) => ({
    date: localDate(start + DAY_MS / 2, timeZone),
    inbound: 0,
    outbound: 0,
    newCustomers: 0,
    activeChats: 0,
  }));
  const chatsPerDay = shown.map(() => new Set<string>());
  const hours = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const first = shown[0] ?? Infinity;
  for (const m of messages) {
    if (m.at < first) continue;
    const i = dayIndex(m.at);
    chatsPerDay[i]!.add(m.chat);
    if (m.fromMe === 1) {
      daily[i]!.outbound++;
    } else {
      daily[i]!.inbound++;
      const { weekday, hour } = local(m.at);
      hours[weekday]![hour]!++;
    }
  }
  for (const s of starters) if (s.at >= first) daily[dayIndex(s.at)]!.newCustomers++;

  const weekdayDays = new Array<number>(7).fill(0);
  const weekdayTotals = Array.from({ length: 7 }, () => ({ inbound: 0, chats: 0 }));
  daily.forEach((day, i) => {
    day.activeChats = chatsPerDay[i]!.size;
    const { weekday } = local(shown[i]! + DAY_MS / 2);
    weekdayDays[weekday]!++;
    weekdayTotals[weekday]!.inbound += day.inbound;
    weekdayTotals[weekday]!.chats += day.activeChats;
  });
  const average = (sum: number, n: number) => (n ? Math.round((sum / n) * 10) / 10 : 0);
  return {
    daily,
    weekdays: weekdayTotals.map((w, weekday) => ({
      weekday,
      avgInbound: average(w.inbound, weekdayDays[weekday]!),
      avgChats: average(w.chats, weekdayDays[weekday]!),
    })),
    hours: hours.map((row, wd) => row.map((n) => average(n, weekdayDays[wd]!))),
  };
}

/** Team rows from the responders of `computeInboxActivity`: members, AI agents and the phone. */
function teamRows(db: DB, responders: InboxActivity['responders']): Report['team'] {
  const users = new Map(
    (
      db.prepare('SELECT id, display_name AS name, kind FROM users').all() as Array<{
        id: number;
        name: string;
        kind: 'human' | 'ai';
      }>
    ).map((u) => [u.id, u]),
  );
  const kindOf = (userId: number | null): Report['team'][number]['kind'] => {
    if (userId === null) return 'phone';
    return users.get(userId)?.kind === 'ai' ? 'ai' : 'human';
  };
  return responders
    .filter((r) => r.messages > 0)
    .map((r) => ({
      userId: r.userId,
      name: (r.userId === null ? undefined : users.get(r.userId)?.name) ?? '',
      kind: kindOf(r.userId),
      chats: r.chats,
      replies: r.messages,
      medianReplyMinutes: r.firstReplyMinutes.median,
    }));
}

/**
 * Open direct chats the AI handed to the team (its last hand-off) where no teammate or the phone has
 * written since: the customer is still waiting for a person.
 */
/**
 * One chat is still waiting after an AI hand-off: the AI handed it over and no person (teammate or
 * phone) has written since. Same rule as Reports' "waiting after AI hand-off", for one chat.
 */
export function chatWaitingAfterHandoff(db: DB, jid: string): boolean {
  const handoff = db
    .prepare(
      "SELECT MAX(at) AS at FROM audit_log WHERE action = 'ai.handoff' AND json_extract(meta, '$.chatJid') = ?",
    )
    .get(jid) as { at: number | null };
  if (handoff.at === null) return false;
  const reply = db
    .prepare(
      `SELECT MAX(m.timestamp) AS at FROM messages m
       WHERE m.chat_jid = ? AND m.from_me = 1 AND ${COUNTED}
         AND (m.sent_by_user_id IS NULL OR m.sent_by_user_id NOT IN (SELECT id FROM users WHERE kind = 'ai'))`,
    )
    .get(jid) as { at: number | null };
  return reply.at === null || reply.at < handoff.at;
}

function waitingAfterHandoff(
  db: DB,
  scope: string,
  only: ReadonlySet<number> | null,
): Report['waitingAfterHandoff'] {
  const lastHandoff = new Map<string, number>();
  for (const row of db
    .prepare("SELECT meta, at FROM audit_log WHERE action = 'ai.handoff' ORDER BY at")
    .all() as Array<{ meta: string; at: number }>) {
    try {
      const chatJid = (JSON.parse(row.meta) as { chatJid?: unknown }).chatJid;
      if (typeof chatJid === 'string' && (!only || only.has(inboxOfKey(chatJid))))
        lastHandoff.set(chatJid, row.at);
    } catch {
      // not a hand-off row we can read
    }
  }
  if (!lastHandoff.size) return { count: 0, oldestAt: null };
  const open = db.prepare(
    `SELECT c.jid FROM chats c WHERE c.jid = ? AND c.type = 'dm' AND c.status = 'open' AND ${scope}`,
  );
  // The newest reply written by a person: a teammate in EzyChat or someone on the phone (no AI).
  const lastPersonReply = db.prepare(
    `SELECT MAX(m.timestamp) AS at FROM messages m
     WHERE m.chat_jid = ? AND m.from_me = 1 AND ${COUNTED}
       AND (m.sent_by_user_id IS NULL OR m.sent_by_user_id NOT IN (SELECT id FROM users WHERE kind = 'ai'))`,
  );
  let count = 0;
  let oldestAt: number | null = null;
  for (const [chatJid, at] of lastHandoff) {
    if (!open.get(chatJid)) continue;
    const reply = lastPersonReply.get(chatJid) as { at: number | null };
    if (reply.at !== null && reply.at >= at) continue;
    count++;
    oldestAt = oldestAt === null ? at : Math.min(oldestAt, at);
  }
  return { count, oldestAt };
}

import type {
  ReportPeriod,
  SafetyKind,
  SafetyReport,
  SafetyReportTotals,
  SafetyRule,
} from '@ezychat/shared';
import { inboxCondition, localDate, localMidnight } from '../chats/stats.js';
import type { DB } from '../db/index.js';

const DAY_MS = 86_400_000;

/** The one kind each flagged message counts as, most telling first. */
export function kindOf(
  rules: readonly SafetyRule[],
  aiCategory: string | null,
  hasFile: boolean,
): SafetyKind {
  if (rules.includes('scamNumber') && rules.length === 1) return 'scamNumber';
  if (rules.some((r) => r === 'exeInZip' || r === 'executable' || r === 'doubleExtension'))
    return 'hiddenProgram';
  if (rules.includes('lookalikeLink') || aiCategory === 'phishing') return 'fakeLink';
  if (rules.includes('cantInspect')) return 'lockedArchive';
  if (rules.includes('macroFile')) return 'macroFile';
  if (
    !hasFile &&
    (rules.includes('financeUrgency') ||
      aiCategory === 'payment_fraud' ||
      aiCategory === 'impersonation')
  )
    return 'paymentTrick';
  return 'other';
}

interface Row {
  id: number;
  chat_jid: string;
  rules: string;
  ai_category: string | null;
  level: 'none' | 'warning' | 'high';
  status: string;
  existing_customer: number;
  has_file: number;
  created_at: number;
}

/**
 * `items` limits `safety_items i` to the report's inboxes. Numbers are shared by inboxes: one inbox
 * counts a blocked number only when that number has a chat in it.
 */
function totals(
  db: DB,
  from: number,
  to: number,
  inboxIds: readonly number[] | undefined,
): SafetyReportTotals {
  const items = inboxCondition('i', inboxIds);
  const numbers = inboxIds
    ? `AND EXISTS (SELECT 1 FROM chats c WHERE c.wa_jid = safety_numbers.wa_jid AND ${inboxCondition('c', inboxIds)})`
    : '';
  const rows = db
    .prepare(`SELECT * FROM safety_items i WHERE created_at >= ? AND created_at < ? AND ${items}`)
    .all(from, to) as Row[];
  const downloads = db
    .prepare(
      `SELECT d.allowed, COUNT(*) AS n FROM safety_downloads d JOIN safety_items i ON i.id = d.item_id
        WHERE i.level = 'high' AND d.at >= ? AND d.at < ? AND ${items} GROUP BY d.allowed`,
    )
    .all(from, to) as Array<{ allowed: number; n: number }>;
  const blocked = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(blocked_auto), 0) AS auto FROM safety_numbers
        WHERE blocked_at >= ? AND blocked_at < ? ${numbers}`,
    )
    .get(from, to) as { n: number; auto: number };
  const high = rows.filter((r) => r.level === 'high');
  return {
    dangerousFiles: high.filter((r) => r.has_file).length,
    scamMessages: rows.filter((r) => r.level !== 'none' && !r.has_file).length,
    riskyDownloads: downloads.find((d) => d.allowed === 1)?.n ?? 0,
    refusedDownloads: downloads.find((d) => d.allowed === 0)?.n ?? 0,
    numbersBlocked: blocked.n,
    autoBlocked: blocked.auto,
    maybeHacked: new Set(
      high.filter((r) => r.existing_customer && r.has_file).map((r) => r.chat_jid),
    ).size,
    flagged: rows.length,
    falseAlarms: rows.filter((r) => r.status === 'safe' || r.status === 'cleared').length,
  };
}

/**
 * Admin → Reports → WhatsApp Safety for the last `days` local days (business time zone), counted on
 * request from `safety_items`, `safety_downloads` and `safety_numbers`. Every inbox together, or
 * only `inboxIds` (admins only).
 */
export function computeSafetyReport(
  db: DB,
  opts: {
    days: ReportPeriod;
    timeZone: string;
    now: number;
    enabled: boolean;
    /** Only these inboxes; omitted = every inbox. */
    inboxIds?: readonly number[];
  },
): SafetyReport {
  const { days, timeZone, now, inboxIds } = opts;
  const items = inboxCondition('i', inboxIds);
  const today = localMidnight(localDate(now, timeZone), timeZone);
  const starts = [today];
  for (let i = 1; i < days; i++)
    starts.unshift(localMidnight(localDate(starts[0]! - DAY_MS / 2, timeZone), timeZone));
  const end = localMidnight(localDate(today + DAY_MS * 1.5, timeZone), timeZone);
  const from = starts[0]!;
  const before = localMidnight(localDate(from - days * DAY_MS + DAY_MS / 2, timeZone), timeZone);

  const rows = db
    .prepare(
      `SELECT * FROM safety_items i WHERE created_at >= ? AND created_at < ? AND ${items}
        ORDER BY created_at`,
    )
    .all(from, end) as Row[];
  const bounds = [...starts, end];
  const daily = starts.map((start, i) => {
    const inDay = rows.filter((r) => r.created_at >= start && r.created_at < bounds[i + 1]!);
    return {
      date: localDate(start + DAY_MS / 2, timeZone),
      high: inDay.filter((r) => r.level === 'high').length,
      warning: inDay.filter((r) => r.level === 'warning').length,
    };
  });

  const kinds = new Map<SafetyKind, number>();
  for (const r of rows.filter((x) => x.level !== 'none')) {
    const kind = kindOf(JSON.parse(r.rules) as SafetyRule[], r.ai_category, r.has_file === 1);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  const senders = db
    .prepare(
      `SELECT i.chat_jid, COUNT(*) AS n, c.name, c.phone, c.wa_jid, p.name AS profile_name, c.type,
              s.scam_at, s.blocked_at,
              (SELECT x.status FROM safety_items x WHERE x.chat_jid = i.chat_jid ORDER BY x.created_at DESC LIMIT 1) AS last_status,
              (SELECT x.existing_customer FROM safety_items x WHERE x.chat_jid = i.chat_jid ORDER BY x.created_at DESC LIMIT 1) AS existing,
              (SELECT x.level FROM safety_items x WHERE x.chat_jid = i.chat_jid ORDER BY x.created_at DESC LIMIT 1) AS last_level
         FROM safety_items i
         LEFT JOIN chats c ON c.jid = i.chat_jid
         LEFT JOIN customer_profiles p ON p.chat_jid = i.chat_jid
         LEFT JOIN safety_numbers s ON s.wa_jid = c.wa_jid
        WHERE i.level != 'none' AND i.created_at >= ? AND i.created_at < ? AND c.type = 'dm' AND ${items}
        GROUP BY i.chat_jid ORDER BY n DESC, MAX(i.created_at) DESC LIMIT 5`,
    )
    .all(from, end) as Array<{
    chat_jid: string;
    n: number;
    name: string | null;
    phone: string | null;
    wa_jid: string | null;
    profile_name: string | null;
    scam_at: number | null;
    blocked_at: number | null;
    last_status: string;
    existing: number;
    last_level: string;
  }>;

  const team = db
    .prepare(
      `SELECT u.display_name AS name, SUM(d.allowed) AS risky, SUM(1 - d.allowed) AS refused
         FROM safety_downloads d JOIN safety_items i ON i.id = d.item_id JOIN users u ON u.id = d.user_id
        WHERE i.level = 'high' AND d.at >= ? AND d.at < ? AND ${items}
        GROUP BY d.user_id ORDER BY risky DESC, refused DESC, u.display_name`,
    )
    .all(from, end) as Array<{ name: string; risky: number; refused: number }>;

  return {
    days,
    inboxId: inboxIds?.length === 1 ? inboxIds[0]! : null,
    enabled: opts.enabled,
    totals: totals(db, from, end, inboxIds),
    previous: totals(db, before, from, inboxIds),
    daily,
    kinds: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    senders: senders.map((s) => ({
      chatJid: s.chat_jid,
      phone: s.phone ?? s.wa_jid?.match(/^(\d{6,15})@s\.whatsapp\.net$/)?.[1] ?? null,
      name: s.profile_name || s.name || 'WhatsApp',
      count: s.n,
      status:
        s.blocked_at !== null
          ? 'blocked'
          : s.scam_at !== null
            ? 'reported'
            : s.last_status !== 'open'
              ? 'done'
              : s.existing && s.last_level === 'high'
                ? 'maybeHacked'
                : 'open',
    })),
    team: team.map((m) => ({ name: m.name, riskyDownloads: m.risky, refused: m.refused })),
  };
}

import { z } from 'zod';

/**
 * Admin → Reports (design: docs/features/reports/design.md): how busy the WhatsApp numbers are and
 * how fast the team and the AI answer. Counted from the local database only; direct chats only.
 */

export const REPORT_PERIODS = [7, 30, 90] as const;
export const ReportPeriod = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type ReportPeriod = z.infer<typeof ReportPeriod>;

/** `GET /api/reports?days=&inbox=` (also `/api/reports/safety`): `inbox` omitted = every inbox. */
export const ReportQuery = z.object({
  days: z.coerce.number().pipe(ReportPeriod).default(30),
  inbox: z.coerce.number().int().positive().optional(),
});

/** A new customer with no reply after this long counts as missed. */
export const MISSED_LEAD_MS = 60 * 60 * 1000;

export const ReportTotals = z.object({
  /** Chats whose first message (from the customer) arrived in the period, after WhatsApp was linked. */
  newCustomers: z.number().int().nonnegative(),
  messagesIn: z.number().int().nonnegative(),
  messagesOut: z.number().int().nonnegative(),
  /** Direct chats with at least one message in the period. */
  activeChats: z.number().int().nonnegative(),
  /** Median minutes from a customer message that starts a wait to the first reply (team or AI). */
  medianFirstReplyMinutes: z.number().nonnegative().nullable(),
  /** New customers with no reply within `MISSED_LEAD_MS`. */
  missedLeads: z.number().int().nonnegative(),
  /** Direct chats the AI agent answered in. */
  aiAnswered: z.number().int().nonnegative(),
  aiResolved: z.number().int().nonnegative(),
  aiHandoffs: z.number().int().nonnegative(),
});
export type ReportTotals = z.infer<typeof ReportTotals>;

export const ReportDay = z.object({
  /** Local `YYYY-MM-DD` in the business time zone. */
  date: z.string(),
  inbound: z.number().int().nonnegative(),
  outbound: z.number().int().nonnegative(),
  newCustomers: z.number().int().nonnegative(),
  activeChats: z.number().int().nonnegative(),
});
export type ReportDay = z.infer<typeof ReportDay>;

export const ReportTeamRow = z.object({
  /** `null` = sent from the linked phone itself. */
  userId: z.number().int().nullable(),
  name: z.string(),
  kind: z.enum(['human', 'ai', 'phone']),
  chats: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  medianReplyMinutes: z.number().nonnegative().nullable(),
});
export type ReportTeamRow = z.infer<typeof ReportTeamRow>;

export const Report = z.object({
  days: ReportPeriod,
  /** The one inbox counted; `null` = every inbox together. */
  inboxId: z.number().int().positive().nullable().default(null),
  timeZone: z.string(),
  /** Local date of the first stored message (`null` = none yet). */
  firstDate: z.string().nullable(),
  /** Local date WhatsApp was first linked (the history import): customers seen before it are not new. */
  linkedDate: z.string().nullable(),
  totals: ReportTotals,
  /** The same totals for the period just before; `null` while it lies before the first message. */
  previous: ReportTotals.nullable(),
  /** Current state, not tied to the period: open chats the AI handed over where the customer still waits. */
  waitingAfterHandoff: z.object({
    count: z.number().int().nonnegative(),
    oldestAt: z.number().int().nullable(),
  }),
  /** One row per local day from the later of the period start and `firstDate`; today is partial. */
  daily: z.array(ReportDay),
  /** Monday first: average messages from customers and active chats per day of that weekday. */
  weekdays: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      avgInbound: z.number().nonnegative(),
      avgChats: z.number().nonnegative(),
    }),
  ),
  /** [weekday Monday first][hour 0–23]: average messages from customers in that hour. */
  hours: z.array(z.array(z.number().nonnegative())),
  handoffReasons: z.array(z.object({ reason: z.string(), count: z.number().int().positive() })),
  team: z.array(ReportTeamRow),
});
export type Report = z.infer<typeof Report>;

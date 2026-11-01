import { z } from 'zod';

/**
 * WhatsApp Safety (design: docs/features/whatsapp-safety/design.md): local rules and an optional AI
 * check flag risky files and scam messages; High-risk files are locked for agents; admins review
 * them on Admin → Safety and in Reports.
 */

/** What the local rules can find. `critical` ones make a message High whatever else is found. */
export const SAFETY_RULES = {
  exeInZip: { points: 0, critical: true },
  executable: { points: 0, critical: true },
  doubleExtension: { points: 0, critical: true },
  scamNumber: { points: 0, critical: true },
  cantInspect: { points: 40, critical: false },
  macroFile: { points: 40, critical: false },
  unlockCodeInMessage: { points: 25, critical: false },
  openOnComputer: { points: 25, critical: false },
  lookalikeLink: { points: 25, critical: false },
  financeUrgency: { points: 20, critical: false },
  firstFile: { points: 15, critical: false },
} as const;

export const SafetyRule = z.enum([
  'exeInZip',
  'executable',
  'doubleExtension',
  'scamNumber',
  'cantInspect',
  'macroFile',
  'unlockCodeInMessage',
  'openOnComputer',
  'lookalikeLink',
  'financeUrgency',
  'firstFile',
]);
export type SafetyRule = z.infer<typeof SafetyRule>;

export const SafetyLevel = z.enum(['none', 'warning', 'high']);
export type SafetyLevel = z.infer<typeof SafetyLevel>;

/** Score at or above which the rules alone say High / Warning. */
export const SAFETY_HIGH_SCORE = 60;
export const SAFETY_WARNING_SCORE = 30;

export const SafetyAiCategory = z.enum([
  'malware_lure',
  'phishing',
  'impersonation',
  'payment_fraud',
  'none',
]);
export type SafetyAiCategory = z.infer<typeof SafetyAiCategory>;

/** The AI check's structured answer; `reason` is one plain sentence in the team's language. */
export const SafetyAiAnswer = z.object({
  level: SafetyLevel,
  category: SafetyAiCategory,
  reason: z.string().trim().max(200),
});
export type SafetyAiAnswer = z.infer<typeof SafetyAiAnswer>;

export const SafetyStatus = z.enum(['open', 'safe', 'reported', 'blocked', 'cleared']);
export type SafetyStatus = z.infer<typeof SafetyStatus>;

/** What a chat bubble needs: attached to `Message.safety` by the message service. */
export const MessageSafety = z.object({
  itemId: z.number().int().positive(),
  level: SafetyLevel,
  rules: z.array(SafetyRule),
  aiReason: z.string().nullable(),
  /** Agents cannot download the file (High, not released, not marked safe). */
  locked: z.boolean(),
  deletedBy: z.string().nullable(),
  status: SafetyStatus,
});
export type MessageSafety = z.infer<typeof MessageSafety>;

export const SafetySettings = z.object({
  enabled: z.boolean(),
  ai: z.boolean(),
  autoBlock: z.boolean(),
  deleteAfterDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
});
export type SafetySettings = z.infer<typeof SafetySettings>;

/** `PUT /api/safety/settings` */
export const SafetySettingsBody = SafetySettings.partial();

/** One flagged message on Admin → Safety. */
export const SafetyItemView = z.object({
  id: z.number().int().positive(),
  messageId: z.string(),
  chatJid: z.string(),
  inboxId: z.number().int().positive(),
  /** Chat name (the saved customer name first), for a group the sender's. */
  senderName: z.string(),
  /** Digits with country code; null when WhatsApp hid the number (a LID only). */
  phone: z.string().nullable(),
  group: z.boolean(),
  at: z.number().int(),
  /** The message text (admins see the chat anyway). */
  text: z.string().nullable(),
  file: z.object({ name: z.string().nullable(), inside: z.array(z.string()) }).nullable(),
  rules: z.array(SafetyRule),
  score: z.number().int(),
  ruleLevel: SafetyLevel,
  critical: z.boolean(),
  ai: SafetyAiAnswer.nullable(),
  level: SafetyLevel,
  status: SafetyStatus,
  existingCustomer: z.boolean(),
  quarantined: z.boolean(),
  released: z.boolean(),
  deleted: z.object({ by: z.string(), at: z.number().int() }).nullable(),
  autoBlocked: z.boolean(),
  scam: z.boolean(),
  blocked: z.boolean(),
  /** The connection can block this number now (capability and, for the Business API, its window). */
  canBlock: z.boolean(),
  downloads: z.array(z.object({ name: z.string(), at: z.number().int(), allowed: z.boolean() })),
});
export type SafetyItemView = z.infer<typeof SafetyItemView>;

export const SafetyBlockedNumber = z.object({
  waJid: z.string(),
  phone: z.string().nullable(),
  name: z.string(),
  by: z.string().nullable(),
  at: z.number().int(),
  auto: z.boolean(),
  /** The flagged item to act on (Unblock); null when none is kept. */
  itemId: z.number().int().positive().nullable(),
});
export type SafetyBlockedNumber = z.infer<typeof SafetyBlockedNumber>;

/** `GET /api/safety` (admins) */
export const SafetyState = z.object({
  settings: SafetySettings,
  /** An AI connection is ready, so the AI check runs when switched on. */
  aiReady: z.boolean(),
  items: z.array(SafetyItemView),
  blocked: z.array(SafetyBlockedNumber),
});
export type SafetyState = z.infer<typeof SafetyState>;

export const SAFETY_ACTIONS = ['safe', 'release', 'delete', 'report', 'block', 'unblock'] as const;
export const SafetyAction = z.enum(SAFETY_ACTIONS);
export type SafetyAction = z.infer<typeof SafetyAction>;

/** `POST /api/safety/items/:id/:action` body: `trust` for safe, `block` for report. */
export const SafetyActionBody = z
  .object({ trust: z.boolean().optional(), block: z.boolean().optional() })
  .default({});
export type SafetyActionBody = z.infer<typeof SafetyActionBody>;

/** `GET /api/safety/chats/:jid` (anyone with the chat's inbox): the bar on top of the chat. */
export const SafetyChatState = z.object({
  enabled: z.boolean(),
  scam: z.boolean(),
  blocked: z
    .object({ by: z.string().nullable(), at: z.number().int(), auto: z.boolean() })
    .nullable(),
  /** A known customer whose latest flagged message is High and still open: their WhatsApp may be hacked. */
  maybeHacked: z.boolean(),
  itemId: z.number().int().positive().nullable(),
});
export type SafetyChatState = z.infer<typeof SafetyChatState>;

export const SafetyKind = z.enum([
  'hiddenProgram',
  'fakeLink',
  'paymentTrick',
  'lockedArchive',
  'macroFile',
  'scamNumber',
  'other',
]);
export type SafetyKind = z.infer<typeof SafetyKind>;

export const SafetyReportTotals = z.object({
  dangerousFiles: z.number().int().nonnegative(),
  scamMessages: z.number().int().nonnegative(),
  riskyDownloads: z.number().int().nonnegative(),
  refusedDownloads: z.number().int().nonnegative(),
  numbersBlocked: z.number().int().nonnegative(),
  autoBlocked: z.number().int().nonnegative(),
  maybeHacked: z.number().int().nonnegative(),
  flagged: z.number().int().nonnegative(),
  falseAlarms: z.number().int().nonnegative(),
});
export type SafetyReportTotals = z.infer<typeof SafetyReportTotals>;

/** `GET /api/reports/safety?days=&inbox=` (admins): Admin → Reports → WhatsApp Safety. */
export const SafetyReport = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  /** The one inbox counted; `null` = every inbox together. */
  inboxId: z.number().int().positive().nullable().default(null),
  enabled: z.boolean(),
  totals: SafetyReportTotals,
  previous: SafetyReportTotals,
  daily: z.array(
    z.object({
      date: z.string(),
      high: z.number().int().nonnegative(),
      warning: z.number().int().nonnegative(),
    }),
  ),
  kinds: z.array(z.object({ kind: SafetyKind, count: z.number().int().positive() })),
  senders: z.array(
    z.object({
      chatJid: z.string(),
      phone: z.string().nullable(),
      name: z.string(),
      count: z.number().int().positive(),
      status: z.enum(['blocked', 'reported', 'maybeHacked', 'open', 'done']),
    }),
  ),
  team: z.array(
    z.object({
      name: z.string(),
      riskyDownloads: z.number().int().nonnegative(),
      refused: z.number().int().nonnegative(),
    }),
  ),
});
export type SafetyReport = z.infer<typeof SafetyReport>;

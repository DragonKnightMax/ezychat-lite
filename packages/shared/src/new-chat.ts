import { z } from 'zod';

/**
 * New chat (design: docs/features/new-chat/design.md): start a WhatsApp chat with a phone number that is
 * not in the inbox yet, one number at a time. Admins always; agents when an admin allows it (setting
 * `new_chat_staff`); never an agent limited to chosen chats, the AI or any other role.
 */

/** Default for the setting `new_chat_daily_limit` (new numbers a day per linked phone; 0 = no limit). */
export const NEW_CHAT_DEFAULT_DAILY_LIMIT = 20;
export const NEW_CHAT_MAX_DAILY_LIMIT = 1000;
/** New numbers a person may start in an hour (every inbox type). */
export const NEW_CHAT_PER_USER_PER_HOUR = 5;
/** Country calling code used when the inbox's own number gives none. */
export const NEW_CHAT_FALLBACK_COUNTRY = '60';

/**
 * ITU country calling codes (without +). Used only to read the country code of an inbox's own number,
 * so local numbers typed with a leading 0 get that country.
 */
const CALLING_CODES: ReadonlySet<string> = new Set(
  (
    '1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 ' +
    '65 66 81 82 84 86 90 91 92 93 94 95 98 211 212 213 216 218 220 221 222 223 224 225 226 227 228 ' +
    '229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 248 249 250 251 252 253 ' +
    '254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299 350 351 352 353 ' +
    '354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 ' +
    '421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 ' +
    '673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 850 852 853 855 856 ' +
    '880 886 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 992 993 994 995 996 998'
  ).split(' '),
);

/** The country calling code a full international number starts with, or null. */
export function countryCodeOf(digits: string): string | null {
  for (const length of [1, 2, 3]) {
    const code = digits.slice(0, length);
    if (CALLING_CODES.has(code)) return code;
  }
  return null;
}

/**
 * Digits of an international number (no +), or null. Accepts `+60 12-345 6789`, `60 12…`, `0060…` and a
 * local number with a leading 0 (`012-345 6789`), which gets `defaultCountry`. Spaces, dots, dashes and
 * brackets are ignored; letters are refused. A Malaysian mobile (+60 1x) must have 9–10 digits after 60.
 */
export function normalizeLocalPhone(
  raw: string,
  defaultCountry: string = NEW_CHAT_FALLBACK_COUNTRY,
): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (!trimmed.startsWith('+')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (digits.startsWith('601') && (digits.length < 11 || digits.length > 12)) return null;
  return digits;
}

/** How New chat works for one inbox (decided on the server from its connection's capabilities). */
export const NewChatMode = z.enum([
  /** Linked phone: the number is checked on WhatsApp, then the chat opens with the normal composer. */
  'check',
  /** WhatsApp Business API: the first message is an approved template; the chat exists once it is sent. */
  'template',
  /** A connection that can neither: shown, not usable. */
  'unsupported',
]);
export type NewChatMode = z.infer<typeof NewChatMode>;

export const NewChatInboxStatus = z.object({
  inboxId: z.number().int().positive(),
  mode: NewChatMode,
  /** New numbers counted today for this inbox (linked phones; 0 for template inboxes). */
  usedToday: z.number().int().nonnegative(),
  /** Country calling code a local number (leading 0) gets: the inbox's own number's, else 60. */
  countryCode: z.string().regex(/^\d{1,3}$/),
});
export type NewChatInboxStatus = z.infer<typeof NewChatInboxStatus>;

/** GET /api/new-chat (any signed-in user). `inboxes` lists only inboxes the user may start from. */
export const NewChatStatus = z.object({
  allowed: z.boolean(),
  staffEnabled: z.boolean(),
  /** New numbers a day per linked phone (0 = no limit). */
  dailyLimit: z.number().int().min(0).max(NEW_CHAT_MAX_DAILY_LIMIT),
  perUserPerHour: z.number().int().positive(),
  inboxes: z.array(NewChatInboxStatus),
});
export type NewChatStatus = z.infer<typeof NewChatStatus>;

/** PUT /api/new-chat/settings (admins). Each change is audited with before/after. */
export const NewChatSettingsBody = z
  .object({
    staffEnabled: z.boolean().optional(),
    dailyLimit: z.number().int().min(0).max(NEW_CHAT_MAX_DAILY_LIMIT).optional(),
  })
  .strict();
export type NewChatSettingsBody = z.infer<typeof NewChatSettingsBody>;

/** POST /api/inboxes/:id/new-chat/check: never asks WhatsApp and is not counted. */
export const NewChatCheckBody = z.object({ phone: z.string().trim().min(1).max(40) });
export type NewChatCheckBody = z.infer<typeof NewChatCheckBody>;

export const NewChatCheckResponse = z.discriminatedUnion('next', [
  /** The number already has a chat in this inbox: open it. */
  z.object({ next: z.literal('existing'), phone: z.string(), chatJid: z.string() }),
  /** Linked phone: Start checks the number on WhatsApp. */
  z.object({ next: z.literal('check'), phone: z.string() }),
  /** Business API: choose an approved template; Start sends it. */
  z.object({ next: z.literal('template'), phone: z.string() }),
]);
export type NewChatCheckResponse = z.infer<typeof NewChatCheckResponse>;

/** POST /api/inboxes/:id/new-chat. */
export const NewChatBody = z.object({
  phone: z.string().trim().min(1).max(40),
  /** Saved as the customer's name (optional). */
  name: z.string().trim().max(100).optional(),
  /** Idempotency: a retry with the same id answers the first result and counts nothing. */
  clientRequestId: z.string().uuid(),
  /** Required for a Business API inbox (the first message), refused otherwise. */
  template: z
    .object({
      name: z.string().min(1).max(512),
      language: z.string().min(1).max(15),
      params: z.array(z.string().trim().min(1).max(1024)).max(20).default([]),
    })
    .optional(),
});
export type NewChatBody = z.infer<typeof NewChatBody>;
export type NewChatBodyInput = z.input<typeof NewChatBody>;

export const NewChatResponse = z.object({ chatJid: z.string(), created: z.boolean() });
export type NewChatResponse = z.infer<typeof NewChatResponse>;

import { z } from 'zod';
import { ChatStatus, MessageType, Role } from './enums.js';
import { LocaleSchema } from './i18n/locales.js';
import {
  ChatEventSchema,
  ChatSchema,
  MessageEditedBy,
  MessageReactionSchema,
  MessageSchema,
  QuickReplySchema,
  SettingsSchema,
  UserSchema,
} from './models.js';

export const SetupStatusResponse = z.object({ needsSetup: z.boolean() });
export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

export const SetupAdminBody = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
});
export type SetupAdminBody = z.infer<typeof SetupAdminBody>;

export const LoginBody = z.object({ username: z.string(), password: z.string() });
export type LoginBody = z.infer<typeof LoginBody>;

export const ChangePasswordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(256),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

export const MeResponse = UserSchema;
export type MeResponse = z.infer<typeof MeResponse>;

/** Self-service preferences of the signed-in user. */
export const PatchMeBody = z.strictObject({ locale: LocaleSchema.nullable() });
export type PatchMeBody = z.infer<typeof PatchMeBody>;

export const ChatListQuery = z.object({
  status: ChatStatus.optional(),
  assigned: z.enum(['me', 'none', 'any']).default('any'),
  q: z.string().max(100).optional(),
  /** Customer tag filter, matched case-insensitively. */
  tag: z.string().trim().min(1).max(30).optional(),
  cursor: z.string().optional(),
  since: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** One inbox only (multi-inbox); unset = every inbox the caller may open. */
  inbox: z.coerce.number().int().positive().optional(),
});
export type ChatListQuery = z.infer<typeof ChatListQuery>;
/** Input shape (before defaults/coercion), for clients building query strings. */
export type ChatListQueryInput = z.input<typeof ChatListQuery>;

export const ChatListResponse = z.object({
  chats: z.array(ChatSchema),
  nextCursor: z.string().nullable(),
});
export type ChatListResponse = z.infer<typeof ChatListResponse>;

export const ChatPatchBody = z.object({
  assignedTo: z.number().nullable().optional(),
  status: ChatStatus.optional(),
});
export type ChatPatchBody = z.infer<typeof ChatPatchBody>;

export const OpenChatCountResponse = z.object({ openCount: z.number().int().nonnegative() });
export type OpenChatCountResponse = z.infer<typeof OpenChatCountResponse>;
export const ResolveAllChatsBody = z.object({ confirmed: z.literal(true) });
export type ResolveAllChatsBody = z.infer<typeof ResolveAllChatsBody>;
export const ResolveAllChatsResponse = z.object({ resolvedCount: z.number().int().nonnegative() });
export type ResolveAllChatsResponse = z.infer<typeof ResolveAllChatsResponse>;

export const ChatDetailResponse = z.object({ chat: ChatSchema, events: z.array(ChatEventSchema) });
export type ChatDetailResponse = z.infer<typeof ChatDetailResponse>;

export const MessageListQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MessageListQuery = z.infer<typeof MessageListQuery>;
export type MessageListQueryInput = z.input<typeof MessageListQuery>;

export const MessageListResponse = z.object({
  messages: z.array(MessageSchema),
  nextBefore: z.string().nullable(),
});
export type MessageListResponse = z.infer<typeof MessageListResponse>;

/**
 * Where a quoted message sits in its chat (`GET /chats/:jid/messages/:id/locate`): `found` is false
 * when it is not stored in this chat or is hidden for the team; `newer` counts the visible messages
 * after it, so the inbox knows how many older pages to load before it can scroll there.
 */
export const MessageLocateResponse = z.object({
  found: z.boolean(),
  newer: z.number().int().nonnegative(),
});
export type MessageLocateResponse = z.infer<typeof MessageLocateResponse>;

/** Most members one message may tag (@mention). */
export const MAX_MESSAGE_MENTIONS = 50;

export const SendTextBody = z.object({
  text: z.string().min(1).max(65536),
  quotedId: z.string().optional(),
  clientId: z.string().min(1).max(64),
  /**
   * Group chats only: the members this message tags. Each is written in the text as `@<number>`
   * (the user part of the JID, as WhatsApp does); the server sends them as WhatsApp mentions.
   */
  mentions: z.array(z.string().min(1).max(256)).max(MAX_MESSAGE_MENTIONS).optional(),
});
export type SendTextBody = z.infer<typeof SendTextBody>;

/** POST /chats/:jid/media: the text fields of the multipart form (the file goes in `file`). */
export const SendMediaFields = z.object({
  clientId: z.string().min(1).max(64),
  caption: z.string().max(4096).optional(),
  quotedId: z.string().max(256).optional(),
  /** "1": send the Ogg/Opus file as a WhatsApp voice note (never with a caption). */
  voiceNote: z.literal('1').optional(),
  /**
   * "1": send a video as a file (a document: full quality, no preview), e.g. above the number's video
   * limit (`InboxCapabilities.mediaLimits.video`). Ignored for other types.
   */
  asFile: z.literal('1').optional(),
});
export type SendMediaFields = z.infer<typeof SendMediaFields>;

/** One emoji: a flag, a keycap, or a picture with skin tone and joined parts; no text or spaces. */
const EMOJI_PART = '\\p{Extended_Pictographic}\\ufe0f?\\p{Emoji_Modifier}?';
const REACTION_EMOJI = new RegExp(
  `^(?:\\p{Regional_Indicator}{2}|[0-9#*]\\ufe0f?\\u20e3|${EMOJI_PART}(?:\\u200d${EMOJI_PART})*)$`,
  'u',
);

/**
 * PUT /messages/:id/reaction: the linked number reacts to the message (WhatsApp keeps one
 * reaction per number, so this replaces the current one); `emoji` '' removes it.
 */
export const SendReactionBody = z.object({
  emoji: z
    .string()
    .max(32)
    .refine((e) => e === '' || REACTION_EMOJI.test(e), 'emoji must be a single emoji or empty'),
});
export type SendReactionBody = z.infer<typeof SendReactionBody>;

/** The message's reactions after the change. */
export const SendReactionResponse = z.object({
  messageId: z.string(),
  reactions: z.array(MessageReactionSchema),
});
export type SendReactionResponse = z.infer<typeof SendReactionResponse>;

/** PATCH /messages/:id: new text (or caption) of a message the team sent; WhatsApp shows "Edited". */
export const EditMessageBody = z.object({ text: z.string().trim().min(1).max(65536) });
export type EditMessageBody = z.infer<typeof EditMessageBody>;

/**
 * DELETE /messages/:id?scope=: `everyone` deletes it on the customer's WhatsApp too; `me` hides it
 * for the whole team and deletes it on the linked phone (admins only).
 */
export const DeleteMessageQuery = z.object({ scope: z.enum(['everyone', 'me']) });
export type DeleteMessageQuery = z.infer<typeof DeleteMessageQuery>;

/** One earlier version of an edited message, oldest first. */
export const MessageEditSchema = z.object({
  /** The text before this edit. */
  previousBody: z.string().nullable(),
  at: z.number(),
  by: MessageEditedBy,
  /** `by` `team`: the teammate who edited. */
  userId: z.number().nullable(),
});
export type MessageEdit = z.infer<typeof MessageEditSchema>;

/**
 * GET /messages/:id/edits. `original`: the text of a message deleted for everyone, for admins only
 * (null for agents and for messages that are not deleted).
 */
export const MessageEditsResponse = z.object({
  messageId: z.string(),
  edits: z.array(MessageEditSchema),
  original: z.string().nullable(),
});
export type MessageEditsResponse = z.infer<typeof MessageEditsResponse>;

export const NoteBody = z.object({ body: z.string().min(1).max(8192) });
export type NoteBody = z.infer<typeof NoteBody>;

export const QuickReplyBody = z.object({
  shortcut: QuickReplySchema.shape.shortcut,
  body: QuickReplySchema.shape.body,
});
export type QuickReplyBody = z.infer<typeof QuickReplyBody>;

export const CreateUserBody = z.object({
  username: SetupAdminBody.shape.username,
  displayName: SetupAdminBody.shape.displayName,
  role: Role,
  password: z.string().min(8).max(256),
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const PatchUserBody = z.object({
  displayName: z.string().min(1).max(64).optional(),
  role: Role.optional(),
  disabled: z.boolean().optional(),
});
export type PatchUserBody = z.infer<typeof PatchUserBody>;

export const ResetPasswordResponse = z.object({ password: z.string() });
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponse>;

/** Browser-side error report (written to the server log as a structured `mod: "web"` entry). */
export const ClientErrorBody = z.object({
  kind: z.enum(['error', 'unhandledrejection', 'react']),
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  componentStack: z.string().max(8000).optional(),
  route: z.string().max(500),
  appVersion: z.string().max(50).optional(),
});
export type ClientErrorBody = z.infer<typeof ClientErrorBody>;

/** Link WhatsApp by phone number (pairing code) instead of QR. Phone includes country code. */
export const PairingCodeBody = z.object({ phone: z.string().min(8).max(32) });
export type PairingCodeBody = z.infer<typeof PairingCodeBody>;
export const PairingCodeResponse = z.object({ code: z.string() });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

export const TunnelStartBody = z.object({
  mode: z.enum(['quick', 'named']),
  token: z.string().min(10).optional(),
  hostname: z.string().optional(),
});
export type TunnelStartBody = z.infer<typeof TunnelStartBody>;

/** Public setup state only. Cloudflare credentials never leave the server. */
export const CloudflareDomain = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/i),
  name: z.string(),
  accountName: z.string().nullable(),
});
export type CloudflareDomain = z.infer<typeof CloudflareDomain>;
export const CloudflareSetupStatus = z.object({
  state: z.enum(['signed_out', 'signing_in', 'awaiting_approval', 'connected', 'error']),
  loginUrl: z.string().nullable(),
  error: z.string().nullable(),
  domains: z.array(CloudflareDomain),
  busy: z.boolean(),
  managed: z.object({ id: z.string().uuid(), name: z.string(), hostname: z.string() }).nullable(),
});
export type CloudflareSetupStatus = z.infer<typeof CloudflareSetupStatus>;
export const CloudflareCreateBody = z.object({
  domainId: CloudflareDomain.shape.id,
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(63)
    .regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      'Use letters, numbers and hyphens, without a hyphen at either end.',
    ),
  tunnelName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/,
      'Use letters, numbers, spaces, dots, underscores and hyphens.',
    ),
});
export type CloudflareCreateBody = z.infer<typeof CloudflareCreateBody>;

// usageStats is re-declared without its default: a patch that leaves it out must not switch it on.
export const SettingsPatchBody = SettingsSchema.omit({ hasTunnelToken: true })
  .partial()
  .extend({ usageStats: z.boolean().optional() });
export type SettingsPatchBody = z.infer<typeof SettingsPatchBody>;

export const PushSubscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBody>;

export const HealthResponse = z.object({
  app: z.literal('wa-team-inbox'),
  /** Product edition ('lite', 'enterprise', ...). Older servers omit it: treat missing as 'lite'. */
  edition: z.string().optional(),
  version: z.string(),
  mode: z.enum(['standalone', 'service', 'dev']),
  /** Access gate state (editions may close it). Older servers omit it: treat missing as 'open'. */
  access: z.enum(['open', 'closed']).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * GET /api/access (public, no sign-in): whether the app is usable. While an edition has closed the
 * access gate, `code` is its stable reason (e.g. 'license_required') and every other /api call answers
 * 403 with that code. Holds no data beyond the state.
 */
export const accessStatusSchema = z.object({
  open: z.boolean(),
  code: z.string().min(1).max(64).optional(),
});
export type AccessStatus = z.infer<typeof accessStatusSchema>;

export const FakeIncomingBody = z.object({
  /** fake WA only: the inbox whose fake phone receives it (default 1) */
  inboxId: z.number().int().positive().optional(),
  chatJid: z.string(),
  /** fake WA only: the other address of the same person (PN for a LID chat, or the reverse) */
  chatJidAlt: z.string().max(256).optional(),
  text: z.string(),
  senderName: z.string().optional(),
  /** fake WA only: group sender and explicit WhatsApp mentions. */
  senderJid: z.string().max(256).optional(),
  mentionedJids: z.array(z.string().max(256)).max(1024).optional(),
  type: MessageType.optional(),
  /** fake WA only: attached media (e.g. a voice note), base64; served by the fake adapter's download. */
  media: z
    .object({
      mime: z.string().min(1).max(100),
      fileName: z.string().max(200).optional(),
      base64: z.string().min(1).max(1_000_000),
    })
    .optional(),
});
export type FakeIncomingBody = z.infer<typeof FakeIncomingBody>;

/**
 * POST /api/dev/fake-reaction (fake WA only): someone reacts to a stored message, changes the
 * reaction or removes it (`emoji` ''). The reactor defaults to the chat partner of a direct chat.
 */
export const FakeReactionBody = z.object({
  /** The stored message id (as `message:new` and the message list give it). */
  messageId: z.string().min(1).max(256),
  /** '' removes the reaction. */
  emoji: z.string().max(32),
  /** Group reactor; required in a group unless `fromMe`. */
  senderJid: z.string().max(256).optional(),
  senderName: z.string().max(200).optional(),
  /** The linked number itself reacted (its phone). */
  fromMe: z.boolean().optional(),
});
export type FakeReactionBody = z.infer<typeof FakeReactionBody>;

/**
 * POST /api/dev/fake-edit and /api/dev/fake-revoke (fake WA only): the fake phone delivers an edit
 * (`body`) or a delete for everyone of a stored message, by its customer, a group member
 * (`senderJid`) or the linked phone (`fromMe`).
 */
export const FakeMessageChangeBody = z.object({
  messageId: z.string().min(1).max(256),
  /** The new text (fake-edit only). */
  body: z.string().max(65536).optional(),
  senderJid: z.string().max(256).optional(),
  fromMe: z.boolean().optional(),
});
export type FakeMessageChangeBody = z.infer<typeof FakeMessageChangeBody>;

/** POST /api/dev/fake-link (fake WA only): the inbox's fake phone links, as a QR scan would. */
export const FakeLinkBody = z.object({ inboxId: z.number().int().positive() });
export type FakeLinkBody = z.infer<typeof FakeLinkBody>;

/** Largest file `POST /chats/:jid/media` accepts; the composer refuses bigger files before uploading. */
export const MEDIA_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

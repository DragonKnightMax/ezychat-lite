import { z } from 'zod';
import { MessageSafety } from './safety.js';
import {
  ChatEventType,
  ChatStatus,
  ChatType,
  MediaStatus,
  MessageStatus,
  MessageType,
  Role,
  TunnelMode,
  TranscriptStatus,
  TunnelState,
  WaState,
} from './enums.js';
import { LocaleSchema } from './i18n/locales.js';

// All timestamps are epoch milliseconds.

export const UserSchema = z.object({
  id: z.number(),
  username: z.string(),
  displayName: z.string(),
  role: Role,
  /** Omitted by older clients/fixtures; persisted users always have an explicit kind. */
  kind: z.enum(['human', 'ai']).optional(),
  /** Business role, independent of sign-in permissions. The first AI member handles sales. */
  aiRole: z.literal('sales').optional(),
  /** The AI agent this AI team member is (AI members only). */
  aiAgentId: z.number().int().optional(),
  /** A deleted AI agent (only in lists that ask for deleted users). */
  aiDeleted: z.boolean().optional(),
  mustChangePassword: z.boolean(),
  disabled: z.boolean(),
  createdAt: z.number(),
  /** Preferred UI language; null = follow the browser. */
  locale: LocaleSchema.nullable(),
  /** Inboxes an agent may open (admin responses only; admins open every inbox). */
  inboxIds: z.array(z.number().int().positive()).optional(),
});
export type User = z.infer<typeof UserSchema>;

export const ChatSchema = z.object({
  /** Chat key: the WhatsApp JID for inbox 1, `<waJid>#<inboxId>` for other inboxes. */
  jid: z.string(),
  /** The inbox (linked number) the chat belongs to; replies leave from it. */
  inboxId: z.number().int().positive(),
  /** The chat's WhatsApp JID inside its inbox. */
  waJid: z.string(),
  type: ChatType,
  name: z.string(),
  /** Authenticated image endpoint; missing/private WhatsApp photos fall back to initials. */
  avatarUrl: z.string().nullable(),
  unreadCount: z.number(),
  lastMessageAt: z.number().nullable(),
  lastMessagePreview: z.string().nullable(),
  status: ChatStatus,
  assignedTo: z.number().nullable(),
  updatedAt: z.number(),
  /** Phone-number digits without `+`; null when WhatsApp has only revealed the WhatsApp ID (LID). */
  phone: z.string().nullable(),
  /** Customer profile tags (direct chats only). */
  tags: z.array(z.string()).optional(),
  /** WhatsApp/saved name, shown under a customer profile name (direct chats only). */
  whatsappName: z.string().nullable().optional(),
  /**
   * epoch ms of the customer's last live message; with the inbox's `replyWindowHours` it says when
   * free-form replies are allowed (WhatsApp Business API). null: none yet.
   */
  lastInboundAt: z.number().nullable().default(null),
});
export type Chat = z.infer<typeof ChatSchema>;

/**
 * One person's emoji reaction to a message, as WhatsApp reported it (one per person: a new emoji
 * replaces the old one, an empty one removes it).
 */
export const MessageReactionSchema = z.object({
  emoji: z.string().min(1),
  /** Who reacted (phone-number JID or WhatsApp ID); null when the linked number itself reacted. */
  senderJid: z.string().nullable(),
  /** The reactor's name from contacts, a customer profile or WhatsApp; never inferred. */
  senderName: z.string().nullable().optional(),
  /** Reacted from the linked WhatsApp number (the phone or another linked device). */
  fromMe: z.boolean(),
  /** epoch ms */
  at: z.number(),
  /**
   * The linked number's reaction only: the teammate who sent it from the inbox; null when it came
   * from the phone (or another linked device).
   */
  sentByUserId: z.number().nullable().default(null),
});
export type MessageReaction = z.infer<typeof MessageReactionSchema>;

/**
 * Who deleted a message for everyone: `sender` = the customer (or group member) who wrote it,
 * `group_admin` = a group admin deleted a member's message, `team` = a teammate in the inbox,
 * `phone` = the linked phone (or another linked device).
 */
export const MessageDeletedBy = z.enum(['sender', 'group_admin', 'team', 'phone']);
export type MessageDeletedBy = z.infer<typeof MessageDeletedBy>;

/** Who edited a message: the customer (`sender`), a teammate (`team`) or the linked phone. */
export const MessageEditedBy = z.enum(['sender', 'team', 'phone']);
export type MessageEditedBy = z.infer<typeof MessageEditedBy>;

export const MessageSchema = z.object({
  id: z.string(),
  chatJid: z.string(),
  senderJid: z.string().nullable(),
  senderName: z.string().nullable(),
  fromMe: z.boolean(),
  sentByUserId: z.number().nullable(),
  type: MessageType,
  body: z.string().nullable(),
  mediaUrl: z.string().nullable(),
  mediaMime: z.string().nullable(),
  mediaName: z.string().nullable(),
  mediaStatus: MediaStatus,
  quotedId: z.string().nullable(),
  status: MessageStatus,
  error: z.string().nullable(),
  timestamp: z.number(),
  clientId: z.string().nullable(),
  /** A WhatsApp voice note recorded in the inbox (audio sent as a voice note, not as a file). */
  voiceNote: z.boolean().optional(),
  /** Sent as an approved template (WhatsApp Business API): its name and language. */
  template: z.object({ name: z.string(), language: z.string() }).nullable().optional(),
  /** Sent by the token owner's AI assistant through MCP (shown as "via AI assistant"). */
  viaAssistant: z.boolean().optional(),
  /** Voice notes only (inbound audio): the transcript text, when `transcriptStatus` is `ok`. */
  transcript: z.string().nullable().optional(),
  /** Language the transcriber detected (e.g. `en`, `ms`, `zh`), when known. */
  transcriptLang: z.string().nullable().optional(),
  /** Missing/null = never transcribed (feature off, history, outbound). */
  transcriptStatus: TranscriptStatus.nullable().optional(),
  /** Group messages: the sender's customer profile (from their direct chat), when one is set. */
  senderProfile: z.object({ chatJid: z.string(), name: z.string() }).nullable().optional(),
  /** Emoji reactions, oldest first; empty when nobody reacted. */
  reactions: z.array(MessageReactionSchema).default([]),
  /** WhatsApp Safety's finding on this inbound message; absent or null when nothing was found. */
  safety: MessageSafety.nullable().optional(),
  /** epoch ms of the last edit (body is the edited text); absent/null = never edited. */
  editedAt: z.number().nullable().optional(),
  /** Earlier versions kept (`GET /messages/:id/edits`). */
  editCount: z.number().int().nonnegative().optional(),
  /** Deleted for everyone: epoch ms (absent/null = not deleted); body, media and reactions are then empty. */
  deletedAt: z.number().nullable().optional(),
  deletedBy: MessageDeletedBy.nullable().optional(),
  /** `deletedBy` `team`: the teammate who deleted it. */
  deletedByUserId: z.number().nullable().optional(),
  /** Deleted for me: hidden for the whole team (clients drop it from the conversation). */
  hidden: z.boolean().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const NoteSchema = z.object({
  id: z.number(),
  chatJid: z.string(),
  userId: z.number(),
  body: z.string(),
  createdAt: z.number(),
});
export type Note = z.infer<typeof NoteSchema>;

export const ChatEventSchema = z.object({
  id: z.number(),
  chatJid: z.string(),
  type: ChatEventType,
  actorId: z.number().nullable(),
  payload: z.record(z.string(), z.unknown()),
  at: z.number(),
});
export type ChatEvent = z.infer<typeof ChatEventSchema>;

export const QuickReplySchema = z.object({
  id: z.number(),
  shortcut: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  body: z.string().min(1).max(4096),
  updatedAt: z.number(),
});
export type QuickReply = z.infer<typeof QuickReplySchema>;

export const WaStatusSchema = z.object({
  state: WaState,
  me: z
    .object({
      jid: z.string(),
      name: z.string().nullable(),
      /** The account's own LID: WhatsApp shows it instead of the number in groups (and in mentions). */
      lid: z.string().nullable().optional(),
    })
    .nullable(),
  qr: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type WaStatus = z.infer<typeof WaStatusSchema>;

export const TunnelStatusSchema = z.object({
  mode: TunnelMode,
  state: TunnelState,
  url: z.string().nullable(),
  hostname: z.string().nullable(),
  lastError: z.string().nullable(),
  logTail: z.array(z.string()),
});
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

export const SettingsSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  lanEnabled: z.boolean(),
  historyDays: z.number().int().min(0).max(365),
  namedTunnelHostname: z.string().nullable(),
  hasTunnelToken: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const AuditEntrySchema = z.object({
  id: z.number(),
  userId: z.number().nullable(),
  action: z.string(),
  ip: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  at: z.number(),
  /** Set when an AI assistant made the change with an access token (userId is the token's owner). */
  apiToken: z.object({ name: z.string(), prefix: z.string() }).nullable().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

import { z } from 'zod';
import { Role } from './enums.js';
import { WaStatusSchema } from './models.js';

/** Colour of an inbox chip, given by creation order (primary, warning, info, success, then again). */
export const InboxTone = z.enum(['primary', 'warning', 'info', 'success']);
export type InboxTone = z.infer<typeof InboxTone>;

const InboxId = z.number().int().positive();
const UserId = z.number().int().positive();
const InboxName = z.string().trim().min(1).max(40);
const AiAgentId = z.number().int().positive();

/**
 * How an inbox is connected: `linked_phone` (the WhatsApp app on a phone, QR scan; the core's own)
 * or a type an edition's extension registers (e.g. `wa-cloud`, the WhatsApp Business API).
 */
export const InboxType = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);
export type InboxType = z.infer<typeof InboxType>;
export const LINKED_PHONE: InboxType = 'linked_phone';

/** What an inbox's connection can do (see `WaCapabilities` in @ezychat/wa). */
export const InboxCapabilitiesSchema = z.object({
  qrLink: z.boolean(),
  history: z.boolean(),
  groups: z.boolean(),
  /** Free-form replies only this many hours after the customer's last message; null: no window. */
  replyWindowHours: z.number().positive().nullable(),
  templates: z.boolean(),
  /** Receives messages through Phone access (a public webhook address). */
  needsPublicUrl: z.boolean().default(false),
  /**
   * Tags group members (@mention) in sent text. Absent (an older server, or a connection that
   * does not say so) means it cannot: read it as `mentions === true`.
   */
  mentions: z.boolean().optional(),
  /** Edits sent messages (linked phone: within 15 minutes). Absent = no. */
  editMessage: z.boolean().optional(),
  /** Deletes sent messages for everyone (linked phone: within about 2 days). */
  deleteForEveryone: z.boolean().optional(),
  /** Deletes a message on the linked phone too ("Delete for me"). */
  deleteForMe: z.boolean().optional(),
});
export type InboxCapabilities = z.infer<typeof InboxCapabilitiesSchema>;
export const DEFAULT_INBOX_CAPABILITIES: InboxCapabilities = {
  qrLink: true,
  history: true,
  groups: true,
  replyWindowHours: null,
  templates: false,
  needsPublicUrl: false,
  mentions: true,
  editMessage: true,
  deleteForEveryone: true,
  deleteForMe: true,
};

/** One linked WhatsApp number (an inbox). Inbox 1 is the number linked before multi-inbox. */
export const InboxSchema = z.object({
  id: InboxId,
  name: z.string().min(1).max(40),
  tone: InboxTone,
  /** Phone-number digits of the linked account; null until a phone is linked. */
  number: z.string().nullable(),
  status: WaStatusSchema,
  /** Removed inboxes keep their chats, read only, for admins. */
  removed: z.boolean(),
  /** Agents who may open the inbox (admins always may); in admin responses only. */
  memberIds: z.array(UserId).optional(),
  /** The AI agent that answers this inbox; null = no AI agent. */
  aiAgentId: z.number().int().nullable().default(null),
  type: InboxType.default(LINKED_PHONE),
  capabilities: InboxCapabilitiesSchema.default(DEFAULT_INBOX_CAPABILITIES),
});
export type Inbox = z.infer<typeof InboxSchema>;

export const InboxListResponse = z.object({
  inboxes: z.array(InboxSchema),
  maxInboxes: z.number().int().positive(),
  canAdd: z.boolean(),
});
export type InboxListResponse = z.infer<typeof InboxListResponse>;

export const CreateInboxBody = z.object({
  name: InboxName,
  memberIds: z.array(UserId).default([]),
  aiAgentId: AiAgentId.nullable().optional(),
});
export type CreateInboxBody = z.infer<typeof CreateInboxBody>;
export type CreateInboxBodyInput = z.input<typeof CreateInboxBody>;

export const UpdateInboxBody = z
  .object({
    name: InboxName.optional(),
    memberIds: z.array(UserId).optional(),
    /** Binds an AI agent to this inbox (null = none). */
    aiAgentId: AiAgentId.nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.memberIds !== undefined || b.aiAgentId !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateInboxBody = z.infer<typeof UpdateInboxBody>;

/** Members → Inbox access: the inboxes an agent may open. */
export const SetUserInboxesBody = z.object({ inboxIds: z.array(InboxId) });
export type SetUserInboxesBody = z.infer<typeof SetUserInboxesBody>;

/** Socket `inbox:status`: the connection status of one inbox. */
export const InboxStatusPayload = z.object({ inboxId: InboxId, status: WaStatusSchema });
export type InboxStatusPayload = z.infer<typeof InboxStatusPayload>;

/** `GET /api/users/directory` row: public team-member fields plus the inboxes they may open. */
export const DirectoryUserSchema = z.object({
  id: z.number(),
  displayName: z.string(),
  role: Role,
  disabled: z.boolean(),
  kind: z.enum(['human', 'ai']).optional(),
  aiRole: z.literal('sales').optional(),
  /** The AI agent this AI team member is (AI members only). */
  aiAgentId: z.number().int().optional(),
  /** A deleted AI agent: kept only to name its old messages; never offered as an assignee. */
  aiDeleted: z.boolean().optional(),
  /** An AI agent with "Answer direct chats" off: never offered for a direct chat (the server refuses). */
  aiNoDirect: z.boolean().optional(),
  inboxIds: z.union([z.literal('all'), z.array(InboxId)]),
});
export type DirectoryUser = z.infer<typeof DirectoryUserSchema>;

/** An approved message template of a Business API number (`GET /api/inboxes/:id/templates`). */
export const MessageTemplateSchema = z.object({
  name: z.string().min(1).max(512),
  language: z.string().min(1).max(15),
  category: z.enum(['utility', 'marketing', 'authentication']),
  body: z.string(),
  /** Number of {{n}} body variables. */
  variables: z.number().int().min(0),
  examples: z.array(z.string()),
  header: z.enum(['text', 'image', 'document', 'video']).nullable(),
  buttons: z.boolean(),
  /** EzyChat sends body-variable templates only (v1); media headers and buttons are listed, not sent. */
  sendable: z.boolean(),
});
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

export const TemplateListResponse = z.object({ templates: z.array(MessageTemplateSchema) });
export type TemplateListResponse = z.infer<typeof TemplateListResponse>;

/** `POST /api/chats/:jid/template`: send an approved template (also outside the reply window). */
export const SendTemplateBody = z.object({
  name: z.string().min(1).max(512),
  language: z.string().min(1).max(15),
  params: z.array(z.string().trim().min(1).max(1024)).max(20).default([]),
  clientId: z.string().min(1).max(64),
});
export type SendTemplateBody = z.infer<typeof SendTemplateBody>;
export type SendTemplateBodyInput = z.input<typeof SendTemplateBody>;

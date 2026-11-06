import { z } from 'zod';
import { AI_HANDOFF_RULES_CHARACTERS, AI_INSTRUCTIONS_CHARACTERS } from './ai.js';
import { ChatStatus } from './enums.js';

// AI assistant (MCP) access: admin-created personal access tokens and the read-only tool inputs.

/** Days until a new token expires; null = never. */
export const ApiTokenExpiry = z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable();
export type ApiTokenExpiry = z.infer<typeof ApiTokenExpiry>;

export const ApiTokenSchema = z.object({
  id: z.number(),
  userId: z.number(),
  /** Display name of the admin who owns the token. */
  userName: z.string(),
  name: z.string(),
  /** First characters of the secret, enough to recognise it (never the whole secret). */
  prefix: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  /** Scope `inbox:send`: the token's AI assistant may send text replies into existing chats. */
  canSend: z.boolean(),
  /** Scope `inbox:send_new`: the assistant may also start a chat with a number not in the inbox. */
  canMessageNewNumbers: z.boolean(),
  /** Made by an app's sign-in (OAuth approval), not by Create token in Settings. */
  connectedApp: z.boolean().default(false),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const CreateApiTokenBody = z
  .strictObject({
    name: z.string().trim().min(1).max(64),
    expiresInDays: ApiTokenExpiry.default(90),
    /** Grant scope `inbox:send` (off unless the admin ticks it; existing tokens never gain it). */
    canSend: z.boolean().default(false),
    /** Grant scope `inbox:send_new` too (needs canSend; off unless the admin ticks it). */
    canMessageNewNumbers: z.boolean().default(false),
  })
  .refine((b) => b.canSend || !b.canMessageNewNumbers, {
    message: 'Messaging new numbers needs "Can send WhatsApp messages"',
    path: ['canMessageNewNumbers'],
  });
export type CreateApiTokenBody = z.infer<typeof CreateApiTokenBody>;

/** Change what an existing token may do (only its owner, in Settings; never through a token). */
export const UpdateApiTokenBody = z
  .strictObject({ canSend: z.boolean(), canMessageNewNumbers: z.boolean() })
  .refine((b) => b.canSend || !b.canMessageNewNumbers, {
    message: 'Messaging new numbers needs "Can send WhatsApp messages"',
    path: ['canMessageNewNumbers'],
  });
export type UpdateApiTokenBody = z.infer<typeof UpdateApiTokenBody>;
export const UpdateApiTokenResponse = z.object({ token: ApiTokenSchema });
export type UpdateApiTokenResponse = z.infer<typeof UpdateApiTokenResponse>;
export type CreateApiTokenBodyInput = z.input<typeof CreateApiTokenBody>;

/** The secret is returned only here, once. */
export const CreateApiTokenResponse = z.object({ token: ApiTokenSchema, secret: z.string() });
export type CreateApiTokenResponse = z.infer<typeof CreateApiTokenResponse>;

export const ApiTokenListResponse = z.object({ tokens: z.array(ApiTokenSchema) });
export type ApiTokenListResponse = z.infer<typeof ApiTokenListResponse>;

export const McpSettingsResponse = z.object({
  enabled: z.boolean(),
  /** Path of the MCP endpoint on this server (`/mcp`). */
  endpointPath: z.string(),
  /** Public HTTPS base URL of the running tunnel, null when no tunnel is up. */
  publicUrl: z.string().nullable(),
  /** Loopback base URL on the port this server listens on (works only on the server's computer). */
  localUrl: z.string(),
});
export type McpSettingsResponse = z.infer<typeof McpSettingsResponse>;

export const McpSettingsPatch = z.strictObject({ enabled: z.boolean() });
export type McpSettingsPatch = z.infer<typeof McpSettingsPatch>;

// MCP sign-in (OAuth 2.1 authorization code + PKCE): an AI assistant app (claude.ai, ChatGPT, …)
// sends the admin's browser to /oauth/authorize; the page shows the app and asks the admin to approve.

/** The authorization request as the app sent it (query names of RFC 6749 / RFC 7636 / RFC 8707). */
export const OAuthAuthorizeParams = z.object({
  response_type: z.string().max(32),
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(32).optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
});
export type OAuthAuthorizeParams = z.infer<typeof OAuthAuthorizeParams>;

/** What the approval page shows: the app's own name (unverified) and where it returns to. */
export const OAuthRequestInfo = z.object({
  clientName: z.string(),
  /** Host of the redirect address (e.g. claude.ai): the part the admin can trust. */
  redirectHost: z.string(),
});
export type OAuthRequestInfo = z.infer<typeof OAuthRequestInfo>;

export const OAuthDecisionBody = OAuthAuthorizeParams.extend({ approve: z.boolean() });
export type OAuthDecisionBody = z.infer<typeof OAuthDecisionBody>;

/** Where the page sends the browser next: back to the app with a code, or with access_denied. */
export const OAuthDecisionResponse = z.object({ redirectTo: z.string() });
export type OAuthDecisionResponse = z.infer<typeof OAuthDecisionResponse>;

// Tool inputs. MCP clients send real JSON numbers, so these never coerce.

/** Optional inbox (WhatsApp number) filter of the inbox tools; omitted = every inbox in scope. */
const McpInboxFilter = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Only this inbox (WhatsApp number), by inboxId from list_chats; omit for every inbox');

export const McpListChatsInput = z.strictObject({
  status: ChatStatus.optional().describe('open or resolved; omit for both'),
  assigned: z
    .enum(['any', 'none', 'me'])
    .default('any')
    .describe('any, none (unassigned) or me (the token owner)'),
  query: z.string().max(100).optional().describe('Match on customer name or phone number'),
  since: z.number().int().optional().describe('Only chats updated at or after this epoch ms'),
  cursor: z.string().optional().describe('nextCursor from the previous page'),
  limit: z.number().int().min(1).max(100).default(25),
  inboxId: McpInboxFilter,
});
export type McpListChatsInput = z.infer<typeof McpListChatsInput>;

export const McpGetChatInput = z.strictObject({
  jid: z
    .string()
    .min(1)
    .max(200)
    .describe('Chat id from list_chats (a phone or WhatsApp ID works)'),
});
export type McpGetChatInput = z.infer<typeof McpGetChatInput>;

export const McpGetMessagesInput = z.strictObject({
  jid: z.string().min(1).max(200).describe('Chat id from list_chats'),
  before: z.string().optional().describe('nextBefore from the previous page, for older messages'),
  limit: z.number().int().min(1).max(100).default(50),
});
export type McpGetMessagesInput = z.infer<typeof McpGetMessagesInput>;

export const McpGetStatsInput = z.strictObject({
  days: z.number().int().min(1).max(90).default(14).describe('Days of daily activity to include'),
  inboxId: McpInboxFilter,
});
export type McpGetStatsInput = z.infer<typeof McpGetStatsInput>;

export const McpGetActivityInput = z.strictObject({
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(28)
    .describe('Days to cover, ending now (today counts as one day)'),
  inboxId: McpInboxFilter,
});
export type McpGetActivityInput = z.infer<typeof McpGetActivityInput>;

/**
 * get_message_file: largest stored file it opens (the document reader's own limit), the largest
 * photo it returns and the longest text it returns.
 */
export const MCP_FILE_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MCP_FILE_MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MCP_FILE_MAX_TEXT_CHARS = 20_000;

export const McpGetMessageFileInput = z.strictObject({
  messageId: z
    .string()
    .min(1)
    .max(256)
    .describe('Message id from get_messages (a message with media)'),
});
export type McpGetMessageFileInput = z.infer<typeof McpGetMessageFileInput>;

// Send tool (scope `inbox:send`).

/** Longest text the send tool accepts (WhatsApp allows more; replies this long are a model error). */
export const MCP_SEND_MAX_TEXT = 4096;

export const McpSendMessageInput = z.strictObject({
  jid: z
    .string()
    .min(1)
    .max(200)
    .describe('Chat id from list_chats or get_chat; only existing chats can receive a message'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(MCP_SEND_MAX_TEXT)
    .describe('The exact text to send, as the user approved it'),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .describe(
      'A unique id you choose for this message (8-64 letters, digits, _ or -); repeat it on a retry so the message is never sent twice',
    ),
  quotedMessageId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Message id from get_messages to reply to (must be in the same chat)'),
});
export type McpSendMessageInput = z.infer<typeof McpSendMessageInput>;

/** Largest image the send_image tool accepts (decoded bytes; WhatsApp compresses photos anyway). */
export const MCP_SEND_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest caption of an image (WhatsApp shows up to 1024 characters under a photo). */
export const MCP_SEND_MAX_CAPTION = 1024;

export const McpSendImageInput = z.strictObject({
  jid: McpSendMessageInput.shape.jid,
  imageUrl: z
    .string()
    .url()
    .max(2048)
    .optional()
    .describe(
      'A public https link to the image (JPEG, PNG or WebP, up to 5 MB). Pass imageUrl or imageBase64, not both',
    ),
  imageBase64: z
    .string()
    .max(Math.ceil(MCP_SEND_MAX_IMAGE_BYTES / 3) * 4 + 64)
    .optional()
    .describe(
      'The image file as base64 (JPEG, PNG or WebP, up to 5 MB; a data: URL prefix is allowed). Pass imageUrl or imageBase64, not both',
    ),
  caption: z
    .string()
    .trim()
    .max(MCP_SEND_MAX_CAPTION)
    .optional()
    .describe('Text shown under the image, exactly as the user approved it'),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe('A file name for the image, for example product.jpg'),
  requestId: McpSendMessageInput.shape.requestId,
  quotedMessageId: McpSendMessageInput.shape.quotedMessageId,
});
export type McpSendImageInput = z.infer<typeof McpSendImageInput>;

/** Largest document the send_file tool accepts (decoded bytes; same MCP body limit as an image). */
export const MCP_SEND_MAX_FILE_BYTES = 5 * 1024 * 1024;

export const McpSendFileInput = z.strictObject({
  jid: McpSendMessageInput.shape.jid,
  fileUrl: z
    .string()
    .url()
    .max(2048)
    .optional()
    .describe(
      'A public https link to the file (PDF or Word .docx, up to 5 MB). Pass fileUrl or fileBase64, not both',
    ),
  fileBase64: z
    .string()
    .max(Math.ceil(MCP_SEND_MAX_FILE_BYTES / 3) * 4 + 64)
    .optional()
    .describe(
      'The file as base64 (PDF or Word .docx, up to 5 MB; a data: URL prefix is allowed). Pass fileUrl or fileBase64, not both',
    ),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('The file name the customer sees, for example Quotation-1042.pdf'),
  caption: z
    .string()
    .trim()
    .max(MCP_SEND_MAX_CAPTION)
    .optional()
    .describe('Text shown with the file, exactly as the user approved it'),
  requestId: McpSendMessageInput.shape.requestId,
  quotedMessageId: McpSendMessageInput.shape.quotedMessageId,
});
export type McpSendFileInput = z.infer<typeof McpSendFileInput>;

/** Digits of a phone number with its country code, or null (spaces, dashes, brackets and a leading + allowed). */
export function normalizeNewChatPhone(raw: string): string | null {
  const digits = raw
    .trim()
    .replace(/^\+/, '')
    .replace(/[\s()-]/g, '');
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

export const McpSendToNewNumberInput = z.strictObject({
  phone: z
    .string()
    .min(7)
    .max(32)
    .describe('Full phone number with country code, for example 60123456789 or +60 12-345 6789'),
  text: McpSendMessageInput.shape.text,
  requestId: McpSendMessageInput.shape.requestId,
  inboxId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The inbox (WhatsApp number) to send from; required when the team has more than one inbox',
    ),
});
export type McpSendToNewNumberInput = z.infer<typeof McpSendToNewNumberInput>;

// AI Sales Agent setup tools (scope `ai:setup`).

export const McpSetupTarget = z
  .enum(['instructions', 'handoff_rules', 'context_text'])
  .describe(
    'instructions = AI instructions; handoff_rules = hand-off rules; context_text = a Business context text item',
  );
export type McpSetupTarget = z.infer<typeof McpSetupTarget>;

const McpAgentId = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('AI agent id from list_ai_agents; omit for the only agent, else the agent of inbox 1');

export const McpListAiAgentsInput = z.strictObject({});
export type McpListAiAgentsInput = z.infer<typeof McpListAiAgentsInput>;

export const McpGetAiAgentSetupInput = z.strictObject({ agentId: McpAgentId });
export type McpGetAiAgentSetupInput = z.infer<typeof McpGetAiAgentSetupInput>;

export const McpGetAiContextItemInput = z.strictObject({
  agentId: McpAgentId,
  id: z.number().int().positive().describe('Business context item id from get_ai_agent_setup'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset for long items: pass nextOffset from the previous page'),
});
export type McpGetAiContextItemInput = z.infer<typeof McpGetAiContextItemInput>;

export const McpTryAiReplyInput = z.strictObject({
  agentId: McpAgentId,
  message: z.string().trim().min(1).max(500).describe('A customer message to test'),
  instructions: z
    .string()
    .max(AI_INSTRUCTIONS_CHARACTERS)
    .optional()
    .describe('Draft AI instructions to test instead of the saved ones'),
  handoffRules: z
    .string()
    .max(AI_HANDOFF_RULES_CHARACTERS)
    .optional()
    .describe('Draft hand-off rules to test instead of the saved ones'),
});
export type McpTryAiReplyInput = z.infer<typeof McpTryAiReplyInput>;

export const McpUpdateAiSetupInput = z.strictObject({
  agentId: McpAgentId,
  target: McpSetupTarget,
  itemId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('context_text only: the item to change; omit to add a new text item'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe('context_text only: item name (required when adding)'),
  text: z
    .string()
    .max(200_000)
    .describe(
      'The complete new text (not a diff). One line per paragraph or list item, no line breaks inside a sentence (the app shows every line break). For a long item, read every page with get_ai_context_item first so nothing is lost.',
    ),
  reason: z
    .string()
    .trim()
    .min(5)
    .max(300)
    .describe('Why this change is being made; stored in the audit log and version history'),
  internal: z
    .boolean()
    .optional()
    .describe(
      'context_text only: true = Internal item (used to decide, never told to customers); omit to keep it as it is',
    ),
});
export type McpUpdateAiSetupInput = z.infer<typeof McpUpdateAiSetupInput>;

export const McpGetAiSetupHistoryInput = z.strictObject({
  agentId: McpAgentId,
  target: McpSetupTarget,
  itemId: z.number().int().positive().optional().describe('context_text only: the item'),
  limit: z.number().int().min(1).max(50).default(10),
});
export type McpGetAiSetupHistoryInput = z.infer<typeof McpGetAiSetupHistoryInput>;

export const McpGetAiSetupVersionInput = z.strictObject({
  versionId: z.number().int().positive().describe('versionId from get_ai_setup_history'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset for long texts: pass nextOffset from the previous page'),
});
export type McpGetAiSetupVersionInput = z.infer<typeof McpGetAiSetupVersionInput>;

import { z } from 'zod';
import { AiGroupEvent } from './ai-groups.js';
import { AiToolCalendarDetail } from './connectors.js';
import { UserSchema } from './models.js';

/** EXPERIMENTAL direct ChatGPT sign-in: documented fallback when the live model list is unavailable
 * (ids from Codex 0.160's model list, visibility "list", by priority). The server validates a saved
 * model against the live list (or this list); '' means Auto. */
export const CHATGPT_FALLBACK_MODELS = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
] as const;
export const CHATGPT_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Claude API key mode: the fixed models an admin may choose ('' means the default). */
export const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export const CLAUDE_DEFAULT_MODEL: ClaudeModel = 'claude-sonnet-5-5';
/**
 * The AI connection: `api` = an OpenAI API key (name kept for older clients and saves),
 * `chatgpt` = the EXPERIMENTAL ChatGPT sign-in, `claude` = an Anthropic Claude API key.
 */
export const AiConnectionMode = z.enum(['api', 'chatgpt', 'claude']);
export type AiConnectionMode = z.infer<typeof AiConnectionMode>;

/**
 * Text limit of one Business context text item in characters (Unicode code points, so an emoji
 * counts once). Above the server's 40,000-character full-context budget, relevant parts of all
 * context items are selected per question.
 */
export const AI_CONTEXT_CHARACTERS = 100_000;
/** Name limit of a Business context item. */
export const AI_CONTEXT_NAME_CHARACTERS = 120;
/** Business context items (uploaded files plus text content) per inbox. */
export const AI_CONTEXT_ITEMS = 20;
/** Length in Unicode code points (never splits surrogate pairs, unlike `string.length`). */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}

/**
 * Starting AI instructions, so a business can turn the agent on with only its Business context.
 * Shown (editable) on a new AI member and used whenever the saved instructions are blank. They set
 * role, scope, style and extra hand-off cases only; company facts belong in the Business context,
 * and the fixed safety rules (facts only from context, hand-offs, no fake orders, resolution,
 * privacy, prompt protection) live in the server prompt where admins cannot change them.
 */
export const DEFAULT_AI_INSTRUCTIONS = [
  'ROLE',
  "You are this business's WhatsApp assistant. You answer customer enquiries and product questions and represent the business professionally.",
  '',
  'SCOPE',
  'You help with:',
  '- Products: features, specifications, variants, availability and usage',
  '- General enquiries: business hours, location, how to order, delivery areas, payment methods and return policy',
  '- The right next step: how to order, how to request a quotation, or reaching our team',
  'You do not help with topics unrelated to the business or its products (general chat, news, coding, homework, opinions, politics, religion). Reply politely in one line and steer back, for example: "Sorry, I can only help with questions about our products and services. How can I help you with those?"',
  '',
  'KNOWLEDGE',
  '- Keep product names, model numbers and prices exactly as written in the business context.',
  '- Never guess prices, stock, specifications, delivery dates, promotions or policies. If a detail is missing, say so and let our team confirm.',
  '- Never promise discounts, free gifts or exceptions.',
  '',
  'LANGUAGE',
  "- Reply in the customer's language. If they mix languages, reply in the main language of their message.",
  '- If you cannot reply in their language, use the default language named in the business context, otherwise English.',
  '',
  'STYLE',
  '- Professional, polite and friendly; no slang. At most one emoji, and only where it fits.',
  '- One to three short sentences. Use a short list only for options or specifications.',
  '- Answer first: no long greetings and no repeating the question back.',
  '- Ask at most one clarifying question when needed (for example which model, size or area).',
  '- WhatsApp formatting only: *bold* for key details and plain line breaks. No headings, tables or links you were not given.',
].join('\n');

export const AI_HANDOFF_RULES_CHARACTERS = 4000;
export const AI_INSTRUCTIONS_CHARACTERS = 8000;
/**
 * Business hand-off rules (layer 2): cases this business wants a person to handle, on top of the
 * fixed system hand-offs (customer asks for a person, a request the AI cannot carry out, facts not
 * in the context, legal/medical/personal data). Shown (editable) on a new AI member; a saved blank
 * value means "no extra rules".
 */
export const DEFAULT_AI_HANDOFF_RULES = [
  '- The customer is upset or makes a complaint',
  '- The customer asks for a refund, return, exchange or warranty claim',
  '- The customer asks about an existing order, delivery or payment',
  '- The customer wants a bulk or custom order, or a quotation',
  '- The customer wants to negotiate the price or asks for a discount',
].join('\n');

/** Starting text of a new agent; `custom` starts blank. The preset also labels the agent. */
export const AiAgentPreset = z.enum(['sales', 'faq', 'custom']);
export type AiAgentPreset = z.infer<typeof AiAgentPreset>;

/** FAQ / help desk starting role text: answers questions, never sells. */
const FAQ_INSTRUCTIONS = [
  'ROLE',
  "You are this business's WhatsApp help desk. You answer customers' questions clearly and correctly. You do not sell: never recommend products, upsell or ask the customer to order.",
  '',
  'SCOPE',
  'You help with:',
  '- Questions about the services, opening hours, location, prices and fees written in the business context',
  '- Procedures and policies: how to book, what to bring, how long it takes, who to contact',
  '- The right next step: where to find a form, how to make an appointment, or reaching our team',
  'You do not help with topics unrelated to the business (general chat, news, coding, homework, opinions, politics, religion). Reply politely in one line and steer back, for example: "Sorry, I can only help with questions about our services. What would you like to know?"',
  '',
  'KNOWLEDGE',
  '- Answer only from the business context. Keep names, times, fees and steps exactly as written.',
  '- Never guess. If a detail is missing, say so and let our team confirm.',
  '- Never give personal medical, legal or financial advice, and never promise exceptions.',
  '',
  'LANGUAGE',
  "- Reply in the customer's language. If they mix languages, reply in the main language of their message.",
  '- If you cannot reply in their language, use the default language named in the business context, otherwise English.',
  '',
  'STYLE',
  '- Calm, polite and helpful; no slang and no sales language. At most one emoji, and only where it fits.',
  '- One to three short sentences. Use a short numbered list only for steps.',
  '- Answer first: no long greetings and no repeating the question back.',
  '- Ask at most one clarifying question when needed.',
  '- WhatsApp formatting only: *bold* for key details and plain line breaks. No headings, tables or links you were not given.',
].join('\n');

const FAQ_HANDOFF_RULES = [
  '- The customer is upset or makes a complaint',
  '- The customer wants to book, change or cancel an appointment or an order',
  '- The customer asks about their own account, case, payment or personal records',
  '- The customer asks for an exception to a rule or policy',
].join('\n');

/** English starting texts per preset (the web shows localized copies `ai.defaults.<preset>.*`). */
export const AI_AGENT_PRESETS: Readonly<
  Record<Exclude<AiAgentPreset, 'custom'>, { instructions: string; handoffRules: string }>
> = Object.freeze({
  sales: { instructions: DEFAULT_AI_INSTRUCTIONS, handoffRules: DEFAULT_AI_HANDOFF_RULES },
  faq: { instructions: FAQ_INSTRUCTIONS, handoffRules: FAQ_HANDOFF_RULES },
});

/** The starting instructions and hand-over rules of a preset (`custom`: both blank). */
export function presetTexts(preset: AiAgentPreset): { instructions: string; handoffRules: string } {
  if (preset === 'custom') return { instructions: '', handoffRules: '' };
  return { ...AI_AGENT_PRESETS[preset] };
}

/** Internal Business context items of one agent, in characters in total (always sent in full). */
export const AI_INTERNAL_CHARACTERS = 10_000;

export const AiSettingsBody = z.object({
  displayName: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  mode: AiConnectionMode,
  model: z.string().trim().max(128),
  instructions: z.string().max(AI_INSTRUCTIONS_CHARACTERS),
  /** Optional in requests (older clients); the server always returns the effective rules. */
  handoffRules: z.string().max(AI_HANDOFF_RULES_CHARACTERS).optional(),
  apiKey: z.string().trim().min(10).max(512).optional(),
});
export type AiSettingsBody = z.infer<typeof AiSettingsBody>;
export const AiSettings = AiSettingsBody.omit({ apiKey: true });
export type AiSettings = z.infer<typeof AiSettings>;
/** One connection/model shared by every current and future AI member. */
export const AiConnectionBody = AiSettingsBody.pick({
  mode: true,
  model: true,
  apiKey: true,
})
  .refine(({ mode, model }) => mode !== 'chatgpt' || !model || CHATGPT_MODEL_ID.test(model), {
    path: ['model'],
    message: 'ChatGPT mode supports only listed model ids. Choose Auto to use the default.',
  })
  .refine(
    ({ mode, model }) =>
      mode !== 'claude' || !model || (CLAUDE_MODELS as readonly string[]).includes(model),
    {
      path: ['model'],
      message: `Claude mode supports ${CLAUDE_MODELS.join(', ')}. Choose the default to use ${CLAUDE_DEFAULT_MODEL}.`,
    },
  );
export type AiConnectionBody = z.infer<typeof AiConnectionBody>;
export const AiMemberBody = AiSettings.omit({ mode: true, model: true });
export type AiMemberBody = z.infer<typeof AiMemberBody>;

const contextName = z.string().trim().min(1).max(AI_CONTEXT_NAME_CHARACTERS);
const contextText = z
  .string()
  // UTF-16 bound first (cheap), then the exact code point limit.
  .max(AI_CONTEXT_CHARACTERS * 2)
  .refine((text) => text.trim().length > 0, { message: 'Add some text' })
  .refine((text) => codePointLength(text) <= AI_CONTEXT_CHARACTERS, {
    message: `Text content can contain up to ${AI_CONTEXT_CHARACTERS.toLocaleString('en')} characters`,
  });
/** Business context "Add text content": a named text item (hours, prices, policies, FAQs…). */
export const AiContextTextBody = z.object({
  name: contextName,
  text: contextText,
  /** Internal: used by the agent to decide, never told to customers. */
  internal: z.boolean().optional(),
});
export type AiContextTextBody = z.infer<typeof AiContextTextBody>;
/** Edits a text item (file items are read-only). */
export const AiContextPatchBody = z
  .object({
    name: contextName.optional(),
    text: contextText.optional(),
    internal: z.boolean().optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.text !== undefined || body.internal !== undefined,
    { message: 'Change the name, the text or Internal' },
  );
export type AiContextPatchBody = z.infer<typeof AiContextPatchBody>;

/** One Business context item: an uploaded file or text content. */
export const AiDocument = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: z.enum(['file', 'text']),
  /** Bytes of the original upload, or of the text in UTF-8. */
  size: z.number(),
  characters: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Internal: used by the agent to decide, never told to customers. */
  internal: z.boolean().default(false),
});
export type AiDocument = z.infer<typeof AiDocument>;
/** Characters of a file item's extracted text shown in its read-only preview. */
export const AI_CONTEXT_PREVIEW_CHARACTERS = 20_000;
/** An item with its text: full for text items (editable), a preview for files. */
export const AiDocumentView = AiDocument.extend({ text: z.string(), truncated: z.boolean() });
export type AiDocumentView = z.infer<typeof AiDocumentView>;
export const AiConnection = z.object({
  state: z.enum(['unavailable', 'signed_out', 'signing_in', 'connected', 'error', 'expired']),
  loginUrl: z.string().nullable(),
  error: z.string().nullable(),
  /** Signed-in ChatGPT account email (direct sign-in only). */
  email: z.string().nullable().optional(),
});
export type AiConnection = z.infer<typeof AiConnection>;
/** One AI agent: its own name, preset, texts and knowledge; answers at most one inbox. */
export const AiAgentSummary = z.object({
  id: z.number().int().positive(),
  /** The agent's `kind='ai'` team member. */
  userId: z.number().int().positive(),
  displayName: z.string(),
  enabled: z.boolean(),
  preset: AiAgentPreset,
  /** The inbox this agent answers; null = not answering any inbox. */
  inboxId: z.number().int().positive().nullable(),
  documentCount: z.number().int().nonnegative(),
  /**
   * "Ask if the question is answered": end answers with a resolution question and close the chat
   * on a clear "yes". Off: no check-in lines, the team closes chats. Missing (older servers) = off.
   */
  resolutionCheck: z.boolean().optional(),
  /** The agent answers direct chats (at most one agent per number does). Older servers: true. */
  answerDirect: z.boolean().default(true),
  /** WhatsApp groups switched on for this agent. Older servers: 0. */
  groupCount: z.number().int().nonnegative().default(0),
});
export type AiAgentSummary = z.infer<typeof AiAgentSummary>;
/** Create or save one agent (same text limits as the AI member). */
export const AiAgentBody = z.object({
  displayName: AiMemberBody.shape.displayName,
  enabled: z.boolean(),
  /** Labels the agent; the web prefills the texts from it on create (see `presetTexts`). */
  preset: AiAgentPreset.optional(),
  instructions: AiMemberBody.shape.instructions,
  handoffRules: AiMemberBody.shape.handoffRules,
  inboxId: z.number().int().positive().nullable().optional(),
  /** Omitted: unchanged on save, off on create (every preset). */
  resolutionCheck: z.boolean().optional(),
});
export type AiAgentBody = z.infer<typeof AiAgentBody>;
/** `PUT /api/ai/agents/:agentId/resolution-check`: the "Ask if the question is answered" switch. */
export const AiResolutionCheckBody = z.strictObject({ enabled: z.boolean() });
export type AiResolutionCheckBody = z.infer<typeof AiResolutionCheckBody>;
/** `GET /api/ai/agents/:agentId`: the agent, its effective settings and its items. */
export const AiAgentStatus = z.object({
  agent: AiAgentSummary,
  settings: AiSettings,
  documents: z.array(AiDocument),
});
export type AiAgentStatus = z.infer<typeof AiAgentStatus>;

/** `GET /api/ai`: the connection and the agent of inbox 1 in the old shape, plus every agent. */
export const AiMemberStatus = z.object({
  member: UserSchema.nullable(),
  settings: AiSettings,
  /** An OpenAI API key is saved (kept while another mode is selected). */
  hasApiKey: z.boolean(),
  /** A Claude API key is saved (kept while another mode is selected); false from older servers. */
  hasClaudeApiKey: z.boolean().default(false),
  connection: AiConnection,
  documents: z.array(AiDocument),
  // Defaults keep a client working with an older server or a test double that predates agents.
  agents: z.array(AiAgentSummary).default([]),
  /** Agents this edition allows (= maxInboxes; Lite 1). */
  maxAgents: z.number().int().default(1),
});
export type AiMemberStatus = z.infer<typeof AiMemberStatus>;
export const AiStatus = AiMemberStatus;
export type AiStatus = AiMemberStatus;

export const AiModelList = z.object({
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  source: z.enum(['live', 'fallback']),
});
export type AiModelList = z.infer<typeof AiModelList>;
export const AiTestResult = z.object({
  ok: z.boolean(),
  model: z.string().nullable(),
  reply: z.string().nullable(),
  error: z.string().nullable(),
});
export type AiTestResult = z.infer<typeof AiTestResult>;

/**
 * Why the AI handed a chat to the team: the customer asked for a person, the facts are missing or
 * conflicting, the topic is sensitive, or the customer wants something done that the AI cannot do
 * (place/change/cancel an order, book, pay…).
 */
export const AI_MODEL_HANDOFF_REASONS = [
  'asked_for_human',
  'missing_facts',
  'sensitive',
  'needs_action',
  'business_rule',
] as const;
/**
 * Model reasons plus the server's own: a message the AI cannot read, the AI being unavailable, or
 * a look-up an extension tool could not complete (`lookup_failed`).
 */
export const AiHandoffReason = z.enum([
  ...AI_MODEL_HANDOFF_REASONS,
  'unsupported_message',
  'ai_unavailable',
  'lookup_failed',
  /** The reply quoted an Internal item; it was not sent. */
  'confidential_leak',
  /** WhatsApp Business API: the 24-hour reply window closed; only a template may be sent. */
  'window_closed',
]);
export type AiHandoffReason = z.infer<typeof AiHandoffReason>;

/**
 * What the AI does with a customer turn. `no_reply`: nothing to say (e.g. a bare "ok" / "thanks"
 * after the details are collected): the AI keeps the chat and sends nothing.
 */
export const AiDecisionAction = z.enum([
  'answer',
  'ask_resolution',
  'resolve',
  'handoff',
  'no_reply',
]);
export type AiDecisionAction = z.infer<typeof AiDecisionAction>;

/** Structured decisions are checked by the server before sending or changing ownership. */
export const AiDecision = z
  .object({
    /** Empty only with `no_reply` (which never sends anything). */
    reply: z.string().trim().max(4096),
    action: AiDecisionAction,
    /** Set with `handoff`; missing or null otherwise (an answer without it still parses). */
    handoffReason: AiHandoffReason.nullable().optional(),
  })
  .refine((d) => d.action === 'no_reply' || d.reply.length > 0, {
    message: 'A reply is required unless the action is no_reply',
    path: ['reply'],
  });
export type AiDecision = z.infer<typeof AiDecision>;

/** Paste-the-callback fallback for admins who cannot reach the server's localhost callback. */
export const AiCallbackBody = z.object({ url: z.string().trim().min(1).max(4096) });
export type AiCallbackBody = z.infer<typeof AiCallbackBody>;

/**
 * Check an API key before saving it; the server never stores or logs the key. `mode` picks the
 * service: `api` (OpenAI, the default for older clients) or `claude` (Anthropic).
 */
export const AiKeyTestBody = z.object({
  apiKey: z.string().trim().min(1).max(400),
  mode: z.enum(['api', 'claude']).optional(),
});
export type AiKeyTestBody = z.infer<typeof AiKeyTestBody>;
/**
 * invalid_key: the service rejected the key (401), never saved. The others may still answer customers
 * (a restricted key without the Models permission, a region block, a passing rate limit or outage),
 * so the admin may save the key anyway.
 */
export const AiKeyTestError = z.enum([
  'invalid_key',
  'forbidden',
  'unreachable',
  'rate_limited',
  // The service answered 400: no credit on the account, or another refusal (the key may be fine).
  'no_credit',
  'rejected',
]);
export type AiKeyTestError = z.infer<typeof AiKeyTestError>;
export const AiKeyTestResponse = z.object({
  ok: z.boolean(),
  error: AiKeyTestError.nullable(),
});
export type AiKeyTestResponse = z.infer<typeof AiKeyTestResponse>;

export const AI_TRY_QUESTION_CHARACTERS = 500;
/**
 * Try it: a test question answered with the page's current (possibly unsaved) name and
 * instructions; the server adds the saved Business context items.
 */
export const AiTryBody = z.object({
  question: z.string().trim().min(1).max(AI_TRY_QUESTION_CHARACTERS),
  knowledge: AiMemberBody.pick({ displayName: true, instructions: true, handoffRules: true }),
  /** The agent whose saved items answer; omitted = the agent of inbox 1. */
  agentId: z.number().int().positive().optional(),
  /** Answer as in a WhatsApp group (the question tags the business); look-ups only. */
  group: z.boolean().optional(),
});
export type AiTryBody = z.infer<typeof AiTryBody>;
/** Shown text of one look-up an extension tool made ("AI looked up {{title}} · {{source}}"). */
export const AI_TOOL_LABEL_CHARACTERS = 120;
export const AiToolUsedPayload = z.object({
  title: z.string().min(1).max(AI_TOOL_LABEL_CHARACTERS),
  sourceLabel: z.string().min(1).max(AI_TOOL_LABEL_CHARACTERS),
  /** Google Calendar (core connector): what the AI checked or booked. */
  calendar: AiToolCalendarDetail.optional(),
  /** A WhatsApp group: the AI answered a tag or a quote, handed over, or paused (loop guard). */
  group: AiGroupEvent.optional(),
  /** Google Sheets (core connector): the AI added a row to this tab. */
  sheet: z.object({ action: z.literal('row_added'), tab: z.string().max(100) }).optional(),
});
export type AiToolUsedPayload = z.infer<typeof AiToolUsedPayload>;
/** One extension tool call of a Try it answer: names and timing only, never input or output. */
export const AiTryLookup = AiToolUsedPayload.extend({
  tool: z.string(),
  source: z.string(),
  ok: z.boolean(),
  ms: z.number().int().nonnegative(),
  /** Try it never changes data: a tool that would (e.g. a booking) is reported as not run. */
  notRun: z.boolean().optional(),
});
export type AiTryLookup = z.infer<typeof AiTryLookup>;
export const AiTryResult = z.object({
  ok: z.boolean(),
  reply: z.string().nullable(),
  action: AiDecisionAction.nullable(),
  handoffReason: AiHandoffReason.nullable().optional(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  /** Extension look-ups in call order; absent when no extension tool was called. */
  lookups: z.array(AiTryLookup).optional(),
});
export type AiTryResult = z.infer<typeof AiTryResult>;

export const AI_EDIT_REQUEST_CHARACTERS = 500;
/** The AI member texts "Edit with AI" can rewrite (one box at a time). */
export const AiEditField = z.enum(['instructions', 'handoffRules']);
export type AiEditField = z.infer<typeof AiEditField>;
export const AI_EDIT_FIELD_CHARACTERS: Record<AiEditField, number> = {
  instructions: AI_INSTRUCTIONS_CHARACTERS,
  handoffRules: AI_HANDOFF_RULES_CHARACTERS,
};
/**
 * Edit with AI: the admin's request applied to one box's current (possibly unsaved) text. The
 * server returns a suggestion only; nothing is saved until the page's Save.
 */
export const AiEditBody = z
  .object({
    field: AiEditField,
    current: z.string().max(AI_INSTRUCTIONS_CHARACTERS),
    request: z.string().trim().min(1).max(AI_EDIT_REQUEST_CHARACTERS),
    /** The agent's preset, so a FAQ agent is not pushed toward sales. */
    preset: AiAgentPreset.optional(),
  })
  .refine((body) => body.current.length <= AI_EDIT_FIELD_CHARACTERS[body.field], {
    path: ['current'],
    message: 'Too long for this field',
  });
export type AiEditBody = z.infer<typeof AiEditBody>;
export const AiEditResult = z.object({
  ok: z.boolean(),
  /** The full suggested text for the box (null when the edit failed). */
  text: z.string().nullable(),
  error: z.string().nullable(),
});
export type AiEditResult = z.infer<typeof AiEditResult>;

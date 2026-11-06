import { randomUUID } from 'node:crypto';
import type {
  AiAgentBody,
  AiAgentPreset,
  FixGrammarResult,
  SafetyAiAnswer,
  ReplyCompleteResult,
  ReplySuggestModelInfo,
  ReplySuggestionsResult,
  AiAgentStatus,
  AiAgentSummary,
  AiContextPatchBody,
  AiEditBody,
  AiEditResult,
  AiHandoffReason,
  AiDocumentView,
  AiMemberBody,
  AiMemberStatus,
  AiModelList,
  AiTestResult,
  AiTryBody,
  AiTryResult,
  AiSettings,
  EnrichmentExtraction,
  Chat,
  ChatEvent,
  Message,
  ScheduledRunReason,
} from '@ezychat/shared';
import {
  AI_GROUP_CONTEXT_MESSAGES,
  AI_CONTEXT_CHARACTERS,
  AI_CONTEXT_ITEMS,
  AI_CONTEXT_PREVIEW_CHARACTERS,
  AI_EDIT_FIELD_CHARACTERS,
  AI_INTERNAL_CHARACTERS,
  AiConnectionBody,
  AiContextTextBody,
  AiDecision,
  CHATGPT_FALLBACK_MODELS,
  CLAUDE_MODELS,
  DEFAULT_AI_HANDOFF_RULES,
  DEFAULT_AI_INSTRUCTIONS,
  codePointLength,
  notEnglish,
  presetTexts,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { recordSetupVersion, type SetupChangeSource } from './setup-versions.js';
import {
  AgentError,
  agentById,
  agentByUserId,
  agentForInbox,
  createAgentRow,
  defaultAgent,
  deleteAgentRow,
  listAgents,
  migrateMemberSetting,
  setAgentInbox,
  updateAgentTexts,
  type AgentRow,
} from './agents.js';
import { findLeak } from './leak-check.js';
import {
  addressedToAi,
  agentForChat,
  backfillGroupAgents,
  chatAgent,
  directAgentTaken,
  groupChatRow,
  groupLine,
  groupText,
  loopGuard,
  memberName,
  pausedLineWritten,
  type GroupTrigger,
} from './groups.js';
import { answersDirect, directAgentOf, directSlotTaken } from './direct.js';
import { HttpError, errors, parse } from '../http/errors.js';
import { getChats, getMessages } from '../wa-bridge/index.js';
import { usersWhoCanOpenChat } from '../inboxes/access.js';
import { getAliases } from '../chats/aliases.js';
import { AI_KNOWLEDGE_CHARACTERS, relevantKnowledge } from './knowledge.js';
import { AgentTurnFailure, errorNameOf } from './agent/models.js';
import type { AssistResult } from './agent/assist.js';
import { AI_OLDER_MESSAGES_PAGE, chatTools } from './agent/tools.js';
import type { AgentToolInfo } from './agent/extension-tools.js';
import { SAVE_FILE_TO_DRIVE } from '../connectors/google-drive/tools.js';
import { agentLookupsAvailable, agentTurnTools } from './agent/turn-tools.js';
import { OAuthError } from './chatgpt-oauth.js';
import { migrateAiKnowledge, sliceCodePoints } from './migrate.js';
import { buildEditPrompt } from './edit-prompt.js';
import { createAiProvider } from './provider-factory.js';
import {
  AI_TIMEZONE_SETTING,
  GROUP_HANDOVER_REPLY,
  HANDOFF_REPLY,
  VOICE_RETRY_REPLY,
  administratorInstructions,
  aiCustomer,
  buildAiPrompt,
  resolveAiTimeZone,
  splitKnowledge,
  type AiContextItem,
  type AiConversationTurn,
  type AiGroupSituation,
  type AiScheduledSituation,
  type AiCustomer,
  type AiKnowledge,
} from './prompt.js';
import { OPENAI_DEFAULT_MODEL } from './provider.js';
import { claudeModelId } from './claude.js';
import type {
  AiAssistCall,
  AiPromptImage,
  AiPromptPdf,
  AiProvider,
  AiRewritePrompt,
} from './provider-types.js';
import { AI_LIVE_MEDIA_MS, AI_MAX_IMAGES, AI_MAX_RECORD_IMAGES } from './images.js';
import { collectPromptFiles, promptFilesLog, skippedFilesNote } from './files.js';
import { sheetsCanAddRows, type SheetRecordContext } from '../connectors/google-sheets/record.js';
import { guardResolution, objectsToResolution } from './resolution.js';
import {
  AI_CLAUDE_SECRET_KEY,
  AI_PROVIDER_KEY,
  AI_SECRET_KEY,
  aiApiKey,
  aiProviderSettings,
  secretKeyFor,
} from './settings-keys.js';
import { AI_VOICE_WAIT_MS, conversationLine, customerText, isTranscribed } from './conversation.js';
import { CompletionOutput, DraftOutput, buildDraftPrompt } from './draft-prompt.js';
import { acceptDrafts, checkCompletion, type CompletionDrop } from './draft-check.js';
import {
  AGENT_SUGGEST_MODEL,
  FAST_SUGGEST_MODEL,
  replySuggestionsEnabled,
  replySuggestionsModel,
} from './reply-suggestions-setting.js';
import { CHATGPT_FAST_DRAFT_MODELS, DRAFT_FAST_MODELS } from './agent/draft.js';
import { FIX_GRAMMAR_RULES, FixGrammarOutput, grammarIssues } from '../fix-english/grammar.js';
import { SAFETY_CHECK_RULES, SafetyAiOutput } from '../safety/ai-check.js';
import { fixEnglishEnabled } from '../fix-english/setting.js';
import { PhraseOutput, buildPhrasePrompt } from './phrases/prompt.js';
import { WINDOW_CLOSED, isWindowClosed, replyWindowOpen } from '../inboxes/reply-window.js';

/**
 * The chat as the model sees it: who spoke (AI, a teammate, the customer) and what was said. Every
 * AI agent's message is `AI` (an inbox may have been answered by another agent before).
 */
const conversation = (history: Message[], aiUserIds: ReadonlySet<number>): AiConversationTurn[] =>
  // A message deleted for everyone is gone for the customer too: the model never sees it.
  history
    .filter((message) => message.deletedAt == null)
    .map((message) => ({
      speaker: message.fromMe
        ? message.sentByUserId !== null && aiUserIds.has(message.sentByUserId)
          ? 'AI'
          : 'human'
        : 'customer',
      text: conversationLine(message),
    }));

/**
 * A Try it "Group question" decision as a group answer would go out (nothing is sent): every reply
 * is an answer, a hand-over is the group line and an empty reply is no reply.
 */
const groupTryDecision = (decision: AiDecision): AiDecision =>
  decision.action === 'handoff'
    ? { ...decision, reply: GROUP_HANDOVER_REPLY }
    : decision.action === 'no_reply' || !decision.reply.trim()
      ? { action: 'no_reply', reply: '', handoffReason: null }
      : { action: 'answer', reply: decision.reply, handoffReason: null };

export const AI_FALLBACK_MS = 10_000;
/**
 * "Reads every message" groups: a turn starts this long after the last member message and sees
 * every new one (a claim sent as text + photo + PDF is one turn).
 */
export const AI_GROUP_LISTEN_WINDOW_MS = 8_000;
/** A listening group's batch keeps at most this many of the newest messages. */
const AI_GROUP_LISTEN_BATCH_MAX = 30;
/** Names of the fixed Claude models (`GET /api/ai/models` in Claude mode). */
const CLAUDE_MODEL_LABELS: Record<(typeof CLAUDE_MODELS)[number], string> = {
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
};
const PROVIDER_KEY = AI_PROVIDER_KEY;
const MEMBER_KEY = 'ai_sales_member';
const SECRET_KEY = AI_SECRET_KEY;
/** Random per-install id, created once; only its hash (with the model) is sent as prompt_cache_key. */
const INSTALL_ID_KEY = 'ai_install_id';
/** Set once the legacy member knowledge (context, or notes + FAQs) became a context item. */
const CONTEXT_MIGRATED_KEY = 'ai_context_migrated';
const LEGACY_KNOWLEDGE_FIELDS = ['context', 'notes', 'faqs'];
/** The one text item created from legacy member knowledge. */
export const MIGRATED_CONTEXT_NAME = 'Business context';
const DEFAULT_SETTINGS: AiSettings = {
  displayName: 'Sales Agent',
  enabled: false,
  mode: 'chatgpt',
  model: '',
  instructions: DEFAULT_AI_INSTRUCTIONS,
  handoffRules: DEFAULT_AI_HANDOFF_RULES,
};
type Actor = {
  userId: number;
  ip: string | null;
  /** Changes from an AI assistant over MCP carry the token and the assistant's reason. */
  via?: 'app' | 'mcp';
  tokenId?: number;
  reason?: string;
};
/** Who made a setup change, for the version history. */
const versionSource = (actor: Actor): SetupChangeSource => ({
  userId: actor.userId,
  via: actor.via ?? 'app',
  tokenId: actor.tokenId ?? null,
  reason: actor.reason ?? null,
});
/** Extra audit fields for a change an AI assistant made over MCP. */
const mcpAudit = (actor: Actor) =>
  actor.via === 'mcp' ? { via: 'mcp', tokenId: actor.tokenId, reason: actor.reason } : {};
type AgentHttpCode = AgentError['code'] | 'last_agent';
const AGENT_ERRORS: Record<AgentHttpCode, [status: number, message: string]> = {
  agent_limit: [409, 'No more AI agents can be added in this edition'],
  inbox_has_direct_agent: [409, 'Another AI agent already answers direct chats on this number'],
  agent_not_found: [404, 'AI agent not found'],
  internal_too_large: [
    409,
    `Internal items can contain up to ${AI_INTERNAL_CHARACTERS.toLocaleString('en')} characters in total`,
  ],
  last_agent: [409, 'The only AI agent cannot be deleted'],
};
/** Agent errors as HTTP errors whose `code` is the agent code (`{ error: { code } }`). */
const agentHttpError = (code: AgentHttpCode) =>
  new HttpError(AGENT_ERRORS[code][0], code, AGENT_ERRORS[code][1]);
/** Runs a repo call and turns its `AgentError` into the matching HTTP error. */
function agentCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AgentError) throw agentHttpError(error.code);
    throw error;
  }
}
interface State {
  paused: number;
  awaiting_confirmation: number;
  last_customer_message_id: string | null;
  last_replied_message_id: string | null;
  due_at: number | null;
}

export interface AiService {
  /** Shared connection, independent of the Sales Agent's on/off and ownership. */
  connectionReady(): boolean;
  /** The connection can run an agent turn now (signed in or a key saved; any agent on or off). */
  answerReady(): boolean;
  extractCustomer(prompt: AiRewritePrompt, signal: AbortSignal): Promise<EnrichmentExtraction>;
  /** The connection and the default agent (the only one, else inbox 1's) in the old shape, plus every agent. */
  status(): AiMemberStatus;
  /** Every agent, oldest first. */
  listAgents(): AiAgentSummary[];
  /** Agents this edition allows (`maxAgents`, default maxInboxes; Lite 1). */
  maxAgents(): number;
  /** 404 `agent_not_found` for an unknown or deleted agent. */
  agentStatus(agentId: number): AiAgentStatus;
  /**
   * 409 `agent_limit` at maxAgents. A new agent in an inbox whose direct chats another agent answers
   * starts group-only; 409 `inbox_has_direct_agent` when it cannot. Lite: always inbox 1.
   */
  createAgent(body: AiAgentBody, actor: Actor): AiAgentStatus;
  saveAgent(agentId: number, body: AiAgentBody, actor: Actor): AiAgentStatus;
  /** The agent's "Ask if the question is answered" switch (audited, takes effect on the next reply). */
  setResolutionCheck(agentId: number, enabled: boolean, actor: Actor): AiAgentStatus;
  /** Releases its chats first; 409 `last_agent` in Lite. */
  deleteAgent(agentId: number, actor: Actor): void;
  /** Binds the agent to an inbox (null = none) and releases the chats it owned. */
  setAgentInbox(agentId: number, inboxId: number | null, actor: Actor): AiAgentStatus;
  /** The inbox-1 agent if one exists (nothing is updated), else a new one from `body`. */
  ensureDefaultAgent(body: AiAgentBody, actor: Actor): AiAgentStatus;
  /** Old `PUT /api/ai`: `ensureDefaultAgent`, then saves it. */
  saveMember(body: AiMemberBody, actor: Actor): AiMemberStatus;
  saveConnection(body: AiConnectionBody, actor: Actor): AiMemberStatus;
  /** Business context of one agent; `agentId` null = the default agent (old routes and tools). */
  addDocument(
    agentId: number | null,
    name: string,
    size: number,
    text: string,
    actor: Actor,
    internal?: boolean,
  ): AiAgentStatus;
  addText(agentId: number | null, body: AiContextTextBody, actor: Actor): AiAgentStatus;
  updateText(
    agentId: number | null,
    id: number,
    body: AiContextPatchBody,
    actor: Actor,
  ): AiAgentStatus;
  document(agentId: number | null, id: number): AiDocumentView;
  removeDocument(agentId: number | null, id: number, actor: Actor): AiAgentStatus;
  /**
   * The agent that answers this chat, or null: a group's own agent (group on, agent on with "Answer
   * in groups"), a direct chat's the inbox's direct agent (`ai/groups.ts#agentForChat`).
   */
  agentForChat(jid: string): AgentRow | null;
  /** Unassigns and pauses every open chat the agent owns (through chats.patch, so events fire). */
  releaseAgent(agentId: number): void;
  /** "Answer direct chats" went off: stops the agent's direct-chat replies and returns its open direct chats to the team. */
  releaseDirect(agentId: number): void;
  /** Stops the agent's scheduled and running replies. */
  cancelAgent(agentId: number): void;
  login(): Promise<void>;
  completeSignIn(url: string): Promise<void>;
  logout(): Promise<void>;
  models(): Promise<AiModelList>;
  testConnection(): Promise<AiTestResult>;
  tryAnswer(body: AiTryBody): Promise<AiTryResult>;
  /** Edit with AI: a suggested rewrite of one AI agent text; nothing is saved. */
  /** `signal`: the admin cancelled (closed the popup) — stop the AI call. */
  /** `agentId`: whose business items inform the edit (null/absent = the default agent). */
  editText(body: AiEditBody, signal?: AbortSignal, agentId?: number | null): Promise<AiEditResult>;
  canSend(jid: string, userId: number, quotedId: string | undefined): boolean;
  /** Stops scheduled and running WhatsApp group answers of one agent or in one group. */
  stopGroupTurns(filter: { agentId?: number; jid?: string }): void;
  /**
   * AI reply suggestions: `ready` = drafts can run now, `unavailable` = a saved connection that
   * does not work now (expired, blocked, service closing), `none` = no saved connection.
   */
  draftConnection(): 'ready' | 'unavailable' | 'none';
  /** Ask Ezy: like `draftConnection`, for the assistant turn (`assist`); `expired` = sign in again. */
  assistConnection(): 'ready' | 'unavailable' | 'expired' | 'none';
  /**
   * Ask Ezy (docs/features/ask-ezy/design.md): one assistant turn on the business AI connection with the
   * tools the caller built for the signed-in user. Throws like the providers (`AgentTurnFailure`, abort).
   */
  assist(call: AiAssistCall, signal: AbortSignal): Promise<AssistResult & { model: string }>;
  /**
   * Suggest reply (up to 2 grounded drafts) or a completion of the typed text for one chat, from
   * the chat's agent knowledge whether the agent is on or off. Nothing is sent or stored. Throws
   * 409 `ai_suggestions_off` / 503 `ai_unavailable`; a slow or failed completion is `null`.
   */
  draftReply(
    jid: string,
    request: { kind: 'suggest' },
    signal: AbortSignal,
  ): Promise<ReplySuggestionsResult>;
  draftReply(
    jid: string,
    request: { kind: 'complete'; typed: string },
    signal: AbortSignal,
  ): Promise<ReplyCompleteResult>;
  /**
   * Fix English (docs/features/grammar-fix/design.md): the grammar marks for a draft the teammate
   * is typing in this chat, from one structured call on the "Model for suggestions" model. Nothing
   * is sent or stored. Throws 409 `fix_english_off` / 503 `ai_unavailable`.
   */
  fixGrammar(jid: string, text: string, signal: AbortSignal): Promise<FixGrammarResult>;
  /**
   * WhatsApp Safety's AI check (docs/features/whatsapp-safety/design.md): one structured call on the
   * connection's fast model with the fixed `SAFETY_CHECK_RULES` and the message as data (text, file
   * name and type, a ZIP's file names; never a file's content). null when no AI is ready or the call
   * fails: the rules' result stands. Logs level, category, ms and model only.
   */
  checkSafety(chatJid: string, input: string, signal: AbortSignal): Promise<SafetyAiAnswer | null>;
  /** The "Model for suggestions" choice: the saved value, the models it may name, what calls use. */
  suggestModelInfo(): ReplySuggestModelInfo;
  /** `fast`, `agent` or a model of the current connection. */
  isSuggestModel(model: string): boolean;
  /**
   * One phrase-list build for an agent (the phrase worker calls it): its business context, AI
   * instructions, the cleaned team replies and the stored phrases into one structured call on the
   * "Model for suggestions" model. Returns the AI's candidates and what the checks need.
   */
  buildPhrases(
    agentId: number,
    input: {
      teamReplies: readonly string[];
      existing: readonly { text: string; language: string }[];
    },
    signal: AbortSignal,
  ): Promise<{ output: PhraseOutput; model: string; business: string; internalTexts: string[] }>;
  /**
   * A scheduled task's turn (docs/features/scheduled-tasks/design.md): one agent turn for the chat
   * with the agent's knowledge and look-ups (no writes but a sheet row on an Add rows tab), answer
   * or no_reply. `preview`: Try it style, no chat tools that change data, nothing stored. Never
   * sends; the scheduler sends `text`.
   */
  scheduledTurn(
    input: {
      agentId: number;
      chatJid: string;
      task: { name: string; instruction: string };
      preview: boolean;
    },
    signal: AbortSignal,
  ): Promise<ScheduledTurnResult>;
  shutdown(): Promise<void>;
}

/** What a scheduled turn decided: send `text`, skip with a reason, or fail with a reason. */
export interface ScheduledTurnResult {
  outcome: 'send' | 'skip' | 'fail';
  text: string | null;
  reason: ScheduledRunReason | null;
  /** The look-ups it used (the "AI used …" chat lines; titles only in a preview). */
  lookups: AgentToolInfo[];
}
/** A scheduled turn (look-ups included) may take this long. */
export const AI_SCHEDULED_TURN_TIMEOUT_MS = 90_000;
/** The conversation part of a scheduled turn: at most this many of the chat's last messages. */
export const AI_SCHEDULED_CONTEXT_MESSAGES = 20;

/** A completion that takes longer arrives after the teammate moved on: it is dropped. */
export const AI_COMPLETION_TIMEOUT_MS = 3_000;
/** A completion sees only this many of the last chat messages (plus the typed text). */
export const AI_COMPLETION_TURNS = 6;
const AI_SUGGESTION_TIMEOUT_MS = 30_000;
/** A grammar check slower than this is dropped: the teammate has typed on or sent by then. */
export const FIX_GRAMMAR_TIMEOUT_MS = 10_000;
/** WhatsApp Safety's AI check: past this the rules' result stands. */
export const SAFETY_CHECK_TIMEOUT_MS = 15_000;
/** One phrase-list build (a larger structured answer, in the background). */
const AI_PHRASE_BUILD_TIMEOUT_MS = 120_000;

declare module '../context.js' {
  interface Services {
    ai?: AiService;
  }
}

export { isResolutionConfirmation } from './resolution.js';

export function createAiService(
  ctx: AppContext,
  deps: { provider?: AiProvider; isOnline?: (id: number) => boolean } = {},
): AiService {
  const provider = deps.provider ?? createAiProvider(ctx);
  const chats = getChats(ctx);
  const messages = getMessages(ctx);
  const log = ctx.log.child({ mod: 'ai' });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const generations = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();
  let closed = false;
  /** The edition's limit (`runCli({ maxAgents })`), else one per inbox: Lite 1. */
  const maxAgents = () => ctx.config.maxAgents ?? ctx.inboxes.connections.maxInboxes();
  /** The agent whose knowledge and work belong to the chat (it may be off: callers check). */
  const agentOfChat = (jid: string) => chatAgent(ctx, jid);
  /** Every AI team member, deleted agents included (their messages stay in the history). */
  const aiUserIds = () =>
    new Set(
      (ctx.db.prepare("SELECT id FROM users WHERE kind = 'ai'").all() as Array<{ id: number }>).map(
        (row) => row.id,
      ),
    );
  const isAiUser = (id: number | null) =>
    id !== null &&
    (ctx.db.prepare('SELECT kind FROM users WHERE id = ?').get(id) as { kind: string } | undefined)
      ?.kind === 'ai';
  /** An explicit agent id, else the default agent (old routes and tools name none). */
  const agentOrDefault = (agentId: number | null): AgentRow | null => {
    if (agentId === null) return defaultAgent(ctx.db);
    const agent = agentById(ctx.db, agentId);
    if (!agent) throw agentHttpError('agent_not_found');
    return agent;
  };
  /**
   * Migration on read: member knowledge stored as one `context` text (or older notes + FAQs)
   * becomes ONE "Business context" text item, then the fields are dropped. The flag makes it
   * idempotent, even if a stale legacy value is written back later.
   */
  const migrateLegacyContext = () => {
    const stored = ctx.settings.get<unknown>(MEMBER_KEY, null);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    const old = stored as Record<string, unknown>;
    if (!LEGACY_KNOWLEDGE_FIELDS.some((field) => field in old)) return;
    const knowledge = migrateAiKnowledge(old);
    const kept = Object.fromEntries(
      Object.entries(old).filter(([field]) => !LEGACY_KNOWLEDGE_FIELDS.includes(field)),
    );
    let documentId: number | null = null;
    ctx.db.transaction(() => {
      if (!ctx.settings.get<boolean>(CONTEXT_MIGRATED_KEY, false) && knowledge.context.trim()) {
        const now = Date.now();
        documentId = Number(
          ctx.db
            .prepare(
              "INSERT INTO ai_documents(agent_id, name, kind, size, text, created_at, updated_at) VALUES (?, ?, 'text', ?, ?, ?, ?)",
            )
            .run(
              // No agent yet: the first agent adopts it (migrateMemberSetting / insertAgent).
              (agentForInbox(ctx.db, 1) ?? defaultAgent(ctx.db))?.id ?? null,
              MIGRATED_CONTEXT_NAME,
              Buffer.byteLength(knowledge.context),
              knowledge.context,
              now,
              now,
            ).lastInsertRowid,
        );
      }
      ctx.settings.set(MEMBER_KEY, { ...kept, instructions: knowledge.instructions });
      ctx.settings.set(CONTEXT_MIGRATED_KEY, true);
    })();
    log.info(
      { event: 'ai_context_migrated', documentId, truncated: knowledge.truncated },
      'Moved stored AI knowledge into a Business context item',
    );
    if (knowledge.truncated)
      log.warn(
        { event: 'ai_context_truncated', limit: AI_CONTEXT_CHARACTERS, unit: 'code_points' },
        'Stored AI knowledge exceeded the text item limit; kept the start',
      );
  };
  /**
   * The effective settings of one agent: its name and on/off, its texts (NULL = never saved → the
   * preset's defaults; a saved blank stays blank) and the shared connection. No agent → defaults.
   */
  const settingsFor = (agent: AgentRow | null): AiSettings => {
    migrateLegacyContext();
    const defaults = presetTexts(agent?.preset ?? 'sales');
    return {
      ...DEFAULT_SETTINGS,
      instructions: agent?.instructions ?? defaults.instructions,
      handoffRules: agent?.handoffRules ?? defaults.handoffRules,
      // Never saved → ChatGPT sign-in (nothing signs in until an admin does).
      ...aiProviderSettings(ctx.settings),
      displayName: agent?.displayName ?? DEFAULT_SETTINGS.displayName,
      enabled: !!agent?.enabled,
    };
  };
  /** The shared connection (mode, model) as the provider reads it. */
  const settings = (): AiSettings => settingsFor(defaultAgent(ctx.db));
  /** Models the "Model for suggestions" choice may name, for the current connection. */
  const suggestModels = (current: AiSettings): string[] => {
    if (current.mode === 'claude') return [...CLAUDE_MODELS];
    if (current.mode === 'api')
      return [
        ...new Set([
          DRAFT_FAST_MODELS.api,
          current.model || OPENAI_DEFAULT_MODEL,
          'gpt-4.1',
          'gpt-5.5',
        ]),
      ];
    return [...(provider.knownModels?.() ?? CHATGPT_FALLBACK_MODELS)];
  };
  /** The saved model of the connection (Auto = the first listed ChatGPT model). */
  const agentModel = (current: AiSettings): string =>
    current.mode === 'claude'
      ? claudeModelId(current)
      : current.mode === 'api'
        ? current.model || OPENAI_DEFAULT_MODEL
        : current.model || suggestModels(current)[0]!;
  const fastModel = (current: AiSettings): string =>
    current.mode === 'chatgpt'
      ? (CHATGPT_FAST_DRAFT_MODELS.find((id) => suggestModels(current).includes(id)) ??
        agentModel(current))
      : DRAFT_FAST_MODELS[current.mode];
  /**
   * The settings and `fast` flag a draft call uses, from the "Model for suggestions" choice. A model
   * that the connection no longer lists (the mode changed) falls back to the fast model.
   */
  const draftChoice = (current: AiSettings): { settings: AiSettings; fast: boolean } => {
    const choice = replySuggestionsModel(ctx.settings);
    if (choice === AGENT_SUGGEST_MODEL) return { settings: current, fast: false };
    if (choice !== FAST_SUGGEST_MODEL && suggestModels(current).includes(choice))
      return { settings: { ...current, model: choice }, fast: false };
    return { settings: current, fast: true };
  };
  const resolvedSuggestModel = (current: AiSettings): string => {
    const { settings: chosen, fast } = draftChoice(current);
    return fast ? fastModel(current) : agentModel(chosen);
  };
  const installId = () => {
    let id = ctx.settings.get<string | null>(INSTALL_ID_KEY, null);
    if (typeof id !== 'string' || !id) {
      id = randomUUID();
      ctx.settings.set(INSTALL_ID_KEY, id);
    }
    return id;
  };
  /** The cacheable prompt plus this call's facts (time, zone, resolution state) in the last block. */
  /** `agentId` makes the cache key per agent (`<installId>#agent:<id>`); 0 = no agent yet. */
  const prompt = (
    agentId: number,
    knowledge: AiKnowledge,
    internal: string,
    business: string,
    conversation: AiConversationTurn[],
    awaitingConfirmation: boolean,
    images: readonly AiPromptImage[] = [],
    customer: AiCustomer | null = null,
    /** A WhatsApp group answer (group rules and the group in the Current situation block). */
    group?: AiGroupSituation,
    /** The batch's PDFs and the note on files left out (Current situation block). */
    files?: { pdfs: AiPromptPdf[]; note: string | null },
    /** A scheduled task's turn (scheduled rules and the task in the Current situation block). */
    scheduled?: AiScheduledSituation,
  ) => ({
    ...buildAiPrompt(
      knowledge,
      internal,
      business,
      conversation,
      {
        now: new Date(),
        timeZone: resolveAiTimeZone(ctx.settings.get<unknown>(AI_TIMEZONE_SETTING, null)),
        awaitingConfirmation,
        ...(group ? { group } : {}),
        ...(files?.note ? { filesNote: files.note } : {}),
        ...(scheduled ? { scheduled } : {}),
      },
      images,
      customer,
    ),
    ...(files?.pdfs.length ? { pdfs: [...files.pdfs] } : {}),
    cacheId: `${installId()}#agent:${agentId}`,
  });
  const mediaPending = (id: string) =>
    (
      ctx.db.prepare('SELECT media_status FROM messages WHERE id = ?').get(id) as
        { media_status: string } | undefined
    )?.media_status === 'pending';
  /** Live media is downloaded after the AI is notified: wait (bounded) until it is stored or failed. */
  const waitForMedia = (id: string, signal: AbortSignal, deadline: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        ctx.bus.off('message:new', onStored);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const onStored = (message: Message) => {
        if (message.id === id) done();
      };
      const timeout = setTimeout(done, Math.max(0, deadline - Date.now()));
      timeout.unref?.();
      ctx.bus.on('message:new', onStored);
      signal.addEventListener('abort', done, { once: true });
      if (!mediaPending(id) || signal.aborted) done();
    });
  /**
   * The photos and PDFs of a batch the model is given (`ai/files.ts`): up to 10 photos when the
   * agent may add sheet rows (an invoice set), else 3; High-risk files never. The note says which
   * files were left out (when the files module provides one).
   */
  async function batchFiles(batch: readonly Message[], agentId: number, signal: AbortSignal) {
    const files = await collectPromptFiles(
      batch,
      {
        waitForMedia,
        mediaPending,
        mediaPath: (id) => messages.mediaPath(id),
        safetyLevel: (id) => ctx.services.safety?.levelOf(id) ?? null,
      },
      {
        maxImages: sheetsCanAddRows(ctx, agentId) ? AI_MAX_RECORD_IMAGES : AI_MAX_IMAGES,
        signal,
        // the ChatGPT sign-in backend takes no files: it gets each PDF's text layer
        textLayer: aiProviderSettings(ctx.settings).mode === 'chatgpt',
      },
    );
    return { ...files, note: skippedFilesNote(files.skipped) };
  }
  /** Who a sheet row of this turn is for (Google Sheets "Add rows"); `group` = the batch's senders. */
  const recordContext = (
    batch: readonly Message[],
    files: { images: readonly unknown[]; pdfs: readonly unknown[] },
    group: boolean,
  ): SheetRecordContext => ({
    personJids: group
      ? [
          ...new Set(
            batch.flatMap((message) =>
              message.senderJid ? [getAliases(ctx).resolve(message.senderJid)] : [],
            ),
          ),
        ]
      : null,
    messageIds: batch.map((message) => message.id),
    filesGiven: files.images.length + files.pdfs.length > 0,
    fileNames: batch.flatMap((message) =>
      (message.type === 'image' || message.type === 'document') && message.mediaName
        ? [message.mediaName]
        : [],
    ),
  });
  const state = (jid: string) =>
    ctx.db.prepare('SELECT * FROM ai_chat_state WHERE chat_jid = ?').get(jid) as State | undefined;
  /** One agent's Business context items with their text, oldest first (stable knowledge prefix). */
  const contextItems = (agentId: number | null): AiContextItem[] =>
    agentId === null
      ? []
      : (
          ctx.db
            .prepare(
              `SELECT id, name, kind, text, internal, created_at AS createdAt FROM ai_documents
               WHERE agent_id = ? ORDER BY created_at, id`,
            )
            .all(agentId) as Array<Omit<AiContextItem, 'internal'> & { internal: number }>
        ).map((item) => ({ ...item, internal: item.internal === 1 }));
  /** One agent's items as the page lists them (no text). */
  const documentsOf = (agentId: number | null): AiMemberStatus['documents'] =>
    agentId === null
      ? []
      : (
          ctx.db
            .prepare(
              `SELECT id, name, kind, size, length(text) AS characters, created_at AS createdAt,
               updated_at AS updatedAt, internal FROM ai_documents WHERE agent_id = ?
               ORDER BY created_at, id`,
            )
            .all(agentId) as Array<
            Omit<AiMemberStatus['documents'][number], 'internal'> & {
              internal: number;
            }
          >
        ).map((doc) => ({ ...doc, internal: doc.internal === 1 }));
  /** The agent whose items change; null = the default agent, which must exist. */
  const contextAgent = (agentId: number | null): AgentRow => {
    const agent = agentOrDefault(agentId);
    if (!agent) throw errors.conflict('Add the AI agent before adding business context');
    return agent;
  };
  /**
   * Item count and total text limits of one agent; `replacing` is the item being edited (not
   * counted). `internal`: the new text is Internal, which has its own total (always sent in full).
   */
  const checkLimits = (
    agentId: number,
    adding: string,
    replacing: number | null,
    internal: boolean,
    countText = true,
  ) => {
    const total = ctx.db
      .prepare(
        `SELECT count(*) AS count, coalesce(sum(length(text)), 0) AS characters,
         coalesce(sum(CASE WHEN internal = 1 THEN length(text) ELSE 0 END), 0) AS internal
         FROM ai_documents WHERE agent_id = ? AND id IS NOT ?`,
      )
      .get(agentId, replacing) as { count: number; characters: number; internal: number };
    const length = codePointLength(adding);
    if (
      countText &&
      ((replacing === null && total.count >= AI_CONTEXT_ITEMS) ||
        total.characters + length > AI_KNOWLEDGE_CHARACTERS)
    )
      throw errors.validation('Business context can contain up to 20 items and 500,000 characters');
    if (internal && total.internal + length > AI_INTERNAL_CHARACTERS)
      throw agentHttpError('internal_too_large');
  };
  /** False while an edition has closed the access gate: the AI member does no work then. */
  const gateOpen = () => ctx.access.state().open;
  /** API-key modes (OpenAI, Claude) are ready with a saved key; ChatGPT once signed in. */
  const ready = () =>
    aiProviderSettings(ctx.settings).mode === 'chatgpt'
      ? provider.connection().state === 'connected'
      : !!aiApiKey(ctx.settings);
  const cancel = (jid: string) => {
    const timer = timers.get(jid);
    if (timer) clearTimeout(timer);
    timers.delete(jid);
    generations.get(jid)?.abort();
    generations.delete(jid);
    failPendingAi(jid);
  };
  /** AI messages of this chat still waiting in the send queue are never sent. */
  const failPendingAi = (jid: string) => {
    const rows = ctx.db
      .prepare(
        `SELECT m.id, m.client_id FROM messages m JOIN users u ON u.id = m.sent_by_user_id
      WHERE m.chat_jid = ? AND m.status = 'pending' AND u.kind = 'ai'`,
      )
      .all(jid) as Array<{ id: string; client_id: string | null }>;
    for (const row of rows) {
      ctx.db
        .prepare(
          "UPDATE messages SET status = 'failed', error = 'AI reply cancelled' WHERE id = ? AND status = 'pending'",
        )
        .run(row.id);
      ctx.bus.emit('message:status', {
        id: row.id,
        clientId: row.client_id,
        chatJid: jid,
        status: 'failed',
        error: 'AI reply cancelled',
      });
    }
  };
  // WhatsApp groups (docs/features/ai-groups/design.md): addressed questions wait per group and are
  // answered one at a time; the AI never owns a group chat, so none of the direct-chat state applies.
  /**
   * Group turns waiting, per group, oldest first: an addressed message (`tag` / `quote`), or a
   * listening group's batch of new member messages (`listen`, `id` = its newest).
   */
  const groupQueues = new Map<
    string,
    Array<{ id: string; trigger: GroupTrigger | 'listen'; batch?: string[] }>
  >();
  const groupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** "Reads every message": member messages collected per group until it is quiet for a while. */
  const listenBatches = new Map<string, string[]>();
  const listenTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const groupTurns = new Map<string, AbortController>();
  /** `<jid>\n<quoted message id>` of group answers being sent now: canSend lets only these out. */
  const groupSends = new Set<string>();
  const cancelGroup = (jid: string) => {
    const timer = groupTimers.get(jid);
    if (timer) clearTimeout(timer);
    groupTimers.delete(jid);
    groupQueues.delete(jid);
    const listening = listenTimers.get(jid);
    if (listening) clearTimeout(listening);
    listenTimers.delete(jid);
    listenBatches.delete(jid);
    const turn = groupTurns.get(jid);
    groupTurns.delete(jid);
    if (turn) {
      turn.abort();
      failPendingAi(jid);
    }
  };
  const groupJids = () =>
    new Set([...groupTimers.keys(), ...groupTurns.keys(), ...listenTimers.keys()]);
  const cancelAll = () => {
    for (const jid of new Set([...timers.keys(), ...generations.keys()])) cancel(jid);
    for (const jid of groupJids()) cancelGroup(jid);
  };
  /** Stops scheduled and running replies in the chats this agent answers or owns. */
  const cancelAgent = (agentId: number) => {
    const agent = agentById(ctx.db, agentId);
    for (const jid of new Set([...timers.keys(), ...generations.keys()]))
      if (
        agentOfChat(jid)?.id === agentId ||
        (agent && chats.get(jid)?.assignedTo === agent.userId)
      )
        cancel(jid);
    stopGroupTurns({ agentId });
  };
  function stopGroupTurns(filter: { agentId?: number; jid?: string }) {
    for (const jid of groupJids())
      if (
        (filter.jid === undefined || filter.jid === jid) &&
        (filter.agentId === undefined || agentOfChat(jid)?.id === filter.agentId)
      )
        cancelGroup(jid);
  }
  const pause = (jid: string) => {
    ctx.db
      .prepare(
        'UPDATE ai_chat_state SET paused = 1, awaiting_confirmation = 0, due_at = NULL WHERE chat_jid = ?',
      )
      .run(jid);
    cancel(jid);
  };
  const ownedOpenChats = (userId: number) =>
    (
      ctx.db
        .prepare("SELECT jid FROM chats WHERE assigned_to = ? AND status = 'open'")
        .all(userId) as Array<{ jid: string }>
    ).map((row) => row.jid);
  /** Unassigns and pauses every open chat this AI user owns, so none waits on an AI that will not answer. */
  const releaseUser = (userId: number) => {
    for (const jid of ownedOpenChats(userId)) {
      pause(jid);
      chats.patch(jid, { assignedTo: null }, userId);
    }
  };
  /**
   * A person answered on the phone in a chat the AI owns: the chat goes back to the team and the AI
   * stays paused in it (until it is resolved or assigned to the AI again), so it never talks over them.
   * Unassign first: the `unassigned` event clears `paused`.
   */
  const releaseToTeam = (jid: string) => {
    const owner = ctx.db
      .prepare("SELECT assigned_to AS assignedTo FROM chats WHERE jid = ? AND type = 'dm'")
      .get(jid) as { assignedTo: number | null } | undefined;
    if (owner?.assignedTo != null && isAiUser(owner.assignedTo)) {
      chats.patch(jid, { assignedTo: null }, owner.assignedTo);
      log.info({ jid }, 'AI returned the chat to the team after a phone reply');
    }
    pause(jid);
  };
  const releaseAgent = (agentId: number) => {
    const agent = agentById(ctx.db, agentId);
    if (agent) releaseUser(agent.userId);
  };
  /** Like `releaseAgent` for direct chats only: a group-only agent keeps its group answers. */
  const releaseDirect = (agentId: number) => {
    const agent = agentById(ctx.db, agentId);
    if (!agent) return;
    for (const jid of new Set([...timers.keys(), ...generations.keys()]))
      if (chats.get(jid)?.type === 'dm' && agentOfChat(jid)?.id === agentId) cancel(jid);
    for (const jid of ownedOpenChats(agent.userId))
      if (chats.get(jid)?.type === 'dm') {
        pause(jid);
        chats.patch(jid, { assignedTo: null }, agent.userId);
      }
  };
  /** Every agent's chats (a changed connection, a sign-out). */
  const releaseOwned = () => {
    for (const agent of listAgents(ctx.db)) releaseUser(agent.userId);
  };
  /**
   * The connection itself broke (sign-in expired, or ChatGPT blocked us): stop all AI work and
   * leave its open chats unassigned for the team. Customers are never sent error text.
   */
  const releaseForConnection = () => {
    cancelAll();
    for (const agent of listAgents(ctx.db))
      for (const jid of ownedOpenChats(agent.userId)) {
        ctx.db.prepare('UPDATE ai_chat_state SET due_at = NULL WHERE chat_jid = ?').run(jid);
        chats.patch(jid, { assignedTo: null }, agent.userId);
      }
  };
  provider.onProblem?.(() => {
    if (!closed) {
      ctx.bus.emit('ai:connection-changed');
      releaseForConnection();
    }
  });
  const eligible = (jid: string): boolean => {
    const agent = agentForChat(ctx, jid);
    const chat = chats.get(jid);
    const s = state(jid);
    return (
      !closed &&
      gateOpen() &&
      !!agent &&
      agent.enabled &&
      answersDirect(ctx, agent) &&
      ready() &&
      chat?.type === 'dm' &&
      chat.status === 'open' &&
      (chat.assignedTo === null || chat.assignedTo === agent.userId) &&
      !!s &&
      !s.paused &&
      !!s.last_customer_message_id &&
      s.last_customer_message_id !== s.last_replied_message_id
    );
  };

  function schedule(jid: string, dueAt: number) {
    if (!eligible(jid)) return;
    cancel(jid);
    // Bound automatic work under an inbound burst rather than accumulating unlimited timers.
    if (timers.size >= 200) return;
    const timer = setTimeout(
      () => {
        timers.delete(jid);
        if (running.size >= 3) {
          schedule(jid, Date.now() + 1000);
          return;
        }
        const promise = respond(jid)
          .catch(() => log.warn({ jid, reason: 'workflow_failed' }, 'AI workflow failed'))
          .finally(() => running.delete(promise));
        running.add(promise);
      },
      Math.max(0, dueAt - Date.now()),
    );
    timer.unref?.();
    timers.set(jid, timer);
  }

  function refreshPending() {
    const pending = ctx.db
      .prepare(
        'SELECT chat_jid AS jid, due_at AS dueAt FROM ai_chat_state WHERE paused = 0 AND due_at IS NOT NULL',
      )
      .all() as Array<{ jid: string; dueAt: number }>;
    for (const item of pending)
      if (Date.now() - item.dueAt < 10 * 60_000)
        schedule(item.jid, Math.max(Date.now() + 300, item.dueAt));
  }

  function drainPending() {
    if (closed || !gateOpen() || !listAgents(ctx.db).some((a) => a.enabled) || !ready()) return;
    const pending = ctx.db
      .prepare(
        `SELECT chat_jid AS jid, due_at AS dueAt FROM ai_chat_state
      WHERE paused = 0 AND due_at IS NOT NULL AND due_at >= ? ORDER BY due_at LIMIT 250`,
      )
      .all(Date.now() - 10 * 60_000) as Array<{ jid: string; dueAt: number }>;
    for (const item of pending) {
      if (timers.size >= 200) break;
      if (!timers.has(item.jid) && !generations.has(item.jid))
        schedule(item.jid, Math.max(Date.now() + 300, item.dueAt));
    }
  }
  // Requeue persisted work when ChatGPT finishes restoring or a burst exceeds timer capacity.
  const drainTimer = setInterval(drainPending, 1000);
  drainTimer.unref?.();

  /**
   * The AI itself resolved this chat last, and since then nobody on the team wrote or acted in it: only the
   * customer's new messages reopened it (e.g. a closing "thanks").
   */
  function resolvedByAgentSinceThen(jid: string, aiUserId: number): boolean {
    const resolved = ctx.db
      .prepare(
        "SELECT actor_id, at FROM chat_events WHERE chat_jid = ? AND type = 'resolved' ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(jid) as { actor_id: number | null; at: number } | undefined;
    if (resolved?.actor_id !== aiUserId) return false;
    const teamSince = ctx.db
      .prepare(
        `SELECT 1 FROM chat_events WHERE chat_jid = @jid AND at >= @at AND actor_id IS NOT NULL AND actor_id <> @ai
         UNION ALL
         SELECT 1 FROM messages WHERE chat_jid = @jid AND from_me = 1 AND type <> 'system' AND created_at > @at
           AND (sent_by_user_id IS NULL OR sent_by_user_id <> @ai)
         LIMIT 1`,
      )
      .get({ jid, at: resolved.at, ai: aiUserId });
    return !teamSince;
  }

  /**
   * A closing message the AI chose not to answer after it had resolved the chat: acknowledge it with a 👍
   * reaction (a "👍" reply where the connection cannot react) and resolve the chat again, instead of keeping
   * an open chat nobody answers. The chat is resolved even when neither can be sent (offline, window closed).
   */
  async function closeAfterThanks(
    jid: string,
    userId: number,
    customerId: string,
    agentId: number,
    signal: AbortSignal,
    owned: () => boolean,
  ) {
    let ack: 'reaction' | 'reply' | 'none' = 'reaction';
    try {
      await messages.sendReaction(customerId, '👍', userId);
    } catch {
      ack = 'reply';
      try {
        await sendReply(jid, userId, customerId, '👍', signal);
      } catch {
        ack = 'none';
      }
    }
    // A new customer message while the 👍 went out needs an answer: keep the chat open for it.
    if (!owned() || state(jid)?.last_customer_message_id !== customerId) return;
    chats.patch(jid, { status: 'resolved' }, userId);
    audit(ctx.db, {
      userId,
      action: 'ai.resolve',
      ip: null,
      meta: { chatJid: jid, agentId, after: 'thanks' },
    });
    log.info({ jid, agentId, ack }, 'AI resolved the chat again after thanks');
  }

  async function sendReply(
    jid: string,
    userId: number,
    customerId: string,
    text: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const clientId = `ai-${randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        ctx.bus.off('message:status', onStatus);
        signal.removeEventListener('abort', onAbort);
      };
      const onStatus = (event: {
        clientId: string | null;
        status: string;
        error?: string | null;
      }) => {
        if (event.clientId !== clientId) return;
        if (['sent', 'delivered', 'read'].includes(event.status)) {
          cleanup();
          resolve();
        } else if (event.status === 'failed') {
          cleanup();
          reject(new Error(event.error === WINDOW_CLOSED ? WINDOW_CLOSED : 'AI send failed'));
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException('AI reply cancelled', 'AbortError'));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('AI send timed out'));
      }, 65_000);
      timeout.unref?.();
      ctx.bus.on('message:status', onStatus);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        messages.sendText(jid, { text, clientId, quotedId: customerId }, userId);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    signal.throwIfAborted();
  }

  function handoff(jid: string, userId: number, reason: AiHandoffReason | null) {
    // Selection and assignment are synchronous, so simultaneous handoffs cannot choose the same idle agent.
    const candidates = ctx.db
      .prepare(
        `SELECT u.id FROM users u WHERE u.kind = 'human' AND u.role = 'agent' AND u.disabled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.assigned_to = u.id AND c.status = 'open') ORDER BY u.id`,
      )
      .all() as Array<{ id: number }>;
    // Only a teammate who may open the chat (its inbox, or one of their chosen chats).
    const allowed = new Set(usersWhoCanOpenChat(ctx, jid));
    const idle = candidates.find(
      (user) =>
        allowed.has(user.id) &&
        (deps.isOnline ?? ((id) => ctx.services.realtime?.isOnline(id) ?? false))(user.id),
    );
    const agentId = agentByUserId(ctx.db, userId)?.id ?? null;
    pause(jid);
    chats.patch(jid, { assignedTo: idle?.id ?? null }, userId, { handoff: reason });
    audit(ctx.db, {
      userId,
      action: 'ai.handoff',
      ip: null,
      meta: { chatJid: jid, assignedTo: idle?.id ?? null, reason, agentId },
    });
    log.info(
      { event: 'ai_handoff', assignedTo: idle?.id ?? null, reason, agentId },
      'AI handed chat to team',
    );
    const handedOver = chats.get(jid);
    if (handedOver) ctx.bus.emit('ai:handoff', handedOver);
  }

  /** The agent that may answer in this WhatsApp group now (every switch on), else null. */
  const groupAgent = (jid: string): AgentRow | null => {
    if (closed || !gateOpen() || !ready()) return null;
    if (chats.get(jid)?.type !== 'group') return null;
    return agentForChat(ctx, jid);
  };
  /**
   * Loop guard: after AI_GROUP_LOOP_GUARD AI messages in a row without a teammate message the AI
   * waits; the first held question of the run writes the one "AI paused" line.
   */
  const holdForLoopGuard = (jid: string, agent: AgentRow, listen = false): boolean => {
    const guard = loopGuard(ctx.db, jid, listen);
    if (!guard.paused) return false;
    if (!pausedLineWritten(ctx.db, jid, guard.since)) {
      chats.addAiToolUsed(jid, agent.userId, [groupLine(agent, { kind: 'paused', member: null })]);
      log.info(
        { jid, agentId: agent.id, inRow: guard.inRow, reason: 'loop_guard' },
        'AI paused in group',
      );
    }
    return true;
  };
  /** Waiting questions of one group: at most this many (a burst beyond it gets no answer). */
  const GROUP_QUEUE_MAX = 5;
  const GROUP_DEBOUNCE_MS = 1000;
  function scheduleGroup(jid: string, delay = GROUP_DEBOUNCE_MS) {
    if (groupTimers.has(jid) || groupTurns.has(jid) || groupTimers.size >= 200) return;
    const timer = setTimeout(() => {
      groupTimers.delete(jid);
      if (running.size >= 3) {
        scheduleGroup(jid);
        return;
      }
      const promise = drainGroup(jid)
        .catch(() => log.warn({ jid, reason: 'workflow_failed' }, 'AI group workflow failed'))
        .finally(() => running.delete(promise));
      running.add(promise);
    }, delay);
    timer.unref?.();
    groupTimers.set(jid, timer);
  }
  async function drainGroup(jid: string) {
    const controller = new AbortController();
    groupTurns.set(jid, controller);
    try {
      for (let ask = groupQueues.get(jid)?.shift(); ask; ask = groupQueues.get(jid)?.shift()) {
        if (controller.signal.aborted) return;
        await groupTurn(jid, ask, controller.signal);
      }
    } finally {
      if (groupTurns.get(jid) === controller) groupTurns.delete(jid);
      if (!groupQueues.get(jid)?.length) groupQueues.delete(jid);
    }
  }
  /**
   * The group as the model sees it: who spoke (AI, a teammate, a named member) and what was said.
   * A message deleted for everyone is left out, as in `conversation`.
   */
  const groupConversation = (history: Message[], aiUsers: ReadonlySet<number>) =>
    history.flatMap((message): AiConversationTurn[] =>
      conversation([message], aiUsers).map((turn) => ({
        speaker: turn.speaker,
        ...(turn.speaker === 'customer' ? { name: memberName(ctx, message) ?? 'Member' } : {}),
        text: groupText(turn.text),
      })),
    );
  /**
   * One answer to an addressed group message: never a claim or an assignment change, look-up tools
   * only. answer → the reply quoting the member; handoff → "A team member will reply soon." quoting
   * them, plus a notification; no_reply → nothing. Logs carry ids, counts and outcomes, never text.
   */
  async function groupTurn(
    jid: string,
    ask: { id: string; trigger: GroupTrigger | 'listen'; batch?: string[] },
    signal: AbortSignal,
  ) {
    const agent = groupAgent(jid);
    if (!agent) return;
    const listen = ask.trigger === 'listen';
    const still = () => !signal.aborted && groupAgent(jid)?.id === agent.id;
    if (holdForLoopGuard(jid, agent, listen)) return;
    if (!replyWindowOpen(ctx, jid)) {
      log.info({ jid, agentId: agent.id, reason: 'window_closed' }, 'AI group question skipped');
      return;
    }
    const chat = chats.get(jid)!;
    const history = messages.list(jid, { limit: AI_GROUP_CONTEXT_MESSAGES }).messages;
    const asked = history.find((message) => message.id === ask.id);
    // Listening: the batch's member messages still in the chat (a deleted one is not read).
    const batch = listen
      ? history.filter(
          (message) =>
            (ask.batch ?? [ask.id]).includes(message.id) &&
            !message.fromMe &&
            message.deletedAt == null,
        )
      : asked
        ? [asked]
        : [];
    if (!asked || !batch.length) {
      log.info({ jid, agentId: agent.id, reason: 'question_too_old' }, 'AI group question skipped');
      return;
    }
    const member = memberName(ctx, asked);
    const question = groupText(customerText(asked)).trim();
    const batchTexts = batch.map((message) => ({
      member: memberName(ctx, message) ?? 'Member',
      text: groupText(customerText(message)).trim(),
    }));
    const quoted = asked.quotedId
      ? history.find((message) => message.id === asked.quotedId)
      : undefined;
    const current = settingsFor(agent);
    const saved = contextItems(agent.id);
    const items = splitKnowledge(saved);
    const internalTexts = saved.filter((item) => item.internal).map((item) => item.text);
    const knowledge = relevantKnowledge(
      items.business,
      listen
        ? batchTexts.map((line) => line.text).join('\n')
        : [quoted ? customerText(quoted) : '', question].filter(Boolean).join('\n'),
    );
    const canRecord = sheetsCanAddRows(ctx, agent.id);
    const hasFacts =
      !!knowledge.trim() || agentLookupsAvailable(ctx, 'sales', agent.id) || canRecord;
    const unsafe = batch.some((message) => ctx.services.safety?.levelOf(message.id) === 'high');
    // Photos and PDFs of the batch (a tagged photo, a listening group's claim files).
    const files =
      !unsafe && hasFacts && batch.some((m) => m.type === 'image' || m.type === 'document')
        ? await batchFiles(batch, agent.id, signal)
        : { images: [], pdfs: [], skipped: [], note: null };
    if (!still()) return;
    if (listen && !unsafe) {
      // A listening group gets no hand-over line for what it cannot read: it stays quiet.
      const readable =
        batchTexts.some((line) => line.text) || files.images.length + files.pdfs.length > 0;
      if (!readable || !hasFacts) {
        log.info(
          { jid, agentId: agent.id, reason: readable ? 'missing_facts' : 'nothing_readable' },
          'AI group messages skipped',
        );
        return;
      }
    }
    const toolCalls: string[] = [];
    let lookups: AgentToolInfo[] = [];
    let lookupFailed = false;
    const started = Date.now();
    const handover = (handoffReason: AiHandoffReason): AiDecision => ({
      action: 'handoff',
      reply: GROUP_HANDOVER_REPLY,
      handoffReason,
    });
    let decision: AiDecision;
    try {
      // A tag or quote without text (a sticker, a voice note, a photo without caption) goes to the team.
      if (unsafe) decision = handover('sensitive');
      else if (
        !listen &&
        (!asked.body?.trim() || !question) &&
        !(asked.type === 'document' && files.pdfs.length > 0)
      )
        decision = handover('unsupported_message');
      else if (!hasFacts) decision = handover('missing_facts');
      else {
        const lookupAbort = new AbortController();
        const turnSignal = AbortSignal.any([signal, lookupAbort.signal]);
        const extension = await agentTurnTools(
          ctx,
          log,
          { agent: 'sales', agentId: agent.id, chatJid: jid, signal: turnSignal },
          {
            onFailure: () => {
              lookupFailed = true;
              lookupAbort.abort();
            },
            onCall: (name) => toolCalls.push(name),
            lookupsOnly: true,
            record: recordContext(batch, files, true),
          },
        );
        try {
          decision = AiDecision.parse(
            await provider.generate(
              current,
              aiApiKey(ctx.settings),
              {
                ...prompt(
                  agent.id,
                  { ...current, preset: agent.preset },
                  items.internal,
                  knowledge,
                  groupConversation(history, aiUserIds()),
                  false,
                  files.images,
                  null,
                  {
                    name: chat.name?.trim() || 'WhatsApp group',
                    member: member ?? 'Member',
                    trigger: ask.trigger,
                    message: question,
                    ...(listen ? { messages: batchTexts } : {}),
                  },
                  files,
                ),
                tools: {
                  ...chatTools({
                    knowledge: items.business,
                    onCall: (name) => toolCalls.push(name),
                  }),
                  ...extension.tools,
                },
                onTiming: (timing) =>
                  log.info({ event: 'ai_turn', source: 'group', ...timing }, 'AI turn timing'),
              },
              turnSignal,
            ),
          );
        } finally {
          lookups = extension.used();
          await extension.dispose();
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (lookupFailed) decision = handover('lookup_failed');
      else if (!ready()) {
        log.warn({ jid, reason: 'connection_unavailable' }, 'AI connection unavailable');
        return;
      } else {
        const turnFailure = error instanceof AgentTurnFailure ? error : null;
        log.warn(
          {
            jid,
            reason: 'provider_failed',
            kind: turnFailure?.kind ?? 'other',
            errName: turnFailure?.causeName ?? errorNameOf(error),
            status: turnFailure?.status ?? null,
          },
          'AI answer unavailable',
        );
        decision = handover('ai_unavailable');
      }
    }
    if (!still()) return;
    // In a group every reply is an answer: there is no resolution question and nothing to close.
    if (decision.action !== 'handoff' && decision.action !== 'no_reply' && !decision.reply.trim())
      decision = { action: 'no_reply', reply: '', handoffReason: null };
    if (decision.action !== 'handoff' && decision.action !== 'no_reply') {
      if (findLeak(decision.reply, internalTexts)) {
        log.warn({ jid, agentId: agent.id, reason: 'confidential_leak' }, 'AI reply withheld');
        decision = handover('confidential_leak');
      }
    }
    log.info(
      {
        jid,
        agentId: agent.id,
        group: true,
        trigger: ask.trigger,
        batch: batch.length,
        ...promptFilesLog(files),
        action: decision.action,
        handoffReason: decision.handoffReason ?? null,
        toolCalls,
        model: current.model ?? null,
        ms: Date.now() - started,
      },
      'AI decision',
    );
    if (decision.action === 'no_reply') return;
    const handedOver = decision.action === 'handoff';
    if (lookups.length) chats.addAiToolUsed(jid, agent.userId, lookups);
    const sending = `${jid}\n${ask.id}`;
    groupSends.add(sending);
    try {
      await sendReply(
        jid,
        agent.userId,
        ask.id,
        handedOver ? GROUP_HANDOVER_REPLY : decision.reply,
        signal,
      );
    } catch (error) {
      if (!signal.aborted)
        log.warn(
          {
            jid,
            agentId: agent.id,
            reason: isWindowClosed(error) ? 'window_closed' : 'send_failed',
          },
          'AI group answer could not be sent',
        );
      return;
    } finally {
      groupSends.delete(sending);
    }
    chats.addAiToolUsed(jid, agent.userId, [
      groupLine(
        agent,
        handedOver
          ? { kind: 'handover', member }
          : { kind: 'answered', member, ...(ask.trigger === 'quote' ? { quoted: true } : {}) },
      ),
    ]);
    if (!handedOver) return;
    const reason = decision.handoffReason ?? null;
    audit(ctx.db, {
      userId: agent.userId,
      action: 'ai.group_handoff',
      ip: null,
      meta: { chatJid: jid, agentId: agent.id, reason },
    });
    log.info(
      {
        event: 'ai_group_handoff',
        jid,
        agentId: agent.id,
        reason,
        assigned: chat.assignedTo != null,
      },
      'AI handed a group question to the team',
    );
    const now = chats.get(jid);
    if (now)
      ctx.bus.emit('ai:group_handoff', {
        chat: now,
        agentName: agent.displayName,
        member,
        question,
      });
  }
  /** A listening group was quiet for the window: its batch becomes one queued turn. */
  const flushListen = (jid: string) => {
    listenTimers.delete(jid);
    const batch = listenBatches.get(jid);
    listenBatches.delete(jid);
    if (!batch?.length || !groupAgent(jid)) return;
    const queue = groupQueues.get(jid) ?? [];
    if (queue.length >= GROUP_QUEUE_MAX) {
      log.info({ jid, reason: 'queue_full' }, 'AI group question skipped');
      return;
    }
    queue.push({ id: batch.at(-1)!, trigger: 'listen', batch });
    groupQueues.set(jid, queue);
    log.info({ jid, trigger: 'listen', batch: batch.length }, 'AI group messages');
    scheduleGroup(jid, 0);
  };
  /**
   * A live group message: in a group with "Reads every message" on it joins the group's batch (one
   * turn once the group is quiet for AI_GROUP_LISTEN_WINDOW_MS); else it is queued for an answer
   * only when every switch is on and it is addressed.
   */
  const onGroupInbound = (chat: Chat, message: Message) => {
    const agent = groupAgent(chat.jid);
    if (!agent) return;
    if (groupChatRow(ctx.db, chat.jid).listen) {
      if (message.fromMe || isAiUser(message.sentByUserId)) return;
      const batch = [...(listenBatches.get(chat.jid) ?? []), message.id].slice(
        -AI_GROUP_LISTEN_BATCH_MAX,
      );
      listenBatches.set(chat.jid, batch);
      const waiting = listenTimers.get(chat.jid);
      if (waiting) clearTimeout(waiting);
      const timer = setTimeout(() => flushListen(chat.jid), AI_GROUP_LISTEN_WINDOW_MS);
      timer.unref?.();
      listenTimers.set(chat.jid, timer);
      return;
    }
    const trigger = addressedToAi(ctx, {
      chatJid: chat.jid,
      messageId: message.id,
      quotedId: message.quotedId,
      aiUserId: agent.userId,
    });
    if (!trigger || holdForLoopGuard(chat.jid, agent)) return;
    const queue = groupQueues.get(chat.jid) ?? [];
    if (queue.length >= GROUP_QUEUE_MAX) {
      log.info(
        { jid: chat.jid, agentId: agent.id, reason: 'queue_full' },
        'AI group question skipped',
      );
      return;
    }
    queue.push({ id: message.id, trigger });
    groupQueues.set(chat.jid, queue);
    log.info({ jid: chat.jid, agentId: agent.id, trigger }, 'AI group question');
    scheduleGroup(chat.jid);
  };

  async function respond(jid: string) {
    if (!eligible(jid)) return;
    const agent = agentForChat(ctx, jid)!;
    const user = { id: agent.userId };
    const customerId = state(jid)!.last_customer_message_id!;
    const controller = new AbortController();
    generations.set(jid, controller);
    const owned = () =>
      !controller.signal.aborted &&
      chats.get(jid)?.assignedTo === user.id &&
      state(jid)?.last_customer_message_id === customerId &&
      !state(jid)?.paused &&
      agentForChat(ctx, jid)?.id === agent.id &&
      !!agentById(ctx.db, agent.id)?.enabled;
    try {
      if (chats.get(jid)!.assignedTo === null) chats.patch(jid, { assignedTo: user.id }, user.id);
      if (!owned()) return;
      // WhatsApp Business API: past the reply window only a template may go out, which the AI
      // never sends; the team takes over (no model call, no message).
      if (!replyWindowOpen(ctx, jid)) {
        log.info({ jid, agentId: agent.id, reason: 'window_closed' }, 'AI reply window closed');
        handoff(jid, user.id, 'window_closed');
        return;
      }
      const current = settingsFor(agentById(ctx.db, agent.id) ?? agent);
      const knowledgeOf = {
        ...current,
        preset: agent.preset,
        resolutionCheck: agent.resolutionCheck,
      };
      // This agent's items only: Internal ones in full, business ones selected per question.
      const saved = contextItems(agent.id);
      const items = splitKnowledge(saved);
      const internalTexts = saved.filter((item) => item.internal).map((item) => item.text);
      const aiUsers = aiUserIds();
      /** The team's saved details as the AI sees them (no tags). */
      const customerDetails = () =>
        aiCustomer(ctx.services.customers?.profile(jid).profile ?? null);
      const savedCustomer = customerDetails();
      /** When the customer last edited or deleted a message of this chat. */
      const customerChanges = () =>
        JSON.stringify(
          ctx.db
            .prepare(
              'SELECT MAX(edited_at) AS edited, MAX(deleted_at) AS deleted FROM messages WHERE chat_jid = ? AND from_me = 0',
            )
            .get(jid),
        );
      const savedChanges = customerChanges();
      /** The last 20 messages, the customer message being answered and its debounce batch. */
      const snapshot = () => {
        const page = messages.list(jid, { limit: 20 });
        const history = page.messages;
        const customer = history.find((message) => message.id === customerId);
        // A question the customer deleted is not answered.
        if (!customer || customer.fromMe || customer.deletedAt != null) return null;
        // The debounce batch: every customer message since the last AI reply.
        const repliedIndex = history.findIndex(
          (message) => message.id === state(jid)!.last_replied_message_id,
        );
        const batchStart =
          repliedIndex >= 0
            ? repliedIndex + 1
            : history.findLastIndex((message) => message.fromMe) + 1;
        const batch = history
          .slice(batchStart, history.indexOf(customer) + 1)
          .filter((message) => !message.fromMe);
        return { history, customer, batchStart, batch, olderBefore: page.nextBefore };
      };
      let snap = snapshot();
      if (!snap) return;
      // Voice notes are transcribed before the AI decides: wait (bounded) for their audio and
      // transcripts, then read the conversation again with the transcripts.
      // Imported history voice notes stay pending until opened and are never transcribed: skip them.
      const voiceNotes = snap.batch.filter(
        (message) =>
          message.type === 'audio' &&
          !(mediaPending(message.id) && Date.now() - message.timestamp > AI_LIVE_MEDIA_MS),
      );
      if (voiceNotes.length) {
        const deadline = Date.now() + AI_VOICE_WAIT_MS;
        for (const note of voiceNotes) {
          await waitForMedia(note.id, controller.signal, deadline);
          await ctx.services.voice?.waitForTranscript(
            note.id,
            controller.signal,
            Math.max(0, deadline - Date.now()),
          );
        }
        if (!owned()) return;
        snap = snapshot();
        if (!snap) return;
      }
      const { history, customer, batchStart, batch, olderBefore } = snap;
      const knowledge = relevantKnowledge(
        items.business,
        history
          .filter((message) => !message.fromMe)
          .slice(-3)
          .map(customerText)
          .join('\n'),
      );
      // awaiting_confirmation counts the resolution questions already sent in a row.
      const asked = state(jid)!.awaiting_confirmation;
      const awaiting = asked > 0;
      let decision: AiDecision;
      let files: Awaited<ReturnType<typeof batchFiles>> = {
        images: [],
        pdfs: [],
        skipped: [],
        note: null,
      };
      const toolCalls: string[] = [];
      /** Successful extension look-ups ("AI looked up …" lines) and whether one failed. */
      let lookups: AgentToolInfo[] = [];
      let lookupFailed = false;
      const started = Date.now();
      /** Page `n` of this chat's messages older than the prompt's, oldest first. */
      const olderMessages = (n: number) => {
        let before = olderBefore;
        let older: Message[] = [];
        for (let page = 1; page <= n && before; page++) {
          const result = messages.list(jid, { limit: AI_OLDER_MESSAGES_PAGE, before });
          older = result.messages;
          before = result.nextBefore;
        }
        return conversation(older, aiUsers);
      };
      /** One model decision; the model may use this chat's read tools first. */
      const decide = async (
        turns: AiConversationTurn[],
        facts: string,
        awaitingConfirmation: boolean,
        given: typeof files,
      ): Promise<AiDecision> => {
        // A failed extension look-up ends the turn at once; the catch below hands over.
        const lookupAbort = new AbortController();
        const signal = AbortSignal.any([controller.signal, lookupAbort.signal]);
        const extension = await agentTurnTools(
          ctx,
          log,
          { agent: 'sales', agentId: agent.id, chatJid: jid, signal },
          {
            onFailure: () => {
              lookupFailed = true;
              lookupAbort.abort();
            },
            onCall: (name) => toolCalls.push(name),
            record: recordContext(batch, given, false),
          },
        );
        try {
          return AiDecision.parse(
            await provider.generate(
              current,
              aiApiKey(ctx.settings),
              {
                ...prompt(
                  agent.id,
                  knowledgeOf,
                  items.internal,
                  facts,
                  turns,
                  awaitingConfirmation,
                  given.images,
                  savedCustomer,
                  undefined,
                  given,
                ),
                tools: {
                  ...chatTools({
                    knowledge: items.business,
                    olderMessages: olderBefore ? olderMessages : undefined,
                    onCall: (name) => toolCalls.push(name),
                  }),
                  ...extension.tools,
                },
                onTiming: (timing) =>
                  log.info({ event: 'ai_turn', source: 'live', ...timing }, 'AI turn timing'),
              },
              signal,
            ),
          );
        } finally {
          lookups = extension.used();
          await extension.dispose();
        }
      };
      try {
        // Text, images (with or without a caption), PDFs the model is given and voice notes can be
        // handled; video, other documents, stickers and the like go to the team.
        const voice = customer.type === 'audio';
        const document = customer.type === 'document';
        if (
          (customer.type === 'text' || customer.type === 'image' || voice || document) &&
          knowledge.trim()
        )
          files = await batchFiles(batch, agent.id, controller.signal);
        if (!owned()) return;
        const pdfGiven = document && files.pdfs.length > 0;
        const readable = customer.type === 'text' || customer.type === 'image' || voice || pdfGiven;
        const understood =
          !!customer.body?.trim() ||
          (customer.type === 'image' && files.images.length > 0) ||
          voice ||
          pdfGiven;
        // An untranscribed voice note gets one "please type it" answer; a second one after
        // that request goes to the team.
        const customerIndex = history.indexOf(customer);
        const voiceRepeat =
          voice &&
          !isTranscribed(customer) &&
          history
            .slice(0, batchStart)
            .some(
              (message, index) =>
                !message.fromMe &&
                message.type === 'audio' &&
                !isTranscribed(message) &&
                history
                  .slice(index + 1, customerIndex)
                  .some((reply) => reply.fromMe && reply.sentByUserId === user.id),
            );
        // Facts come from the Business context or from extension look-ups the agent may call.
        const hasFacts = !!knowledge.trim() || agentLookupsAvailable(ctx, 'sales', agent.id);
        // WhatsApp Safety: a High-risk message (malware lure, phishing) goes to the team unanswered.
        const unsafe = batch.some(
          (message) => !message.fromMe && ctx.services.safety?.levelOf(message.id) === 'high',
        );
        decision = unsafe
          ? { action: 'handoff' as const, reply: HANDOFF_REPLY, handoffReason: 'sensitive' }
          : !readable || !understood || !hasFacts || voiceRepeat
            ? {
                action: 'handoff' as const,
                reply: HANDOFF_REPLY,
                handoffReason: hasFacts ? 'unsupported_message' : 'missing_facts',
              }
            : await decide(conversation(history, aiUsers), knowledge, awaiting, files);
        // The first voice note the AI could not listen to always gets the "please type it" answer
        // (a repeat was handed off above); only a request for a person or a sensitive topic
        // still hands off.
        if (
          voice &&
          !voiceRepeat &&
          !isTranscribed(customer) &&
          decision.action === 'handoff' &&
          decision.handoffReason !== 'asked_for_human' &&
          decision.handoffReason !== 'sensitive'
        )
          decision = { action: 'answer', reply: VOICE_RETRY_REPLY, handoffReason: null };
      } catch (error) {
        if (controller.signal.aborted) return;
        if (lookupFailed) {
          log.warn({ jid, reason: 'lookup_failed' }, 'AI look-up failed');
          decision = {
            action: 'handoff' as const,
            reply: HANDOFF_REPLY,
            handoffReason: 'lookup_failed',
          };
        } else if (!ready()) {
          log.warn({ jid, reason: 'connection_unavailable' }, 'AI connection unavailable');
          releaseForConnection();
          return;
        } else {
          // Failure kind, error class and HTTP status only: messages and bodies can carry customer
          // text. The providers wrap failures in AgentTurnFailure, which keeps these facts.
          const turnFailure = error instanceof AgentTurnFailure ? error : null;
          const failure = error as { name?: unknown; statusCode?: unknown; finishReason?: unknown };
          log.warn(
            {
              jid,
              reason: 'provider_failed',
              kind: turnFailure?.kind ?? 'other',
              errName:
                turnFailure?.causeName ?? (typeof failure?.name === 'string' ? failure.name : null),
              status:
                turnFailure?.status ??
                (typeof failure?.statusCode === 'number' ? failure.statusCode : null),
              finishReason: typeof failure?.finishReason === 'string' ? failure.finishReason : null,
            },
            'AI answer unavailable',
          );
          decision = {
            action: 'handoff' as const,
            reply: HANDOFF_REPLY,
            handoffReason: 'ai_unavailable',
          };
        }
      }
      if (!owned()) return;
      // A teammate corrected the customer's details while the model was writing: never send
      // the outdated reply, answer again with the current details.
      if (JSON.stringify(customerDetails()) !== JSON.stringify(savedCustomer)) {
        log.info({ jid, reason: 'customer_details_changed' }, 'AI reply regenerated');
        schedule(jid, Date.now());
        return;
      }
      // The customer edited or deleted a message meanwhile: answer what the chat says now.
      if (customerChanges() !== savedChanges) {
        log.info({ jid, reason: 'customer_message_changed' }, 'AI reply regenerated');
        schedule(jid, Date.now());
        return;
      }
      // Judge every customer message since the last AI reply (the debounce batch), not only the
      // latest, so "No, still not working" + "thanks" never closes the chat.
      const batchText = batch.map(customerText).join('\n');
      const conversationText = history
        .filter((message) => !message.fromMe)
        .map(customerText)
        .join('\n');
      const proposed = decision.action;
      decision = guardResolution(decision, asked, batchText, conversationText, {
        resolutionCheck: agent.resolutionCheck,
      });
      // A reply that quotes an Internal item is never sent: the team takes over (no text logged).
      if (decision.action !== 'no_reply' && findLeak(decision.reply, internalTexts)) {
        log.warn({ jid, agentId: agent.id, reason: 'confidential_leak' }, 'AI reply withheld');
        decision = {
          action: 'handoff' as const,
          reply: HANDOFF_REPLY,
          handoffReason: 'confidential_leak',
        };
      }
      // One line per decision (no message text) so a chat's AI behaviour can be traced from the log.
      log.info(
        {
          jid,
          action: decision.action,
          proposed,
          handoffReason: decision.handoffReason ?? null,
          asked,
          ...promptFilesLog(files),
          toolCalls,
          voiceNotes: voiceNotes.length,
          model: current.model ?? null,
          ms: Date.now() - started,
        },
        'AI decision',
      );
      // Nothing to say (e.g. a bare "ok" / "thanks"): the AI keeps the chat and sends nothing; the
      // batch counts as handled so it is not answered again.
      if (decision.action === 'no_reply') {
        // The 👍 goes out first: the send guard lets an AI reply out only while the message is unanswered.
        if (resolvedByAgentSinceThen(jid, user.id))
          await closeAfterThanks(jid, user.id, customerId, agent.id, controller.signal, owned);
        ctx.db
          .prepare(
            'UPDATE ai_chat_state SET last_replied_message_id = ?, due_at = NULL WHERE chat_jid = ? AND last_customer_message_id = ?',
          )
          .run(customerId, jid, customerId);
        return;
      }
      // Consecutive resolution questions: a new question or objection restarts the count at 1.
      const nextAsked =
        decision.action !== 'ask_resolution' ? 0 : objectsToResolution(batchText) ? 1 : asked + 1;
      // "AI looked up …" lines sit just above the reply they informed (title and source only).
      if (lookups.length) chats.addAiToolUsed(jid, user.id, lookups);
      await sendReply(jid, user.id, customerId, decision.reply, controller.signal);
      if (!owned()) return;
      ctx.db
        .prepare(
          'UPDATE ai_chat_state SET last_replied_message_id = ?, awaiting_confirmation = ?, due_at = NULL WHERE chat_jid = ?',
        )
        .run(customerId, nextAsked, jid);
      if (decision.action === 'handoff') handoff(jid, user.id, decision.handoffReason ?? null);
      else if (decision.action === 'resolve') {
        chats.patch(jid, { status: 'resolved' }, user.id);
        audit(ctx.db, {
          userId: user.id,
          action: 'ai.resolve',
          ip: null,
          meta: { chatJid: jid, agentId: agent.id },
        });
      }
    } catch (error) {
      if (owned()) {
        // the window closed while the reply was written or queued
        const closed = isWindowClosed(error);
        log.warn(
          { jid, reason: closed ? 'window_closed' : 'send_failed' },
          'AI reply could not be sent',
        );
        handoff(jid, user.id, closed ? 'window_closed' : 'ai_unavailable');
      }
    } finally {
      if (generations.get(jid) === controller) generations.delete(jid);
    }
  }

  const onInbound = ({ chat, message }: { chat: Chat; message: Message }) => {
    if (chat.type === 'group') {
      onGroupInbound(chat, message);
      return;
    }
    // Only the inbox's direct agent answers a direct chat.
    const agent = directAgentOf(ctx, chat.inboxId);
    const user = agent?.enabled && answersDirect(ctx, agent) ? { id: agent.userId } : null;
    if (
      !user ||
      chat.type !== 'dm' ||
      chat.status !== 'open' ||
      (chat.assignedTo !== null && chat.assignedTo !== user.id)
    )
      return;
    if (state(chat.jid)?.paused) {
      // Keep the newest question, so the AI answers it when the chat is assigned to it again.
      ctx.db
        .prepare('UPDATE ai_chat_state SET last_customer_message_id = ? WHERE chat_jid = ?')
        .run(message.id, chat.jid);
      return;
    }
    const dueAt = Date.now() + (chat.assignedTo === user.id ? 300 : AI_FALLBACK_MS);
    ctx.db
      .prepare(
        `INSERT INTO ai_chat_state(chat_jid, last_customer_message_id, due_at) VALUES (?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET last_customer_message_id = excluded.last_customer_message_id, due_at = excluded.due_at`,
      )
      .run(chat.jid, message.id, dueAt);
    schedule(chat.jid, dueAt);
  };
  const onMessage = (message: Message) => {
    // Any AI agent's own reply is not a human response.
    if (!message.fromMe || isAiUser(message.sentByUserId)) return;
    const s = state(message.chatJid);
    if (!s?.last_customer_message_id) return;
    const customer = ctx.db
      .prepare('SELECT timestamp FROM messages WHERE id = ?')
      .get(s.last_customer_message_id) as { timestamp: number } | undefined;
    // Ignore old history echoes. A current phone reply also counts as a human response.
    if (!customer || message.timestamp < customer.timestamp) return;
    // A phone reply names no teammate, so nobody claims the chat: the AI hands it to the team.
    if (message.sentByUserId === null) releaseToTeam(message.chatJid);
    else pause(message.chatJid);
  };
  const onReceived = (event: { chat: Chat; message: Message }) => {
    if (event.message.fromMe) onMessage(event.message);
    else onInbound(event);
  };
  const onChat = (chat: Chat) => {
    // A group keeps its assignee and status whatever the AI does: neither stops a group answer.
    if (chat.type === 'group') return;
    if (chat.status === 'resolved') {
      cancel(chat.jid);
      ctx.db.prepare('DELETE FROM ai_chat_state WHERE chat_jid = ?').run(chat.jid);
    } else if (
      chat.assignedTo !== null &&
      chat.assignedTo !== directAgentOf(ctx, chat.inboxId)?.userId
    )
      pause(chat.jid);
  };
  const onChatEvent = (event: ChatEvent) => {
    const agent = agentOfChat(event.chatJid);
    const user = agent ? { id: agent.userId } : null;
    if (!user || event.actorId === user.id) return;
    if (event.type === 'assigned' && event.payload.assignedTo === user.id) {
      ctx.db
        .prepare(
          'UPDATE ai_chat_state SET paused = 0, awaiting_confirmation = 0 WHERE chat_jid = ?',
        )
        .run(event.chatJid);
      // chat:event is emitted before chat:updated; wait until ownership has committed.
      queueMicrotask(() => {
        if (!closed) schedule(event.chatJid, Date.now() + 300);
      });
    } else if (event.type === 'unassigned' && event.payload.reason !== 'resolved') {
      ctx.db.prepare('UPDATE ai_chat_state SET paused = 0 WHERE chat_jid = ?').run(event.chatJid);
    }
  };
  const onDisabled = (id: number) => {
    const agent = agentByUserId(ctx.db, id);
    if (agent) {
      cancelAgent(agent.id);
      releaseAgent(agent.id);
    }
  };
  // Access gate closed: stop in-flight work; on open, persisted due times are picked up again.
  const onAccessClosed = () => cancelAll();
  const onAccessOpened = () => drainPending();
  ctx.bus
    .on('access:closed', onAccessClosed)
    .on('access:opened', onAccessOpened)
    .on('message:received', onReceived)
    .on('message:new', onMessage)
    .on('chat:updated', onChat)
    .on('chat:event', onChatEvent)
    .on('user:disabled', onDisabled);

  // Permanent start-up repair: before 0.1.66 a phone reply paused the AI but left the chat assigned
  // to it, so later customer messages reached nobody. Every other stop path unassigns the chat.
  const stuck = (
    ctx.db
      .prepare(
        `SELECT c.jid, c.assigned_to AS owner FROM chats c JOIN ai_chat_state s ON s.chat_jid = c.jid
         WHERE c.type = 'dm' AND c.status = 'open' AND s.paused = 1 AND c.assigned_to IS NOT NULL`,
      )
      .all() as Array<{ jid: string; owner: number }>
  ).filter((row) => isAiUser(row.owner));
  for (const { jid } of stuck) releaseToTeam(jid);
  if (stuck.length)
    log.info({ count: stuck.length }, 'AI returned paused chats to the team at start');

  const summary = (agent: AgentRow): AiAgentSummary => ({
    id: agent.id,
    userId: agent.userId,
    displayName: agent.displayName,
    enabled: agent.enabled,
    preset: agent.preset,
    inboxId: agent.inboxId,
    resolutionCheck: agent.resolutionCheck,
    answerDirect: answersDirect(ctx, agent),
    groupCount: (
      ctx.db
        .prepare('SELECT count(*) AS n FROM ai_group_chats WHERE agent_id = ? AND enabled = 1')
        .get(agent.id) as { n: number }
    ).n,
    documentCount: (
      ctx.db.prepare('SELECT count(*) AS n FROM ai_documents WHERE agent_id = ?').get(agent.id) as {
        n: number;
      }
    ).n,
  });
  /** One agent, or one number: every agent serves inbox 1. */
  const oneInbox = () => maxAgents() <= 1 || ctx.inboxes.connections.maxInboxes() <= 1;
  const requireInbox = (inboxId: number) => {
    const inbox = ctx.inboxes.repo.get(inboxId);
    if (!inbox || inbox.removed_at !== null) throw errors.notFound('Inbox');
  };
  /**
   * The AI answers only from business facts (its Business context, or extension look-ups), so
   * instructions alone cannot turn an agent on. `agentId` null = no agent yet: items written
   * before any agent existed count only when `adoptsOrphans` (the new agent serves inbox 1 and
   * adopts them, see insertAgent); any other new agent starts with no items.
   */
  const checkEnable = (agentId: number | null, enabled: boolean, adoptsOrphans = true) => {
    if (!enabled) return;
    if (!ready())
      throw errors.validation('Configure the inbox AI connection before enabling the Sales Agent');
    const hasContext =
      (agentId !== null || adoptsOrphans) &&
      !!ctx.db
        .prepare(
          'SELECT 1 FROM ai_documents WHERE agent_id IS ? AND internal = 0 AND length(trim(text)) > 0 LIMIT 1',
        )
        .get(agentId);
    if (!hasContext && !agentLookupsAvailable(ctx, 'sales', agentId))
      throw errors.validation('Add business context before turning on the AI member');
  };
  /** A new `kind = 'ai'` team member and its agent row (409 `agent_limit` / `inbox_has_direct_agent`). */
  const insertAgent = (
    fields: {
      displayName: string;
      enabled: boolean;
      preset: AiAgentPreset;
      inboxId: number | null;
      instructions: string | null;
      handoffRules: string | null;
      resolutionCheck?: boolean;
    },
    actor: Actor,
  ): AgentRow => {
    if (listAgents(ctx.db).length >= maxAgents()) throw agentHttpError('agent_limit');
    // Lite (and any build with one number): the agents always answer the only inbox.
    const inboxId = oneInbox() ? 1 : fields.inboxId;
    if (inboxId !== null) requireInbox(inboxId);
    // An inbox without groups has no group-only agents: its one agent answers direct chats.
    if (directSlotTaken(ctx, inboxId, null)) throw agentHttpError('inbox_has_direct_agent');
    return ctx.db.transaction(() => {
      const now = Date.now();
      const userId = Number(
        ctx.db
          .prepare(
            "INSERT INTO users(username, display_name, password_hash, role, kind, disabled_at, created_at) VALUES (?, ?, '', 'agent', 'ai', ?, ?)",
          )
          .run(`ai-${randomUUID()}`, fields.displayName, fields.enabled ? null : now, now)
          .lastInsertRowid,
      );
      const agent = agentCall(() =>
        createAgentRow(
          ctx.db,
          {
            userId,
            inboxId,
            preset: fields.preset,
            instructions: fields.instructions,
            handoffRules: fields.handoffRules,
            ...(fields.resolutionCheck !== undefined
              ? { resolutionCheck: fields.resolutionCheck }
              : {}),
          },
          now,
        ),
      );
      // Items and history written before any agent existed belong to the inbox-1 agent.
      if (inboxId === 1) {
        ctx.db.prepare('UPDATE ai_documents SET agent_id = ? WHERE agent_id IS NULL').run(agent.id);
        ctx.db
          .prepare('UPDATE ai_setup_versions SET agent_id = ? WHERE agent_id IS NULL')
          .run(agent.id);
      }
      audit(ctx.db, {
        userId: actor.userId,
        ip: actor.ip,
        action: 'ai.agent_create',
        meta: { agentId: agent.id, preset: fields.preset, inboxId, ...mcpAudit(actor) },
      });
      return agent;
    })();
  };

  const service: AiService = {
    connectionReady: () => !closed && gateOpen() && ready() && !!provider.extractCustomer,
    answerReady: () => !closed && ready(),
    async extractCustomer(prompt, signal) {
      if (!service.connectionReady()) throw errors.conflict('AI connection unavailable');
      return provider.extractCustomer!(
        settings(),
        aiApiKey(ctx.settings),
        { ...prompt, cacheId: installId() },
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      );
    },
    status() {
      const agent = defaultAgent(ctx.db);
      const current = settingsFor(agent);
      return {
        member: agent ? (ctx.services.auth!.getUser(agent.userId) ?? null) : null,
        settings: current,
        hasApiKey: !!ctx.settings.getSecret(SECRET_KEY),
        hasClaudeApiKey: !!ctx.settings.getSecret(AI_CLAUDE_SECRET_KEY),
        documents: documentsOf(agent?.id ?? null),
        connection:
          current.mode === 'chatgpt'
            ? provider.connection()
            : { state: ready() ? 'connected' : 'signed_out', loginUrl: null, error: null },
        agents: service.listAgents(),
        maxAgents: maxAgents(),
      };
    },
    listAgents: () => listAgents(ctx.db).map(summary),
    maxAgents,
    agentStatus(agentId) {
      const agent = agentById(ctx.db, agentId);
      if (!agent) throw agentHttpError('agent_not_found');
      return {
        agent: summary(agent),
        settings: settingsFor(agent),
        documents: documentsOf(agent.id),
      };
    },
    createAgent(body, actor) {
      // Lite forces inbox 1 (insertAgent); only an inbox-1 agent adopts items written before it.
      checkEnable(null, body.enabled, oneInbox() || body.inboxId === 1);
      const preset = body.preset ?? 'sales';
      const agent = insertAgent(
        {
          displayName: body.displayName,
          enabled: body.enabled,
          preset,
          inboxId: body.inboxId ?? null,
          instructions: body.instructions,
          handoffRules: body.handoffRules ?? presetTexts(preset).handoffRules,
          ...(body.resolutionCheck !== undefined ? { resolutionCheck: body.resolutionCheck } : {}),
        },
        actor,
      );
      if (body.enabled) refreshPending();
      return service.agentStatus(agent.id);
    },
    saveAgent(agentId, body, actor) {
      const agent = agentById(ctx.db, agentId);
      if (!agent) throw agentHttpError('agent_not_found');
      checkEnable(agent.id, body.enabled);
      // A new inbox first: it may be refused (inbox_has_direct_agent) before anything is saved.
      if (body.inboxId !== undefined && body.inboxId !== agent.inboxId)
        service.setAgentInbox(agent.id, body.inboxId, actor);
      cancelAgent(agent.id);
      const before = settingsFor(agent);
      // Older clients send no rules: keep the effective ones.
      const handoffRules = body.handoffRules ?? before.handoffRules ?? '';
      ctx.db.transaction(() => {
        ctx.db
          .prepare('UPDATE users SET display_name = ?, disabled_at = ? WHERE id = ?')
          .run(body.displayName, body.enabled ? null : Date.now(), agent.userId);
        agentCall(() =>
          updateAgentTexts(ctx.db, agent.id, {
            ...(body.preset ? { preset: body.preset } : {}),
            ...(body.resolutionCheck !== undefined
              ? { resolutionCheck: body.resolutionCheck }
              : {}),
            instructions: body.instructions,
            handoffRules,
          }),
        );
        // Record who changed the AI's behaviour, without copying the text into the audit log.
        if (body.instructions !== before.instructions)
          recordSetupVersion(
            ctx.db,
            agent.id,
            'instructions',
            null,
            before.instructions,
            body.instructions,
            versionSource(actor),
          );
        if (handoffRules !== before.handoffRules)
          recordSetupVersion(
            ctx.db,
            agent.id,
            'handoff_rules',
            null,
            before.handoffRules ?? null,
            handoffRules,
            versionSource(actor),
          );
        audit(ctx.db, {
          userId: actor.userId,
          ip: actor.ip,
          action: 'ai.member_update',
          meta: {
            agentId: agent.id,
            enabled: body.enabled,
            role: 'sales',
            preset: body.preset ?? agent.preset,
            presetChanged: body.preset !== undefined && body.preset !== agent.preset,
            instructionsChanged: body.instructions !== before.instructions,
            handoffRulesChanged: handoffRules !== before.handoffRules,
            ...(body.resolutionCheck !== undefined && body.resolutionCheck !== agent.resolutionCheck
              ? { resolutionCheck: body.resolutionCheck }
              : {}),
            ...mcpAudit(actor),
          },
        });
      })();
      if (!body.enabled) {
        ctx.bus.emit('user:disabled', agent.userId);
        releaseAgent(agent.id);
      } else refreshPending();
      return service.agentStatus(agent.id);
    },
    setResolutionCheck(agentId, enabled, actor) {
      const agent = agentById(ctx.db, agentId);
      if (!agent) throw agentHttpError('agent_not_found');
      if (enabled !== agent.resolutionCheck)
        ctx.db.transaction(() => {
          agentCall(() => updateAgentTexts(ctx.db, agent.id, { resolutionCheck: enabled }));
          audit(ctx.db, {
            userId: actor.userId,
            ip: actor.ip,
            action: 'ai.resolution_check_update',
            meta: { agentId: agent.id, enabled, ...mcpAudit(actor) },
          });
        })();
      return service.agentStatus(agent.id);
    },
    deleteAgent(agentId, actor) {
      const agent = agentById(ctx.db, agentId);
      if (!agent) throw agentHttpError('agent_not_found');
      // Lite edits its one agent; it never deletes it.
      if (maxAgents() <= 1) throw agentHttpError('last_agent');
      cancelAgent(agent.id);
      releaseAgent(agent.id);
      ctx.db.transaction(() => {
        agentCall(() => deleteAgentRow(ctx.db, agent.id));
        audit(ctx.db, {
          userId: actor.userId,
          ip: actor.ip,
          action: 'ai.agent_delete',
          meta: { agentId: agent.id, inboxId: agent.inboxId, ...mcpAudit(actor) },
        });
      })();
      ctx.bus.emit('user:disabled', agent.userId);
    },
    setAgentInbox(agentId, inboxId, actor) {
      const agent = agentById(ctx.db, agentId);
      if (!agent) throw agentHttpError('agent_not_found');
      if (oneInbox() && inboxId !== 1)
        throw errors.validation('The AI agent always answers the only inbox');
      if (inboxId !== null) requireInbox(inboxId);
      if (inboxId === agent.inboxId) return service.agentStatus(agent.id);
      if (directSlotTaken(ctx, inboxId, agent.id)) throw directAgentTaken();
      cancelAgent(agent.id);
      ctx.db.transaction(() => {
        agentCall(() => setAgentInbox(ctx.db, agent.id, inboxId));
        audit(ctx.db, {
          userId: actor.userId,
          ip: actor.ip,
          action: 'ai.agent_inbox_update',
          meta: { agentId: agent.id, from: agent.inboxId, to: inboxId, ...mcpAudit(actor) },
        });
      })();
      // Its chats of the old inbox would wait on an AI that no longer answers them.
      releaseAgent(agent.id);
      return service.agentStatus(agent.id);
    },
    ensureDefaultAgent(body, actor) {
      const existing = agentForInbox(ctx.db, 1);
      if (existing) return service.agentStatus(existing.id);
      return service.createAgent({ ...body, inboxId: 1 }, actor);
    },
    saveMember(body, actor) {
      const existing = defaultAgent(ctx.db);
      // Refuse before creating anything (same checks as before agents existed).
      checkEnable(existing?.id ?? null, body.enabled);
      const agent =
        existing ??
        insertAgent(
          {
            displayName: body.displayName,
            enabled: false,
            preset: 'sales',
            inboxId: 1,
            instructions: null,
            handoffRules: null,
          },
          actor,
        );
      service.saveAgent(agent.id, body, actor);
      return service.status();
    },
    saveConnection(body, actor) {
      body = parse(AiConnectionBody, body);
      if (body.mode === 'chatgpt' && body.model) {
        const known: readonly string[] = provider.knownModels?.() ?? CHATGPT_FALLBACK_MODELS;
        if (!known.includes(body.model))
          throw errors.validation(
            `ChatGPT mode supports ${known.join(', ')}. Choose Auto to use the default.`,
          );
      }
      cancelAll();
      ctx.db.transaction(() => {
        ctx.settings.set(PROVIDER_KEY, { mode: body.mode, model: body.model });
        // Each API-key mode keeps its own key; the other mode's key stays saved.
        if (body.apiKey) ctx.settings.setSecret(secretKeyFor(body.mode) ?? SECRET_KEY, body.apiKey);
        audit(ctx.db, {
          ...actor,
          action: 'ai.connection_update',
          meta: { mode: body.mode, model: body.model },
        });
      })();
      ctx.bus.emit('ai:connection-changed');
      // A changed connection does not continue an old provider's conversations silently.
      releaseOwned();
      refreshPending();
      return service.status();
    },
    addDocument(agentId, name, size, text, actor, internal = false) {
      const agent = contextAgent(agentId);
      ctx.db.transaction(() => {
        checkLimits(agent.id, text, null, internal);
        const now = Date.now();
        const result = ctx.db
          .prepare(
            "INSERT INTO ai_documents(agent_id, name, kind, size, text, internal, created_at, updated_at) VALUES (?, ?, 'file', ?, ?, ?, ?, ?)",
          )
          .run(agent.id, name, size, text, internal ? 1 : 0, now, now);
        audit(ctx.db, {
          ...actor,
          action: 'ai.document_add',
          meta: {
            agentId: agent.id,
            documentId: Number(result.lastInsertRowid),
            kind: 'file',
            size,
            internal,
          },
        });
      })();
      cancelAgent(agent.id);
      refreshPending();
      return service.agentStatus(agent.id);
    },
    addText(agentId, body, actor) {
      const { name, text, internal = false } = parse(AiContextTextBody, body);
      const agent = contextAgent(agentId);
      const size = Buffer.byteLength(text);
      ctx.db.transaction(() => {
        checkLimits(agent.id, text, null, internal);
        const now = Date.now();
        const result = ctx.db
          .prepare(
            "INSERT INTO ai_documents(agent_id, name, kind, size, text, internal, created_at, updated_at) VALUES (?, ?, 'text', ?, ?, ?, ?, ?)",
          )
          .run(agent.id, name, size, text, internal ? 1 : 0, now, now);
        const documentId = Number(result.lastInsertRowid);
        recordSetupVersion(
          ctx.db,
          agent.id,
          'context_text',
          documentId,
          null,
          text,
          versionSource(actor),
          now,
        );
        audit(ctx.db, {
          userId: actor.userId,
          ip: actor.ip,
          action: 'ai.document_add',
          meta: { agentId: agent.id, documentId, kind: 'text', size, internal, ...mcpAudit(actor) },
        });
      })();
      cancelAgent(agent.id);
      refreshPending();
      return service.agentStatus(agent.id);
    },
    updateText(agentId, id, body, actor) {
      const agent = agentOrDefault(agentId);
      if (!agent) throw errors.notFound('Document');
      ctx.db.transaction(() => {
        const row = ctx.db
          .prepare(
            'SELECT kind, name, text, internal FROM ai_documents WHERE id = ? AND agent_id = ?',
          )
          .get(id, agent.id) as
          { kind: 'file' | 'text'; name: string; text: string; internal: number } | undefined;
        if (!row) throw errors.notFound('Document');
        // A file item may only be flagged Internal (or not); its text is read-only.
        if (row.kind !== 'text' && (body.name !== undefined || body.text !== undefined))
          throw errors.validation('Only text content can be edited. Upload a new file instead.');
        const name = body.name ?? row.name;
        const text = body.text ?? row.text;
        const internal = body.internal ?? row.internal === 1;
        const checkInternal = internal && (body.text !== undefined || row.internal !== 1);
        if (body.text !== undefined || checkInternal)
          checkLimits(agent.id, text, id, checkInternal, body.text !== undefined);
        // A file keeps its uploaded size; a text item's size is its text.
        const size = row.kind === 'text' ? Buffer.byteLength(text) : null;
        ctx.db
          .prepare(
            'UPDATE ai_documents SET name = ?, text = ?, size = coalesce(?, size), internal = ?, updated_at = ? WHERE id = ? AND agent_id = ?',
          )
          .run(name, text, size, internal ? 1 : 0, Date.now(), id, agent.id);
        if (text !== row.text)
          recordSetupVersion(
            ctx.db,
            agent.id,
            'context_text',
            id,
            row.text,
            text,
            versionSource(actor),
          );
        audit(ctx.db, {
          userId: actor.userId,
          ip: actor.ip,
          action: 'ai.document_update',
          meta: {
            agentId: agent.id,
            documentId: id,
            size,
            renamed: body.name !== undefined,
            edited: body.text !== undefined,
            internal,
            ...mcpAudit(actor),
          },
        });
      })();
      cancelAgent(agent.id);
      refreshPending();
      return service.agentStatus(agent.id);
    },
    document(agentId, id) {
      const agent = agentOrDefault(agentId);
      const row = (
        agent
          ? ctx.db
              .prepare(
                `SELECT id, name, kind, size, length(text) AS characters, created_at AS createdAt,
                updated_at AS updatedAt, internal, text FROM ai_documents WHERE id = ? AND agent_id = ?`,
              )
              .get(id, agent.id)
          : undefined
      ) as (Omit<AiDocumentView, 'truncated' | 'internal'> & { internal: number }) | undefined;
      if (!row) throw errors.notFound('Document');
      // Text items are edited in full; a file shows a read-only preview of its extracted text.
      const truncated = row.kind === 'file' && row.characters > AI_CONTEXT_PREVIEW_CHARACTERS;
      return {
        ...row,
        internal: row.internal === 1,
        text: truncated ? sliceCodePoints(row.text, AI_CONTEXT_PREVIEW_CHARACTERS) : row.text,
        truncated,
      };
    },
    removeDocument(agentId, id, actor) {
      const agent = agentOrDefault(agentId);
      if (!agent) throw errors.notFound('Document');
      ctx.db.transaction(() => {
        const row = ctx.db
          .prepare('SELECT internal FROM ai_documents WHERE id = ? AND agent_id = ?')
          .get(id, agent.id) as { internal: number } | undefined;
        if (!row) throw errors.notFound('Document');
        ctx.db.prepare('DELETE FROM ai_documents WHERE id = ? AND agent_id = ?').run(id, agent.id);
        audit(ctx.db, {
          ...actor,
          action: 'ai.document_remove',
          meta: { agentId: agent.id, documentId: id, internal: row.internal === 1 },
        });
      })();
      cancelAgent(agent.id);
      refreshPending();
      return service.agentStatus(agent.id);
    },
    agentForChat: (jid) => agentOfChat(jid),
    releaseAgent,
    releaseDirect,
    cancelAgent,
    async login() {
      await provider.login();
    },
    async completeSignIn(url) {
      if (!provider.submitCallbackUrl)
        throw errors.validation('Pasting a sign-in address is not supported');
      try {
        await provider.submitCallbackUrl(url);
      } catch (error) {
        // Only known OAuth / sign-in messages (fixed, credential-free) reach the admin.
        throw errors.validation(
          error instanceof OAuthError ? error.message : 'ChatGPT sign-in failed. Try again.',
        );
      }
    },
    async logout() {
      cancelAll();
      ctx.bus.emit('ai:connection-changed');
      await provider.logout();
      releaseOwned();
    },
    async models() {
      // Claude: the fixed list (no network call).
      if (settings().mode === 'claude')
        return {
          models: CLAUDE_MODELS.map((id) => ({ id, label: CLAUDE_MODEL_LABELS[id] })),
          source: 'fallback',
        };
      if (!provider.models) return { models: [], source: 'fallback' };
      return provider.models();
    },
    async testConnection() {
      const current = settings();
      if (current.mode !== 'chatgpt' || !provider.test)
        throw errors.validation('Connection test is available for ChatGPT sign-in only');
      return provider.test(current.model);
    },
    async tryAnswer(body) {
      // The named agent's saved items (else the default agent's), with the page's draft texts.
      const agent = agentOrDefault(body.agentId ?? null);
      const current = settingsFor(agent);
      if (!ready())
        return {
          ok: false,
          reply: null,
          action: null,
          model: null,
          error: 'Set up the AI connection in Settings → AI first.',
        };
      // The draft name and instructions, with the saved Business context items.
      const saved = contextItems(agent?.id ?? null);
      const items = splitKnowledge(saved);
      const internalTexts = saved.filter((item) => item.internal).map((item) => item.text);
      const knowledge = relevantKnowledge(items.business, body.question);
      // "Group question": answered as a tag in a WhatsApp group (group rules, look-ups only, the
      // group hand-over line). Nothing is sent.
      const group = body.group === true;
      const handoffText = group ? GROUP_HANDOVER_REPLY : HANDOFF_REPLY;
      // Same rule as live replies: with no relevant knowledge and no extension look-ups the AI hands
      // the chat to a human.
      if (!knowledge.trim() && !agentLookupsAvailable(ctx, 'sales', agent?.id))
        return {
          ok: true,
          reply: handoffText,
          action: 'handoff',
          handoffReason: 'missing_facts',
          model: null,
          error: null,
        };
      let model: string | null = null;
      // Extension look-ups run in Try it too (no chat); a failed one ends it with a hand-over.
      const lookupAbort = new AbortController();
      const signal = AbortSignal.any([AbortSignal.timeout(60_000), lookupAbort.signal]);
      let extension: Awaited<ReturnType<typeof agentTurnTools>> | null = null;
      const lookups = () => {
        const calls = extension?.calls() ?? [];
        return calls.length ? { lookups: calls } : {};
      };
      try {
        model =
          current.mode === 'api'
            ? current.model || OPENAI_DEFAULT_MODEL
            : current.mode === 'claude'
              ? claudeModelId(current)
              : ((await provider.resolveModel?.(current.model)) ?? current.model);
        extension = await agentTurnTools(
          ctx,
          log,
          { agent: 'sales', agentId: agent?.id, chatJid: null, signal },
          { onFailure: () => lookupAbort.abort(), lookupsOnly: group },
        );
        const decision = await provider.generate(
          { ...current, ...body.knowledge },
          aiApiKey(ctx.settings),
          // Draft rules when the page sends them, else the saved ones. Same knowledge tools as a
          // live reply, so Try it tests what customers get; no chat, so no chat history.
          {
            ...prompt(
              agent?.id ?? 0,
              {
                handoffRules: current.handoffRules,
                ...body.knowledge,
                preset: agent?.preset ?? 'sales',
                resolutionCheck: agent?.resolutionCheck ?? false,
              },
              items.internal,
              knowledge,
              group
                ? [{ speaker: 'customer', name: 'Member', text: body.question }]
                : [{ speaker: 'customer', text: body.question }],
              false,
              [],
              null,
              group
                ? {
                    name: 'WhatsApp group',
                    member: 'Member',
                    trigger: 'tag',
                    message: body.question,
                  }
                : undefined,
            ),
            tools: {
              ...chatTools({ knowledge: items.business }),
              ...extension.tools,
            },
            onTiming: (timing) =>
              log.info({ event: 'ai_turn', source: 'try', ...timing }, 'AI turn timing'),
          },
          signal,
        );
        // Same gate as live replies; Try it has never asked, so it can never resolve. In a group every
        // reply is an answer and a hand-over is the group line.
        const guarded = group
          ? groupTryDecision(decision)
          : guardResolution(decision, 0, body.question, body.question, {
              resolutionCheck: agent?.resolutionCheck ?? false,
            });
        // Same leak check as live replies: Try it shows the hand-over, never the quoted item.
        if (guarded.action !== 'no_reply' && findLeak(guarded.reply, internalTexts)) {
          log.warn({ event: 'ai_try_leak', agentId: agent?.id ?? null }, 'AI reply withheld');
          return {
            ok: true,
            reply: handoffText,
            action: 'handoff',
            handoffReason: 'confidential_leak',
            model,
            error: null,
            ...lookups(),
          };
        }
        return {
          ok: true,
          reply: guarded.reply,
          action: guarded.action,
          handoffReason: guarded.handoffReason ?? null,
          model,
          error: null,
          ...lookups(),
        };
      } catch (error) {
        if (extension?.failed())
          return {
            ok: true,
            reply: handoffText,
            action: 'handoff',
            handoffReason: 'lookup_failed',
            model,
            error: null,
            ...lookups(),
          };
        log.warn({ event: 'ai_try_failed' }, 'AI Try it answer failed');
        return {
          ok: false,
          reply: null,
          action: null,
          model,
          error: error instanceof Error ? error.message : 'The AI could not answer.',
          ...lookups(),
        };
      } finally {
        await extension?.dispose();
      }
    },
    async editText(body, signal, agentId = null) {
      const agent = agentOrDefault(agentId);
      if (!ready() || !provider.rewrite)
        return { ok: false, text: null, error: 'Connect the AI in Settings → AI first.' };
      const started = Date.now();
      let model: string | null = null;
      let result: AiEditResult;
      try {
        const suggestion = await provider.rewrite(
          settings(),
          aiApiKey(ctx.settings),
          {
            ...buildEditPrompt({
              field: body.field,
              current: body.current,
              request: body.request,
              businessKnowledge: relevantKnowledge(
                splitKnowledge(contextItems(agent?.id ?? null)).business,
                body.request,
              ),
              // A FAQ agent's texts are not pushed toward sales.
              preset: body.preset ?? agent?.preset ?? 'sales',
            }),
            cacheId: `${installId()}#agent:${agent?.id ?? 0}`,
          },
          signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
            : AbortSignal.timeout(60_000),
        );
        model = suggestion.model;
        const text = suggestion.text.trim();
        result = !text
          ? { ok: false, text: null, error: 'The AI returned an empty suggestion. Try again.' }
          : text.length > AI_EDIT_FIELD_CHARACTERS[body.field]
            ? {
                ok: false,
                text: null,
                error: 'The suggestion is too long for this box. Try a smaller change.',
              }
            : { ok: true, text, error: null };
      } catch (error) {
        result = {
          ok: false,
          text: null,
          error: error instanceof Error ? error.message : 'The AI could not suggest an edit.',
        };
      }
      // Never the request, the current text or the suggestion: they can hold business details.
      log.info(
        { event: 'ai_edit', field: body.field, ok: result.ok, ms: Date.now() - started, model },
        'AI edit',
      );
      return result;
    },
    suggestModelInfo() {
      const current = settings();
      return {
        model: replySuggestionsModel(ctx.settings),
        fastModel: fastModel(current),
        agentModel: agentModel(current),
        models: suggestModels(current),
        resolved: resolvedSuggestModel(current),
      };
    },
    isSuggestModel(model) {
      return (
        model === FAST_SUGGEST_MODEL ||
        model === AGENT_SUGGEST_MODEL ||
        suggestModels(settings()).includes(model)
      );
    },
    async buildPhrases(agentId, input, signal) {
      if (service.draftConnection() !== 'ready' || !gateOpen())
        throw new HttpError(503, 'ai_unavailable', 'The AI connection is not available now');
      const agent = agentById(ctx.db, agentId);
      if (!agent) throw agentHttpError('agent_not_found');
      const current = settingsFor(agent);
      const saved = contextItems(agent.id);
      const items = splitKnowledge(saved);
      const business = relevantKnowledge(items.business, '');
      const prompt = {
        ...buildPhrasePrompt({
          instructions: administratorInstructions({ ...current, preset: agent.preset }),
          businessKnowledge: business,
          teamReplies: input.teamReplies,
          existingPhrases: input.existing,
        }),
        cacheId: `${installId()}#agent:${agent.id}#phrases`,
      };
      const choice = draftChoice(current);
      const answer = await provider.draft!(
        choice.settings,
        aiApiKey(ctx.settings),
        prompt,
        { schema: PhraseOutput, fast: choice.fast, maxOutputTokens: 8_000 },
        AbortSignal.any([signal, AbortSignal.timeout(AI_PHRASE_BUILD_TIMEOUT_MS)]),
      );
      return {
        output: answer.output,
        model: answer.model,
        // Facts may come from the business context and the administrator instructions.
        business: [business, administratorInstructions({ ...current, preset: agent.preset })].join(
          '\n',
        ),
        internalTexts: saved.filter((item) => item.internal).map((item) => item.text),
      };
    },
    assistConnection() {
      if (!provider.assist) return 'none';
      const mode = aiProviderSettings(ctx.settings).mode;
      if (mode !== 'chatgpt') {
        if (!aiApiKey(ctx.settings)) return 'none';
        return closed || !gateOpen() ? 'unavailable' : 'ready';
      }
      const state = provider.connection().state;
      if (state === 'signed_out' || state === 'signing_in') return 'none';
      if (state === 'expired') return 'expired';
      return state === 'connected' && !closed && gateOpen() ? 'ready' : 'unavailable';
    },
    assist(call, signal) {
      if (!provider.assist)
        throw new HttpError(503, 'ai_unavailable', 'Ask Ezy is not available now');
      return provider.assist(
        settingsFor(null),
        aiApiKey(ctx.settings),
        { ...call, cacheId: `${installId()}#ask-ezy` },
        signal,
      );
    },
    draftConnection() {
      if (!provider.draft) return 'none';
      const mode = aiProviderSettings(ctx.settings).mode;
      if (mode !== 'chatgpt') {
        if (!aiApiKey(ctx.settings)) return 'none';
        return closed ? 'unavailable' : 'ready';
      }
      const state = provider.connection().state;
      if (state === 'signed_out' || state === 'signing_in') return 'none';
      return state === 'connected' && !closed ? 'ready' : 'unavailable';
    },
    draftReply: (async (
      jid: string,
      request: { kind: 'suggest' } | { kind: 'complete'; typed: string },
      signal: AbortSignal,
    ) => {
      if (!replySuggestionsEnabled(ctx.settings))
        throw new HttpError(409, 'ai_suggestions_off', 'Reply suggestions are off');
      if (service.draftConnection() !== 'ready' || !gateOpen())
        throw new HttpError(503, 'ai_unavailable', 'AI suggestions are not available now');
      const agent = agentOfChat(jid);
      const current = settingsFor(agent);
      const saved = agent ? contextItems(agent.id) : [];
      const items = splitKnowledge(saved);
      const internalTexts = saved.filter((item) => item.internal).map((item) => item.text);
      const history = messages.list(jid, { limit: 20 }).messages;
      // A group shows each member's name (never a number) and has no customer profile.
      const group = chats.get(jid)?.type === 'group';
      // A completion predicts the next words like a keyboard: only the last messages and the typed
      // text, never the knowledge (smaller and faster; its facts may only come from the chat).
      const completing = request.kind === 'complete';
      const allTurns = group
        ? groupConversation(history, aiUserIds())
        : conversation(history, aiUserIds());
      const turns = completing ? allTurns.slice(-AI_COMPLETION_TURNS) : allTurns;
      const business = completing
        ? ''
        : relevantKnowledge(
            items.business,
            history
              .filter((message) => !message.fromMe)
              .slice(-3)
              .map(customerText)
              .join('\n'),
          );
      const customer = group
        ? null
        : aiCustomer(ctx.services.customers?.profile(jid).profile ?? null);
      // No agent: no preset texts that nobody configured (only the conversation and the customer).
      const instructions = agent
        ? administratorInstructions({ ...current, preset: agent.preset })
        : '(none: follow the rules above)';
      // Facts a draft may state: what the model was shown, never the Internal items.
      const sources = [
        business,
        agent ? instructions : '',
        // A group draft may name the member it answers.
        ...turns.map((turn) => (turn.name ? `${turn.name}: ${turn.text}` : turn.text)),
        JSON.stringify(customer ?? {}),
      ].join('\n');
      const prompt = {
        ...buildDraftPrompt({
          kind: request.kind,
          instructions,
          handoffRules: agent ? current.handoffRules : '',
          internalKnowledge: completing ? '' : items.internal,
          businessKnowledge: business,
          conversation: turns,
          customer,
          group,
          now: new Date(),
          timeZone: resolveAiTimeZone(ctx.settings.get<unknown>(AI_TIMEZONE_SETTING, null)),
          ...(request.kind === 'complete' ? { typed: request.typed } : {}),
        }),
        cacheId: `${installId()}#agent:${agent?.id ?? 0}`,
      };
      const choice = draftChoice(current);
      const started = Date.now();
      let model: string | null = null;
      let count = 0;
      let ok = false;
      /** The failure's class name and HTTP status (never its message: it can echo the prompt). */
      let cause: { causeName: string | null; status: number | null } | null = null;
      /** Completions only: why no grey text showed, and whether the 3 s limit cut the call. */
      let dropped: CompletionDrop | null = null;
      let timedOut = false;
      const noteFailure = (error: unknown) => {
        const status = (error as { statusCode?: unknown; status?: unknown } | null) ?? {};
        const code = status.statusCode ?? status.status;
        cause = { causeName: errorNameOf(error), status: typeof code === 'number' ? code : null };
      };
      try {
        if (request.kind === 'suggest') {
          try {
            const answer = await provider.draft!(
              choice.settings,
              aiApiKey(ctx.settings),
              prompt,
              { schema: DraftOutput, fast: choice.fast, maxOutputTokens: 2_000 },
              AbortSignal.any([signal, AbortSignal.timeout(AI_SUGGESTION_TIMEOUT_MS)]),
            );
            model = answer.model;
            const result = acceptDrafts(answer.output, sources, internalTexts, business);
            count = result.suggestions.length;
            ok = true;
            return result;
          } catch (error) {
            noteFailure(error);
            if (signal.aborted) throw error;
            throw new HttpError(
              503,
              'ai_unavailable',
              'The AI could not suggest a reply. Try again.',
            );
          }
        }
        // Completions: bounded by a timer (dropped after 3 s) and the client's own cancel.
        const bound = new AbortController();
        const timer = setTimeout(() => bound.abort(), AI_COMPLETION_TIMEOUT_MS);
        try {
          const answer = await provider.draft!(
            choice.settings,
            aiApiKey(ctx.settings),
            prompt,
            { schema: CompletionOutput, fast: choice.fast, maxOutputTokens: 300 },
            AbortSignal.any([signal, bound.signal]),
          );
          model = answer.model;
          const checked = checkCompletion(
            answer.output,
            request.typed,
            sources,
            internalTexts,
            business,
          );
          count = checked.completion ? 1 : 0;
          dropped = checked.dropped;
          ok = true;
          return { completion: checked.completion };
        } catch (error) {
          noteFailure(error);
          // Both cancels are an AbortError: tell the 3 s limit apart from the app's own cancel.
          timedOut = bound.signal.aborted && !signal.aborted;
          return { completion: null };
        } finally {
          clearTimeout(timer);
        }
      } finally {
        // Never the typed text, the drafts, the conversation or the customer.
        log.info(
          {
            event: 'ai_draft',
            kind: request.kind,
            ok,
            ms: Date.now() - started,
            model,
            count,
            ...(cause ?? {}),
            ...(dropped ? { dropped } : {}),
            ...(timedOut ? { timedOut } : {}),
          },
          'AI draft',
        );
      }
    }) as AiService['draftReply'],
    async fixGrammar(jid, text, signal) {
      if (!fixEnglishEnabled(ctx.settings))
        throw new HttpError(409, 'fix_english_off', 'Fix English is off');
      if (service.draftConnection() !== 'ready' || !gateOpen())
        throw new HttpError(503, 'ai_unavailable', 'The grammar check is not available now');
      if ((text.match(/\p{L}+/gu) ?? []).length < 2)
        return { status: 'skipped', reason: 'too_short' };
      if (notEnglish(text)) return { status: 'skipped', reason: 'not_english' };
      const choice = draftChoice(settingsFor(agentOfChat(jid)));
      const started = Date.now();
      let model: string | null = null;
      let count = 0;
      let ok = false;
      let cause: { causeName: string | null; status: number | null } | null = null;
      try {
        const answer = await provider.draft!(
          choice.settings,
          aiApiKey(ctx.settings),
          {
            instructions: FIX_GRAMMAR_RULES,
            input: JSON.stringify({ text }),
            cacheId: `${installId()}#fix-english`,
          },
          { schema: FixGrammarOutput, fast: choice.fast, maxOutputTokens: 3_000 },
          AbortSignal.any([signal, AbortSignal.timeout(FIX_GRAMMAR_TIMEOUT_MS)]),
        );
        model = answer.model;
        const issues = grammarIssues(text, answer.output.corrected);
        count = issues.length;
        ok = true;
        return { status: 'checked', issues };
      } catch (error) {
        const failure = (error as { statusCode?: unknown; status?: unknown } | null) ?? {};
        const code = failure.statusCode ?? failure.status;
        cause = { causeName: errorNameOf(error), status: typeof code === 'number' ? code : null };
        if (signal.aborted) throw error;
        throw new HttpError(503, 'ai_unavailable', 'The grammar check did not answer. Try again.');
      } finally {
        // Never the text or the corrections: counts and timing only.
        log.info(
          { event: 'fix_grammar', ok, ms: Date.now() - started, model, count, ...cause },
          'Fix English grammar check',
        );
      }
    },
    async checkSafety(chatJid, input, signal) {
      if (service.draftConnection() !== 'ready' || !gateOpen()) return null;
      const current = settingsFor(agentOfChat(chatJid));
      const started = Date.now();
      let model: string | null = null;
      let answer: SafetyAiAnswer | null = null;
      let cause: { causeName: string | null; status: number | null } | null = null;
      try {
        const result = await provider.draft!(
          current,
          aiApiKey(ctx.settings),
          { instructions: SAFETY_CHECK_RULES, input, cacheId: `${installId()}#safety` },
          { schema: SafetyAiOutput, fast: true, maxOutputTokens: 600 },
          AbortSignal.any([signal, AbortSignal.timeout(SAFETY_CHECK_TIMEOUT_MS)]),
        );
        model = result.model;
        answer = {
          level: result.output.level,
          category: result.output.category,
          reason: result.output.level === 'none' ? '' : result.output.reason.trim().slice(0, 200),
        };
        return answer;
      } catch (error) {
        const failure = (error as { statusCode?: unknown; status?: unknown } | null) ?? {};
        const code = failure.statusCode ?? failure.status;
        cause = { causeName: errorNameOf(error), status: typeof code === 'number' ? code : null };
        return null;
      } finally {
        // Never the message, the file name or the reason: the verdict and timing only.
        log.info(
          {
            event: 'safety_check',
            ok: answer !== null,
            level: answer?.level ?? null,
            category: answer?.category ?? null,
            ms: Date.now() - started,
            model,
            ...cause,
          },
          'WhatsApp Safety AI check',
        );
      }
    },
    async scheduledTurn({ agentId, chatJid, task, preview }, outer) {
      const agent = agentById(ctx.db, agentId);
      if (!agent) return { outcome: 'skip', text: null, reason: 'agent_off', lookups: [] };
      if (!ready()) return { outcome: 'skip', text: null, reason: 'ai_disconnected', lookups: [] };
      const chat = chats.get(chatJid);
      if (!chat) return { outcome: 'skip', text: null, reason: 'chat_gone', lookups: [] };
      const group = chat.type === 'group';
      const current = settingsFor(agent);
      const saved = contextItems(agent.id);
      const items = splitKnowledge(saved);
      const internalTexts = saved.filter((item) => item.internal).map((item) => item.text);
      const knowledge = relevantKnowledge(items.business, `${task.name}\n${task.instruction}`);
      const history = messages
        .list(chatJid, { limit: AI_SCHEDULED_CONTEXT_MESSAGES })
        .messages.filter((message) => message.deletedAt == null);
      const lookupAbort = new AbortController();
      const signal = AbortSignal.any([
        outer,
        lookupAbort.signal,
        AbortSignal.timeout(AI_SCHEDULED_TURN_TIMEOUT_MS),
      ]);
      const started = Date.now();
      const toolCalls: string[] = [];
      let extension: Awaited<ReturnType<typeof agentTurnTools>> | null = null;
      let decision: AiDecision;
      let lookups: AgentToolInfo[];
      try {
        extension = await agentTurnTools(
          ctx,
          log,
          // A preview names no chat: tools that change data are not run (as in Try it).
          { agent: 'sales', agentId: agent.id, chatJid: preview ? null : chatJid, signal },
          {
            onFailure: () => lookupAbort.abort(),
            onCall: (name) => toolCalls.push(name),
            lookupsOnly: true,
            // Nobody wrote: a sheet row holds the automatic columns (and AI values where allowed).
            record: {
              personJids: group ? [] : null,
              messageIds: [],
              filesGiven: false,
              fileNames: [],
            },
          },
        );
        // No file came in: nothing to save to Drive.
        const tools: Record<string, unknown> = { ...extension.tools };
        delete tools[SAVE_FILE_TO_DRIVE];
        decision = AiDecision.parse(
          await provider.generate(
            current,
            aiApiKey(ctx.settings),
            {
              ...prompt(
                agent.id,
                { ...current, preset: agent.preset },
                items.internal,
                knowledge,
                group
                  ? groupConversation(history, aiUserIds())
                  : conversation(history, aiUserIds()),
                false,
                [],
                group ? null : aiCustomer(ctx.services.customers?.profile(chatJid).profile ?? null),
                undefined,
                undefined,
                {
                  name: task.name,
                  instruction: task.instruction,
                  chat: {
                    name: chat.name?.trim() || (group ? 'WhatsApp group' : 'Customer'),
                    type: group ? 'group' : 'dm',
                  },
                },
              ),
              tools: {
                ...chatTools({ knowledge: items.business, onCall: (name) => toolCalls.push(name) }),
                ...(tools as typeof extension.tools),
              },
              onTiming: (timing) =>
                log.info({ event: 'ai_turn', source: 'scheduled', ...timing }, 'AI turn timing'),
            },
            signal,
          ),
        );
      } catch (error) {
        const failed = extension?.failed() ?? false;
        const turnFailure = error instanceof AgentTurnFailure ? error : null;
        log.warn(
          {
            event: 'scheduled_turn_failed',
            agentId: agent.id,
            reason: failed ? 'lookup_failed' : 'ai_unavailable',
            kind: turnFailure?.kind ?? 'other',
            errName: turnFailure?.causeName ?? errorNameOf(error),
            status: turnFailure?.status ?? null,
            ms: Date.now() - started,
          },
          'AI scheduled turn failed',
        );
        if (outer.aborted) throw error;
        return {
          outcome: 'fail',
          text: null,
          reason: failed ? 'lookup_failed' : 'ai_unavailable',
          lookups: [],
        };
      } finally {
        lookups = preview
          ? (extension?.calls() ?? []).map((call) => ({
              title: call.title,
              sourceLabel: call.sourceLabel,
            }))
          : (extension?.used() ?? []);
        await extension?.dispose();
      }
      const reply = decision.reply.trim();
      let result: ScheduledTurnResult;
      if (decision.action === 'handoff')
        result = { outcome: 'skip', text: null, reason: 'needs_team', lookups };
      else if (decision.action === 'no_reply' || !reply)
        result = { outcome: 'skip', text: null, reason: 'nothing_to_say', lookups };
      else if (findLeak(reply, internalTexts))
        result = { outcome: 'skip', text: null, reason: 'confidential_leak', lookups };
      else result = { outcome: 'send', text: reply, reason: null, lookups };
      // Ids, counts and names of tools only: never the instruction or the message.
      log.info(
        {
          event: 'scheduled_turn',
          agentId: agent.id,
          preview,
          group,
          action: decision.action,
          outcome: result.outcome,
          reason: result.reason,
          toolCalls,
          model: current.model ?? null,
          ms: Date.now() - started,
        },
        'AI scheduled turn',
      );
      return result;
    },
    canSend(jid, userId, quotedId) {
      // A group answer goes out only while its turn sends it, quoting the member's message.
      if (chats.get(jid)?.type === 'group')
        return (
          !!quotedId && groupSends.has(`${jid}\n${quotedId}`) && groupAgent(jid)?.userId === userId
        );
      return (
        eligible(jid) &&
        agentForChat(ctx, jid)?.userId === userId &&
        chats.get(jid)?.assignedTo === userId &&
        !!quotedId &&
        state(jid)?.last_customer_message_id === quotedId
      );
    },
    stopGroupTurns,
    async shutdown() {
      closed = true;
      ctx.bus.emit('ai:connection-changed');
      clearInterval(drainTimer);
      cancelAll();
      ctx.bus
        .off('access:closed', onAccessClosed)
        .off('access:opened', onAccessOpened)
        .off('message:received', onReceived)
        .off('message:new', onMessage)
        .off('chat:updated', onChat)
        .off('chat:event', onChatEvent)
        .off('user:disabled', onDisabled);
      await provider.shutdown();
      await Promise.allSettled([...running]);
    },
  };
  migrateLegacyContext();
  // Permanent start-up step: the old member texts become agent 1 (once, see ai/agents.ts).
  migrateMemberSetting(ctx.db, ctx.settings);
  // Permanent start-up step: a switched-on group with no agent gets its inbox's only agent.
  backfillGroupAgents(ctx.db);
  // Restore only explicitly recorded live inbound work; imported WhatsApp history never creates state.
  const pending = ctx.db
    .prepare(
      'SELECT chat_jid AS jid, due_at AS dueAt FROM ai_chat_state WHERE paused = 0 AND due_at IS NOT NULL',
    )
    .all() as Array<{ jid: string; dueAt: number }>;
  for (const item of pending)
    if (Date.now() - item.dueAt < 10 * 60_000)
      schedule(item.jid, Math.max(Date.now() + 1000, item.dueAt));
  return service;
}

export function initAi(ctx: AppContext) {
  ctx.services.ai = createAiService(ctx);
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WaAdapter } from '@ezychat/wa';
import type { AppContext } from './context.js';
import type { InboxRow } from './inboxes/repo.js';
import type { AgentKind, AgentToolsInput, AgentToolsResult } from './ai/agent/extension-tools.js';

/** Lowercase id used for the route prefix (/api/ext/<name>) and the migration track. */
export const EXTENSION_NAME = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED = new Set(['lite', 'core']);

/**
 * A feature added by another product build (e.g. EzyChat Enterprise) without changing core code.
 * Lite itself passes no extensions.
 */
/**
 * An inbox connection type an extension adds next to the core's `linked_phone` (e.g. `wa-cloud`,
 * the WhatsApp Business API). The extension keeps the type's own settings (credentials) per inbox
 * id and creates or switches inboxes of its type through `InboxService.create`/`changeType`.
 */
export interface InboxTypeDefinition {
  /** Stored in `inboxes.type`; `[a-z][a-z0-9_-]{1,31}`, never `linked_phone`. */
  id: string;
  /** The adapter of one inbox of this type (not connected yet; the core connects it). */
  createAdapter(ctx: AppContext, row: InboxRow): Promise<WaAdapter>;
  /**
   * The inbox stops using this type (removed, or switched to another type) after its adapter was
   * disconnected: drop what the type keeps for it (a webhook registration, stored secrets).
   */
  detach?(ctx: AppContext, inboxId: number): Promise<void>;
}

/**
 * Routes a third party calls with no session and no browser Origin (a webhook), mounted at
 * `/api/ext/<name>/public`. `verify` runs before the handler (raw body available as `rawBody`)
 * and must reject anything it cannot authenticate (e.g. an HMAC signature); the Host allowlist and
 * the access gate still apply.
 */
export interface PublicRoutes {
  verify(request: FastifyRequest & { rawBody?: Buffer }): boolean | Promise<boolean>;
  routes(api: FastifyInstance, ctx: AppContext): Promise<void>;
}

export interface ServerExtension {
  name: string;
  /** Folder of NNN_*.sql files, applied once each and tracked in extension_migrations. */
  migrationsDir?: string;
  /** Runs after every core initializer, in list order. */
  init?(ctx: AppContext): void | Promise<void>;
  /** Mounted at /api/ext/<name> after core routes; add requireUser/requireAdmin yourself. */
  routes?(api: FastifyInstance, ctx: AppContext): Promise<void>;
  /** Unauthenticated, signature-checked routes at /api/ext/<name>/public (webhooks). */
  publicRoutes?: PublicRoutes;
  /** Inbox connection types this extension adds (first extension wins a duplicate id). */
  inboxTypes?: readonly InboxTypeDefinition[];
  /**
   * Extra read tools for one AI turn (live reply or Try it), merged with the core tools within
   * the same step limit and abort/timeout. Return null to add none. A tool that throws (e.g.
   * `ToolHandoverError`) ends the turn with a hand-over (reason `lookup_failed`). `dispose` runs
   * when the turn ends. Calls are announced on the bus as `ai:tool_call` (no input or output).
   */
  agentTools?(ctx: AppContext, input: AgentToolsInput): Promise<AgentToolsResult | null>;
  /**
   * Cheap and synchronous (no network): true when `agentTools` would offer this agent at least one
   * look-up right now (`agentId`: which AI agent asks). The core then treats look-ups as a fact source and does not hand over (or
   * refuse to turn the agent on) only because the Business context is empty.
   */
  hasAgentLookups?(ctx: AppContext, input: { agent: AgentKind; agentId?: number }): boolean;
  /**
   * Who sends feedback (`POST /api/feedback`) to the licence portal: e.g. the licence's install id
   * and secret (`product: 'EZC-ENT'`). The first extension that returns non-null wins; its
   * `company` fills the dialog, and `portalOrigin` (https, or http to loopback) replaces the
   * portal address. Without one, Lite sends as `EZC-LITE` and other editions refuse to send (503
   * `feedback_unavailable`). Called only when the dialog opens or a report is sent; never logged.
   */
  feedbackAuth?(ctx: AppContext): Promise<FeedbackAuth | null>;
}

/** An edition's identity for the licence portal's feedback (see `ServerExtension.feedbackAuth`). */
export interface FeedbackAuth {
  product: string;
  installId: string;
  secret: string;
  company?: string;
  /** e.g. `https://license.anchorsprint.app`; default: the portal Lite uses. */
  portalOrigin?: string;
}

export function validateExtensions(list: readonly ServerExtension[]): void {
  const seen = new Set<string>();
  for (const ext of list) {
    if (!EXTENSION_NAME.test(ext.name) || RESERVED.has(ext.name))
      throw new Error(`invalid extension name ${JSON.stringify(ext.name)}`);
    if (seen.has(ext.name)) throw new Error(`duplicate extension "${ext.name}"`);
    seen.add(ext.name);
    for (const t of ext.inboxTypes ?? [])
      if (!/^[a-z][a-z0-9_-]{1,31}$/.test(t.id) || t.id === 'linked_phone')
        throw new Error(`invalid inbox type ${JSON.stringify(t.id)} in extension "${ext.name}"`);
  }
}

export function validateEdition(id: string): void {
  if (!EXTENSION_NAME.test(id)) throw new Error(`invalid edition ${JSON.stringify(id)}`);
}

// MCP client plumbing: one MCP SDK client (Streamable HTTP) per use, over the guarded fetch.
// Ported from Enterprise ent-connectors (packages/ent-connectors/src/mcp.ts and the result handling
// of service.ts), moved from the AI SDK MCP client to the MCP SDK client the core already ships.
// Errors are classified from what the guarded fetch saw (status, blocked, network), never from
// error messages (they can carry server text).
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError as RpcError } from '@modelcontextprotocol/sdk/types.js';
import { InteractiveSignInNeeded } from './oauth.js';
import { guardedFetch, NetProbe, REQUEST_TIMEOUT_MS, type NetPolicy } from './net.js';

export const MAX_TOOLS = 100;
/** Characters of a tool result handed to the model. */
export const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_TEXT = 1000;

export type McpFailure = 'url_private' | 'unauthorized' | 'unreachable';

export class McpError extends Error {
  constructor(
    readonly failure: McpFailure,
    /** What the failing client's requests saw (status, blocked, network). */
    readonly probe?: NetProbe,
  ) {
    super(failure);
    this.name = 'McpError';
  }
}

/** Why an MCP request failed, from what the transport's requests saw. */
export function classify(error: unknown, probe: NetProbe): McpFailure {
  if (error instanceof McpError) return error.failure;
  if (probe.blocked) return 'url_private';
  if (error instanceof InteractiveSignInNeeded) return 'unauthorized';
  if (probe.lastStatus === 401 || probe.lastStatus === 403) return 'unauthorized';
  if (error instanceof UnauthorizedError) return 'unauthorized';
  return 'unreachable';
}

/**
 * A JSON-RPC error answer (e.g. -32602 invalid params) that came back over a 2xx response: the
 * system is up and refused this one request. Not a transport failure.
 */
export function isRpcError(error: unknown, probe: NetProbe): boolean {
  if (!(error instanceof RpcError)) return false;
  if (probe.blocked || probe.networkError || probe.timedOut) return false;
  return probe.lastStatus !== null && probe.lastStatus >= 200 && probe.lastStatus < 300;
}

export interface OpenClient {
  client: Client;
  probe: NetProbe;
  close(): Promise<void>;
}

/** Connects and initializes (bounded by `signal` and 10 s). Throws McpError. */
export async function openClient(
  url: string,
  headers: Record<string, string>,
  policy: NetPolicy,
  signal?: AbortSignal,
): Promise<OpenClient> {
  const probe = new NetProbe();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const bound = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: guardedFetch(policy, probe),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: 'EzyChat', version: '1.0.0' }, { capabilities: {} });
  // Server-side errors outside a request carry server text: never log them.
  client.onerror = () => undefined;
  try {
    await client.connect(transport, { signal: bound, timeout: REQUEST_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new McpError(classify(error, probe), probe);
  }
  return { client, probe, close: () => client.close().catch(() => undefined) };
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; [k: string]: unknown };
}

/** Every tool the server offers (paginated, at most MAX_TOOLS). Throws McpError. */
export async function listToolDefinitions(
  open: OpenClient,
  signal?: AbortSignal,
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 10 && tools.length < MAX_TOOLS; page++) {
      const result = await open.client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: REQUEST_TIMEOUT_MS,
      });
      tools.push(...(result.tools as ToolDefinition[]));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
  } catch (error) {
    throw new McpError(classify(error, open.probe), open.probe);
  }
  return tools.slice(0, MAX_TOOLS);
}

const text = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Limits for the live input schema handed to the model (it is written by the remote system). */
export const SCHEMA_LIMITS = {
  /** Properties per object. */
  properties: 20,
  /** Nesting depth of objects and arrays. */
  depth: 4,
  /** Characters of each description or title. */
  text: 200,
  /** Values of an enum, and characters of each. */
  enumValues: 50,
  enumChars: 100,
  /** Serialised size of one tool's schema; a larger one leaves the tool out. */
  toolChars: 8_000,
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const SIMPLE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);

function boundedNode(raw: unknown, depth: number): Record<string, unknown> {
  const node =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const kept = types.filter((t): t is string => typeof t === 'string' && SIMPLE_TYPES.has(t));
  if (kept.length === 1) out.type = kept[0];
  else if (kept.length > 1) out.type = kept.slice(0, 4);
  const description =
    text(node.description, SCHEMA_LIMITS.text) || text(node.title, SCHEMA_LIMITS.text);
  if (description) out.description = description;
  if (Array.isArray(node.enum)) {
    const values = node.enum
      .filter((v) => ['string', 'number', 'boolean'].includes(typeof v) || v === null)
      .slice(0, SCHEMA_LIMITS.enumValues)
      .map((v) => (typeof v === 'string' ? v.slice(0, SCHEMA_LIMITS.enumChars) : v));
    if (values.length) out.enum = values;
  }
  if (depth >= SCHEMA_LIMITS.depth) return out;
  if (out.type === 'object' || node.properties) {
    out.type ??= 'object';
    const props = isRecord(node.properties)
      ? Object.entries(node.properties).slice(0, SCHEMA_LIMITS.properties)
      : [];
    // A free-form map (no fixed fields, `additionalProperties` true or a schema), e.g. a Notion
    // page's column name → value: keep it a map (no `properties`), so guards.ts cleanArgs keeps
    // its keys within MAP_LIMITS and checks each value against the value schema.
    const extra = node.additionalProperties;
    if (!props.length && (extra === true || isRecord(extra))) {
      out.additionalProperties = extra === true ? true : boundedNode(extra, depth + 1);
      return out;
    }
    out.properties = Object.fromEntries(
      props.map(([name, child]) => [name.slice(0, 64), boundedNode(child, depth + 1)]),
    );
    const names = new Set(Object.keys(out.properties as object));
    const required = Array.isArray(node.required)
      ? node.required.filter((r): r is string => typeof r === 'string' && names.has(r))
      : [];
    if (required.length) out.required = [...new Set(required)];
  }
  if (out.type === 'array' && node.items !== undefined && !Array.isArray(node.items))
    out.items = boundedNode(node.items, depth + 1);
  return out;
}

/**
 * A bounded copy of a tool's live input schema: only type, properties, required, items, enum,
 * a free-form map's additionalProperties and a short description per field, at most 20 fields per
 * object and 4 levels deep. Null when
 * even the bounded copy is too large (the tool is then left out of the turn).
 */
export function boundedInputSchema(schema: unknown): Record<string, unknown> | null {
  const root = boundedNode(schema, 0);
  const bounded = {
    type: 'object',
    properties: (root.properties as Record<string, unknown> | undefined) ?? {},
    ...(root.required ? { required: root.required } : {}),
    additionalProperties: false,
  };
  return JSON.stringify(bounded).length > SCHEMA_LIMITS.toolChars ? null : bounded;
}

/** A partner tool as cached at connect / test time (bounded; never the partner's text in full). */
export interface PartnerTool {
  name: string;
  /** Bounded input schema, or null when it was too large (the tool is then never offered). */
  inputSchema: Record<string, unknown> | null;
  readOnly: boolean;
}

export function partnerTool(def: ToolDefinition): PartnerTool {
  return {
    name: text(def.name, 128),
    inputSchema: boundedInputSchema(def.inputSchema),
    readOnly: def.annotations?.readOnlyHint === true,
  };
}

// ── results ───────────────────────────────────────────────────────────────────────────────────

export type CallOutcome =
  | { kind: 'ok'; text: string; structured: unknown }
  | { kind: 'nothing_found'; text: string }
  | { kind: 'failed' };

export function capText(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}… (cut: the result was too long)` : s;
}

function textOf(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((c: { type?: unknown; text?: unknown }) =>
      c?.type === 'text' && typeof c.text === 'string' ? c.text : '',
    )
    .filter(Boolean)
    .join('\n');
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  if (typeof v === 'string') return v.trim().length === 0;
  return false;
}

/**
 * What a tool result means: data, "nothing found" (an empty result or a not_found error, which the
 * model may tell the customer), or a failure (any other error result: the chat is handed over).
 */
export function interpretResult(result: unknown): CallOutcome {
  const r = (result ?? {}) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
    toolResult?: unknown;
  };
  if ('toolResult' in r) {
    if (isEmpty(r.toolResult)) return { kind: 'nothing_found', text: 'Nothing found.' };
    return {
      kind: 'ok',
      text: capText(JSON.stringify(r.toolResult) ?? ''),
      structured: r.toolResult,
    };
  }
  const body = textOf(r);
  if (r.isError) {
    let code: unknown;
    try {
      code = (JSON.parse(body) as { error?: unknown }).error;
    } catch {
      code = /not[ _-]?found/i.test(body) ? 'not_found' : undefined;
    }
    if (code === 'not_found')
      return { kind: 'nothing_found', text: capText(body || 'Nothing found.') };
    return { kind: 'failed' };
  }
  if (r.structuredContent !== undefined) {
    if (isEmpty(r.structuredContent)) return { kind: 'nothing_found', text: 'Nothing found.' };
    return {
      kind: 'ok',
      text: capText(JSON.stringify(r.structuredContent) ?? ''),
      structured: r.structuredContent,
    };
  }
  if (!body.trim()) return { kind: 'nothing_found', text: 'Nothing found.' };
  let structured: unknown;
  try {
    structured = JSON.parse(body);
  } catch {
    structured = undefined;
  }
  return { kind: 'ok', text: capText(body), structured };
}

/** String and number leaves of a result (for `valueFrom`), at most `max`, each ≤ 200 characters. */
export function leafValues(value: unknown, max = 500): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (out.size >= max || depth > 8) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s && s.length <= 200) out.add(s);
    } else if (typeof v === 'number' && Number.isFinite(v)) out.add(String(v));
    else if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
    else if (v && typeof v === 'object') for (const item of Object.values(v)) walk(item, depth + 1);
  };
  walk(value, 0);
  return [...out];
}

import type { ToolExecutionOptions, ToolSet } from 'ai';
import type { Logger } from 'pino';
import type { AiToolUsedPayload } from '@ezychat/shared';
import { AI_TOOL_LABEL_CHARACTERS } from '@ezychat/shared';
import type { AppContext } from '../../context.js';

/**
 * The kind of agent that may get extension tools. Every customer-facing AI agent passes `'sales'`
 * (whatever its preset); `agentId` says which agent it is.
 */
export type AgentKind = 'sales';

/** What an extension is told about the turn it adds tools to. */
export interface AgentToolsInput {
  agent: AgentKind;
  /** The AI agent of this turn (`ai_agents.id`); absent only before any agent exists (Try it). */
  agentId?: number;
  /** The chat being answered; null for Try it (POST /api/ai/try), which has no chat. */
  chatJid: string | null;
  /** Aborted when the turn is cancelled, times out or ends early (a failed look-up). */
  signal: AbortSignal;
}

/** Owner-facing labels of one tool: "AI looked up {{title}} · {{sourceLabel}}". */
export type AgentToolInfo = AiToolUsedPayload;

export interface AgentToolsResult {
  /** AI SDK tools for this one turn. Names must not repeat a core or another extension's tool. */
  tools: ToolSet;
  /** Labels per tool name. A tool without one is shown with its name and the extension name. */
  info?: Readonly<Record<string, AgentToolInfo>>;
  /** Called once when the turn ends (also after a failure or cancellation). */
  dispose?: () => Promise<void>;
}

/**
 * Throw from an extension tool to end the turn with a hand-over (reason `lookup_failed`). Any other
 * error thrown by an extension tool is treated the same; this one only names the intent.
 * Its message is never logged or shown to customers.
 */
export class ToolHandoverError extends Error {
  override name = 'ToolHandoverError';
}

/** Bus payload `ai:tool_call`: one finished extension tool call. Never its input or output. */
export interface AiToolCallEvent {
  agent: AgentKind;
  /** The AI agent that made the call. */
  agentId?: number;
  chatJid: string | null;
  /** Tool name as the model saw it. */
  tool: string;
  /** Name of the extension that provided the tool. */
  source: string;
  title?: string;
  ok: boolean;
  ms: number;
}

/** OpenAI-compatible function names. */
export const AGENT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Core tool names, reserved whether or not the core offers them in a given turn. */
export const CORE_AGENT_TOOL_NAMES: readonly string[] = [
  'search_business_context',
  'get_older_messages',
  // Google Calendar connector (connectors/google-calendar/tools.ts)
  'check_free_times',
  'book_appointment',
  // Google Sheets connector (connectors/google-sheets/tools.ts)
  'read_sheet_rows',
  'add_sheet_row',
  // Google Drive connector (connectors/google-drive/tools.ts)
  'save_file_to_drive',
  'list_drive_files',
  'read_drive_file',
  // Offered by older releases; stays reserved.
  'add_lead_row',
  // SQL Account connector (connectors/sql-account/tools.ts)
  'sql_check_stock',
  'sql_my_account',
  'sql_document_status',
  'sql_my_payments',
  'sql_quotation_preview',
  'sql_create_quotation',
  // GitHub connector (connectors/github/tools.ts)
  'github_search_issues',
  'github_list_issues',
  'github_read_issue',
  'github_search_pull_requests',
];
/** An extension that has not handed over its tools by then is left out of the turn. */
export const AGENT_TOOLS_SETUP_MS = 10_000;

/** One finished tool call (Try it shows them). `notRun`: Try it reported it without changing data. */
export type ExtensionToolCall = AgentToolInfo & {
  tool: string;
  source: string;
  ok: boolean;
  ms: number;
  notRun?: boolean;
};

export interface ExtensionToolsTurn {
  tools: ToolSet;
  /** True once an extension tool threw: the caller must hand over with `lookup_failed`. */
  failed(): boolean;
  /** Successful look-ups, first call of each title/source pair, in call order. */
  used(): AgentToolInfo[];
  /** Every finished call (Try it shows them). */
  calls(): ExtensionToolCall[];
  dispose(): Promise<void>;
}

const label = (text: unknown, fallback: string) => {
  const value = typeof text === 'string' ? text.trim() : '';
  return (value || fallback).slice(0, AI_TOOL_LABEL_CHARACTERS);
};

function errName(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name.slice(0, 60) : null;
}

/** Waits for one extension's tools, bounded by the turn signal and AGENT_TOOLS_SETUP_MS. */
async function setup(
  ctx: AppContext,
  name: string,
  provide: NonNullable<AppContext['extensions'][number]['agentTools']>,
  input: AgentToolsInput,
): Promise<AgentToolsResult | null> {
  const pending = Promise.resolve().then(() => provide(ctx, input));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bound = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), AGENT_TOOLS_SETUP_MS);
    timer.unref?.();
    onAbort = () => resolve('late');
    input.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([pending, bound]);
    if (result === 'late') {
      // Never leak what the extension opened for a turn that no longer waits for it.
      pending.then((late) => late?.dispose?.()).catch(() => {});
      if (!input.signal.aborted)
        ctx.log.warn(
          { mod: 'ai', event: 'ai_tools_setup_timeout', source: name },
          'Extension tools were not ready',
        );
      return null;
    }
    return result ?? null;
  } finally {
    clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * True when any extension says it would offer this agent a look-up now (`hasAgentLookups`). Cheap
 * and synchronous; an extension that throws counts as "no look-ups" and is logged by name only.
 */
export function extensionLookupsAvailable(
  ctx: AppContext,
  agent: AgentKind,
  agentId?: number,
): boolean {
  for (const ext of ctx.extensions) {
    if (!ext.hasAgentLookups) continue;
    try {
      if (ext.hasAgentLookups(ctx, agentId === undefined ? { agent } : { agent, agentId }))
        return true;
    } catch (error) {
      ctx.log.warn(
        { mod: 'ai', event: 'ai_lookups_check_failed', source: ext.name, err: errName(error) },
        'Extension look-up check failed',
      );
    }
  }
  return false;
}

/**
 * Collects every extension's tools for one AI agent turn and wraps each so that a call emits
 * `ai:tool_call` and logs (tool, source, ok, ms only), and a thrown error marks the turn failed
 * and calls `onFailure` (the caller aborts the turn and hands over).
 */
export async function extensionAgentTools(
  ctx: AppContext,
  log: Logger,
  input: AgentToolsInput,
  options: {
    /** Tool names already taken (the core's). */
    reserved?: readonly string[];
    onFailure: () => void;
    /** Each tool name the model uses, for the decision log. */
    onCall?: (name: string) => void;
  },
): Promise<ExtensionToolsTurn> {
  const tools: ToolSet = {};
  const taken = new Set([...CORE_AGENT_TOOL_NAMES, ...(options.reserved ?? [])]);
  const disposers: Array<() => Promise<void>> = [];
  const calls: ExtensionToolCall[] = [];
  let failed = false;
  for (const ext of ctx.extensions) {
    if (!ext.agentTools || input.signal.aborted) continue;
    let result: AgentToolsResult | null;
    try {
      result = await setup(ctx, ext.name, ext.agentTools.bind(ext), input);
    } catch (error) {
      log.warn(
        { event: 'ai_tools_setup_failed', source: ext.name, errName: errName(error) },
        'Extension tools unavailable',
      );
      continue;
    }
    if (!result) continue;
    if (result.dispose) disposers.push(result.dispose);
    for (const [name, original] of Object.entries(result.tools ?? {})) {
      const execute = original?.execute;
      const reason = !AGENT_TOOL_NAME.test(name)
        ? 'invalid_name'
        : taken.has(name)
          ? 'duplicate_name'
          : typeof execute !== 'function'
            ? 'no_execute'
            : null;
      if (reason || !execute) {
        log.warn(
          { event: 'ai_tool_rejected', source: ext.name, tool: name.slice(0, 80), reason },
          'Extension tool left out',
        );
        continue;
      }
      taken.add(name);
      const info = result.info?.[name];
      const title = label(info?.title, name);
      const sourceLabel = label(info?.sourceLabel, ext.name);
      tools[name] = {
        ...original,
        execute: async (args: unknown, callOptions: ToolExecutionOptions<unknown>) => {
          options.onCall?.(name);
          const started = Date.now();
          const finish = (ok: boolean) => {
            const ms = Date.now() - started;
            calls.push({ tool: name, source: ext.name, title, sourceLabel, ok, ms });
            log.info(
              { event: 'ai_tool_call', tool: name, source: ext.name, ok, ms },
              'AI tool call',
            );
            ctx.bus.emit('ai:tool_call', {
              agent: input.agent,
              ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
              chatJid: input.chatJid,
              tool: name,
              source: ext.name,
              title,
              ok,
              ms,
            });
          };
          try {
            const output: unknown = await (
              execute as (a: unknown, o: ToolExecutionOptions<unknown>) => unknown
            )(args, callOptions);
            finish(true);
            return output;
          } catch (error) {
            // A cancelled turn is not a failed look-up.
            if (input.signal.aborted) throw error;
            failed = true;
            finish(false);
            options.onFailure();
            throw error;
          }
        },
      } as ToolSet[string];
    }
  }
  return {
    tools,
    failed: () => failed,
    used: () => {
      const seen = new Set<string>();
      const used: AgentToolInfo[] = [];
      for (const call of calls) {
        const key = `${call.title}\u0000${call.sourceLabel}`;
        if (!call.ok || seen.has(key)) continue;
        seen.add(key);
        used.push({ title: call.title, sourceLabel: call.sourceLabel });
      }
      return used;
    },
    calls: () => [...calls],
    async dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          await dispose();
        } catch (error) {
          log.warn(
            { event: 'ai_tools_dispose_failed', errName: errName(error) },
            'Extension tools did not close',
          );
        }
      }
    },
  };
}

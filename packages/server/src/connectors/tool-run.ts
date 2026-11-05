import type { Logger } from 'pino';
import type { AgentToolsInput, ExtensionToolCall } from '../ai/agent/extension-tools.js';
import type { AppContext } from '../context.js';
import { GoogleError } from './google-calendar/google.js';

/**
 * One tool call of a core connector (Google Sheets, Google Drive): records the call for Try it and
 * the turn, logs tool/source/ok/ms only, emits `ai:tool_call`, and on a failure (not a cancelled
 * turn) logs the Google error kind, lets the connector record its Activity line, marks the turn
 * failed and calls `onFailure` (the caller hands over with `lookup_failed`). The error is thrown on.
 */
export function connectorToolRunner(
  ctx: AppContext,
  log: Logger,
  input: AgentToolsInput & { agentId: number },
  options: {
    source: string;
    sourceLabel: string;
    /** The connector's failure log event, e.g. `google_drive_tool_failed`. */
    failEvent: string;
    calls: ExtensionToolCall[];
    onCall?: (name: string) => void;
    onFailure: () => void;
    /** Marks the turn failed (the connector's `failed()`). */
    markFailed: () => void;
  },
) {
  return async <T>(
    name: string,
    title: string,
    body: () => Promise<{ output: T; notRun?: boolean }>,
    onError?: () => void,
  ): Promise<T> => {
    options.onCall?.(name);
    const started = Date.now();
    const finish = (ok: boolean, notRun?: boolean) => {
      const ms = Date.now() - started;
      options.calls.push({
        tool: name,
        source: options.source,
        title,
        sourceLabel: options.sourceLabel,
        ok,
        ms,
        ...(notRun ? { notRun } : {}),
      });
      log.info(
        { event: 'ai_tool_call', tool: name, source: options.source, ok, ms },
        'AI tool call',
      );
      ctx.bus.emit('ai:tool_call', {
        agent: input.agent,
        agentId: input.agentId,
        chatJid: input.chatJid,
        tool: name,
        source: options.source,
        title,
        ok,
        ms,
      });
    };
    try {
      const { output, notRun } = await body();
      finish(true, notRun);
      return output;
    } catch (error) {
      // A cancelled turn is not a failed call.
      if (input.signal.aborted) throw error;
      options.markFailed();
      log.warn(
        {
          event: options.failEvent,
          tool: name,
          kind: error instanceof GoogleError ? error.kind : 'other',
          status: error instanceof GoogleError ? error.status : null,
        },
        `${options.sourceLabel} tool failed`,
      );
      onError?.();
      finish(false);
      options.onFailure();
      throw error;
    }
  };
}

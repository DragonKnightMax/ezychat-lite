import type { Logger } from 'pino';
import type { AppContext } from '../../context.js';
import {
  BOOK_APPOINTMENT,
  calendarAgentTools,
  calendarLookupsAvailable,
} from '../../connectors/google-calendar/tools.js';
import type { SheetRecordContext } from '../../connectors/google-sheets/record.js';
import { driveAgentTools, driveLookupsAvailable } from '../../connectors/google-drive/tools.js';
import { sheetsAgentTools, sheetsLookupsAvailable } from '../../connectors/google-sheets/tools.js';
import {
  mcpConnectorAgentTools,
  mcpConnectorLookupsAvailable,
} from '../../connectors/mcp/tools.js';
import {
  extensionAgentTools,
  extensionLookupsAvailable,
  type AgentKind,
  type AgentToolsInput,
  type ExtensionToolsTurn,
} from './extension-tools.js';

/**
 * Every look-up source an agent may use besides its Business context: core connectors (Google
 * Calendar with Check free times on, Google Sheets with a tab on Read, Google Drive with picked files to
 * read) and extension look-ups (`hasAgentLookups`).
 */
export function agentLookupsAvailable(
  ctx: AppContext,
  agent: AgentKind,
  agentId?: number | null,
): boolean {
  return (
    calendarLookupsAvailable(ctx, agentId) ||
    sheetsLookupsAvailable(ctx, agentId) ||
    driveLookupsAvailable(ctx, agentId) ||
    mcpConnectorLookupsAvailable(ctx, agentId) ||
    extensionLookupsAvailable(ctx, agent, agentId ?? undefined)
  );
}

/**
 * The tools of one AI agent turn besides the core read tools: core connector tools first, then
 * every extension's. Failures of either end the turn (the caller hands over with `lookup_failed`).
 * `lookupsOnly` (a WhatsApp group answer): no calendar booking and no connector write tool; a sheet
 * row (`add_sheet_row`) and saving a member's file (`save_file_to_drive`) are the writes a group turn
 * keeps (both only for the batch's senders). Extension tools are look-ups by
 * contract (`hasAgentLookups`). `record` says whose values a sheet row may hold (none given: the
 * direct chat's customer and its newest message, no files).
 */
export async function agentTurnTools(
  ctx: AppContext,
  log: Logger,
  input: AgentToolsInput,
  options: {
    onFailure: () => void;
    onCall?: (name: string) => void;
    lookupsOnly?: boolean;
    record?: SheetRecordContext;
  },
): Promise<ExtensionToolsTurn> {
  const calendar = calendarAgentTools(ctx, log, input, options);
  if (options.lookupsOnly) delete calendar.tools[BOOK_APPOINTMENT];
  const sheets = await sheetsAgentTools(ctx, log, input, options);
  const drive = driveAgentTools(ctx, log, input, options);
  const listed = await mcpConnectorAgentTools(ctx, log, input, options);
  const extension = await extensionAgentTools(ctx, log, input, options);
  return {
    tools: {
      ...extension.tools,
      ...listed.tools,
      ...drive.tools,
      ...sheets.tools,
      ...calendar.tools,
    },
    failed: () =>
      calendar.failed() ||
      sheets.failed() ||
      drive.failed() ||
      listed.failed() ||
      extension.failed(),
    used: () => [
      ...calendar.used(),
      ...sheets.used(),
      ...drive.used(),
      ...listed.used(),
      ...extension.used(),
    ],
    calls: () => [
      ...calendar.calls(),
      ...sheets.calls(),
      ...drive.calls(),
      ...listed.calls(),
      ...extension.calls(),
    ],
    dispose: async () => {
      await calendar.dispose();
      await sheets.dispose();
      await drive.dispose();
      await listed.dispose();
      await extension.dispose();
    },
  };
}

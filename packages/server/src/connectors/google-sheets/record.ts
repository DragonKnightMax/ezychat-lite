import type { AppContext } from '../../context.js';
import { readSettings } from './repo.js';

/**
 * Who a sheet row is recorded for in one AI turn (design docs/features/group-agents/design.md).
 * `personJids` null = the customer of a direct chat; in a group, the senders of the batch. Values
 * the AI passes must appear in those people's messages unless `filesGiven` (a photo or PDF they
 * sent was given to the model).
 */
export interface SheetRecordContext {
  personJids: string[] | null;
  /** The batch's message ids (the newest last): the duplicate guard keys on them. */
  messageIds: string[];
  filesGiven: boolean;
  /** File names of the batch for the Source column. */
  fileNames: string[];
}

/** The agent has at least one tab on Add rows (it may get more images per turn). */
export function sheetsCanAddRows(ctx: AppContext, agentId: number | null | undefined): boolean {
  if (agentId === null || agentId === undefined || !ctx.services.googleSheets) return false;
  const settings = readSettings(ctx.db, agentId);
  return !!settings.spreadsheetId && settings.tabs.some((tab) => tab.access === 'add');
}

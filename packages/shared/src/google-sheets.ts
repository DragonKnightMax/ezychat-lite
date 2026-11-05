import { z } from 'zod';
import { GoogleCalendarState } from './connectors.js';

/**
 * Google Sheets connector (core; design docs/features/google-sheets/design.md). One Google account
 * per install, signed in separately from Google Calendar. Per AI agent: one spreadsheet, a tab the
 * AI may look things up in (prices, stock, a FAQ) and a tab it may add each new lead to.
 */

/** Same states as Google Calendar's sign-in. */
export const GoogleSheetsState = GoogleCalendarState;
export type GoogleSheetsState = z.infer<typeof GoogleSheetsState>;

/** `GET /api/connectors/google-sheets` (admins). Tokens are never sent to the browser. */
export const GoogleSheetsStatus = z.object({
  state: GoogleSheetsState,
  account: z.string().nullable(),
  connectedAt: z.number().int().nullable(),
  /** When it stopped working (expired/unavailable), else null. */
  problemSince: z.number().int().nullable(),
});
export type GoogleSheetsStatus = z.infer<typeof GoogleSheetsStatus>;

/** Google's spreadsheet ids: letters, digits, `-` and `_`. */
export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,120}$/;
export const SHEET_TAB_CHARACTERS = 100;

/**
 * The spreadsheet id in a Google Sheets link (`…/spreadsheets/d/<id>/edit…`) or a bare id; null when
 * the text holds neither.
 */
export function spreadsheetIdFromLink(text: string): string | null {
  const value = text.trim();
  if (SPREADSHEET_ID.test(value)) return value;
  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(value);
  return match && SPREADSHEET_ID.test(match[1]!) ? match[1]! : null;
}

/** Google Sheets' own page of a spreadsheet. */
export function googleSheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

/** `POST /api/connectors/google-sheets/spreadsheet` {link}: the sheet's name and its tabs. */
export const SpreadsheetLookupBody = z.object({ link: z.string().trim().min(1).max(500) });
export type SpreadsheetLookupBody = z.infer<typeof SpreadsheetLookupBody>;
export const SpreadsheetInfo = z.object({
  id: z.string(),
  name: z.string(),
  tabs: z.array(
    z.object({
      title: z.string(),
      rows: z.number().int().nonnegative(),
      /** The tab's first row (column names); empty when the first row is empty. */
      columns: z.array(z.string()).default([]),
    }),
  ),
  /** When EzyChat last read the tabs from Google. */
  checkedAt: z.number().int().nullable().default(null),
  url: z.string().url(),
});
export type SpreadsheetInfo = z.infer<typeof SpreadsheetInfo>;

/**
 * What one AI agent may do with one tab (design docs/features/group-agents/design.md): `off`, `read`
 * (look up rows) or `add` (add new rows). The agent's instructions say when; the tab's first row
 * names the columns.
 */
export const SheetTabAccess = z.enum(['off', 'read', 'add']);
export type SheetTabAccess = z.infer<typeof SheetTabAccess>;
export const SheetTabSetting = z.object({
  title: z.string().trim().min(1).max(SHEET_TAB_CHARACTERS),
  access: SheetTabAccess,
  /**
   * Add rows only: the AI may fill values it looked up (a Read tab) or worked out from the chat,
   * not only words the person wrote. Missing = off; the server keeps it only on Add rows.
   */
  aiValues: z.boolean().optional(),
  /**
   * Add rows only: values go in as if typed (`=…` becomes a formula, numbers and dates are parsed).
   * Formulas that reach outside the sheet, and formulas the person wrote, are never run.
   */
  formulas: z.boolean().optional(),
});
export type SheetTabSetting = z.infer<typeof SheetTabSetting>;
export const SHEETS_MAX_TABS = 50;

/**
 * Per AI agent: `GET`/`PUT /api/connectors/google-sheets/agents/:agentId` (admins). The server
 * checks the spreadsheet and the tabs with Google before it saves them. Older saves (`lookupTab`,
 * `leadsTab`) are mapped to `tabs` by the server when read.
 */
export const SheetsAgentSettings = z
  .object({
    /** The spreadsheet; null = not chosen yet. */
    spreadsheetId: z.string().regex(SPREADSHEET_ID).nullable(),
    /** Its name when it was chosen (the server fills it in). */
    spreadsheetName: z.string().max(200).nullable(),
    /** Access per tab; a tab that is not listed is off. */
    tabs: z.array(SheetTabSetting).max(SHEETS_MAX_TABS).default([]),
  })
  .refine((s) => new Set(s.tabs.map((t) => t.title)).size === s.tabs.length, {
    path: ['tabs'],
    message: 'a tab is listed twice',
  });
export type SheetsAgentSettings = z.infer<typeof SheetsAgentSettings>;

export const DEFAULT_SHEETS_SETTINGS: SheetsAgentSettings = {
  spreadsheetId: null,
  spreadsheetName: null,
  tabs: [],
};

/** A cell in A1 notation (columns A–Z, rows 2–1000; row 1 holds the column names): a layout formula. */
export const SHEET_CELL = /^[A-Z](?:[2-9]|[1-9]\d{1,2}|1000)$/;
export const SHEET_LAYOUT_TABS = 20;
export const SHEET_LAYOUT_COLUMNS = 26;
export const SHEET_LAYOUT_FORMULAS = 50;

/**
 * A new spreadsheet to create (docs/connector-design.md, Part E): its name and
 * tabs, each with its column names (the first row), the agent's access and optional formulas. Sent
 * by `POST /api/connectors/google-sheets/agents/:agentId/create` (admins) and carried by an AI
 * agent template (`AgentTemplateEntry.sheet`). Formulas pass the same outside-reach check as the
 * AI's.
 */
export const SheetLayoutTab = z.object({
  title: z.string().trim().min(1).max(SHEET_TAB_CHARACTERS),
  columns: z.array(z.string().trim().min(1).max(100)).min(1).max(SHEET_LAYOUT_COLUMNS),
  access: SheetTabAccess.default('off'),
  formulas: z
    .array(
      z.object({
        cell: z.string().regex(SHEET_CELL),
        formula: z.string().trim().startsWith('=').max(1000),
      }),
    )
    .max(SHEET_LAYOUT_FORMULAS)
    .optional(),
});
export type SheetLayoutTab = z.infer<typeof SheetLayoutTab>;
export const SheetLayout = z
  .object({
    name: z.string().trim().min(1).max(100),
    tabs: z.array(SheetLayoutTab).min(1).max(SHEET_LAYOUT_TABS),
  })
  .refine((l) => new Set(l.tabs.map((t) => t.title)).size === l.tabs.length, {
    path: ['tabs'],
    message: 'a tab is listed twice',
  });
export type SheetLayout = z.infer<typeof SheetLayout>;
export type SheetLayoutInput = z.input<typeof SheetLayout>;

/**
 * Columns EzyChat fills in itself when a tab has them (matched ignoring case and spacing): the
 * date, the person's name and WhatsApp number, the group's name, the source (file name or message)
 * and the agent's name. The AI fills every other column.
 */
export const SHEETS_AUTO_COLUMNS = [
  'Date',
  'Name',
  'WhatsApp',
  'Group',
  'AI agent',
  'Source',
] as const;

/** The columns of a lead row, in this order (written as the header of an empty tab). */
export const SHEETS_LEAD_COLUMNS = [
  'Date',
  'Name',
  'WhatsApp',
  'Email',
  'Request',
  'AI agent',
] as const;

/** One line of the connector's Activity tab: who and when, never chat text or row values. */
export const SheetsActivityKind = z.enum(['looked_up', 'lead_added', 'row_added', 'failed']);
export type SheetsActivityKind = z.infer<typeof SheetsActivityKind>;
export const SheetsActivity = z.object({
  id: z.number().int(),
  at: z.number().int(),
  kind: SheetsActivityKind,
  agentId: z.number().int().nullable(),
  agentName: z.string(),
  chatJid: z.string().nullable(),
  /** The customer's saved or WhatsApp name (shown to admins only). */
  customer: z.string(),
  /** row_added / looked_up: the tab (older lines: null). */
  tab: z.string().nullable().default(null),
  /** The chat's name when it is a group (older lines: null). */
  group: z.string().nullable().default(null),
});
export type SheetsActivity = z.infer<typeof SheetsActivity>;

/** `GET /api/connectors/google-sheets/activity` (admins): newest first, at most 50. */
export const SheetsActivityList = z.object({ activity: z.array(SheetsActivity) });
export type SheetsActivityList = z.infer<typeof SheetsActivityList>;

/**
 * `POST /api/connectors/google-sheets/picker` (admins): open `pickerUrl` in a new window. It is
 * Google's file picker on a page of this computer; only the spreadsheets picked there can be used.
 */
export const SheetsPickerStart = z.object({
  requestId: z.string(),
  pickerUrl: z.string().url(),
});
export type SheetsPickerStart = z.infer<typeof SheetsPickerStart>;

/** `GET /api/connectors/google-sheets/picker/:requestId`: the page polls until it is not pending. */
export const SheetsPickerProgress = z.object({
  status: z.enum(['pending', 'done', 'cancelled', 'failed', 'expired']),
  /** done: the picked spreadsheet, its name and tabs. */
  sheet: SpreadsheetInfo.nullable(),
});
export type SheetsPickerProgress = z.infer<typeof SheetsPickerProgress>;

/** The picker page's answer (`POST /api/connectors/google-sheets/picker-result`, this computer only). */
export const SheetsPickerResult = z.object({
  token: z.string().min(1).max(100),
  id: z.string().regex(SPREADSHEET_ID).optional(),
  cancelled: z.boolean().optional(),
});
export type SheetsPickerResult = z.infer<typeof SheetsPickerResult>;

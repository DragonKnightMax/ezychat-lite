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
  tabs: z.array(z.object({ title: z.string(), rows: z.number().int().nonnegative() })),
  url: z.string().url(),
});
export type SpreadsheetInfo = z.infer<typeof SpreadsheetInfo>;

const Tab = z.string().trim().min(1).max(SHEET_TAB_CHARACTERS).nullable();

/**
 * Per AI agent: `GET`/`PUT /api/connectors/google-sheets/agents/:agentId` (admins). The server
 * checks the spreadsheet and the tabs with Google before it saves them.
 */
export const SheetsAgentSettings = z
  .object({
    /** The spreadsheet; null = not chosen yet. */
    spreadsheetId: z.string().regex(SPREADSHEET_ID).nullable(),
    /** Its name when it was chosen (the server fills it in). */
    spreadsheetName: z.string().max(200).nullable(),
    /** The tab the AI reads (first row = column names). */
    lookupTab: Tab,
    /** The AI may look up rows that match the customer's question. */
    lookup: z.boolean(),
    /** The tab new leads go into. */
    leadsTab: Tab,
    /** The AI may add the customer as a new row (name, WhatsApp number, request). */
    addLeads: z.boolean(),
  })
  .refine((s) => !s.lookup || !s.spreadsheetId || !!s.lookupTab, {
    path: ['lookupTab'],
    message: 'choose the tab to look up',
  })
  .refine((s) => !s.addLeads || !s.spreadsheetId || !!s.leadsTab, {
    path: ['leadsTab'],
    message: 'choose the tab for new leads',
  });
export type SheetsAgentSettings = z.infer<typeof SheetsAgentSettings>;

export const DEFAULT_SHEETS_SETTINGS: SheetsAgentSettings = {
  spreadsheetId: null,
  spreadsheetName: null,
  lookupTab: null,
  lookup: true,
  leadsTab: null,
  addLeads: false,
};

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
export const SheetsActivityKind = z.enum(['looked_up', 'lead_added', 'failed']);
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

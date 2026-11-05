/**
 * The few Google Sheets API v4 calls the connector needs, on GoogleClient's sign-in, timeout, body
 * limit and error mapping. Values are written with `valueInputOption=RAW` by default: Google stores
 * them as text and never runs a formula a customer wrote (`=HYPERLINK(…)`, `+…`). A tab with
 * "Allow formulas" on appends `USER_ENTERED`; the service escapes every value that must stay text.
 *
 * Never log tokens, sheet values, names or phone numbers.
 */
import {
  GOOGLE_ENDPOINTS,
  GoogleClient,
  GoogleError,
  type GoogleApp,
  type GoogleEndpoints,
} from '../google-calendar/google.js';

/**
 * Only the files the admin picks in Google's file picker (non-sensitive scope): EzyChat can never
 * open another file of the account. The Sheets API reads and appends to a picked spreadsheet.
 */
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SHEETS_SCOPES = ['openid', 'email', SHEETS_SCOPE] as const;
export const SHEETS_REQUIRED_SCOPES = [SHEETS_SCOPE] as const;

export const SHEETS_ENDPOINTS: GoogleEndpoints = {
  ...GOOGLE_ENDPOINTS,
  api: 'https://sheets.googleapis.com/v4',
};

/** The look-up reads at most this many rows and columns of a tab (A1:Z1000). */
export const MAX_READ_ROWS = 1000;
export const MAX_READ_COLUMNS = 26;
const MAX_TABS = 100;

/** How Google reads appended values. */
export type SheetValueInput = 'RAW' | 'USER_ENTERED';

export interface SpreadsheetMeta {
  name: string;
  tabs: Array<{ title: string; rows: number }>;
}

const str = (value: unknown) => (typeof value === 'string' ? value : null);
const cellText = (cell: unknown) =>
  typeof cell === 'string'
    ? cell
    : typeof cell === 'number' || typeof cell === 'boolean'
      ? String(cell)
      : '';
/** Ranges per batchGet request (keeps the URL short). */
const BATCH_RANGES = 50;

/** `'Tab name'!A1:Z1000` with quotes doubled, as Google's A1 notation wants. */
export function tabRange(tab: string, cells: string): string {
  return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

export class SheetsClient extends GoogleClient {
  constructor(
    app: GoogleApp,
    endpoints: GoogleEndpoints = SHEETS_ENDPOINTS,
    fetchImpl?: typeof fetch,
  ) {
    super(app, endpoints, fetchImpl);
  }

  /** The spreadsheet's name and its grid tabs (charts and other sheet types are left out). */
  async spreadsheet(token: string, id: string, signal?: AbortSignal): Promise<SpreadsheetMeta> {
    const fields = 'properties.title,sheets.properties(title,sheetType,gridProperties.rowCount)';
    const { json } = await this.api(
      `/spreadsheets/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`,
      token,
      { signal },
    );
    const properties = (json.properties ?? {}) as Record<string, unknown>;
    const sheets = Array.isArray(json.sheets)
      ? (json.sheets as Array<Record<string, unknown>>)
      : [];
    const tabs = sheets.slice(0, MAX_TABS).flatMap((sheet) => {
      const p = (sheet.properties ?? {}) as Record<string, unknown>;
      const title = str(p.title);
      if (!title || (str(p.sheetType) ?? 'GRID') !== 'GRID') return [];
      const grid = (p.gridProperties ?? {}) as Record<string, unknown>;
      const rows = typeof grid.rowCount === 'number' ? Math.max(0, Math.floor(grid.rowCount)) : 0;
      return [{ title: title.slice(0, 100), rows }];
    });
    return { name: (str(properties.title) ?? id).slice(0, 200), tabs };
  }

  /** The tab's values (A1:Z1000) as text, row by row; empty trailing cells are left out by Google. */
  async values(token: string, id: string, tab: string, signal?: AbortSignal): Promise<string[][]> {
    const range = tabRange(tab, `A1:Z${MAX_READ_ROWS}`);
    const { json } = await this.api(
      `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
      token,
      { signal },
    );
    const rows = Array.isArray(json.values) ? (json.values as unknown[]) : [];
    return rows
      .slice(0, MAX_READ_ROWS)
      .map((row) => (Array.isArray(row) ? row : []).slice(0, MAX_READ_COLUMNS).map(cellText));
  }

  /** The first row (A1:Z1) of each tab, in one request per 50 tabs; an empty first row is []. */
  async firstRows(
    token: string,
    id: string,
    tabs: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let start = 0; start < tabs.length; start += BATCH_RANGES) {
      const chunk = tabs.slice(start, start + BATCH_RANGES);
      const ranges = chunk
        .map((tab) => `ranges=${encodeURIComponent(tabRange(tab, `A1:Z1`))}`)
        .join('&');
      const { json } = await this.api(
        `/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${ranges}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
        token,
        { signal },
      );
      const found = Array.isArray(json.valueRanges)
        ? (json.valueRanges as Array<Record<string, unknown>>)
        : [];
      chunk.forEach((tab, i) => {
        const values = found[i]?.values;
        const row =
          Array.isArray(values) && Array.isArray(values[0]) ? (values[0] as unknown[]) : [];
        out.set(tab, row.slice(0, MAX_READ_COLUMNS).map(cellText));
      });
    }
    return out;
  }

  /**
   * Creates a spreadsheet in the signed-in account with these grid tabs (`drive.file` covers files
   * the app creates) and returns its id. Nothing is written into the cells here.
   */
  async create(
    token: string,
    name: string,
    tabs: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const { json } = await this.api('/spreadsheets', token, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        properties: { title: name },
        sheets: tabs.map((title) => ({ properties: { title } })),
      }),
    });
    const id = str(json.spreadsheetId);
    if (!id) throw new GoogleError('rejected');
    return id;
  }

  /** Writes cells as typed (USER_ENTERED): `data` is A1 ranges with their rows. */
  async writeCells(
    token: string,
    id: string,
    data: ReadonlyArray<{ range: string; values: string[][] }>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.api(`/spreadsheets/${encodeURIComponent(id)}/values:batchUpdate`, token, {
      method: 'POST',
      signal,
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    });
  }

  /**
   * Adds `rows` below the last row of the tab's table. RAW (default): never parsed as formulas.
   * USER_ENTERED: as if typed (formulas, numbers, dates); the caller escapes text with a `'`.
   */
  async append(
    token: string,
    id: string,
    tab: string,
    rows: string[][],
    signal?: AbortSignal,
    input: SheetValueInput = 'RAW',
  ): Promise<void> {
    const range = tabRange(tab, 'A1');
    const { json } = await this.api(
      `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=${input}&insertDataOption=INSERT_ROWS`,
      token,
      { method: 'POST', signal, body: JSON.stringify({ majorDimension: 'ROWS', values: rows }) },
    );
    const updates = (json.updates ?? {}) as Record<string, unknown>;
    if (typeof updates.updatedRows === 'number' && updates.updatedRows < rows.length)
      throw new GoogleError('rejected');
  }
}

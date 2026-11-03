/**
 * In-process stand-in for Google (sign-in and Sheets), used ONLY when the server runs with
 * `--fake-wa` (tests, e2e, Dev Builds) and no Google app is configured. Nothing here touches the
 * network: `fetch` answers the same requests SheetsClient sends to the fake base URLs.
 */
import type { GoogleEndpoints } from '../google-calendar/google.js';
import { FakeGoogleAuth, fakeJson as json, type FakeGoogleMode } from '../google-fake-auth.js';
import { SHEETS_SCOPES } from './sheets.js';

const BASE = 'https://fake-google-sheets.invalid';
export const FAKE_SHEETS_ENDPOINTS: GoogleEndpoints = {
  auth: `${BASE}/o/oauth2/v2/auth`,
  token: `${BASE}/token`,
  api: `${BASE}/v4`,
  revoke: `${BASE}/revoke`,
};
export const FAKE_SHEETS_APP = { clientId: 'fake-client', clientSecret: 'fake-secret' };
export const FAKE_SHEETS_ACCOUNT = 'demo.sheets@example.com';
/** The demo spreadsheet: paste this id (or a link with it) on the Settings tab. */
export const FAKE_SPREADSHEET_ID = 'demo-price-list-0000000000000000000';

export type FakeSheetsMode = FakeGoogleMode;

function demoSheets(): Map<string, { name: string; tabs: Map<string, string[][]> }> {
  return new Map([
    [
      FAKE_SPREADSHEET_ID,
      {
        name: 'Demo price list',
        tabs: new Map([
          [
            'Prices',
            [
              ['Item', 'Price (RM)', 'In stock', 'Notes'],
              ['Nasi lemak set', '12.90', 'Yes', 'With fried chicken'],
              ['Teh tarik', '3.50', 'Yes', ''],
              ['Durian cake (whole)', '88.00', 'No', 'Back in stock on Friday'],
              ['Catering for 20', '450.00', 'Yes', 'Order 3 days ahead'],
            ],
          ],
          ['Leads', [['Date', 'Name', 'WhatsApp', 'Email', 'Request', 'AI agent']]],
          [
            'Claims',
            [
              [
                'Date',
                'Name',
                'WhatsApp',
                'Group',
                'Policy no',
                'Amount',
                'What happened',
                'Source',
              ],
            ],
          ],
          ['Notes', []],
        ]),
      },
    ],
  ]);
}

export class FakeGoogleSheets extends FakeGoogleAuth {
  /** Spreadsheets by id; tabs by title, rows of text. */
  readonly sheets = demoSheets();

  constructor() {
    super(FAKE_SHEETS_ACCOUNT, SHEETS_SCOPES.join(' '));
  }

  /**
   * Spreadsheets the admin picked in the (fake) file picker: like `drive.file`, every other
   * spreadsheet answers 404, as Google does for a file the app was not given.
   */
  readonly granted = new Set<string>();

  /** The fake picker's choice of a spreadsheet (tests and the dev picker page). */
  grant(spreadsheetId: string): boolean {
    if (!this.sheets.has(spreadsheetId)) return false;
    this.granted.add(spreadsheetId);
    return true;
  }

  /** HTTP statuses the next appends answer instead of adding (e.g. 429: per-minute quota). */
  readonly appendStatuses: number[] = [];

  /** The rows of one tab (tests and the dev route). */
  rows(spreadsheetId: string, tab: string): string[][] {
    return this.sheets.get(spreadsheetId)?.tabs.get(tab) ?? [];
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    if (url.origin !== BASE) throw new TypeError('fake Google Sheets: unknown host');
    const method = (init?.method ?? 'GET').toUpperCase();
    const denied = this.authorize(url.pathname, init);
    if (denied) return denied;
    const batch = /^\/v4\/spreadsheets\/([^/]+)\/values:batchGet$/.exec(url.pathname);
    if (batch && method === 'GET') {
      const sheet = this.granted.has(decodeURIComponent(batch[1]!))
        ? this.sheets.get(decodeURIComponent(batch[1]!))
        : undefined;
      if (!sheet) return json(404, { error: { code: 404 } });
      this.calls.push('batchGet');
      const valueRanges = [];
      for (const range of url.searchParams.getAll('ranges')) {
        const title = /^'((?:[^']|'')*)'!/.exec(range)?.[1]?.replace(/''/g, "'");
        const tab = title !== undefined ? sheet.tabs.get(title) : undefined;
        if (!tab) return json(400, { error: { code: 400, message: 'Unable to parse range' } });
        valueRanges.push({
          range,
          majorDimension: 'ROWS',
          ...(tab[0] ? { values: [tab[0]] } : {}),
        });
      }
      return json(200, { valueRanges });
    }
    const match = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/([^/]+?)(:append)?)?$/.exec(
      url.pathname,
    );
    const id = match ? decodeURIComponent(match[1]!) : '';
    const sheet = this.granted.has(id) ? this.sheets.get(id) : undefined;
    if (!match || !sheet) return json(404, { error: { code: 404 } });
    if (!match[2] && method === 'GET') {
      this.calls.push('spreadsheet');
      return json(200, {
        properties: { title: sheet.name },
        sheets: [...sheet.tabs].map(([title, rows]) => ({
          properties: {
            title,
            sheetType: 'GRID',
            gridProperties: { rowCount: Math.max(1000, rows.length) },
          },
        })),
      });
    }
    const range = decodeURIComponent(match[2] ?? '');
    const tabName = /^'((?:[^']|'')*)'!/.exec(range)?.[1]?.replace(/''/g, "'");
    const tab = tabName !== undefined ? sheet.tabs.get(tabName) : undefined;
    if (!tab) return json(400, { error: { code: 400, message: 'Unable to parse range' } });
    if (match[3] && method === 'POST') {
      this.calls.push('append');
      const status = this.appendStatuses.shift();
      if (status) return json(status, { error: { code: status } });
      if (url.searchParams.get('valueInputOption') !== 'RAW')
        return json(400, { error: { code: 400 } });
      const body = JSON.parse(String(init?.body)) as { values: string[][] };
      tab.push(...body.values.map((row) => row.map(String)));
      return json(200, { updates: { updatedRows: body.values.length } });
    }
    if (!match[3] && method === 'GET') {
      this.calls.push('values');
      return json(200, { range, majorDimension: 'ROWS', ...(tab.length ? { values: tab } : {}) });
    }
    return json(404, { error: { code: 404 } });
  };
}

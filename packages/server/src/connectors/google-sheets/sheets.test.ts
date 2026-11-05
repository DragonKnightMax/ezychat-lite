import { describe, expect, it, vi } from 'vitest';
import { GoogleError } from '../google-calendar/google.js';
import { SHEETS_ENDPOINTS, SHEETS_SCOPES, SheetsClient, tabRange } from './sheets.js';

const app = { clientId: 'id', clientSecret: 'secret' };
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(response: Response) {
  const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
  return { sheets: new SheetsClient(app, SHEETS_ENDPOINTS, fetchImpl), fetchImpl };
}

describe('SheetsClient', () => {
  it('asks Google only for the files the admin picks (drive.file)', () => {
    const url = new URL(
      new SheetsClient(app).authorizationUrl({
        redirectUri: 'http://127.0.0.1:7420/cb',
        state: 's',
        challenge: 'c',
        scopes: SHEETS_SCOPES,
      }),
    );
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/drive.file',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('quotes tab names for A1 ranges', () => {
    expect(tabRange("Mei's prices", 'A1')).toBe("'Mei''s prices'!A1");
  });

  it('reads the name and grid tabs only, values as text', async () => {
    const meta = client(
      answer(200, {
        properties: { title: 'Prices' },
        sheets: [
          { properties: { title: 'Menu', sheetType: 'GRID', gridProperties: { rowCount: 50 } } },
          { properties: { title: 'Chart 1', sheetType: 'OBJECT' } },
          { properties: { title: 'Plain' } },
        ],
      }),
    );
    expect(await meta.sheets.spreadsheet('tok', 'abc')).toEqual({
      name: 'Prices',
      tabs: [
        { title: 'Menu', rows: 50 },
        { title: 'Plain', rows: 0 },
      ],
    });
    const [url, init] = (meta.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('https://sheets.googleapis.com/v4/spreadsheets/abc?fields=');
    expect(new Headers((init as RequestInit).headers).get('authorization')).toBe('Bearer tok');

    const values = client(answer(200, { values: [['a', 1, true, null], 'bad'] }));
    expect(await values.sheets.values('tok', 'abc', 'Menu')).toEqual([['a', '1', 'true', ''], []]);
    const [valuesUrl] = (values.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(decodeURIComponent(String(valuesUrl))).toContain("/values/'Menu'!A1:Z1000?");
    expect(await client(answer(200, {})).sheets.values('tok', 'abc', 'Menu')).toEqual([]);
  });

  it('appends rows as RAW values and maps errors', async () => {
    const ok = client(answer(200, { updates: { updatedRows: 1 } }));
    await ok.sheets.append('tok', 'abc', 'Leads', [['=1+1']]);
    const [url, init] = (ok.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain(':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      majorDimension: 'ROWS',
      values: [['=1+1']],
    });
    const made = client(answer(200, { spreadsheetId: 'new-sheet-id-000000000000' }));
    expect(await made.sheets.create('tok', 'Claims', ['Claims', 'Rates'])).toBe(
      'new-sheet-id-000000000000',
    );
    const [createUrl, createInit] = (made.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(createUrl)).toMatch(/\/spreadsheets$/);
    expect(JSON.parse(String((createInit as RequestInit).body))).toEqual({
      properties: { title: 'Claims' },
      sheets: [{ properties: { title: 'Claims' } }, { properties: { title: 'Rates' } }],
    });
    await expect(client(answer(200, {})).sheets.create('t', 'X', ['T'])).rejects.toMatchObject({
      kind: 'rejected',
    });
    const cells = client(answer(200, {}));
    await cells.sheets.writeCells('tok', 'abc', [{ range: "'T'!A1", values: [['=1']] }]);
    const [cellsUrl, cellsInit] = (cells.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(cellsUrl)).toContain('/spreadsheets/abc/values:batchUpdate');
    expect(JSON.parse(String((cellsInit as RequestInit).body))).toEqual({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: "'T'!A1", values: [['=1']] }],
    });
    const typed = client(answer(200, { updates: { updatedRows: 1 } }));
    await typed.sheets.append('tok', 'abc', 'Leads', [['=1+1']], undefined, 'USER_ENTERED');
    const [typedUrl] = (typed.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(typedUrl)).toContain(':append?valueInputOption=USER_ENTERED&insertDataOption');
    await expect(
      client(answer(200, { updates: { updatedRows: 0 } })).sheets.append('t', 'a', 'L', [['x']]),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      client(answer(404, { error: { code: 404 } })).sheets.spreadsheet('t', 'a'),
    ).rejects.toBeInstanceOf(GoogleError);
    await expect(client(answer(503, {})).sheets.values('t', 'a', 'L')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});

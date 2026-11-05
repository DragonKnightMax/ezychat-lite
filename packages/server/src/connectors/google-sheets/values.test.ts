import { describe, expect, it } from 'vitest';
import {
  BLOCKED_FORMULA_FUNCTIONS,
  asText,
  autoColumn,
  columnKey,
  datesIn,
  formulaReachesOut,
  headerColumns,
  isFormula,
  matchColumns,
  personWrote,
} from './values.js';

describe('sheet columns', () => {
  it('match ignoring case, spaces, underscores and dashes', () => {
    expect(columnKey(' Policy  No ')).toBe('policyno');
    expect(columnKey('policy_no')).toBe(columnKey('Policy-No'));
    const header = ['Date', 'Policy no', '', 'Amount'];
    expect(matchColumns(header, { 'POLICY NO': 'P-1', amount: '5' })).toEqual({
      ok: true,
      byIndex: new Map([
        [1, 'P-1'],
        [3, '5'],
      ]),
    });
    expect(matchColumns(header, { Policy: 'P-1', Amount: '5', '': 'x' })).toEqual({
      ok: false,
      unknown: ['Policy', ''],
    });
  });

  it('knows the columns EzyChat fills, File as Source', () => {
    expect(autoColumn('AI Agent')).toBe('aiagent');
    expect(autoColumn('whatsapp')).toBe('whatsapp');
    expect(autoColumn('File')).toBe('source');
    expect(autoColumn('Amount')).toBeNull();
  });

  it('reads a first row without trailing empty cells', () => {
    expect(headerColumns([' Date ', 'Name', '', ' '])).toEqual(['Date', 'Name']);
    expect(headerColumns(undefined)).toEqual([]);
  });
});

describe('personWrote', () => {
  const texts = [
    'Hi, claim for policy P-1042. Amount RM 1,250.00, accident on 3/11/2026',
    'My number is 012-345 6789 and the car is a Myvi',
  ];

  it('finds words with case and spacing ignored, never inside a longer word', () => {
    expect(personWrote(texts, 'policy  p-1042')).toBe(true);
    expect(personWrote(texts, 'MYVI')).toBe(true);
    expect(personWrote(texts, 'Myv')).toBe(false);
    expect(personWrote(texts, 'Axia')).toBe(false);
    expect(personWrote(texts, '  ')).toBe(true);
  });

  it('normalises numbers: thousands separators, .00, spaces and dashes', () => {
    expect(personWrote(texts, 'RM1250')).toBe(true);
    expect(personWrote(texts, '1,250')).toBe(true);
    expect(personWrote(texts, '1250.00')).toBe(true);
    expect(personWrote(texts, '125')).toBe(false);
    expect(personWrote(texts, '0123456789')).toBe(true);
    expect(personWrote(texts, '0123456788')).toBe(false);
  });

  it('matches a date in any common form', () => {
    expect(personWrote(texts, '2026-11-03')).toBe(true);
    expect(personWrote(texts, '3 Nov 2026')).toBe(true);
    expect(personWrote(texts, 'November 3rd, 2026')).toBe(true);
    expect(personWrote(texts, '3 Nov')).toBe(true);
    expect(personWrote(texts, '4 Nov 2026')).toBe(false);
    expect(personWrote(texts, '3 Nov 2025')).toBe(false);
    expect(personWrote(['see you 03.11.26'], '2026-11-03')).toBe(true);
  });

  it('lists the dates of a text', () => {
    expect(datesIn('2026-13-40 or 13/13')).toEqual([]);
    expect(datesIn('5th of nothing, Dec 25')).toEqual([{ d: 25, m: 12, y: null }]);
  });
});

describe('sheet formulas', () => {
  it('tells formulas from plain numbers', () => {
    for (const value of ['=SUM(B2:B9)', '  =1+1', '+A1', '-B2*3', '@A1', '+ x'])
      expect(isFormula(value), value).toBe(true);
    for (const value of ['1250', '-12.50', '+60 12 345 6789', '15%', 'RM 1,250', 'P-1042', ''])
      expect(isFormula(value), value).toBe(false);
  });

  it('refuses every function that reaches outside the sheet, and any web address', () => {
    for (const name of BLOCKED_FORMULA_FUNCTIONS)
      expect(formulaReachesOut(`=${name.toLowerCase()}("x")`), name).toBe(true);
    expect(formulaReachesOut('=_xlfn.WEBSERVICE(A1)')).toBe(true);
    // Custom functions with a telling name (Apps Script can fetch) fail closed.
    expect(formulaReachesOut('=FETCHPRICE(A2)')).toBe(true);
    expect(formulaReachesOut('=SENDTOCRM(A2)')).toBe(true);
    expect(formulaReachesOut('=CONCAT("https", "://x.io")')).toBe(true);
    expect(formulaReachesOut('=CONCAT("see ", "www.x.io")')).toBe(true);
    expect(formulaReachesOut('=A1&"http:x"')).toBe(true);
    // Full-width letters are normalised first.
    expect(formulaReachesOut('=ＩＭＰＯＲＴＸＭＬ("a","b")')).toBe(true);
    expect(formulaReachesOut('=IMPORTRANGE ("id", "A1")')).toBe(true);
    for (const ok of [
      '=SUM(B2:B9)*1.06',
      "=VLOOKUP(A2,'Prices'!A:B,2,FALSE)",
      '=TODAY()+3',
      '=1+1',
    ])
      expect(formulaReachesOut(ok), ok).toBe(false);
  });

  it('keeps text as text when values are entered as typed', () => {
    expect(asText('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(asText('+A1')).toBe("'+A1");
    expect(asText("'quoted")).toBe("''quoted");
    expect(asText('1250')).toBe('1250');
    expect(asText('Mei Ying')).toBe('Mei Ying');
  });
});

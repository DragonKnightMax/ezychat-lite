import { describe, expect, it } from 'vitest';
import { MAX_MATCH_ROWS, SMALL_TAB_ROWS, matchRows, queryTerms } from './match.js';

const header = ['Item', 'Price (RM)', 'In stock'];
const big = [
  header,
  ...Array.from({ length: 40 }, (_, i) => [`Product ${i}`, `${10 + i}.00`, i % 2 ? 'Yes' : 'No']),
  ['Durian cake (whole)', '88.00', 'No'],
  ['Durian puff', '6.50', 'Yes'],
  ['Café latte', '9.00', 'Yes'],
  ['榴莲蛋糕', '88.00', 'No'],
];

describe('queryTerms', () => {
  it('keeps words of 2+ characters without accents, and each CJK character', () => {
    expect(queryTerms('How much is the Durian CAKE? a')).toEqual([
      'how',
      'much',
      'is',
      'the',
      'durian',
      'cake',
    ]);
    expect(queryTerms('榴莲 cake')).toEqual(['榴', '莲', 'cake']);
    expect(queryTerms('café')).toEqual(['cafe']);
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('matchRows', () => {
  it('returns a small tab whole, with the header as column names', () => {
    const result = matchRows(
      [header, ['Teh tarik', '3.50', 'Yes'], [], ['', '', ''], ['Kopi', '', 'No']],
      'anything',
    );
    expect(result).toEqual({
      columns: header,
      rows: [
        { Item: 'Teh tarik', 'Price (RM)': '3.50', 'In stock': 'Yes' },
        { Item: 'Kopi', 'In stock': 'No' },
      ],
      totalRows: 2,
      truncated: false,
    });
  });

  it('ranks rows of a large tab by how many query words they hold', () => {
    const result = matchRows(big, 'durian cake price');
    expect(result.totalRows).toBe(44);
    expect(result.rows.map((r) => r.Item)).toEqual(['Durian cake (whole)', 'Durian puff']);
    expect(matchRows(big, '榴莲').rows).toEqual([
      { Item: '榴莲蛋糕', 'Price (RM)': '88.00', 'In stock': 'No' },
    ]);
    expect(matchRows(big, 'CAFE').rows[0]!.Item).toBe('Café latte');
    expect(matchRows(big, 'nothing like this').rows).toEqual([]);
  });

  it('caps the rows sent back and says so', () => {
    const result = matchRows(big, 'product');
    expect(result.rows).toHaveLength(MAX_MATCH_ROWS);
    expect(result.truncated).toBe(true);
    const long = [
      ['Notes'],
      ...Array.from({ length: SMALL_TAB_ROWS }, () => ['word '.repeat(1000)]),
    ];
    const capped = matchRows(long, 'word');
    expect(capped.rows.length).toBeLessThan(SMALL_TAB_ROWS);
    expect(capped.truncated).toBe(true);
  });

  it('names empty and repeated header cells, and survives an empty tab', () => {
    const result = matchRows(
      [
        ['Name', '', 'Name'],
        ['a', 'b', 'c', 'd'],
      ],
      'a',
    );
    expect(result.columns).toEqual(['Name', 'Column B', 'Name (2)', 'Column D']);
    expect(result.rows).toEqual([{ Name: 'a', 'Column B': 'b', 'Name (2)': 'c', 'Column D': 'd' }]);
    expect(matchRows([], 'x')).toEqual({ columns: [], rows: [], totalRows: 0, truncated: false });
  });
});

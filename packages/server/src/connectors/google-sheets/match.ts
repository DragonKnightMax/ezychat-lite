/**
 * Which rows of a look-up tab answer the customer's question. The first row holds the column names;
 * every other row is scored by how many words of the query appear in it (case and accents ignored,
 * CJK characters compared one by one). No AI and no network here.
 */

/** At most this many rows go back to the model. */
export const MAX_MATCH_ROWS = 20;
/** And at most this many characters of them (JSON). */
export const MAX_MATCH_CHARACTERS = 8_000;
/** A tab this small goes back whole, whatever the query. */
export const SMALL_TAB_ROWS = 20;

const normalize = (text: string) =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Query words: Latin/number runs of 2+ characters, and each CJK character. */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of normalize(query).split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (CJK.test(word)) {
      for (const char of word) if (CJK.test(char)) terms.add(char);
      const rest = word.replace(new RegExp(CJK.source, 'gu'), ' ').trim();
      for (const part of rest.split(/\s+/)) if (part.length >= 2) terms.add(part);
    } else if (word.length >= 2) terms.add(word);
  }
  return [...terms].slice(0, 30);
}

export interface MatchResult {
  columns: string[];
  rows: Array<Record<string, string>>;
  /** Rows with data in the tab (header left out). */
  totalRows: number;
  /** More rows matched than were returned. */
  truncated: boolean;
}

/** Column names of the header; an empty one becomes "Column B" etc. */
function columnNames(header: readonly string[], width: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < width; i++) {
    const base = header[i]?.trim() || `Column ${String.fromCharCode(65 + i)}`;
    let name = base;
    for (let n = 2; names.includes(name); n++) name = `${base} (${n})`;
    names.push(name);
  }
  return names;
}

export function matchRows(values: readonly string[][], query: string): MatchResult {
  const [header = [], ...body] = values;
  const data = body.filter((row) => row.some((cell) => cell.trim()));
  const width = Math.max(header.length, ...data.map((row) => row.length), 0);
  const columns = columnNames(header, width);
  const toRecord = (row: readonly string[]) =>
    Object.fromEntries(
      columns.flatMap((name, i) => (row[i]?.trim() ? [[name, row[i]!.trim()]] : [])),
    );
  const terms = queryTerms(query);
  let picked: string[][];
  if (data.length <= SMALL_TAB_ROWS) picked = data;
  else {
    const scored = data
      .map((row, index) => {
        const text = normalize(row.join(' '));
        return { row, index, score: terms.filter((term) => text.includes(term)).length };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    picked = scored.map((r) => r.row);
  }
  const rows: Array<Record<string, string>> = [];
  let size = 0;
  for (const row of picked) {
    if (rows.length >= MAX_MATCH_ROWS) break;
    const record = toRecord(row);
    const length = JSON.stringify(record).length;
    if (size + length > MAX_MATCH_CHARACTERS) break;
    rows.push(record);
    size += length;
  }
  return { columns, rows, totalRows: data.length, truncated: rows.length < picked.length };
}

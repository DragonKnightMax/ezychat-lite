/**
 * Sheet row values (design docs/features/group-agents/design.md, Part A): column names matched
 * ignoring case and spacing, the columns EzyChat fills itself, and the check that a value the AI
 * passes was written by the person (spacing and case ignored, numbers and dates normalised).
 * Pure functions: nothing here logs or stores a value.
 */
import { SHEETS_AUTO_COLUMNS } from '@ezychat/shared';

/** A column name as compared: lower case, without spaces, underscores or dashes. */
export const columnKey = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, '');

export type AutoColumn = 'date' | 'name' | 'whatsapp' | 'group' | 'aiagent' | 'source';

const AUTO_KEYS = new Map<string, AutoColumn>([
  ...SHEETS_AUTO_COLUMNS.map((name) => [columnKey(name), columnKey(name) as AutoColumn] as const),
  // Part C: a column named File gets the same as Source.
  ['file', 'source'],
]);

/** The auto column a header names, else null. */
export function autoColumn(name: string): AutoColumn | null {
  return AUTO_KEYS.get(columnKey(name)) ?? null;
}

/** A tab's first row as column names: trimmed, trailing empty cells left out. */
export function headerColumns(row: readonly string[] | undefined): string[] {
  const cells = (row ?? []).map((cell) => String(cell ?? '').trim());
  while (cells.length && !cells[cells.length - 1]) cells.pop();
  return cells;
}

export type MatchedValues =
  { ok: true; byIndex: Map<number, string> } | { ok: false; unknown: string[] };

/** Maps the AI's `{column: value}` onto the header's positions; unknown names are listed. */
export function matchColumns(
  header: readonly string[],
  values: Readonly<Record<string, string>>,
): MatchedValues {
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    const key = columnKey(name);
    if (key && !index.has(key)) index.set(key, i);
  });
  const byIndex = new Map<number, string>();
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const i = index.get(columnKey(name));
    if (i === undefined) unknown.push(name);
    else byIndex.set(i, value);
  }
  return unknown.length ? { ok: false, unknown } : { ok: true, byIndex };
}

// ── "The person wrote it" ──────────────────────────────────────────────────────────────────

/** Lower case, one space, thousands commas and trailing `.00` removed from numbers. */
function spaced(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)\.0+(?!\d)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const ASCII_WORD = /[a-z0-9]/;
const DIGIT = /[0-9]/;

/** `needle` in `hay`, not cut out of a longer word or number (ASCII letters and digits only). */
function boundedIncludes(hay: string, needle: string, boundary: RegExp): boolean {
  if (!needle) return false;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = hay[at - 1] ?? '';
    const after = hay[at + needle.length] ?? '';
    const startOk = !boundary.test(needle[0]!) || !boundary.test(before);
    const endOk = !boundary.test(needle[needle.length - 1]!) || !boundary.test(after);
    if (startOk && endOk) return true;
  }
  return false;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = `(${MONTHS.join('|')})[a-z]*\\.?`;

interface DayMonth {
  d: number;
  m: number;
  y: number | null;
}

const year = (text: string | undefined): number | null => {
  if (!text) return null;
  const n = Number(text);
  return text.length === 2 ? 2000 + n : n;
};

/** Every date written in `text` (ISO, d/m/y with / - or ., "3 Nov 2026", "Nov 3, 2026"). */
export function datesIn(text: string): DayMonth[] {
  const t = text.toLowerCase();
  const out: DayMonth[] = [];
  const push = (d: number, m: number, y: number | null) => {
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) out.push({ d, m, y });
  };
  for (const g of t.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g))
    push(Number(g[3]), Number(g[2]), Number(g[1]));
  for (const g of t.matchAll(
    /(?<![\d/.-])(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?(?![\d])/g,
  )) {
    // Day first (Malaysia, Singapore); month first is accepted too: the check is against invention.
    push(Number(g[1]), Number(g[2]), year(g[3]));
    push(Number(g[2]), Number(g[1]), year(g[3]));
  }
  for (const g of t.matchAll(
    new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*${MONTH}(?:[\\s,-]*(\\d{4}))?`, 'g'),
  ))
    push(Number(g[1]), MONTHS.indexOf(g[2]!) + 1, year(g[3]));
  for (const g of t.matchAll(
    new RegExp(`${MONTH}\\s*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{4}))?`, 'g'),
  ))
    push(Number(g[2]), MONTHS.indexOf(g[1]!) + 1, year(g[3]));
  return out;
}

const sameDate = (a: DayMonth, b: DayMonth) =>
  a.d === b.d && a.m === b.m && (a.y === null || b.y === null || a.y === b.y);

/**
 * True when `value` appears in one of `texts` (the person's own messages): words with spacing and
 * case ignored, numbers with or without thousands separators, spaces and dashes, and dates in any
 * common form ("2026-11-03" = "3/11/2026" = "3 Nov").
 */
export function personWrote(texts: readonly string[], value: string): boolean {
  const needle = spaced(value);
  if (!needle) return true;
  const hays = texts.map(spaced);
  if (hays.some((hay) => boundedIncludes(hay, needle, ASCII_WORD))) return true;
  if (DIGIT.test(needle)) {
    const compact = needle.replace(/[\s-]+/g, '');
    if (hays.some((hay) => boundedIncludes(hay.replace(/[\s-]+/g, ''), compact, DIGIT)))
      return true;
  }
  const wanted = datesIn(value);
  if (wanted.length) {
    const written = texts.flatMap(datesIn);
    if (wanted.some((date) => written.some((other) => sameDate(date, other)))) return true;
  }
  return false;
}

// ── Formulas (a tab with "Allow formulas" on) ─────────────────────────────────────────────

/** A plain number as typed: sign, digits, separators, an optional decimal part and percent. */
const PLAIN_NUMBER = /^[+-]?\d[\d, ]*(?:\.\d+)?%?$/;

/**
 * True when Google would read `value` as a formula if it were typed into a cell: it starts with
 * `=`, or with `+`, `-` or `@` and is not a plain number (fail closed: treated as a formula).
 */
export function isFormula(value: string): boolean {
  const text = value.trimStart();
  if (text.startsWith('=')) return true;
  return /^[+\-@]/.test(text) && !PLAIN_NUMBER.test(text.trim().replace(/^([+-])\s+/, '$1'));
}

/**
 * Functions that fetch or send data outside the sheet, or open another file. Any function whose
 * name contains one of `BLOCKED_PARTS` is refused too (custom functions such as `FETCHPRICE`).
 */
export const BLOCKED_FORMULA_FUNCTIONS = [
  'IMPORTXML',
  'IMPORTHTML',
  'IMPORTDATA',
  'IMPORTFEED',
  'IMPORTRANGE',
  'IMAGE',
  'HYPERLINK',
  'WEBSERVICE',
  'GOOGLEFINANCE',
  'GOOGLETRANSLATE',
  'DETECTLANGUAGE',
  'ENCODEURL',
  'FILTERXML',
] as const;
const BLOCKED_PARTS = /IMPORT|WEB|URL|HTTP|FETCH|LINK|MAIL|SEND/;
const BLOCKED_NAMES = new Set<string>(BLOCKED_FORMULA_FUNCTIONS);
/** A web address or a link scheme anywhere in the formula (also inside a quoted text). */
const URL_IN_FORMULA = /(?:https?|ftp|file|data|javascript|mailto)\s*:|:\/\/|www\./i;

/**
 * True when a formula may reach outside the sheet: a blocked function, a function name with a
 * blocked part, or a web address anywhere in it. Fails closed (an unusual name is refused).
 */
export function formulaReachesOut(formula: string): boolean {
  const text = formula.normalize('NFKC');
  if (URL_IN_FORMULA.test(text)) return true;
  // Each name, then whether a "(" follows it (spaces allowed): a call. One linear pass per name.
  for (const match of text.matchAll(/[A-Za-z_][\w.]*/g)) {
    const after = text.slice(match.index + match[0].length).trimStart();
    if (!after.startsWith('(')) continue;
    const name = match[0].toUpperCase().replace(/^_XLFN\./, '');
    if (BLOCKED_NAMES.has(name) || BLOCKED_PARTS.test(name)) return true;
  }
  return false;
}

/**
 * A value as Google should store it as text when values are entered as typed: a leading `'`
 * makes Google keep the rest as text (a formula never runs, a leading `'` is kept).
 */
export function asText(value: string): string {
  return isFormula(value) || value.startsWith("'") ? `'${value}` : value;
}

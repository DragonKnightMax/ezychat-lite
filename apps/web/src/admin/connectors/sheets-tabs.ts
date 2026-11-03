import { SHEETS_AUTO_COLUMNS, type SheetTabSetting, type SpreadsheetInfo } from '@ezychat/shared';

/** Column names are matched ignoring case and spacing (as the server does). */
export const columnKey = (column: string) => column.toLowerCase().replace(/\s+/g, '');
const AUTO = new Set<string>(SHEETS_AUTO_COLUMNS.map(columnKey));
/** EzyChat fills this column itself (date, name, WhatsApp number, group, agent, source). */
export const isAutoColumn = (column: string) => AUTO.has(columnKey(column));

/** What a Refresh found for one tab, compared with the tabs read before it. */
export interface TabMarks {
  newTab: boolean;
  changed: boolean;
  /** Column names that were not in the tab's first row before (shown highlighted). */
  added: ReadonlySet<string>;
}

/**
 * Marks for each tab of `after` that is new or whose first row changed since `before`. Nothing is
 * marked when there is nothing to compare with (first read, another spreadsheet).
 */
export function diffTabs(
  before: SpreadsheetInfo | null,
  after: SpreadsheetInfo,
): Map<string, TabMarks> {
  const marks = new Map<string, TabMarks>();
  if (!before || before.id !== after.id) return marks;
  for (const tab of after.tabs) {
    const prev = before.tabs.find((x) => x.title === tab.title);
    if (!prev) {
      marks.set(tab.title, { newTab: true, changed: false, added: new Set() });
      continue;
    }
    if (JSON.stringify(prev.columns) === JSON.stringify(tab.columns)) continue;
    const had = new Set(prev.columns.map(columnKey));
    marks.set(tab.title, {
      newTab: false,
      changed: true,
      added: new Set(tab.columns.filter((c) => !had.has(columnKey(c)))),
    });
  }
  return marks;
}

/** The tabs that are not off, sorted by title (a tab that is not listed is off). */
export const normalizeTabs = (tabs: readonly SheetTabSetting[]): SheetTabSetting[] =>
  tabs
    .filter((t) => t.access !== 'off')
    .map((t) => ({ title: t.title, access: t.access }))
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

/**
 * The tabs to save: with the spreadsheet's tabs known, a tab Google no longer lists and a tab
 * without column names lose their access; unknown (Google not read) keeps them as they are.
 */
export function tabsToSave(
  tabs: readonly SheetTabSetting[],
  info: SpreadsheetInfo | null,
): SheetTabSetting[] {
  if (!info) return normalizeTabs(tabs);
  return normalizeTabs(
    tabs.filter((t) => info.tabs.some((x) => x.title === t.title && x.columns.length > 0)),
  );
}

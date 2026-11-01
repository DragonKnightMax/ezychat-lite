// The after-import notice for admins (`/api/lite-import/notice`): the team checklist after a merge
// and the "address changed, connect AI assistants again" flag. One setting, cleared item by item.
import {
  LiteImportNotice,
  type LiteImportChecklistItem,
  type LiteImportNoticeUpdate,
} from '@ezychat/shared';
import type { SettingsStore } from '../db/settings.js';

export const LITE_IMPORT_NOTICE_KEY = 'lite_import_notice';

const EMPTY: LiteImportNotice = { checklist: null, mcp: null };

export const CHECKLIST_ITEMS: readonly LiteImportChecklistItem[] = [
  'share',
  'signin',
  'notifications',
  'mcp',
];

/** The saved notice; nulls when none is saved or it no longer parses. */
export function readNotice(settings: SettingsStore): LiteImportNotice {
  const raw = settings.get<unknown>(LITE_IMPORT_NOTICE_KEY, null);
  if (raw === null) return EMPTY;
  const parsed = LiteImportNotice.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY;
}

/** Saves the notice; an empty one removes the setting. */
export function writeNotice(settings: SettingsStore, notice: LiteImportNotice): void {
  settings.set(
    LITE_IMPORT_NOTICE_KEY,
    notice.checklist === null && notice.mcp === null ? undefined : notice,
  );
}

/** Ticks a checklist item or dismisses a part; returns the notice as saved. */
export function updateNotice(
  settings: SettingsStore,
  update: LiteImportNoticeUpdate,
): LiteImportNotice {
  const cur = readNotice(settings);
  let next: LiteImportNotice = cur;
  if (update.item !== undefined && cur.checklist) {
    next = {
      ...next,
      checklist: {
        ...cur.checklist,
        items: { ...cur.checklist.items, [update.item]: update.done ?? true },
      },
    };
  }
  if (update.dismiss === 'checklist') next = { ...next, checklist: null };
  if (update.dismiss === 'mcp') next = { ...next, mcp: null };
  writeNotice(settings, next);
  return next;
}

/**
 * An AI assistant reached EzyChat through the new address: the "connect again" flag is done.
 * Returns true when a flag was cleared (cheap: one settings read when there is none).
 */
export function clearMcpNotice(settings: SettingsStore): boolean {
  const cur = readNotice(settings);
  if (!cur.mcp) return false;
  writeNotice(settings, { ...cur, mcp: null });
  return true;
}

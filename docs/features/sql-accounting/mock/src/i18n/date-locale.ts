import type { Locale as DateFnsLocale } from 'date-fns';
import { enGB } from 'date-fns/locale/en-GB';
import type { Locale } from '@ezychat/shared';

/**
 * date-fns locale per UI language. English stays bundled (en-GB keeps the existing
 * "3 Oct 2026" day-first style); the others load with their catalogs.
 */
const loaders: Record<Locale, () => Promise<DateFnsLocale>> = {
  en: async () => enGB,
  ms: () => import('date-fns/locale/ms').then((m) => m.ms),
  'zh-CN': () => import('date-fns/locale/zh-CN').then((m) => m.zhCN),
};

let current: DateFnsLocale = enGB;

export async function loadDateLocale(locale: Locale): Promise<void> {
  current = await loaders[locale]();
}

/** date-fns locale of the active UI language (English until another one has loaded). */
export function dateLocale(): DateFnsLocale {
  return current;
}

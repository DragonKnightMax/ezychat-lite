import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { intlTag, isLocale, scheduledRunDays, type ScheduledTask } from '@ezychat/shared';

/** Monday first, as the business week reads. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/** Rows the card shows before "Show all". */
export const FOLDED_ROWS = 5;

/**
 * Dates and times of scheduled tasks in the page's language. Task times are wall-clock times of the
 * business time zone (`timeZone`), so run times are shown in that zone too; an unknown zone falls
 * back to the device's own.
 */
export function useScheduledFormat(timeZone: string) {
  const { t, i18n } = useTranslation('admin');
  return useMemo(() => {
    const lang = intlTag(isLocale(i18n.language) ? i18n.language : 'en');
    const time = (hhmm: string) => {
      const [h = 0, m = 0] = hhmm.split(':').map(Number);
      return new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(
        new Date(2026, 0, 5, h, m),
      );
    };
    const whenOptions: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    };
    let whenFormat: Intl.DateTimeFormat;
    try {
      whenFormat = new Intl.DateTimeFormat(lang, { ...whenOptions, timeZone });
    } catch {
      whenFormat = new Intl.DateTimeFormat(lang, whenOptions);
    }
    const when = (ms: number) => whenFormat.format(new Date(ms));
    // 4 January 2026 is a Sunday (day 0).
    const day = (d: number) =>
      new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(new Date(2026, 0, 4 + d));
    /** "Weekdays · 8:30 AM" / "Mon, Thu · 9:00 AM". */
    const schedule = (task: Pick<ScheduledTask, 'dayRule' | 'days' | 'time'>) => {
      const runs = scheduledRunDays(task);
      const days =
        task.dayRule === 'daily'
          ? t('ai.scheduled.days.daily')
          : task.dayRule === 'weekdays'
            ? t('ai.scheduled.days.weekdays')
            : WEEK.filter((d) => runs.includes(d))
                .map(day)
                .join(', ');
      return t('ai.scheduled.scheduleLine', { days, time: time(task.time) });
    };
    return { time, when, day, schedule };
  }, [i18n.language, t, timeZone]);
}

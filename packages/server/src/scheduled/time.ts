import { scheduledRunDays, type ScheduledDayRule } from '@ezychat/shared';

/** What the schedule math needs of a task. */
export interface TaskSchedule {
  /** Minutes after midnight in the business time zone. */
  timeMinutes: number;
  dayRule: ScheduledDayRule;
  days: readonly number[];
}

const DAY = 86_400_000;

/** The wall clock of `ms` in `timeZone`: date, weekday (0 = Sunday) and minutes after midnight. */
export function zonedParts(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** The zone's offset from UTC at `ms`, in ms (UTC+8 → 8 h). */
function offsetAt(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, 0, p.minutes);
  return asUtc - (ms - (ms % 60_000));
}

/**
 * The instant a wall-clock time happens in `timeZone`. A time that does not exist (a daylight-saving
 * jump) moves forward by the jump; a repeated time takes its first occurrence.
 */
export function zonedTime(
  date: { year: number; month: number; day: number },
  minutes: number,
  timeZone: string,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  const real = [first, second].filter((at) => {
    const p = zonedParts(at, timeZone);
    return p.day === date.day && p.minutes === minutes;
  });
  // A repeated time: its first occurrence; a skipped time: after the jump.
  return real.length ? Math.min(...real) : Math.max(first, second);
}

/** The local calendar date `daysBack` days before the date of `ms` in `timeZone`. */
function dateBefore(ms: number, daysBack: number, timeZone: string) {
  const p = zonedParts(ms, timeZone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) - daysBack * DAY);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

/** The latest scheduled time at or before `now`, within the last 8 days; null when none. */
export function latestSlot(task: TaskSchedule, now: number, timeZone: string): number | null {
  const days = scheduledRunDays(task);
  for (let back = 0; back <= 8; back++) {
    const date = dateBefore(now, back, timeZone);
    if (!days.includes(date.weekday)) continue;
    const slot = zonedTime(date, task.timeMinutes, timeZone);
    if (slot <= now) return slot;
  }
  return null;
}

/** The next scheduled time after `now`; null when the task has no day. */
export function nextSlot(task: TaskSchedule, now: number, timeZone: string): number | null {
  const days = scheduledRunDays(task);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const date = dateBefore(now, -ahead, timeZone);
    if (!days.includes(date.weekday)) continue;
    const slot = zonedTime(date, task.timeMinutes, timeZone);
    if (slot > now) return slot;
  }
  return null;
}

/** "08:30" ↔ 510. */
export const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
export const toTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Custom days as a bit mask (bit 0 = Sunday) and back. */
export const toDayBits = (days: readonly number[]) => days.reduce((bits, d) => bits | (1 << d), 0);
export const fromDayBits = (bits: number) =>
  [0, 1, 2, 3, 4, 5, 6].filter((d) => (bits & (1 << d)) !== 0);

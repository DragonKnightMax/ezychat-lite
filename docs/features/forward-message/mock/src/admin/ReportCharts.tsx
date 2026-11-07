import { useState } from 'react';
import type React from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Report, ReportDay } from '../mock/reports';

/**
 * Proposed (reports): small charts drawn with HTML and SVG in the app's colour tokens (no chart
 * library). Every chart has a "Show as table" switch with the same numbers for screen readers and
 * anyone who prefers rows; a readout line above each chart names the bar under the pointer or finger.
 */

const MONDAY = Date.UTC(2024, 0, 1); // a Monday

export function useFormat() {
  const { i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? 'en';
  return {
    weekday: (wd: number, width: 'short' | 'long' = 'short') =>
      new Intl.DateTimeFormat(lang, { weekday: width, timeZone: 'UTC' }).format(
        MONDAY + wd * 86_400_000,
      ),
    day: (date: string, withWeekday = false) =>
      new Intl.DateTimeFormat(lang, {
        day: 'numeric',
        month: 'short',
        ...(withWeekday ? { weekday: 'short' } : {}),
        timeZone: 'UTC',
      }).format(Date.parse(`${date}T00:00:00Z`)),
    hour: (h: number) =>
      new Intl.DateTimeFormat(lang, { hour: 'numeric', timeZone: 'UTC' }).format(
        Date.UTC(2024, 0, 1, h),
      ),
    number: (n: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n),
  };
}

function weekdayOf(date: string) {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** A report card with a title, a one-line finding and a Chart / Table switch. */
export function ChartCard({
  title,
  finding,
  table,
  children,
  testId,
}: {
  title: string;
  finding?: React.ReactNode;
  table?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation('admin');
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className="min-w-0 gap-3 py-4" data-testid={testId}>
      <CardHeader className="flex items-start justify-between gap-2 px-4">
        <div className="min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          {finding && <CardDescription className="mt-1">{finding}</CardDescription>}
        </div>
        {table && (
          <Button
            variant="ghost"
            size="sm"
            className="-mt-1 shrink-0 text-muted-foreground pointer-coarse:min-h-11"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />}
            {/* Phones: icon only, so the card title keeps the width. */}
            <span className="max-sm:sr-only">
              {asTable ? t('mockReports.showChart') : t('mockReports.showTable')}
            </span>
          </Button>
        )}
      </CardHeader>
      <CardContent className="min-w-0 px-4">{asTable ? table : children}</CardContent>
    </Card>
  );
}

/** A plain two-column-or-more table used by every "Show as table". */
export function NumberTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={cn('px-3 py-2 font-medium', i > 0 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-t">
              {row.map((cell, i) => (
                <td
                  key={i}
                  className={cn(
                    'px-3 py-1.5',
                    i > 0 && 'text-right whitespace-nowrap tabular-nums',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Messages from customers per day; weekends lighter, the busiest day marked. */
export function DailyChart({ daily }: { daily: ReportDay[] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const max = Math.max(1, ...daily.map((d) => d.inbound));
  const busiest = daily.reduce((a, b) => (b.inbound > a.inbound ? b : a), daily[0]!);
  const [selected, setSelected] = useState<ReportDay | null>(null);
  const shown = selected ?? busiest;
  const ticks = [daily[0]!, daily[Math.floor(daily.length / 2)]!, daily[daily.length - 1]!];
  return (
    <div
      className="flex flex-col gap-2"
      onPointerLeave={(e) => e.pointerType === 'mouse' && setSelected(null)}
    >
      <p className="min-h-5 text-sm" aria-live="polite" data-testid="daily-readout">
        <span className="font-medium">{f.day(shown.date, true)}</span>
        {selected ? '' : ` · ${t('mockReports.busiestDay')}`}
        <span className="text-muted-foreground">
          {' · '}
          {t('mockReports.readoutDay', {
            inbound: shown.inbound,
            outbound: shown.outbound,
            chats: shown.activeChats,
          })}
        </span>
      </p>
      <div className="flex h-44 items-stretch gap-2" aria-hidden>
        <div className="flex w-7 shrink-0 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums">
          <span>{max}</span>
          <span>{Math.round(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative flex min-w-0 flex-1 items-end gap-px border-b border-l border-border">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
          {daily.map((d) => {
            const weekend = weekdayOf(d.date) >= 5;
            const isShown = d.date === shown.date;
            return (
              <div
                key={d.date}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-end"
                onPointerEnter={() => setSelected(d)}
                onPointerDown={() => setSelected(d)}
                data-testid="daily-bar"
              >
                <div
                  className={cn(
                    'w-full rounded-t-[2px] transition-colors',
                    isShown ? 'bg-foreground' : weekend ? 'bg-primary/40' : 'bg-primary',
                  )}
                  style={{ height: `${Math.max(d.inbound ? 2 : 0, (d.inbound / max) * 100)}%` }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-between pl-9 text-xs text-muted-foreground" aria-hidden>
        {ticks.map((d, i) => (
          <span key={`${d.date}-${i}`}>{f.day(d.date)}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pl-9 text-xs text-muted-foreground">
        <Legend className="bg-primary" label={t('mockReports.legendWeekday')} />
        <Legend className="bg-primary/40" label={t('mockReports.legendWeekend')} />
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2.5 rounded-[2px]', className)} aria-hidden />
      {label}
    </span>
  );
}

/** Average messages from customers per weekday, Monday first; the busiest weekday stands out. */
export function WeekdayChart({ weekdays }: { weekdays: Report['weekdays'] }) {
  const f = useFormat();
  const max = Math.max(1, ...weekdays.map((w) => w.avgInbound));
  const top = weekdays.reduce((a, b) => (b.avgInbound > a.avgInbound ? b : a), weekdays[0]!);
  return (
    <div className="flex h-48 items-end gap-2 sm:gap-4" aria-hidden data-testid="weekday-chart">
      {weekdays.map((w) => (
        <div key={w.weekday} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
          <div className="flex w-full flex-1 flex-col items-center justify-end gap-1">
            <span
              className={cn(
                'text-xs tabular-nums',
                w === top ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              {Math.round(w.avgInbound)}
            </span>
            <div
              className={cn(
                'w-full max-w-14 rounded-t-md',
                w === top ? 'bg-primary' : 'bg-primary/35',
              )}
              style={{ height: `${Math.max(w.avgInbound ? 3 : 0, (w.avgInbound / max) * 100)}%` }}
            />
          </div>
          <span
            className={cn(
              'text-xs',
              w === top ? 'font-semibold text-foreground' : 'text-muted-foreground',
            )}
          >
            {f.weekday(w.weekday)}
          </span>
        </div>
      ))}
    </div>
  );
}

const HEAT = ['bg-muted', 'bg-primary/15', 'bg-primary/35', 'bg-primary/60', 'bg-primary/85'];

/** Busiest times: weekday rows × 24 hours, darker = more messages from customers. */
export function HoursHeatmap({ hours }: { hours: number[][] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const max = Math.max(0.1, ...hours.flat());
  const level = (v: number) => (v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999)));
  const [selected, setSelected] = useState<{ wd: number; h: number } | null>(null);
  return (
    <div
      className="flex flex-col gap-2"
      onPointerLeave={(e) => e.pointerType === 'mouse' && setSelected(null)}
    >
      <p className="min-h-5 text-sm" aria-live="polite">
        {selected ? (
          <>
            <span className="font-medium">
              {f.weekday(selected.wd, 'long')} {f.hour(selected.h)}–{f.hour((selected.h + 1) % 24)}
            </span>
            <span className="text-muted-foreground">
              {' · '}
              {t('mockReports.readoutHour', { count: hours[selected.wd]![selected.h]! })}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{t('mockReports.heatHint')}</span>
        )}
      </p>
      <div className="flex flex-col gap-[3px]" aria-hidden data-testid="hours-heatmap">
        {hours.map((row, wd) => (
          <div key={wd} className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-xs text-muted-foreground">{f.weekday(wd)}</span>
            <div className="grid min-w-0 flex-1 grid-cols-24 gap-[2px]">
              {row.map((v, h) => (
                <div
                  key={h}
                  className={cn(
                    'aspect-square min-h-2 cursor-pointer rounded-[2px] sm:aspect-auto sm:h-5',
                    HEAT[level(v)],
                    selected?.wd === wd && selected.h === h && 'ring-2 ring-foreground',
                  )}
                  onPointerEnter={() => setSelected({ wd, h })}
                  onPointerDown={() => setSelected({ wd, h })}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0" />
          <div className="grid min-w-0 flex-1 grid-cols-4 text-xs text-muted-foreground">
            {[0, 6, 12, 18].map((h) => (
              <span key={h}>{f.hour(h)}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 pl-10 text-xs text-muted-foreground">
        {t('mockReports.fewer')}
        {HEAT.map((c) => (
          <span key={c} className={cn('size-3 rounded-[2px]', c)} aria-hidden />
        ))}
        {t('mockReports.more')}
      </div>
    </div>
  );
}

/** New customers per day as a line with the area under it. */
export function NewCustomersChart({ daily }: { daily: ReportDay[] }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const max = Math.max(1, ...daily.map((d) => d.newCustomers));
  const [index, setIndex] = useState<number | null>(null);
  const n = daily.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 40 - (v / max) * 38;
  const line = daily.map((d, i) => `${x(i)},${y(d.newCustomers)}`).join(' ');
  const shown = index === null ? null : daily[index]!;
  const total = daily.reduce((s, d) => s + d.newCustomers, 0);
  const pick = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setIndex(Math.round(ratio * (n - 1)));
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="min-h-5 text-sm" aria-live="polite">
        {shown ? (
          <>
            <span className="font-medium">{f.day(shown.date, true)}</span>
            <span className="text-muted-foreground">
              {' · '}
              {t('mockReports.readoutNew', { count: shown.newCustomers })}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {t('mockReports.newAverage', { value: f.number(total / Math.max(1, n)) })}
          </span>
        )}
      </p>
      <div className="flex h-32 items-stretch gap-2" aria-hidden>
        <div className="flex w-7 shrink-0 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums">
          <span>{max}</span>
          <span>0</span>
        </div>
        <div
          className="relative min-w-0 flex-1 cursor-crosshair border-b border-l border-border"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setIndex(null)}
          data-testid="new-customers-chart"
        >
          <svg
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            className="size-full overflow-visible"
          >
            <polygon points={`0,40 ${line} 100,40`} className="fill-primary/15" />
            <polyline
              points={line}
              fill="none"
              className="stroke-primary"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
            {shown && (
              <line
                x1={x(index!)}
                x2={x(index!)}
                y1={0}
                y2={40}
                className="stroke-foreground"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
      </div>
      <div className="flex justify-between pl-9 text-xs text-muted-foreground" aria-hidden>
        <span>{f.day(daily[0]!.date)}</span>
        <span>{f.day(daily[n - 1]!.date)}</span>
      </div>
    </div>
  );
}

/** Horizontal bars, largest first (hand-off reasons). */
export function RankedBars({
  rows,
}: {
  rows: Array<{ key: string; label: string; count: number; action?: React.ReactNode }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <ul className="flex flex-col gap-3" data-testid="handoff-reasons">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0">{r.label}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {r.count} · {Math.round((r.count / Math.max(1, total)) * 100)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted" aria-hidden>
            <div
              className="h-2 rounded-full bg-primary"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
          {r.action}
        </li>
      ))}
    </ul>
  );
}

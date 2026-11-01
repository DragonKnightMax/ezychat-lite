import { useId, useState } from 'react';
import type React from 'react';
import { ArrowDownRight, ArrowUpRight, BarChart3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Inbox, Report, ReportPeriod, ReportTotals } from '@ezychat/shared';
import { useReport } from '../api/queries';
import { useVisibleInboxes } from '../inbox/useVisibleInboxes';
import { formatPhone } from '../lib/jid';
import { Banner, PageHeader, SegmentedControl } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ErrorState } from './adminUi';
import { SafetyReportSection } from './SafetyReport';
import {
  ChartCard,
  DailyChart,
  HoursHeatmap,
  NewCustomersChart,
  NumberTable,
  RankedBars,
  WeekdayChart,
  useReportFormat,
} from './ReportCharts';

/** Patterns from fewer days than this mislead: the busy-day and busy-time findings wait. */
const MIN_DAYS_FOR_PATTERNS = 14;

const HANDOFF_REASONS = [
  'missing_facts',
  'business_rule',
  'needs_action',
  'unsupported_message',
  'asked_for_human',
  'ai_unavailable',
  'sensitive',
  'lookup_failed',
] as const;
type HandoffReason = (typeof HANDOFF_REASONS)[number];
const isKnownReason = (reason: string): reason is HandoffReason =>
  (HANDOFF_REASONS as readonly string[]).includes(reason);

/**
 * Admin → Reports (design: docs/features/reports/design.md): how busy the WhatsApp numbers are
 * (busy days, busy times, new customers) and how fast the team and the AI answer, for 7, 30 or 90
 * days. Counted from this computer's database only; nothing is sent anywhere. With two or more
 * WhatsApp numbers the admin sees them all together or picks one.
 */
export function ReportsPage() {
  const { t } = useTranslation('admin');
  const [days, setDays] = useState<ReportPeriod>(30);
  const [picked, setPicked] = useState<number | null>(null);
  const inboxes = useVisibleInboxes();
  // An inbox that was removed (or is no longer listed) falls back to every inbox together.
  const inbox = picked !== null && inboxes.some((i) => i.id === picked) ? picked : null;
  const periodId = useId();
  const report = useReport(days, inbox);
  return (
    <div className="flex flex-col gap-4" data-testid="reports-page">
      <PageHeader
        className="pb-0"
        title={t('reports.title')}
        description={t('reports.description')}
        actions={
          <>
            <ReportInboxPicker inboxes={inboxes} value={inbox} onChange={setPicked} />
            <span id={periodId} className="sr-only">
              {t('reports.period')}
            </span>
            <SegmentedControl<`${ReportPeriod}`>
              aria-labelledby={periodId}
              value={`${days}`}
              onValueChange={(v) => setDays(Number(v) as ReportPeriod)}
              options={[
                { value: '7', label: t('reports.days', { count: 7 }) },
                { value: '30', label: t('reports.days', { count: 30 }) },
                { value: '90', label: t('reports.days', { count: 90 }) },
              ]}
            />
          </>
        }
      />
      {report.isPending && <ReportSkeleton />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {report.isSuccess && <ReportBody report={report.data} inbox={inbox} />}
    </div>
  );
}

const ALL_INBOXES = 'all';

/** Every inbox together or one of them; shown only with two or more WhatsApp numbers. */
function ReportInboxPicker({
  inboxes,
  value,
  onChange,
}: {
  inboxes: readonly Inbox[];
  value: number | null;
  onChange(inbox: number | null): void;
}) {
  const { t } = useTranslation('inbox');
  if (inboxes.length < 2) return null;
  return (
    <Select
      value={value === null ? ALL_INBOXES : String(value)}
      onValueChange={(v) => onChange(v === ALL_INBOXES ? null : Number(v))}
    >
      <SelectTrigger
        aria-label={t('inboxFilter.label')}
        data-testid="reports-inbox"
        className="h-11! w-full min-w-0 bg-surface text-base *:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate sm:w-64 md:text-sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={ALL_INBOXES} className="min-h-11 md:min-h-8">
          {t('inboxFilter.all', { total: inboxes.length })}
        </SelectItem>
        {inboxes.map((i) => {
          const number = formatPhone({ phone: i.number });
          return (
            <SelectItem key={i.id} value={String(i.id)} className="min-h-11 md:min-h-8">
              {number ? t('inboxFilter.option', { name: i.name, number }) : i.name}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function ReportBody({ report, inbox }: { report: Report; inbox: number | null }) {
  const { t } = useTranslation('admin');
  const f = useReportFormat();
  if (!report.daily.some((d) => d.inbound > 0 || d.outbound > 0))
    return (
      <Card className="items-center gap-3 px-6 py-10 text-center" data-testid="reports-empty">
        <BarChart3 className="size-10 text-muted-foreground" aria-hidden />
        <p className="font-semibold">{t('reports.emptyTitle')}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t('reports.emptyText')}</p>
      </Card>
    );
  const daysWithData = report.daily.length;
  const early = daysWithData < MIN_DAYS_FOR_PATTERNS;
  const top = report.weekdays.reduce((a, b) => (b.avgInbound > a.avgInbound ? b : a));
  const quiet = report.weekdays.reduce((a, b) => (b.avgInbound < a.avgInbound ? b : a));
  const peak = busiestBlock(report.hours);
  return (
    <>
      {report.firstDate && daysWithData < report.days && (
        <p className="text-sm text-muted-foreground" data-testid="reports-since">
          {t('reports.since', { date: f.day(report.firstDate) })}
        </p>
      )}
      {early && (
        <Banner tone="info" title={t('reports.shortTitle', { count: daysWithData })}>
          {t('reports.shortText')}
        </Banner>
      )}
      <Totals report={report} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <ChartCard
          testId="card-weekdays"
          title={t('reports.weekdaysTitle')}
          finding={
            early
              ? t('reports.tooEarly')
              : t('reports.weekdaysFinding', {
                  day: f.weekday(top.weekday, 'long'),
                  value: Math.round(top.avgInbound),
                  quiet: f.weekday(quiet.weekday, 'long'),
                })
          }
          table={
            <NumberTable
              head={[t('reports.colDay'), t('reports.colAvgIn'), t('reports.colAvgChats')]}
              rows={report.weekdays.map((w) => [
                f.weekday(w.weekday, 'long'),
                f.number(w.avgInbound),
                f.number(w.avgChats),
              ])}
            />
          }
        >
          <WeekdayChart weekdays={report.weekdays} />
        </ChartCard>
        <ChartCard
          testId="card-hours"
          title={t('reports.hoursTitle')}
          finding={
            early || !peak
              ? t('reports.tooEarly')
              : t('reports.hoursFinding', {
                  day: f.weekday(peak.wd, 'long'),
                  from: f.hour(peak.h),
                  to: f.hour((peak.h + 2) % 24),
                })
          }
          table={
            <NumberTable
              head={[t('reports.colHour'), ...report.weekdays.map((w) => f.weekday(w.weekday))]}
              rows={Array.from({ length: 24 }, (_, h) => [
                f.hour(h),
                ...report.hours.map((row) => f.number(row[h]!)),
              ])}
            />
          }
        >
          <HoursHeatmap hours={report.hours} />
        </ChartCard>
      </div>
      <ChartCard
        testId="card-daily"
        title={t('reports.dailyTitle')}
        finding={t('reports.dailyFinding')}
        table={
          <NumberTable
            head={[
              t('reports.colDate'),
              t('reports.colIn'),
              t('reports.colOut'),
              t('reports.colChats'),
            ]}
            rows={[...report.daily]
              .reverse()
              .map((d) => [f.day(d.date, true), d.inbound, d.outbound, d.activeChats])}
          />
        }
      >
        <DailyChart daily={report.daily} />
      </ChartCard>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <ChartCard
          testId="card-new"
          title={t('reports.newTitle')}
          finding={
            report.linkedDate
              ? t('reports.newFinding', { date: f.day(report.linkedDate) })
              : undefined
          }
          table={
            <NumberTable
              head={[t('reports.colDate'), t('reports.colNew')]}
              rows={[...report.daily].reverse().map((d) => [f.day(d.date, true), d.newCustomers])}
            />
          }
        >
          <NewCustomersChart daily={report.daily} />
        </ChartCard>
        <ChartCard
          testId="card-handoffs"
          title={t('reports.handoffsTitle')}
          finding={
            report.handoffReasons.length
              ? t('reports.handoffsFinding', { count: report.totals.aiHandoffs })
              : t('reports.handoffsNone')
          }
        >
          <RankedBars
            rows={report.handoffReasons.map((r) => ({
              key: r.reason,
              label: isKnownReason(r.reason)
                ? t(`reports.reason.${r.reason}`)
                : t('reports.reason.other'),
              count: r.count,
              action:
                r.reason === 'missing_facts' ? (
                  <Link
                    to="/admin/members/ai"
                    className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('reports.addContext')}
                  </Link>
                ) : undefined,
            }))}
          />
        </ChartCard>
      </div>
      <Team report={report} />
      <SafetyReportSection days={report.days} inbox={inbox} />
    </>
  );
}

/** The two hours in a row with the most messages from customers; null when there are none. */
export function busiestBlock(hours: number[][]) {
  let best: { wd: number; h: number; v: number } | null = null;
  hours.forEach((row, wd) =>
    row.forEach((v, h) => {
      const sum = v + (row[h + 1] ?? 0);
      if (h < 23 && sum > 0 && (!best || sum > best.v)) best = { wd, h, v: sum };
    }),
  );
  return best as { wd: number; h: number; v: number } | null;
}

function minutes(t: TFunction<'admin'>, value: number | null) {
  if (value === null) return '–';
  if (value < 1) return t('reports.underMinute');
  const rounded = Math.round(value);
  if (rounded < 60) return t('reports.minutes', { count: rounded });
  return t('reports.hoursMinutes', { h: Math.floor(rounded / 60), m: rounded % 60 });
}

function Totals({ report }: { report: Report }) {
  const { t } = useTranslation('admin');
  const { totals: now, previous, days, waitingAfterHandoff: waiting } = report;
  const delta = (key: keyof ReportTotals, lowerIsBetter = false) => {
    const before = previous?.[key];
    const value = now[key];
    if (typeof before !== 'number' || typeof value !== 'number' || before === 0) return undefined;
    const pct = Math.round(((value - before) / before) * 100);
    return { pct, good: lowerIsBetter ? pct <= 0 : pct >= 0, days };
  };
  const waitingDays =
    waiting.oldestAt !== null ? Math.floor((Date.now() - waiting.oldestAt) / 86_400_000) : 0;
  return (
    <section
      aria-label={t('reports.totals')}
      className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3"
      data-testid="report-totals"
    >
      <Stat
        label={t('reports.newCustomers')}
        value={now.newCustomers}
        delta={delta('newCustomers')}
      />
      <Stat
        label={t('reports.messagesIn')}
        value={now.messagesIn}
        hint={t('reports.messagesOut', { count: now.messagesOut })}
        delta={delta('messagesIn')}
      />
      <Stat
        label={t('reports.firstReply')}
        value={minutes(t, now.medianFirstReplyMinutes)}
        hint={t('reports.firstReplyHint')}
        delta={delta('medianFirstReplyMinutes', true)}
      />
      <Stat
        label={t('reports.missedLeads')}
        value={now.missedLeads}
        hint={t('reports.missedLeadsHint')}
        tone={now.missedLeads > 0 ? 'warning' : undefined}
        delta={delta('missedLeads', true)}
        testId="stat-missed"
      />
      <Stat
        label={t('reports.waitingHandoff')}
        value={waiting.count}
        hint={
          waiting.count > 0
            ? t('reports.waitingOldest', { count: waitingDays })
            : t('reports.waitingNone')
        }
        tone={waiting.count > 0 ? 'danger' : undefined}
        action={
          waiting.count > 0 ? (
            <Button asChild size="sm" variant="outline" className="pointer-coarse:min-h-11">
              <Link to="/">{t('reports.openChats')}</Link>
            </Button>
          ) : undefined
        }
        testId="stat-waiting"
      />
      <Stat
        label={t('reports.aiAnswered')}
        value={now.aiAnswered}
        hint={t('reports.aiAnsweredHint', { resolved: now.aiResolved, handoffs: now.aiHandoffs })}
        delta={delta('aiAnswered')}
      />
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  delta,
  tone,
  action,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  delta?: { pct: number; good: boolean; days: number };
  tone?: 'warning' | 'danger';
  action?: React.ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation('admin');
  return (
    <Card
      className={cn(
        'min-w-0 gap-1 px-4 py-3',
        tone === 'warning' && 'border-warning/50',
        tone === 'danger' && 'border-danger/60 bg-danger/5',
      )}
      data-testid={testId}
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
        )}
      >
        {value}
      </p>
      {delta?.pct === 0 && (
        <p className="text-xs text-muted-foreground">{t('reports.same', { count: delta.days })}</p>
      )}
      {delta && delta.pct !== 0 && (
        <p
          className={cn(
            'inline-flex items-center gap-1 text-xs',
            delta.good ? 'text-success' : 'text-danger',
          )}
        >
          {delta.pct > 0 ? (
            <ArrowUpRight className="size-3.5" aria-hidden />
          ) : (
            <ArrowDownRight className="size-3.5" aria-hidden />
          )}
          {t(delta.pct > 0 ? 'reports.deltaUp' : 'reports.deltaDown', {
            pct: Math.abs(delta.pct),
            count: delta.days,
          })}
        </p>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </Card>
  );
}

function Team({ report }: { report: Report }) {
  const { t } = useTranslation('admin');
  return (
    <ChartCard testId="card-team" title={t('reports.teamTitle')} finding={t('reports.teamFinding')}>
      {report.team.length ? (
        <NumberTable
          head={[
            t('reports.colMember'),
            t('reports.colChats'),
            t('reports.colReplies'),
            t('reports.colReplyTime'),
          ]}
          rows={report.team.map((m) => [
            <span key="name" className="inline-flex flex-wrap items-center gap-1.5">
              {m.kind === 'phone' ? t('reports.phone') : m.name}
              {m.kind === 'ai' && <Badge variant="secondary">{t('reports.ai')}</Badge>}
            </span>,
            m.chats,
            m.replies,
            minutes(t, m.medianReplyMinutes),
          ])}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('reports.teamNone')}</p>
      )}
    </ChartCard>
  );
}

function ReportSkeleton() {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy data-testid="reports-loading">
      <span className="sr-only">{t('reports.loading')}</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

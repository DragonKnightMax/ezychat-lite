import { useId, useState } from 'react';
import type React from 'react';
import { ArrowDownRight, ArrowUpRight, BarChart3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
import {
  ChartCard,
  DailyChart,
  HoursHeatmap,
  NewCustomersChart,
  NumberTable,
  RankedBars,
  WeekdayChart,
  useFormat,
} from './ReportCharts';
import {
  useReport,
  useReportScenario,
  useSetReportScenario,
  type MockReportScenario,
  type Report,
  type ReportPeriod,
  type ReportTotals,
} from '../mock/reports';

/**
 * Proposed (reports): Admin → Reports. How busy the WhatsApp number is (busy days, busy times, new
 * customers) and how fast the team and the AI answer, for 7, 30 or 90 days. Counted from this
 * computer's database only; nothing is sent anywhere.
 */
export function ReportsPage() {
  const { t } = useTranslation('admin');
  const [days, setDays] = useState<ReportPeriod>(30);
  const periodId = useId();
  const report = useReport(days);
  return (
    <div className="flex flex-col gap-4" data-testid="reports-page">
      <PageHeader
        className="pb-0"
        title={t('mockReports.title')}
        description={t('mockReports.description')}
        actions={
          <>
            <span id={periodId} className="sr-only">
              {t('mockReports.period')}
            </span>
            <SegmentedControl<`${ReportPeriod}`>
              aria-labelledby={periodId}
              value={`${days}`}
              onValueChange={(v) => setDays(Number(v) as ReportPeriod)}
              options={[
                { value: '7', label: t('mockReports.days', { count: 7 }) },
                { value: '30', label: t('mockReports.days', { count: 30 }) },
                { value: '90', label: t('mockReports.days', { count: 90 }) },
              ]}
            />
          </>
        }
      />
      <MockControls />
      {report.isPending ? (
        <ReportSkeleton />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <ReportBody report={report.data} />
      )}
    </div>
  );
}

function ReportBody({ report }: { report: Report }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const hasData = report.daily.some((d) => d.inbound > 0);
  if (!hasData)
    return (
      <Card className="items-center gap-3 px-6 py-10 text-center" data-testid="reports-empty">
        <BarChart3 className="size-10 text-muted-foreground" aria-hidden />
        <p className="font-semibold">{t('mockReports.emptyTitle')}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t('mockReports.emptyText')}</p>
      </Card>
    );
  const daysWithData = report.daily.length;
  const top = report.weekdays.reduce((a, b) => (b.avgInbound > a.avgInbound ? b : a));
  const quiet = report.weekdays.reduce((a, b) => (b.avgInbound < a.avgInbound ? b : a));
  const peak = busiestBlock(report.hours);
  return (
    <>
      {report.firstDate && daysWithData < report.days && (
        <p className="text-sm text-muted-foreground" data-testid="reports-since">
          {t('mockReports.since', { date: f.day(report.firstDate) })}
        </p>
      )}
      {daysWithData < 14 && (
        <Banner tone="info" title={t('mockReports.shortTitle', { count: daysWithData })}>
          {t('mockReports.shortText')}
        </Banner>
      )}
      <Totals report={report} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <ChartCard
          testId="card-weekdays"
          title={t('mockReports.weekdaysTitle')}
          finding={
            daysWithData < 14
              ? t('mockReports.tooEarly')
              : t('mockReports.weekdaysFinding', {
                  day: f.weekday(top.weekday, 'long'),
                  value: Math.round(top.avgInbound),
                  quiet: f.weekday(quiet.weekday, 'long'),
                })
          }
          table={
            <NumberTable
              head={[
                t('mockReports.colDay'),
                t('mockReports.colAvgIn'),
                t('mockReports.colAvgChats'),
              ]}
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
          title={t('mockReports.hoursTitle')}
          finding={
            daysWithData < 14
              ? t('mockReports.tooEarly')
              : t('mockReports.hoursFinding', {
                  day: f.weekday(peak.wd, 'long'),
                  from: f.hour(peak.h),
                  to: f.hour((peak.h + 2) % 24),
                })
          }
          table={
            <NumberTable
              head={[t('mockReports.colHour'), ...report.weekdays.map((w) => f.weekday(w.weekday))]}
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
        title={t('mockReports.dailyTitle')}
        finding={t('mockReports.dailyFinding')}
        table={
          <NumberTable
            head={[
              t('mockReports.colDate'),
              t('mockReports.colIn'),
              t('mockReports.colOut'),
              t('mockReports.colChats'),
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
          title={t('mockReports.newTitle')}
          finding={
            report.historyImportedUntil
              ? t('mockReports.newFinding', { date: f.day(report.historyImportedUntil) })
              : undefined
          }
          table={
            <NumberTable
              head={[t('mockReports.colDate'), t('mockReports.colNew')]}
              rows={[...report.daily].reverse().map((d) => [f.day(d.date, true), d.newCustomers])}
            />
          }
        >
          <NewCustomersChart daily={report.daily} />
        </ChartCard>
        <ChartCard
          testId="card-handoffs"
          title={t('mockReports.handoffsTitle')}
          finding={t('mockReports.handoffsFinding', { count: report.totals.aiHandoffs })}
        >
          <RankedBars
            rows={report.handoffReasons.map((r) => ({
              key: r.reason,
              label: t(`mockReports.reason.${r.reason as HandoffReason}`),
              count: r.count,
              action:
                r.reason === 'missing_facts' ? (
                  <Link
                    to="/admin/members/ai/1"
                    className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('mockReports.addContext')}
                  </Link>
                ) : undefined,
            }))}
          />
        </ChartCard>
      </div>
      <Team report={report} />
    </>
  );
}

type HandoffReason =
  | 'missing_facts'
  | 'business_rule'
  | 'needs_action'
  | 'unsupported_message'
  | 'asked_for_human'
  | 'ai_unavailable'
  | 'sensitive'
  | 'lookup_failed';

/** Two hours in a row with the most messages from customers. */
function busiestBlock(hours: number[][]) {
  let best = { wd: 0, h: 0, v: -1 };
  hours.forEach((row, wd) =>
    row.forEach((v, h) => {
      const sum = v + (row[h + 1] ?? 0);
      if (h < 23 && sum > best.v) best = { wd, h, v: sum };
    }),
  );
  return best;
}

function minutes(t: TFunction<'admin'>, value: number | null) {
  if (value === null) return '–';
  if (value < 1) return t('mockReports.underMinute');
  if (value < 60) return t('mockReports.minutes', { count: value });
  return t('mockReports.hoursMinutes', { h: Math.floor(value / 60), m: value % 60 });
}

function Totals({ report }: { report: Report }) {
  const { t } = useTranslation('admin');
  const { totals: now, previous } = report;
  const days = report.days;
  const delta = (key: keyof ReportTotals, lowerIsBetter = false) => {
    const before = previous?.[key];
    const value = now[key];
    if (typeof before !== 'number' || typeof value !== 'number' || before === 0) return undefined;
    const pct = Math.round(((value - before) / before) * 100);
    return { pct, good: lowerIsBetter ? pct <= 0 : pct >= 0, days };
  };
  const waitingDays =
    now.oldestWaitingAt !== null ? Math.floor((Date.now() - now.oldestWaitingAt) / 86_400_000) : 0;
  return (
    <section
      aria-label={t('mockReports.totals')}
      className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3"
      data-testid="report-totals"
    >
      <Stat
        label={t('mockReports.newCustomers')}
        value={now.newCustomers}
        delta={delta('newCustomers')}
      />
      <Stat
        label={t('mockReports.messagesIn')}
        value={now.messagesIn}
        hint={t('mockReports.messagesOut', { count: now.messagesOut })}
        delta={delta('messagesIn')}
      />
      <Stat
        label={t('mockReports.firstReply')}
        value={minutes(t, now.medianFirstReplyMinutes)}
        hint={t('mockReports.firstReplyHint')}
        delta={delta('medianFirstReplyMinutes', true)}
      />
      <Stat
        label={t('mockReports.missedLeads')}
        value={now.missedLeads}
        hint={t('mockReports.missedLeadsHint')}
        tone={now.missedLeads > 0 ? 'warning' : undefined}
        delta={delta('missedLeads', true)}
      />
      <Stat
        label={t('mockReports.waitingHandoff')}
        value={now.waitingAfterHandoff}
        hint={
          now.waitingAfterHandoff > 0
            ? t('mockReports.waitingOldest', { count: waitingDays })
            : t('mockReports.waitingNone')
        }
        tone={now.waitingAfterHandoff > 0 ? 'danger' : undefined}
        action={
          now.waitingAfterHandoff > 0 ? (
            <Button asChild size="sm" variant="outline" className="pointer-coarse:min-h-11">
              <Link to="/">{t('mockReports.openChats')}</Link>
            </Button>
          ) : undefined
        }
        testId="stat-waiting"
      />
      <Stat
        label={t('mockReports.aiAnswered')}
        value={now.aiAnswered}
        hint={t('mockReports.aiAnsweredHint', {
          resolved: now.aiResolved,
          handoffs: now.aiHandoffs,
        })}
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
      {delta && delta.pct === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('mockReports.same', { count: delta.days })}
        </p>
      )}
      {delta && delta.pct !== 0 && (
        <p
          className={cn(
            'inline-flex items-center gap-1 text-xs',
            delta.good ? 'text-success' : 'text-danger',
          )}
        >
          {delta.pct >= 0 ? (
            <ArrowUpRight className="size-3.5" aria-hidden />
          ) : (
            <ArrowDownRight className="size-3.5" aria-hidden />
          )}
          {t('mockReports.delta', { pct: Math.abs(delta.pct), count: delta.days })}
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
    <ChartCard
      testId="card-team"
      title={t('mockReports.teamTitle')}
      finding={t('mockReports.teamFinding')}
    >
      <NumberTable
        head={[
          t('mockReports.colMember'),
          t('mockReports.colChats'),
          t('mockReports.colReplies'),
          t('mockReports.colReplyTime'),
        ]}
        rows={report.team.map((m) => [
          <span key="name" className="inline-flex flex-wrap items-center gap-1.5">
            {m.name}
            {m.kind === 'ai' && <Badge variant="secondary">{t('mockReports.ai')}</Badge>}
          </span>,
          m.chats,
          m.replies,
          m.kind === 'ai' ? t('mockReports.underMinute') : minutes(t, m.medianReplyMinutes),
        ])}
      />
    </ChartCard>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy data-testid="reports-loading">
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

/** Mock only: switch the demo data (normal, a new install, 5 days, slow, error). */
function MockControls() {
  const { t } = useTranslation('admin');
  const scenario = useReportScenario();
  const set = useSetReportScenario();
  const id = useId();
  const options: MockReportScenario[] = ['normal', 'short', 'empty', 'slow', 'error'];
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed px-3 py-2"
      data-testid="mock-report-controls"
    >
      <Badge variant="outline">{t('mockReports.mockControls')}</Badge>
      <span id={id} className="text-sm font-medium">
        {t('mockReports.mockData')}
      </span>
      <Select
        value={scenario.data?.scenario ?? 'normal'}
        onValueChange={(v) => set.mutate(v as MockReportScenario)}
      >
        <SelectTrigger aria-labelledby={id} className="w-56 max-w-full" data-testid="mock-scenario">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {t(`mockReports.scenario.${o}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

import type React from 'react';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReportPeriod, SafetyReport, SafetyReportTotals } from '@ezychat/shared';
import { useSafetyReport } from '../api/safety';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ChartCard, NumberTable, RankedBars, useReportFormat } from './ReportCharts';

/**
 * Admin → Reports → WhatsApp Safety (docs/features/whatsapp-safety/design.md): what reached the
 * team (dangerous files, scam messages), what the team did with it (risky downloads, blocks) and
 * whether the checks are set right (false alarms), for the same 7 / 30 / 90 days and inbox as
 * the page.
 */
export function SafetyReportSection({
  days,
  inbox = null,
}: {
  days: ReportPeriod;
  /** The page's inbox choice; null = every inbox together. */
  inbox?: number | null;
}) {
  const { t } = useTranslation('admin');
  const { data } = useSafetyReport(days, inbox);
  if (!data) return null;
  return (
    <section
      aria-labelledby="report-safety"
      className="flex min-w-0 flex-col gap-4"
      data-testid="report-safety"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <h2 id="report-safety" className="flex items-center gap-2 text-lg font-semibold">
          <ShieldAlert className="size-5 text-muted-foreground" aria-hidden />
          {t('safetyReport.title')}
        </h2>
        <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
          <Link to="/admin/safety">{t('safetyReport.open')}</Link>
        </Button>
      </div>
      {!data.enabled ? (
        <Card className="px-4 py-4 text-sm text-muted-foreground">{t('safetyReport.off')}</Card>
      ) : (
        <SafetyBody report={data} />
      )}
    </section>
  );
}

function SafetyBody({ report }: { report: SafetyReport }) {
  const { t } = useTranslation('admin');
  const f = useReportFormat();
  const { totals: now, previous, days } = report;
  const delta = (key: keyof SafetyReportTotals) => {
    const before = previous[key];
    if (!before) return undefined;
    const pct = Math.round(((now[key] - before) / before) * 100);
    if (pct === 0) return undefined;
    return pct > 0
      ? t('safetyReport.up', { pct, days })
      : t('safetyReport.down', { pct: -pct, days });
  };
  const falsePct = now.flagged ? Math.round((now.falseAlarms / now.flagged) * 100) : 0;
  const peak = report.daily.reduce((a, b) => (b.high + b.warning > a.high + a.warning ? b : a));
  return (
    <>
      <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3" data-testid="safety-totals">
        <Tile
          label={t('safetyReport.dangerousFiles')}
          value={now.dangerousFiles}
          hint={delta('dangerousFiles') ?? t('safetyReport.dangerousFilesHint')}
        />
        <Tile
          label={t('safetyReport.scamMessages')}
          value={now.scamMessages}
          hint={delta('scamMessages') ?? t('safetyReport.scamMessagesHint')}
        />
        <Tile
          label={t('safetyReport.riskyDownloads')}
          value={now.riskyDownloads}
          hint={t('safetyReport.riskyDownloadsHint', { n: now.refusedDownloads })}
          tone={now.riskyDownloads > 0 ? 'danger' : undefined}
          testId="safety-risky-downloads"
        />
        <Tile
          label={t('safetyReport.numbersBlocked')}
          value={now.numbersBlocked}
          hint={t('safetyReport.numbersBlockedHint', { n: now.autoBlocked })}
        />
        <Tile
          label={t('safetyReport.maybeHacked')}
          value={now.maybeHacked}
          hint={t('safetyReport.maybeHackedHint')}
          tone={now.maybeHacked > 0 ? 'warning' : undefined}
        />
        <Tile
          label={t('safetyReport.falseAlarms')}
          value={`${falsePct}%`}
          hint={t('safetyReport.falseAlarmsHint', { n: now.falseAlarms, total: now.flagged })}
        />
      </div>
      <ChartCard
        testId="card-safety-daily"
        title={t('safetyReport.dailyTitle')}
        finding={
          peak.high + peak.warning > 0
            ? t('safetyReport.dailyFinding', {
                date: f.day(peak.date),
                n: peak.high + peak.warning,
              })
            : t('safetyReport.dailyNone')
        }
        table={
          <NumberTable
            head={[t('reports.colDate'), t('safety.level.high'), t('safety.level.warning')]}
            rows={[...report.daily].reverse().map((d) => [f.day(d.date, true), d.high, d.warning])}
          />
        }
      >
        <StackedDays daily={report.daily} />
      </ChartCard>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <ChartCard
          testId="card-safety-kinds"
          title={t('safetyReport.kindsTitle')}
          finding={
            report.kinds[0]
              ? t('safetyReport.kindsFinding', {
                  kind: t(`safetyReport.kind.${report.kinds[0].kind}`),
                })
              : t('safetyReport.dailyNone')
          }
        >
          <RankedBars
            rows={report.kinds.map((k) => ({
              key: k.kind,
              label: t(`safetyReport.kind.${k.kind}`),
              count: k.count,
            }))}
          />
        </ChartCard>
        <ChartCard
          testId="card-safety-team"
          title={t('safetyReport.teamTitle')}
          finding={
            report.team.length === 0
              ? t('safetyReport.teamNone')
              : report.team.some((m) => m.riskyDownloads > 0)
                ? t('safetyReport.teamFinding')
                : t('safetyReport.teamLocked')
          }
        >
          {report.team.length > 0 && (
            <NumberTable
              head={[
                t('safetyReport.colTeammate'),
                t('safetyReport.colRisky'),
                t('safetyReport.colRefused'),
              ]}
              rows={report.team.map((m) => [m.name, m.riskyDownloads, m.refused])}
            />
          )}
        </ChartCard>
      </div>
      <ChartCard
        testId="card-safety-senders"
        title={t('safetyReport.sendersTitle')}
        finding={
          report.senders.length ? t('safetyReport.sendersFinding') : t('safetyReport.dailyNone')
        }
      >
        {report.senders.length > 0 && (
          <NumberTable
            head={[
              t('safetyReport.colSender'),
              t('safetyReport.colFlagged'),
              t('safetyReport.colStatus'),
            ]}
            rows={report.senders.map((s) => [
              <Link
                key="s"
                to={`/chats/${encodeURIComponent(s.chatJid)}`}
                className="flex min-w-0 flex-col hover:underline"
              >
                <span className="truncate font-medium">{s.name}</span>
                {s.phone && (
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    +{s.phone}
                  </span>
                )}
              </Link>,
              s.count,
              t(`safetyReport.senderStatus.${s.status}`),
            ])}
          />
        )}
      </ChartCard>
    </>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'warning' | 'danger';
  testId?: string;
}) {
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
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** One stacked bar per day: High on top of Check. */
function StackedDays({ daily }: { daily: SafetyReport['daily'] }) {
  const { t } = useTranslation('admin');
  const f = useReportFormat();
  const max = Math.max(1, ...daily.map((d) => d.high + d.warning));
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-32 items-end gap-px"
        role="img"
        aria-label={t('safetyReport.dailyTitle')}
      >
        {daily.map((d) => (
          <div
            key={d.date}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`${f.day(d.date, true)}: ${d.high} · ${d.warning}`}
          >
            <div className="bg-danger/80" style={{ height: `${(d.high / max) * 100}%` }} />
            <div className="bg-warning/70" style={{ height: `${(d.warning / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{f.day(daily[0]!.date)}</span>
        <span>{f.day(daily.at(-1)!.date)}</span>
      </div>
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-danger/80" aria-hidden />
          {t('safety.level.high')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-warning/70" aria-hidden />
          {t('safety.level.warning')}
        </span>
      </div>
    </div>
  );
}

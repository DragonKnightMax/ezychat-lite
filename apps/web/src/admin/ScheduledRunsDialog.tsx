import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { SCHEDULED_RUNS_SHOWN, type ScheduledRun, type ScheduledTask } from '@ezychat/shared';
import { useScheduledRuns } from '../api/scheduled-tasks';
import { encodeJid } from '../lib/jid';
import { ResponsiveDialog } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ErrorState, ListSkeleton } from './adminUi';
import { useScheduledFormat } from './scheduled-format';

type Shown = NonNullable<ScheduledRun['result']> | 'running';

const RESULT_TONE: Record<Shown, string> = {
  sent: 'border-transparent bg-success/15 text-success',
  skipped: 'border-transparent bg-muted text-muted-foreground',
  failed: 'border-transparent bg-destructive/15 text-destructive',
  running: 'border-transparent bg-primary/10 text-primary',
};

/** A run's result as a small badge (a run still going has no result yet). */
export function RunResultBadge({ run }: Readonly<{ run: Pick<ScheduledRun, 'result'> }>) {
  const { t } = useTranslation('admin');
  const shown: Shown = run.result ?? 'running';
  return (
    <Badge variant="outline" className={cn(RESULT_TONE[shown])} data-testid="scheduled-result">
      {t(`ai.scheduled.result.${shown}`)}
    </Badge>
  );
}

/** History: the task's last runs, newest first, with why one sent nothing and a link to the chat. */
export function ScheduledRunsDialog({
  agentId,
  task,
  timeZone,
  onClose,
}: Readonly<{ agentId: number; task: ScheduledTask; timeZone: string; onClose: () => void }>) {
  const { t } = useTranslation('admin');
  const f = useScheduledFormat(timeZone);
  const q = useScheduledRuns(agentId, task.id);
  const runs = q.data?.runs.slice(0, SCHEDULED_RUNS_SHOWN) ?? [];
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="medium"
      title={t('ai.scheduled.historyTitle', { name: task.name })}
      description={t('ai.scheduled.historyBody')}
    >
      {q.isError ? (
        <div className="pb-4">
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : !q.data ? (
        <div className="pb-4">
          <ListSkeleton rows={3} />
        </div>
      ) : runs.length === 0 ? (
        <p className="pb-4 text-sm text-muted-foreground" data-testid="scheduled-history-empty">
          {t('ai.scheduled.historyEmpty')}
        </p>
      ) : (
        <ol className="flex flex-col divide-y pb-2" data-testid="scheduled-history-list">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <RunResultBadge run={run} />
                <span className="text-sm font-medium">{f.when(run.at)}</span>
                {run.trigger === 'run_now' && (
                  <span className="text-xs text-muted-foreground">
                    {run.byUserName
                      ? t('ai.scheduled.byRunNow', { name: run.byUserName })
                      : t('ai.scheduled.byRunNowUnknown')}
                  </span>
                )}
              </div>
              {run.reason && (
                <p className="text-sm text-muted-foreground">
                  {t(`ai.scheduled.reason.${run.reason}`)}
                </p>
              )}
              {run.result === 'sent' && task.chat && (
                <Link
                  to={`/chats/${encodeJid(task.chat.jid)}`}
                  className="inline-flex items-center self-start text-sm font-medium text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11"
                >
                  {t('ai.scheduled.openChatNamed', { chat: task.chat.name })}
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
    </ResponsiveDialog>
  );
}

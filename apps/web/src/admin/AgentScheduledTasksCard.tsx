import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, History, MoreVertical, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ScheduledPausedReason, ScheduledTask } from '@ezychat/shared';
import { ApiError, errorMessage } from '../api/client';
import {
  useDeleteScheduledTask,
  useRunScheduledTask,
  useScheduledTasks,
  useUpdateScheduledTask,
} from '../api/scheduled-tasks';
import { encodeJid } from '../lib/jid';
import { Banner, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog, ErrorState, ListSkeleton, Pending } from './adminUi';
import { FOLDED_ROWS, useScheduledFormat } from './scheduled-format';
import { RunResultBadge, ScheduledRunsDialog } from './ScheduledRunsDialog';
import { ChatIcon, ScheduledTaskDialog } from './ScheduledTaskDialog';

/**
 * Agent page → Scheduled tasks (design docs/features/scheduled-tasks/design.md): each task makes
 * this agent send one message at a set time to one existing chat or group of its inbox, or nothing
 * when there is nothing to tell. Paused while the agent is off, the AI or WhatsApp is not connected
 * or the app is locked. Admins only.
 */
export function AgentScheduledTasksCard({
  agentId,
  name,
}: Readonly<{ agentId: number; name: string }>) {
  const { t } = useTranslation('admin');
  const q = useScheduledTasks(agentId);
  const toggle = useUpdateScheduledTask(agentId);
  const remove = useDeleteScheduledTask(agentId);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null);
  const [history, setHistory] = useState<ScheduledTask | null>(null);
  const [running, setRunning] = useState<ScheduledTask | null>(null);
  const [removing, setRemoving] = useState<ScheduledTask | null>(null);

  const body = () => {
    if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
    if (!q.data) return <ListSkeleton rows={2} />;
    const { tasks, max, paused, timeZone, inboxId } = q.data;
    if (inboxId === null)
      return <p className="text-sm text-muted-foreground">{t('ai.scheduled.noInbox', { name })}</p>;
    const full = tasks.length >= max;
    const shown = showAll ? tasks : tasks.slice(0, FOLDED_ROWS);
    return (
      <>
        {paused && (
          <Banner tone="warning" title={t('ai.scheduled.paused.title')}>
            <span data-testid="scheduled-paused">
              {t(`ai.scheduled.paused.${paused}`, { name })}
            </span>
          </Banner>
        )}

        {tasks.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center"
            data-testid="scheduled-empty"
          >
            <CalendarClock className="size-8 text-muted-foreground" aria-hidden="true" />
            <div>
              <p className="font-medium">{t('ai.scheduled.empty.title')}</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {t('ai.scheduled.empty.body', { name })}
              </p>
            </div>
            <Button size="touch" onClick={() => setEditing('new')} data-testid="scheduled-add">
              <Plus aria-hidden="true" />
              {t('ai.scheduled.add')}
            </Button>
          </div>
        ) : (
          <>
            <ul className="flex flex-col divide-y rounded-lg border" data-testid="scheduled-list">
              {shown.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  paused={paused !== null}
                  timeZone={timeZone}
                  busy={toggle.isPending && toggle.variables?.taskId === task.id}
                  onToggle={(enabled) =>
                    toggle.mutate(
                      { taskId: task.id, patch: { enabled } },
                      { onError: () => toast.error(t('ai.scheduled.saveFailed')) },
                    )
                  }
                  onEdit={() => setEditing(task)}
                  onHistory={() => setHistory(task)}
                  onRun={() => setRunning(task)}
                  onDelete={() => setRemoving(task)}
                />
              ))}
            </ul>
            {tasks.length > FOLDED_ROWS && (
              <Button
                variant="ghost"
                size="touch"
                className="self-start"
                onClick={() => setShowAll((v) => !v)}
                data-testid="scheduled-show-all"
              >
                {showAll
                  ? t('ai.scheduled.showFewer')
                  : t('ai.scheduled.showAll', { total: tasks.length })}
              </Button>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground" data-testid="scheduled-count">
                {full
                  ? t('ai.scheduled.limitReached', { max })
                  : t('ai.scheduled.total', { total: tasks.length, max })}
              </p>
              <Button
                variant="outline"
                size="touch"
                onClick={() => setEditing('new')}
                disabled={full}
                data-testid="scheduled-add"
              >
                <Plus aria-hidden="true" />
                {t('ai.scheduled.add')}
              </Button>
            </div>
          </>
        )}

        <p className="text-sm text-muted-foreground">{t('ai.scheduled.safety')}</p>

        {editing && (
          <ScheduledTaskDialog
            key={editing === 'new' ? 'new' : editing.id}
            agentId={agentId}
            agentName={name}
            task={editing === 'new' ? null : editing}
            inboxId={inboxId}
            timeZone={timeZone}
            max={max}
            onClose={() => setEditing(null)}
          />
        )}
        {history && (
          <ScheduledRunsDialog
            agentId={agentId}
            task={history}
            timeZone={timeZone}
            onClose={() => setHistory(null)}
          />
        )}
        {running && (
          <RunNowDialog
            agentId={agentId}
            task={running}
            agentName={name}
            paused={paused}
            onClose={() => setRunning(null)}
          />
        )}
      </>
    );
  };

  return (
    <Card className="gap-4" data-testid="agent-scheduled-tasks">
      <CardHeader>
        <CardTitle>{t('ai.scheduled.title')}</CardTitle>
        <CardDescription>{t('ai.scheduled.description', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{body()}</CardContent>
      <ConfirmDialog
        open={removing !== null}
        title={t('ai.scheduled.deleteTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('ai.scheduled.delete')}
        danger
        loading={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => {
              setRemoving(null);
              remove.reset();
            },
          });
        }}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
      >
        {t('ai.scheduled.deleteBody')}
      </ConfirmDialog>
    </Card>
  );
}

function TaskRow({
  task,
  paused,
  timeZone,
  busy,
  onToggle,
  onEdit,
  onHistory,
  onRun,
  onDelete,
}: Readonly<{
  task: ScheduledTask;
  paused: boolean;
  timeZone: string;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onHistory: () => void;
  onRun: () => void;
  onDelete: () => void;
}>) {
  const { t } = useTranslation('admin');
  const f = useScheduledFormat(timeZone);
  const switchId = useId();
  const lastRun = task.lastRun;
  const lastResult = lastRun ? t(`ai.scheduled.result.${lastRun.result ?? 'running'}`) : '';
  return (
    <li className="flex items-start gap-3 px-3 py-3" data-testid="scheduled-row">
      <div className="min-w-0 flex-1">
        <Button
          variant="link"
          className="h-auto max-w-full justify-start p-0 text-left font-medium whitespace-normal text-foreground [overflow-wrap:anywhere] pointer-coarse:min-h-11"
          onClick={onEdit}
          data-testid="scheduled-name-link"
        >
          {task.name}
        </Button>
        <p className="mt-0.5 text-sm text-muted-foreground">{f.schedule(task)}</p>
        {task.chat ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <ChatIcon type={task.chat.type} />
            <span className="truncate">{task.chat.name}</span>
          </p>
        ) : (
          <p className="mt-0.5 text-sm text-warning" data-testid="scheduled-chat-gone">
            {t('ai.scheduled.chatGone')}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {!task.enabled ? (
            <span>{t('ai.scheduled.off')}</span>
          ) : paused ? (
            <span className="text-warning">{t('ai.scheduled.pausedShort')}</span>
          ) : (
            task.nextRunAt !== null && (
              <span data-testid="scheduled-next">
                {t('ai.scheduled.next', { when: f.when(task.nextRunAt) })}
              </span>
            )
          )}
          {lastRun && (
            <Button
              variant="link"
              onClick={onHistory}
              className="h-auto gap-1.5 p-0 text-xs font-normal text-muted-foreground pointer-coarse:min-h-11"
              aria-label={t('ai.scheduled.lastRun', {
                result: lastResult,
                when: f.when(lastRun.at),
              })}
              data-testid="scheduled-last-run"
            >
              <RunResultBadge run={lastRun} />
              {f.when(lastRun.at)}
            </Button>
          )}
        </div>
      </div>
      <Label
        htmlFor={switchId}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
      >
        <span className="sr-only">{t('ai.scheduled.switchLabel', { name: task.name })}</span>
        <Switch
          id={switchId}
          checked={task.enabled}
          disabled={busy}
          onCheckedChange={onToggle}
          data-testid="scheduled-switch"
        />
      </Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 pointer-coarse:size-11"
            aria-label={t('ai.scheduled.actions', { name: task.name })}
            data-testid="scheduled-menu"
          >
            <MoreVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit} className="pointer-coarse:min-h-11">
            <Pencil aria-hidden="true" />
            {t('ai.scheduled.edit')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onRun}
            className="pointer-coarse:min-h-11"
            data-testid="scheduled-run-now"
          >
            <Play aria-hidden="true" />
            {t('ai.scheduled.runNow')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onHistory}
            className="pointer-coarse:min-h-11"
            data-testid="scheduled-history"
          >
            <History aria-hidden="true" />
            {t('ai.scheduled.history')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={onDelete}
            className="pointer-coarse:min-h-11"
            data-testid="scheduled-delete"
          >
            <Trash2 aria-hidden="true" />
            {t('ai.scheduled.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * Run now: confirm, then one run as at the set time. A sent run toasts with Open chat; the server's
 * limits (429) and a pause (409) are shown in the dialog in plain words.
 */
function RunNowDialog({
  agentId,
  task,
  agentName,
  paused,
  onClose,
}: Readonly<{
  agentId: number;
  task: ScheduledTask;
  agentName: string;
  paused: ScheduledPausedReason | null;
  onClose: () => void;
}>) {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const run = useRunScheduledTask(agentId);
  const chat = task.chat;
  const chatName = chat?.name ?? '';
  const confirm = () =>
    run.mutate(task.id, {
      onSuccess: ({ run: done }) => {
        const reason = t(`ai.scheduled.reason.${done.reason ?? 'nothing_to_say'}`);
        if (done.result === 'sent') {
          toast.success(t('ai.scheduled.runNowSent', { chat: chatName }), {
            action: chat
              ? {
                  label: t('ai.scheduled.openChat'),
                  onClick: () => void navigate(`/chats/${encodeJid(chat.jid)}`),
                }
              : undefined,
          });
        } else if (done.result === 'failed') {
          toast.error(t('ai.scheduled.runNowFailed', { reason }));
        } else {
          toast(t('ai.scheduled.runNowSkipped', { reason }));
        }
        onClose();
      },
    });
  const error = run.error;
  const refused = () => {
    if (!error) return null;
    if (error instanceof ApiError && error.status === 429)
      return <Banner tone="warning">{t('ai.scheduled.runNowLimit')}</Banner>;
    if (error instanceof ApiError && error.code === 'scheduled_paused')
      return (
        <Banner tone="warning" title={t('ai.scheduled.paused.title')}>
          {paused ? t(`ai.scheduled.paused.${paused}`, { name: agentName }) : null}
        </Banner>
      );
    return <Banner tone="danger">{errorMessage(error)}</Banner>;
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && !run.isPending && onClose()}
      title={t('ai.scheduled.runNowTitle', { chat: chatName })}
      description={t('ai.scheduled.runNowBody', { name: agentName })}
      footer={
        <>
          <Button variant="outline" size="touch" onClick={onClose} disabled={run.isPending}>
            {tc('actions.cancel')}
          </Button>
          <Button
            size="touch"
            onClick={confirm}
            disabled={run.isPending || paused !== null || chat === null}
            data-testid="scheduled-run-confirm"
          >
            {run.isPending ? <Pending show /> : <Play aria-hidden="true" />}
            {t('ai.scheduled.runNow')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2 text-sm" data-testid="scheduled-run-dialog">
        {paused ? (
          <Banner tone="warning">{t(`ai.scheduled.paused.${paused}`, { name: agentName })}</Banner>
        ) : chat === null ? (
          <Banner tone="warning">{t('ai.scheduled.chatGone')}</Banner>
        ) : (
          refused()
        )}
      </div>
    </ResponsiveDialog>
  );
}

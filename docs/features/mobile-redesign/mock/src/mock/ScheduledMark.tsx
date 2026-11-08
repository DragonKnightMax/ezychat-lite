import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useScheduledTasks } from './scheduledTasks';

/**
 * Proposed (scheduled-tasks): "Scheduled · <task>" above a message a scheduled task sent. The mock
 * reads the task from the clientId (`sched-<taskId>-…`); production reads `Message.scheduledTask`
 * ({ id, name } from `messages.scheduled_task_id`, name null once the task is deleted).
 */
export function ScheduledMark({ clientId }: Readonly<{ clientId: string | null }>) {
  const { t } = useTranslation('inbox');
  const { tasks } = useScheduledTasks();
  const match = clientId ? /^sched-(st-[a-z0-9]+(?:-[a-z0-9]+)?)-[a-z0-9]+$/.exec(clientId) : null;
  if (!clientId?.startsWith('sched-')) return null;
  const task = match ? tasks.find((x) => x.id === match[1]) : undefined;
  return (
    <p
      className="mb-1 flex min-w-0 items-center gap-1 text-[11px] font-medium text-primary"
      data-testid="scheduled-mark"
    >
      <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {task ? t('mockScheduled.markNamed', { name: task.name }) : t('mockScheduled.mark')}
      </span>
    </p>
  );
}

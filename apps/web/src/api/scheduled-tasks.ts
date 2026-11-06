import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ScheduledPreviewResponse,
  ScheduledRunNowResponse,
  ScheduledRunsResponse,
  ScheduledTask,
  ScheduledTasksResponse,
  type ScheduledPreviewBody,
  type ScheduledTaskBodyInput,
  type ScheduledTaskPatch,
} from '@ezychat/shared';
import { api } from './client';

/**
 * Scheduled tasks of one AI agent (design docs/features/scheduled-tasks/design.md, admins only):
 * the list with the pause reason, the limit and the business time zone, and its changes. Every
 * change reads the list again, so the next run and the last result come from the server.
 */
export const scheduledTasksKey = (agentId: number) => ['scheduled-tasks', agentId] as const;
export const scheduledRunsKey = (agentId: number, taskId: number) =>
  [...scheduledTasksKey(agentId), 'runs', taskId] as const;

/** Read again every minute: the next run, the last result and the pause move by themselves. */
export const SCHEDULED_REFETCH_MS = 60_000;

export function useScheduledTasks(agentId: number) {
  return useQuery({
    queryKey: scheduledTasksKey(agentId),
    queryFn: ({ signal }) =>
      api(`/ai/agents/${agentId}/scheduled-tasks`, { signal, schema: ScheduledTasksResponse }),
    refetchInterval: SCHEDULED_REFETCH_MS,
  });
}

function useRefresh(agentId: number) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: scheduledTasksKey(agentId) });
}

/** Adds a task (409 `scheduled_task_limit`, 400 `chat_not_in_inbox`). */
export function useCreateScheduledTask(agentId: number) {
  const refresh = useRefresh(agentId);
  return useMutation({
    mutationFn: (body: ScheduledTaskBodyInput) =>
      api(`/ai/agents/${agentId}/scheduled-tasks`, {
        method: 'POST',
        body,
        schema: ScheduledTask,
      }),
    onSettled: refresh,
  });
}

/** Changes a task; the row's on/off switch sends `{ enabled }` only. */
export function useUpdateScheduledTask(agentId: number) {
  const refresh = useRefresh(agentId);
  return useMutation({
    mutationFn: ({ taskId, patch }: { taskId: number; patch: ScheduledTaskPatch }) =>
      api(`/ai/agents/${agentId}/scheduled-tasks/${taskId}`, {
        method: 'PATCH',
        body: patch,
        schema: ScheduledTask,
      }),
    onSettled: refresh,
  });
}

export function useDeleteScheduledTask(agentId: number) {
  const refresh = useRefresh(agentId);
  return useMutation({
    mutationFn: (taskId: number) =>
      api(`/ai/agents/${agentId}/scheduled-tasks/${taskId}`, { method: 'DELETE' }),
    onSettled: refresh,
  });
}

/** The task's last runs, newest first. */
export function useScheduledRuns(agentId: number, taskId: number) {
  return useQuery({
    queryKey: scheduledRunsKey(agentId, taskId),
    queryFn: ({ signal }) =>
      api(`/ai/agents/${agentId}/scheduled-tasks/${taskId}/runs`, {
        signal,
        schema: ScheduledRunsResponse,
      }),
  });
}

/** Run now (429 `rate_limited`, 409 `scheduled_paused`): answers the run as recorded. */
export function useRunScheduledTask(agentId: number) {
  const refresh = useRefresh(agentId);
  return useMutation({
    mutationFn: (taskId: number) =>
      api(`/ai/agents/${agentId}/scheduled-tasks/${taskId}/run`, {
        method: 'POST',
        schema: ScheduledRunNowResponse,
      }),
    onSettled: refresh,
  });
}

/** Preview: one turn, nothing sent or stored. */
export function usePreviewScheduledTask(agentId: number) {
  return useMutation({
    mutationFn: (body: ScheduledPreviewBody) =>
      api(`/ai/agents/${agentId}/scheduled-tasks/preview`, {
        method: 'POST',
        body,
        schema: ScheduledPreviewResponse,
      }),
  });
}

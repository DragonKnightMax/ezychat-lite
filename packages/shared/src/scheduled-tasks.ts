import { z } from 'zod';

/**
 * Scheduled tasks for AI agents (design docs/features/scheduled-tasks/design.md, confirmed
 * 2026-11-06). A task makes one agent send one message at a set time (business time zone
 * `ai_timezone`) to one existing chat or group of its inbox, following a plain-words instruction,
 * or nothing when there is nothing to tell. Admins only.
 */
export const SCHEDULED_TASKS_MAX = 10;
export const SCHEDULED_TASK_NAME_MAX = 60;
export const SCHEDULED_TASK_INSTRUCTION_MAX = 1000;
/** A run starts at most this long after its scheduled time; later it is recorded as missed. */
export const SCHEDULED_GRACE_MS = 15 * 60_000;
/** Run now: per task per hour, and per admin per hour. */
export const SCHEDULED_RUN_NOW_PER_TASK_HOUR = 3;
export const SCHEDULED_RUN_NOW_PER_ADMIN_HOUR = 20;
/** History shows this many runs; older runs are pruned above `SCHEDULED_RUNS_KEPT`. */
export const SCHEDULED_RUNS_SHOWN = 30;
export const SCHEDULED_RUNS_KEPT = 100;

export const ScheduledDayRule = z.enum(['daily', 'weekdays', 'custom']);
export type ScheduledDayRule = z.infer<typeof ScheduledDayRule>;

/** HH:MM, 5-minute steps (00:00 … 23:55). */
export const ScheduledTime = z.string().regex(/^([01]\d|2[0-3]):[0-5][05]$/);

const ScheduledTaskFields = {
  name: z.string().trim().min(1).max(SCHEDULED_TASK_NAME_MAX),
  enabled: z.boolean(),
  time: ScheduledTime,
  dayRule: ScheduledDayRule,
  /** 0 = Sunday … 6 = Saturday; used when `dayRule` is `custom` (at least one then). */
  days: z.array(z.number().int().min(0).max(6)).max(7),
  chatJid: z.string().min(1).max(200),
  instruction: z.string().trim().min(1).max(SCHEDULED_TASK_INSTRUCTION_MAX),
};

const customNeedsDay = (value: { dayRule?: ScheduledDayRule; days?: number[] }) =>
  value.dayRule !== 'custom' || (value.days?.length ?? 0) > 0;

/** `POST /api/ai/agents/:agentId/scheduled-tasks` (admins). */
export const ScheduledTaskBody = z
  .strictObject({
    ...ScheduledTaskFields,
    enabled: ScheduledTaskFields.enabled.default(true),
    days: ScheduledTaskFields.days.default([]),
  })
  .refine(customNeedsDay, { message: 'Choose at least one day', path: ['days'] });
export type ScheduledTaskBody = z.infer<typeof ScheduledTaskBody>;
export type ScheduledTaskBodyInput = z.input<typeof ScheduledTaskBody>;

/** `PATCH /api/ai/agents/:agentId/scheduled-tasks/:taskId` (admins): any field. */
export const ScheduledTaskPatch = z
  .strictObject({
    name: ScheduledTaskFields.name.optional(),
    enabled: ScheduledTaskFields.enabled.optional(),
    time: ScheduledTaskFields.time.optional(),
    dayRule: ScheduledTaskFields.dayRule.optional(),
    days: ScheduledTaskFields.days.optional(),
    chatJid: ScheduledTaskFields.chatJid.optional(),
    instruction: ScheduledTaskFields.instruction.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });
export type ScheduledTaskPatch = z.infer<typeof ScheduledTaskPatch>;

export const ScheduledRunResult = z.enum(['sent', 'skipped', 'failed']);
export type ScheduledRunResult = z.infer<typeof ScheduledRunResult>;

/** Why a run sent nothing (skipped) or did not work (failed). */
export const ScheduledRunReason = z.enum([
  'nothing_to_say',
  'needs_team',
  'agent_off',
  'ai_disconnected',
  'wa_disconnected',
  'access_closed',
  'window_closed',
  'missed',
  'chat_gone',
  'confidential_leak',
  'ai_unavailable',
  'lookup_failed',
  'send_failed',
  'interrupted',
]);
export type ScheduledRunReason = z.infer<typeof ScheduledRunReason>;

/** What pauses every task of an agent right now. */
export const ScheduledPausedReason = z.enum([
  'agent_off',
  'ai_disconnected',
  'wa_disconnected',
  'access_closed',
]);
export type ScheduledPausedReason = z.infer<typeof ScheduledPausedReason>;

export const ScheduledRun = z.object({
  id: z.number().int(),
  /** The scheduled time (Run now: when it was pressed), epoch ms. */
  at: z.number(),
  trigger: z.enum(['schedule', 'run_now']),
  /** Run now: the admin's display name. */
  byUserName: z.string().nullable(),
  result: ScheduledRunResult.nullable(),
  reason: ScheduledRunReason.nullable(),
  /** The message it sent (sent runs). */
  messageId: z.string().nullable(),
});
export type ScheduledRun = z.infer<typeof ScheduledRun>;

export const ScheduledTaskChat = z.object({
  jid: z.string(),
  name: z.string(),
  type: z.enum(['dm', 'group']),
});
export type ScheduledTaskChat = z.infer<typeof ScheduledTaskChat>;

export const ScheduledTask = z.object({
  id: z.number().int(),
  agentId: z.number().int(),
  ...ScheduledTaskFields,
  /** The chat as the list shows it; null when it is no longer in the agent's inbox. */
  chat: ScheduledTaskChat.nullable(),
  /** Next scheduled time (epoch ms), null when off or no day is chosen. */
  nextRunAt: z.number().nullable(),
  lastRun: ScheduledRun.nullable(),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

/** `GET /api/ai/agents/:agentId/scheduled-tasks` (admins). */
export const ScheduledTasksResponse = z.object({
  tasks: z.array(ScheduledTask),
  max: z.number().int().positive(),
  paused: ScheduledPausedReason.nullable(),
  /** The business time zone the times are read in (`ai_timezone`). */
  timeZone: z.string(),
  /** The agent's inbox; null when the agent serves none (tasks cannot run). */
  inboxId: z.number().int().nullable(),
});
export type ScheduledTasksResponse = z.infer<typeof ScheduledTasksResponse>;

/** `GET …/scheduled-tasks/:taskId/runs` (admins): newest first, at most `SCHEDULED_RUNS_SHOWN`. */
export const ScheduledRunsResponse = z.object({ runs: z.array(ScheduledRun) });
export type ScheduledRunsResponse = z.infer<typeof ScheduledRunsResponse>;

/** `POST …/scheduled-tasks/preview` (admins): one turn, nothing sent or stored. */
export const ScheduledPreviewBody = z.strictObject({
  chatJid: ScheduledTaskFields.chatJid,
  instruction: ScheduledTaskFields.instruction,
});
export type ScheduledPreviewBody = z.infer<typeof ScheduledPreviewBody>;

export const ScheduledLookup = z.object({ title: z.string(), sourceLabel: z.string() });

export const ScheduledPreviewResponse = z.object({
  result: z.enum(['sent', 'skipped']),
  text: z.string().nullable(),
  reason: ScheduledRunReason.nullable(),
  lookups: z.array(ScheduledLookup),
});
export type ScheduledPreviewResponse = z.infer<typeof ScheduledPreviewResponse>;

/** `POST …/scheduled-tasks/:taskId/run` (admins): the run as recorded. */
export const ScheduledRunNowResponse = z.object({ run: ScheduledRun });
export type ScheduledRunNowResponse = z.infer<typeof ScheduledRunNowResponse>;

/** The "Scheduled · <task>" mark on a message a task sent; `name` null once the task is deleted. */
export const MessageScheduledTask = z.object({ id: z.number().int(), name: z.string().nullable() });
export type MessageScheduledTask = z.infer<typeof MessageScheduledTask>;

/** The days a task runs on (0 = Sunday). */
export function scheduledRunDays(task: { dayRule: ScheduledDayRule; days: readonly number[] }) {
  if (task.dayRule === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (task.dayRule === 'weekdays') return [1, 2, 3, 4, 5];
  return [...new Set(task.days)].sort((a, b) => a - b);
}

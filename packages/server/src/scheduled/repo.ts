import type { ScheduledDayRule, ScheduledRunReason, ScheduledRunResult } from '@ezychat/shared';
import type { DB } from '../db/index.js';
import { fromDayBits } from './time.js';

/** The only SQL of scheduled tasks (tables `ai_scheduled_tasks`, `ai_scheduled_runs`, migration 036). */
export interface TaskRow {
  id: number;
  agentId: number;
  name: string;
  enabled: boolean;
  timeMinutes: number;
  dayRule: ScheduledDayRule;
  days: number[];
  chatJid: string;
  instruction: string;
  createdAt: number;
  updatedAt: number;
}

export type RunState = 'running' | ScheduledRunResult;

export interface RunRow {
  id: number;
  taskId: number;
  slot: number;
  trigger: 'schedule' | 'run_now';
  byUserId: number | null;
  byUserName: string | null;
  state: RunState;
  reason: ScheduledRunReason | null;
  messageId: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface RawTask {
  id: number;
  agent_id: number;
  name: string;
  enabled: number;
  time_minutes: number;
  day_rule: ScheduledDayRule;
  days: number;
  chat_jid: string;
  instruction: string;
  created_at: number;
  updated_at: number;
}

interface RawRun {
  id: number;
  task_id: number;
  slot: number;
  trigger: 'schedule' | 'run_now';
  by_user_id: number | null;
  by_user_name: string | null;
  state: RunState;
  reason: ScheduledRunReason | null;
  message_id: string | null;
  started_at: number;
  finished_at: number | null;
}

const task = (r: RawTask): TaskRow => ({
  id: r.id,
  agentId: r.agent_id,
  name: r.name,
  enabled: r.enabled === 1,
  timeMinutes: r.time_minutes,
  dayRule: r.day_rule,
  days: fromDayBits(r.days),
  chatJid: r.chat_jid,
  instruction: r.instruction,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const run = (r: RawRun): RunRow => ({
  id: r.id,
  taskId: r.task_id,
  slot: r.slot,
  trigger: r.trigger,
  byUserId: r.by_user_id,
  byUserName: r.by_user_name,
  state: r.state,
  reason: r.reason,
  messageId: r.message_id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const RUN_SELECT = `SELECT r.*, u.display_name AS by_user_name FROM ai_scheduled_runs r
  LEFT JOIN users u ON u.id = r.by_user_id`;

export class ScheduledRepo {
  constructor(private readonly db: DB) {}

  list(agentId: number): TaskRow[] {
    return (
      this.db
        .prepare('SELECT * FROM ai_scheduled_tasks WHERE agent_id = ? ORDER BY id')
        .all(agentId) as RawTask[]
    ).map(task);
  }

  enabled(): TaskRow[] {
    return (
      this.db
        .prepare('SELECT * FROM ai_scheduled_tasks WHERE enabled = 1 ORDER BY id')
        .all() as RawTask[]
    ).map(task);
  }

  get(id: number): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM ai_scheduled_tasks WHERE id = ?').get(id) as
      RawTask | undefined;
    return row ? task(row) : null;
  }

  count(agentId: number): number {
    return this.db
      .prepare('SELECT COUNT(*) FROM ai_scheduled_tasks WHERE agent_id = ?')
      .pluck()
      .get(agentId) as number;
  }

  insert(
    t: Omit<TaskRow, 'id' | 'createdAt' | 'updatedAt' | 'days'> & { dayBits: number },
    createdBy: number | null,
    now: number,
  ): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO ai_scheduled_tasks (agent_id, name, enabled, time_minutes, day_rule, days, chat_jid,
             instruction, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          t.agentId,
          t.name,
          t.enabled ? 1 : 0,
          t.timeMinutes,
          t.dayRule,
          t.dayBits,
          t.chatJid,
          t.instruction,
          createdBy,
          now,
          now,
        ).lastInsertRowid,
    );
  }

  update(
    id: number,
    t: Pick<TaskRow, 'name' | 'enabled' | 'timeMinutes' | 'dayRule' | 'chatJid' | 'instruction'> & {
      dayBits: number;
    },
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE ai_scheduled_tasks SET name = ?, enabled = ?, time_minutes = ?, day_rule = ?, days = ?,
           chat_jid = ?, instruction = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        t.name,
        t.enabled ? 1 : 0,
        t.timeMinutes,
        t.dayRule,
        t.dayBits,
        t.chatJid,
        t.instruction,
        now,
        id,
      );
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM ai_scheduled_tasks WHERE id = ?').run(id);
  }

  /** Turns every task of an agent off (agent re-bound, its inbox removed). Returns how many. */
  disableAgent(agentId: number, now: number): number {
    return this.db
      .prepare(
        'UPDATE ai_scheduled_tasks SET enabled = 0, updated_at = ? WHERE agent_id = ? AND enabled = 1',
      )
      .run(now, agentId).changes;
  }

  /** Moves tasks to the surviving chat of a merge (chats/merge.ts). */
  moveChat(from: string, to: string): number {
    return this.db
      .prepare('UPDATE ai_scheduled_tasks SET chat_jid = ? WHERE chat_jid = ?')
      .run(to, from).changes;
  }

  /**
   * Claims a scheduled slot: inserts the run as `running` unless the slot already has a row.
   * Returns the run id, or null when another tick (or an earlier start) took it.
   */
  claimSlot(taskId: number, slot: number, now: number): number | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO ai_scheduled_runs (task_id, slot, trigger, state, started_at)
           VALUES (?, ?, 'schedule', 'running', ?)`,
      )
      .run(taskId, slot, now);
    return info.changes ? Number(info.lastInsertRowid) : null;
  }

  hasSlot(taskId: number, slot: number): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM ai_scheduled_runs WHERE task_id = ? AND slot = ? AND trigger = 'schedule'",
      )
      .get(taskId, slot);
  }

  /** A run recorded straight away (missed, or skipped before a turn). */
  insertFinished(
    taskId: number,
    slot: number,
    trigger: 'schedule' | 'run_now',
    byUserId: number | null,
    state: ScheduledRunResult,
    reason: ScheduledRunReason | null,
    now: number,
  ): number | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO ai_scheduled_runs (task_id, slot, trigger, by_user_id, state, reason, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, slot, trigger, byUserId, state, reason, now, now);
    return info.changes ? Number(info.lastInsertRowid) : null;
  }

  startRunNow(taskId: number, byUserId: number, now: number): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO ai_scheduled_runs (task_id, slot, trigger, by_user_id, state, started_at)
             VALUES (?, ?, 'run_now', ?, 'running', ?)`,
        )
        .run(taskId, now, byUserId, now).lastInsertRowid,
    );
  }

  finish(
    runId: number,
    state: ScheduledRunResult,
    reason: ScheduledRunReason | null,
    messageId: string | null,
    now: number,
  ): void {
    this.db
      .prepare(
        'UPDATE ai_scheduled_runs SET state = ?, reason = ?, message_id = ?, finished_at = ? WHERE id = ?',
      )
      .run(state, reason, messageId, now, runId);
  }

  getRun(id: number): RunRow | null {
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as RawRun | undefined;
    return row ? run(row) : null;
  }

  runs(taskId: number, limit: number): RunRow[] {
    return (
      this.db
        .prepare(`${RUN_SELECT} WHERE r.task_id = ? ORDER BY r.slot DESC, r.id DESC LIMIT ?`)
        .all(taskId, limit) as RawRun[]
    ).map(run);
  }

  /** Run now presses since `since`: of one task, or of one admin across tasks. */
  runNowCount(filter: { taskId?: number; byUserId?: number }, since: number): number {
    if (filter.taskId !== undefined)
      return this.db
        .prepare(
          "SELECT COUNT(*) FROM ai_scheduled_runs WHERE task_id = ? AND trigger = 'run_now' AND started_at >= ?",
        )
        .pluck()
        .get(filter.taskId, since) as number;
    return this.db
      .prepare(
        "SELECT COUNT(*) FROM ai_scheduled_runs WHERE by_user_id = ? AND trigger = 'run_now' AND started_at >= ?",
      )
      .pluck()
      .get(filter.byUserId ?? -1, since) as number;
  }

  /** Keeps the newest `keep` runs of a task. */
  prune(taskId: number, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM ai_scheduled_runs WHERE task_id = ? AND id NOT IN
           (SELECT id FROM ai_scheduled_runs WHERE task_id = ? ORDER BY slot DESC, id DESC LIMIT ?)`,
      )
      .run(taskId, taskId, keep);
  }

  /** A crash left runs `running`: they become failed/interrupted at start. */
  sweepInterrupted(now: number): number {
    return this.db
      .prepare(
        "UPDATE ai_scheduled_runs SET state = 'failed', reason = 'interrupted', finished_at = ? WHERE state = 'running'",
      )
      .run(now).changes;
  }
}

import {
  SCHEDULED_GRACE_MS,
  SCHEDULED_RUN_NOW_PER_ADMIN_HOUR,
  SCHEDULED_RUN_NOW_PER_TASK_HOUR,
  SCHEDULED_RUNS_KEPT,
  SCHEDULED_RUNS_SHOWN,
  SCHEDULED_TASKS_MAX,
  type ScheduledPausedReason,
  type ScheduledPreviewBody,
  type ScheduledPreviewResponse,
  type ScheduledRun,
  type ScheduledRunReason,
  type ScheduledRunsResponse,
  type ScheduledTask,
  type ScheduledTaskBody,
  type ScheduledTaskPatch,
  type ScheduledTasksResponse,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { agentById, type AgentRow } from '../ai/agents.js';
import { AI_TIMEZONE_SETTING, resolveAiTimeZone } from '../ai/prompt.js';
import { audit } from '../db/audit.js';
import { errors, HttpError } from '../http/errors.js';
import { inboxOfKey } from '../inboxes/keys.js';
import { replyWindowOpen } from '../inboxes/reply-window.js';
import { getChats, getMessages } from '../wa-bridge/index.js';
import { ScheduledRepo, type RunRow, type TaskRow } from './repo.js';
import { latestSlot, nextSlot, toDayBits, toMinutes, toTime } from './time.js';

/** How often the scheduler looks for due tasks, and its first look after start. */
export const SCHEDULED_TICK_MS = 30_000;
export const SCHEDULED_START_DELAY_MS = 20_000;
/** How long a scheduled message may wait in the send queue before the run counts as failed. */
export const SCHEDULED_SEND_TIMEOUT_MS = 65_000;
/** Previews per admin per minute. */
export const SCHEDULED_PREVIEWS_PER_MINUTE = 20;

const HOUR = 3_600_000;

interface Actor {
  userId: number;
  ip: string | null;
}

export interface ScheduledService {
  list(agentId: number): ScheduledTasksResponse;
  create(agentId: number, body: ScheduledTaskBody, actor: Actor): ScheduledTask;
  update(agentId: number, taskId: number, patch: ScheduledTaskPatch, actor: Actor): ScheduledTask;
  remove(agentId: number, taskId: number, actor: Actor): void;
  runs(agentId: number, taskId: number): ScheduledRunsResponse;
  runNow(agentId: number, taskId: number, actor: Actor): Promise<ScheduledRun>;
  preview(
    agentId: number,
    body: ScheduledPreviewBody,
    actor: Actor,
  ): Promise<ScheduledPreviewResponse>;
  /** The send queue asks before it sends a scheduled message: the task and its agent may still. */
  canSend(taskId: number): boolean;
  /** One scheduler pass (the timer calls it; tests call it with a fake clock). */
  tick(): Promise<void>;
  /** Waits for runs started by the last ticks (tests). */
  idle(): Promise<void>;
  shutdown(): Promise<void>;
}

declare module '../context.js' {
  interface Services {
    scheduled?: ScheduledService;
  }
}

const scheduledError = (status: number, code: string, message: string) =>
  new HttpError(status, code, message);

/**
 * Scheduled tasks for AI agents (docs/features/scheduled-tasks/design.md). A timer looks every 30 s
 * for enabled tasks whose latest scheduled time (business time zone) has no run yet: inside the
 * 15-minute grace it claims the slot (unique per task and slot, so once per time) and runs one agent
 * turn for the task's chat, then sends its one message; later, the slot is recorded as missed (no
 * catch-up). Paused while the agent is off, the access gate is closed, the AI is not connected or the
 * inbox's WhatsApp is not connected. Logs and audit hold ids and reasons only, never text.
 */
export function createScheduledService(
  ctx: AppContext,
  deps: { now?: () => number; timers?: boolean } = {},
): ScheduledService {
  const now = deps.now ?? Date.now;
  const repo = new ScheduledRepo(ctx.db);
  const chats = getChats(ctx);
  const messages = getMessages(ctx);
  const log = ctx.log.child({ mod: 'scheduled' });
  const running = new Set<Promise<unknown>>();
  const abort = new AbortController();
  const previews = new Map<number, number[]>();
  let closed = false;
  let ticking = false;

  const timeZone = () => resolveAiTimeZone(ctx.settings.get<unknown>(AI_TIMEZONE_SETTING, null));

  const agentOf = (agentId: number): AgentRow => {
    const agent = agentById(ctx.db, agentId);
    if (!agent) throw errors.notFound('AI agent');
    return agent;
  };
  const taskOf = (agentId: number, taskId: number): TaskRow => {
    const task = repo.get(taskId);
    if (!task || task.agentId !== agentId) throw errors.notFound('Scheduled task');
    return task;
  };

  /** What pauses every task of the agent now; null = they run. */
  const pausedFor = (agent: AgentRow | null): ScheduledPausedReason | null => {
    if (!agent || !agent.enabled || agent.inboxId === null) return 'agent_off';
    if (!ctx.access.state().open) return 'access_closed';
    if (!ctx.services.ai?.answerReady()) return 'ai_disconnected';
    let state: string | undefined;
    try {
      state = ctx.inboxes.connections.adapter(agent.inboxId).status.state;
    } catch {
      state = undefined;
    }
    return state === 'open' ? null : 'wa_disconnected';
  };

  /** The task's chat when it is still a chat of the agent's (active) inbox; else null. */
  const chatOf = (agent: AgentRow, jid: string) => {
    const chat = chats.get(jid);
    if (!chat || agent.inboxId === null) return null;
    let inboxId: number;
    try {
      inboxId = inboxOfKey(jid);
    } catch {
      return null;
    }
    if (inboxId !== agent.inboxId) return null;
    const inbox = ctx.inboxes.repo.get(inboxId);
    if (!inbox || inbox.removed_at !== null) return null;
    return chat;
  };

  const requireChat = (agent: AgentRow, jid: string) => {
    const chat = chatOf(agent, jid);
    if (!chat)
      throw scheduledError(
        400,
        'chat_not_in_inbox',
        "Choose a chat or group of this agent's inbox",
      );
    return chat;
  };

  const toRun = (r: RunRow): ScheduledRun => ({
    id: r.id,
    at: r.slot,
    trigger: r.trigger,
    byUserName: r.byUserName,
    result: r.state === 'running' ? null : r.state,
    reason: r.reason,
    messageId: r.messageId,
  });

  const present = (agent: AgentRow, task: TaskRow): ScheduledTask => {
    const chat = chatOf(agent, task.chatJid);
    const last = repo.runs(task.id, 1)[0];
    return {
      id: task.id,
      agentId: task.agentId,
      name: task.name,
      enabled: task.enabled,
      time: toTime(task.timeMinutes),
      dayRule: task.dayRule,
      days: task.dayRule === 'custom' ? task.days : [],
      chatJid: task.chatJid,
      instruction: task.instruction,
      chat: chat
        ? {
            jid: chat.jid,
            name: chat.name?.trim() || chat.phone || chat.jid,
            type: chat.type === 'group' ? 'group' : 'dm',
          }
        : null,
      nextRunAt: task.enabled ? nextSlot(schedule(task), now(), timeZone()) : null,
      lastRun: last ? toRun(last) : null,
    };
  };

  const schedule = (task: Pick<TaskRow, 'timeMinutes' | 'dayRule' | 'days'>) => ({
    timeMinutes: task.timeMinutes,
    dayRule: task.dayRule,
    days: task.days,
  });

  /** Sends the text as the agent with the task's mark and waits until WhatsApp took it. */
  const send = async (agent: AgentRow, task: TaskRow, runId: number, text: string) => {
    const clientId = `sched-${runId}`;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        ctx.bus.off('message:status', onStatus);
      };
      const onStatus = (event: { clientId: string | null; status: string }) => {
        if (event.clientId !== clientId) return;
        if (['sent', 'delivered', 'read'].includes(event.status)) {
          cleanup();
          resolve();
        } else if (event.status === 'failed') {
          cleanup();
          reject(new Error('send_failed'));
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('send_failed'));
      }, SCHEDULED_SEND_TIMEOUT_MS);
      timeout.unref?.();
      ctx.bus.on('message:status', onStatus);
      try {
        const message = messages.sendText(task.chatJid, { text, clientId }, agent.userId, {
          scheduledTaskId: task.id,
        });
        if (['sent', 'delivered', 'read'].includes(message.status)) {
          cleanup();
          resolve();
        }
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error('send_failed'));
      }
    });
    return messages.byClientId(clientId)?.id ?? null;
  };

  /** One run of a task whose run row is already claimed (`running`): turn, checks, send, record. */
  const execute = async (task: TaskRow, runId: number, trigger: 'schedule' | 'run_now') => {
    const started = now();
    const finish = (
      state: 'sent' | 'skipped' | 'failed',
      reason: ScheduledRunReason | null,
      messageId: string | null = null,
    ) => {
      repo.finish(runId, state, reason, messageId, now());
      repo.prune(task.id, SCHEDULED_RUNS_KEPT);
      log.info(
        {
          event: 'scheduled_run',
          taskId: task.id,
          runId,
          agentId: task.agentId,
          trigger,
          result: state,
          reason,
          ms: now() - started,
        },
        'Scheduled task run',
      );
    };
    const blocked = (): ScheduledRunReason | null => {
      const agent = agentById(ctx.db, task.agentId);
      const paused = pausedFor(agent);
      if (paused) return paused;
      if (!chatOf(agent!, task.chatJid)) return 'chat_gone';
      if (!replyWindowOpen(ctx, task.chatJid, now())) return 'window_closed';
      return null;
    };
    try {
      const before = blocked();
      if (before) return finish('skipped', before);
      const turn = await ctx.services.ai!.scheduledTurn(
        {
          agentId: task.agentId,
          chatJid: task.chatJid,
          task: { name: task.name, instruction: task.instruction },
          preview: false,
        },
        abort.signal,
      );
      if (turn.outcome === 'fail') return finish('failed', turn.reason ?? 'ai_unavailable');
      if (turn.outcome === 'skip' || !turn.text)
        return finish('skipped', turn.reason ?? 'nothing_to_say');
      // The world may have moved during the turn (agent turned off, task deleted or edited).
      const current = repo.get(task.id);
      if (!current) return;
      const after = blocked();
      if (after) return finish('skipped', after);
      const agent = agentById(ctx.db, task.agentId)!;
      if (turn.lookups.length) chats.addAiToolUsed(task.chatJid, agent.userId, turn.lookups);
      try {
        const messageId = await send(agent, current, runId, turn.text);
        return finish('sent', null, messageId);
      } catch (error) {
        const code = error instanceof HttpError ? error.code : null;
        const message = error instanceof Error ? error.message : '';
        if (message.includes('window') || code === 'window_closed')
          return finish('skipped', 'window_closed');
        if (error instanceof HttpError && error.status === 409)
          return finish('skipped', 'chat_gone');
        return finish('failed', 'send_failed');
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      log.warn(
        { event: 'scheduled_run_error', taskId: task.id, runId },
        'Scheduled task run failed',
      );
      log.debug(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'Scheduled run error',
      );
      finish('failed', 'ai_unavailable');
    }
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    running.add(p);
    void p.finally(() => running.delete(p));
    return p;
  };

  const tick = async () => {
    if (closed || ticking) return;
    ticking = true;
    try {
      const at = now();
      const zone = timeZone();
      for (const task of repo.enabled()) {
        const slot = latestSlot(schedule(task), at, zone);
        // A task created, edited or turned on after that time does not run for it.
        if (slot === null || slot < task.updatedAt || repo.hasSlot(task.id, slot)) continue;
        const agent = agentById(ctx.db, task.agentId);
        const paused = pausedFor(agent);
        if (at - slot > SCHEDULED_GRACE_MS) {
          repo.insertFinished(task.id, slot, 'schedule', null, 'skipped', paused ?? 'missed', at);
          log.info(
            {
              event: 'scheduled_run',
              taskId: task.id,
              result: 'skipped',
              reason: paused ?? 'missed',
            },
            'Scheduled task run',
          );
          continue;
        }
        // Paused: the slot waits (inside the grace it still runs once the pause ends).
        if (paused) continue;
        const runId = repo.claimSlot(task.id, slot, at);
        if (runId === null) continue;
        void track(execute(task, runId, 'schedule'));
      }
    } finally {
      ticking = false;
    }
  };

  const audited = (actor: Actor, action: string, meta: Record<string, unknown>) =>
    audit(ctx.db, { userId: actor.userId, action, ip: actor.ip, meta });

  const service: ScheduledService = {
    list(agentId) {
      const agent = agentOf(agentId);
      return {
        tasks: repo.list(agentId).map((task) => present(agent, task)),
        max: SCHEDULED_TASKS_MAX,
        paused: pausedFor(agent),
        timeZone: timeZone(),
        inboxId: agent.inboxId,
      };
    },
    create(agentId, body, actor) {
      const agent = agentOf(agentId);
      if (repo.count(agentId) >= SCHEDULED_TASKS_MAX)
        throw scheduledError(
          409,
          'scheduled_task_limit',
          `An agent can have at most ${SCHEDULED_TASKS_MAX} scheduled tasks`,
        );
      requireChat(agent, body.chatJid);
      const id = repo.insert(
        {
          agentId,
          name: body.name,
          enabled: body.enabled,
          timeMinutes: toMinutes(body.time),
          dayRule: body.dayRule,
          dayBits: body.dayRule === 'custom' ? toDayBits(body.days) : 0,
          chatJid: body.chatJid,
          instruction: body.instruction,
        },
        actor.userId,
        now(),
      );
      audited(actor, 'scheduled_task.create', { agentId, taskId: id, chatJid: body.chatJid });
      return present(agent, repo.get(id)!);
    },
    update(agentId, taskId, patch, actor) {
      const agent = agentOf(agentId);
      const task = taskOf(agentId, taskId);
      const next = {
        name: patch.name ?? task.name,
        enabled: patch.enabled ?? task.enabled,
        timeMinutes: patch.time !== undefined ? toMinutes(patch.time) : task.timeMinutes,
        dayRule: patch.dayRule ?? task.dayRule,
        days: patch.days ?? task.days,
        chatJid: patch.chatJid ?? task.chatJid,
        instruction: patch.instruction ?? task.instruction,
      };
      if (next.dayRule === 'custom' && next.days.length === 0)
        throw errors.validation('days: Choose at least one day');
      if (patch.chatJid !== undefined) requireChat(agent, patch.chatJid);
      repo.update(
        taskId,
        { ...next, dayBits: next.dayRule === 'custom' ? toDayBits(next.days) : 0 },
        now(),
      );
      audited(actor, 'scheduled_task.update', {
        agentId,
        taskId,
        chatJid: next.chatJid,
        fields: Object.keys(patch),
      });
      return present(agent, repo.get(taskId)!);
    },
    remove(agentId, taskId, actor) {
      const task = taskOf(agentId, taskId);
      repo.remove(taskId);
      audited(actor, 'scheduled_task.delete', { agentId, taskId, chatJid: task.chatJid });
    },
    runs(agentId, taskId) {
      taskOf(agentId, taskId);
      return { runs: repo.runs(taskId, SCHEDULED_RUNS_SHOWN).map(toRun) };
    },
    async runNow(agentId, taskId, actor) {
      const agent = agentOf(agentId);
      const task = taskOf(agentId, taskId);
      const since = now() - HOUR;
      if (
        repo.runNowCount({ taskId }, since) >= SCHEDULED_RUN_NOW_PER_TASK_HOUR ||
        repo.runNowCount({ byUserId: actor.userId }, since) >= SCHEDULED_RUN_NOW_PER_ADMIN_HOUR
      )
        throw scheduledError(429, 'rate_limited', 'This task ran too often in the last hour');
      const paused = pausedFor(agent);
      if (paused)
        throw scheduledError(409, 'scheduled_paused', `Scheduled tasks are paused: ${paused}`);
      const runId = repo.startRunNow(taskId, actor.userId, now());
      audited(actor, 'scheduled_task.run_now', { agentId, taskId, runId, chatJid: task.chatJid });
      await track(execute(task, runId, 'run_now'));
      return toRun(repo.getRun(runId)!);
    },
    async preview(agentId, body, actor) {
      const agent = agentOf(agentId);
      const at = now();
      const recent = (previews.get(actor.userId) ?? []).filter((t) => at - t < 60_000);
      if (recent.length >= SCHEDULED_PREVIEWS_PER_MINUTE) throw errors.rateLimited(60);
      previews.set(actor.userId, [...recent, at]);
      requireChat(agent, body.chatJid);
      if (!ctx.services.ai?.answerReady())
        return { result: 'skipped', text: null, reason: 'ai_disconnected', lookups: [] };
      if (!replyWindowOpen(ctx, body.chatJid, at))
        return { result: 'skipped', text: null, reason: 'window_closed', lookups: [] };
      const turn = await ctx.services.ai.scheduledTurn(
        {
          agentId,
          chatJid: body.chatJid,
          task: { name: 'Preview', instruction: body.instruction },
          preview: true,
        },
        AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      );
      const lookups = turn.lookups.map((l) => ({ title: l.title, sourceLabel: l.sourceLabel }));
      return turn.outcome === 'send' && turn.text
        ? { result: 'sent', text: turn.text, reason: null, lookups }
        : {
            result: 'skipped',
            text: null,
            reason: turn.reason ?? 'nothing_to_say',
            lookups,
          };
    },
    canSend(taskId) {
      const task = repo.get(taskId);
      if (!task) return false;
      const agent = agentById(ctx.db, task.agentId);
      return !!agent && agent.enabled && ctx.access.state().open;
    },
    tick,
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },
    async shutdown() {
      closed = true;
      clearTimeout(first);
      clearInterval(every);
      abort.abort();
      await Promise.allSettled([...running]);
    },
  };

  // Runs a crash left behind never finish: record them, then start the timer.
  const swept = repo.sweepInterrupted(now());
  if (swept)
    log.info({ event: 'scheduled_sweep', runs: swept }, 'Interrupted scheduled runs recorded');
  let every: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  if (deps.timers !== false) {
    first = setTimeout(() => {
      void tick();
      every = setInterval(() => void tick(), SCHEDULED_TICK_MS);
      every.unref?.();
    }, SCHEDULED_START_DELAY_MS);
    first.unref?.();
  }
  return service;
}

export function initScheduled(ctx: AppContext): void {
  if (ctx.services.ai) ctx.services.scheduled = createScheduledService(ctx);
}

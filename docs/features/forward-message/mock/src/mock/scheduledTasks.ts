import { useSyncExternalStore } from 'react';

/**
 * Proposed (scheduled-tasks): stand-in for `/api/ai/agents/:agentId/scheduled-tasks*`. Tasks, the run
 * history and the Mock only switches are kept in this browser (localStorage). Run now posts the
 * agent's message to `/api/mock/scheduled-tasks/send` so it appears in the real chat with the
 * "Scheduled" mark. Nothing calls a model: the message is built from the instruction's words.
 * Production plan and limits: ../../design.md.
 */
export type DayRule = 'daily' | 'weekdays' | 'custom';
export type RunResult = 'sent' | 'skipped' | 'failed';
export type RunReason =
  | 'nothing_to_say'
  | 'agent_off'
  | 'ai_disconnected'
  | 'wa_disconnected'
  | 'window_closed'
  | 'missed'
  | 'chat_gone'
  | 'ai_unavailable'
  | 'lookup_failed'
  | 'send_failed';

export interface TaskChat {
  jid: string;
  name: string;
  type: 'dm' | 'group';
}

export interface ScheduledTask {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  /** HH:MM in the business time zone (Settings → AI). */
  time: string;
  dayRule: DayRule;
  /** 0 = Sunday … 6 = Saturday; used when dayRule = custom. */
  days: number[];
  chat: TaskChat;
  instruction: string;
  createdAt: number;
}

export interface TaskRun {
  id: string;
  taskId: string;
  at: number;
  /** schedule = at its time; run_now = an admin pressed Run now. */
  trigger: 'schedule' | 'run_now';
  by: string | null;
  result: RunResult;
  reason: RunReason | null;
  /** What was sent (kept only in this mock; production keeps the message id, never the text). */
  text: string | null;
}

export interface Conditions {
  aiConnected: boolean;
  waConnected: boolean;
  /** Mock only: the calendar / sheet has nothing for today. */
  nothingToday: boolean;
  /** Mock only: the chat is on a WhatsApp Business API inbox whose 24 h window is closed. */
  windowClosed: boolean;
}

interface State {
  tasks: ScheduledTask[];
  runs: TaskRun[];
  conditions: Conditions;
  /** Run now presses per task (times), for the 3-an-hour limit. */
  runNow: Record<string, number[]>;
}

export const MAX_TASKS = 10;
export const RUN_NOW_PER_HOUR = 3;
export const TIME_ZONE = 'Asia/Kuala_Lumpur';
export const INSTRUCTION_CHARACTERS = 1000;
export const NAME_CHARACTERS = 60;

export const STAFF_GROUP: TaskChat = {
  jid: '120363025550005@g.us',
  name: 'Kopi Apong Staff',
  type: 'group',
};
const FARAH: TaskChat = { jid: '60123110021@s.whatsapp.net', name: 'Farah Aziz', type: 'dm' };
const FAMILY_DAY: TaskChat = {
  jid: '120363025550004@g.us',
  name: 'Family Day 2026',
  type: 'group',
};

// Bump the key whenever the seed changes, so open browsers load the new demo data.
const KEY = 'mock.scheduledTasks.v1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const at = (daysAgo: number, hh: number, mm: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
};

export const SEED_BOOKINGS_TEXT = [
  "Good morning team ☀️ Today's bookings (Thu 5 Nov):",
  '• 10:00 am – Farah Aziz, 4 pax, birthday cake',
  '• 12:30 pm – Anchor Sprint lunch, 12 pax (set B)',
  '• 7:30 pm – Tan Wei Jie, 2 pax, window seat',
  'Have a good shift!',
].join('\n');

function seed(): State {
  const tasks: ScheduledTask[] = [
    {
      id: 'st-bookings',
      agentId: 'a1',
      name: 'Morning bookings',
      enabled: true,
      time: '08:30',
      dayRule: 'weekdays',
      days: [1, 2, 3, 4, 5],
      chat: STAFF_GROUP,
      instruction:
        "Tell the team today's bookings from Google Calendar: time, name, number of people and any notes. Skip if there are no bookings.",
      createdAt: at(20, 10, 0),
    },
    {
      id: 'st-beans',
      agentId: 'a1',
      name: 'Bean order reminder',
      enabled: true,
      time: '09:00',
      dayRule: 'custom',
      days: [1, 4],
      chat: FARAH,
      instruction:
        'Remind Farah that orders for her weekly coffee beans close at 12 noon today, and ask if she wants the usual 2 kg.',
      createdAt: at(12, 15, 0),
    },
    {
      id: 'st-overdue',
      agentId: 'a1',
      name: 'Family Day overdue tasks',
      enabled: false,
      time: '17:00',
      dayRule: 'daily',
      days: [0, 1, 2, 3, 4, 5, 6],
      chat: FAMILY_DAY,
      instruction:
        'List the overdue tasks from the Family Day sheet with who owns each one. Skip if nothing is overdue.',
      createdAt: at(6, 11, 0),
    },
  ];
  const run = (
    taskId: string,
    when: number,
    result: RunResult,
    reason: RunReason | null,
    text: string | null = null,
    trigger: TaskRun['trigger'] = 'schedule',
    by: string | null = null,
  ): TaskRun => ({
    id: `r-${taskId}-${when}`,
    taskId,
    at: when,
    trigger,
    by,
    result,
    reason,
    text,
  });
  const runs: TaskRun[] = [
    run('st-bookings', at(1, 8, 30), 'sent', null, SEED_BOOKINGS_TEXT),
    run('st-bookings', at(2, 8, 30), 'skipped', 'nothing_to_say'),
    run('st-bookings', at(3, 8, 30), 'skipped', 'wa_disconnected'),
    run('st-bookings', at(4, 8, 30), 'failed', 'ai_unavailable'),
    run('st-bookings', at(7, 8, 30), 'skipped', 'missed'),
    run('st-bookings', at(8, 8, 30), 'sent', null, "Good morning team ☀️ Today's bookings: …"),
    run(
      'st-beans',
      at(3, 9, 0),
      'sent',
      null,
      'Hi Farah! Orders for your weekly coffee beans close at 12 noon today. Would you like the usual 2 kg?',
    ),
    run('st-beans', at(6, 9, 0), 'skipped', 'agent_off'),
    run('st-overdue', at(7, 17, 0), 'failed', 'lookup_failed'),
  ];
  return {
    tasks,
    runs,
    conditions: { aiConnected: true, waConnected: true, nothingToday: false, windowClosed: false },
    runNow: {},
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // Private window or blocked storage: start from the seed.
  }
  return seed();
}

let state: State = load();
const listeners = new Set<() => void>();
function set(next: State) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Keep working in memory.
  }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useScheduledTasks(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export function tasksOf(s: State, agentId: string): ScheduledTask[] {
  return s.tasks.filter((task) => task.agentId === agentId);
}

export function runsOf(s: State, taskId: string): TaskRun[] {
  return s.runs.filter((r) => r.taskId === taskId).sort((a, b) => b.at - a.at);
}

const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type TaskDraft = Omit<ScheduledTask, 'id' | 'agentId' | 'createdAt'>;

export function saveTask(agentId: string, id: string | null, draft: TaskDraft): ScheduledTask {
  if (id) {
    const tasks = state.tasks.map((task) => (task.id === id ? { ...task, ...draft } : task));
    set({ ...state, tasks });
    return tasks.find((task) => task.id === id)!;
  }
  const task: ScheduledTask = { ...draft, id: newId('st'), agentId, createdAt: Date.now() };
  set({ ...state, tasks: [...state.tasks, task] });
  return task;
}

export function setTaskEnabled(id: string, enabled: boolean) {
  set({ ...state, tasks: state.tasks.map((t) => (t.id === id ? { ...t, enabled } : t)) });
}

export function deleteTask(id: string) {
  set({
    ...state,
    tasks: state.tasks.filter((t) => t.id !== id),
    runs: state.runs.filter((r) => r.taskId !== id),
  });
}

export function setConditions(patch: Partial<Conditions>) {
  set({ ...state, conditions: { ...state.conditions, ...patch } });
}

export function addRun(run: Omit<TaskRun, 'id'>) {
  set({ ...state, runs: [{ ...run, id: newId('r') }, ...state.runs].slice(0, 400) });
}

/** Run now presses left this hour for one task (3 an hour). */
export function runNowLeft(s: State, taskId: string, now = Date.now()): number {
  const recent = (s.runNow[taskId] ?? []).filter((t) => now - t < HOUR);
  return Math.max(0, RUN_NOW_PER_HOUR - recent.length);
}

export function noteRunNow(taskId: string, now = Date.now()) {
  const recent = (state.runNow[taskId] ?? []).filter((t) => now - t < HOUR);
  set({ ...state, runNow: { ...state.runNow, [taskId]: [...recent, now] } });
}

/** Mock only: fills an agent's list to the 10-task limit (long list state). */
export function fillTasks(agentId: string, chats: TaskChat[]) {
  const mine = tasksOf(state, agentId).length;
  const names = [
    'Opening checklist',
    'Weekly stock count',
    'Supplier delivery reminder',
    'Monthly rent reminder to landlord – please confirm the bank transfer reference before 5 pm',
    'Friday promo post',
    'Kitchen cleaning roster',
    'Evening closing summary',
    'Payroll cut-off reminder',
    'Catering follow-up',
    'Birthday list',
  ];
  const extra: ScheduledTask[] = [];
  for (let i = 0; mine + extra.length < MAX_TASKS && i < names.length; i++) {
    const chat = chats[i % Math.max(1, chats.length)] ?? STAFF_GROUP;
    extra.push({
      id: newId('st'),
      agentId,
      name: names[i]!,
      enabled: i % 3 !== 2,
      time: `${String(7 + (i % 10)).padStart(2, '0')}:${i % 2 ? '45' : '00'}`,
      dayRule: (['daily', 'weekdays', 'custom'] as const)[i % 3]!,
      days: i % 3 === 2 ? [5] : [1, 2, 3, 4, 5],
      chat,
      instruction: `Send the ${names[i]!.toLowerCase()} to the team.`,
      createdAt: Date.now() + i,
    });
  }
  set({ ...state, tasks: [...state.tasks, ...extra] });
}

export function resetScheduledTasks() {
  set(seed());
}

/** Days the task runs on (0 = Sunday). */
export function runDays(task: Pick<ScheduledTask, 'dayRule' | 'days'>): number[] {
  if (task.dayRule === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (task.dayRule === 'weekdays') return [1, 2, 3, 4, 5];
  return [...task.days].sort();
}

/** The next time the task runs (local clock stands in for the business time zone). */
export function nextRun(task: ScheduledTask, now = Date.now()): number | null {
  const days = runDays(task);
  if (!days.length) return null;
  const [hh, mm] = task.time.split(':').map(Number) as [number, number];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now + i * DAY);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() > now && days.includes(d.getDay())) return d.getTime();
  }
  return null;
}

export interface TaskOutcome {
  result: RunResult;
  reason: RunReason | null;
  text: string | null;
  /** The look-up line the chat shows before the message ("Aina looked up …"). */
  lookup: { title: string; source: string } | null;
}

/** Why every task of this agent is paused right now (null = runs). */
export function pausedReason(
  agentEnabled: boolean,
  c: Conditions,
): Extract<RunReason, 'agent_off' | 'ai_disconnected' | 'wa_disconnected'> | null {
  if (!agentEnabled) return 'agent_off';
  if (!c.aiConnected) return 'ai_disconnected';
  if (!c.waConnected) return 'wa_disconnected';
  return null;
}

const skipWords = /skip|nothing|none|langkau|tiada|跳过|没有/i;

/**
 * Deterministic stand-in for the agent's turn: the words of the instruction pick a calendar,
 * sheet or reminder message. Production runs one agent turn (design.md "Run").
 */
export function outcomeFor(
  task: Pick<ScheduledTask, 'instruction' | 'chat'>,
  c: Conditions,
): TaskOutcome {
  const words = task.instruction.toLowerCase();
  const canSkip = skipWords.test(task.instruction);
  if (c.windowClosed)
    return { result: 'skipped', reason: 'window_closed', text: null, lookup: null };
  if (/calendar|booking|appointment|kalendar|tempahan|temujanji|日历|预约|预订/.test(words)) {
    const lookup = { title: 'Bookings today', source: 'Google Calendar' };
    if (c.nothingToday)
      return canSkip
        ? { result: 'skipped', reason: 'nothing_to_say', text: null, lookup }
        : { result: 'sent', reason: null, text: 'Good morning team ☀️ No bookings today.', lookup };
    return {
      result: 'sent',
      reason: null,
      text: SEED_BOOKINGS_TEXT.replace(' (Thu 5 Nov)', ''),
      lookup,
    };
  }
  if (/sheet|overdue|task|helaian|tugasan|表格|逾期|任务/.test(words)) {
    const lookup = { title: 'Overdue tasks', source: 'Google Sheets' };
    if (c.nothingToday)
      return canSkip
        ? { result: 'skipped', reason: 'nothing_to_say', text: null, lookup }
        : { result: 'sent', reason: null, text: 'Nothing is overdue today. 👍', lookup };
    return {
      result: 'sent',
      reason: null,
      text: [
        'Overdue tasks for Family Day:',
        '• Book the canopy – Hafiz (due Mon)',
        '• Confirm 40 nasi lemak – Priya (due Tue)',
        'Please update the sheet when done.',
      ].join('\n'),
      lookup,
    };
  }
  const first = task.chat.type === 'dm' ? task.chat.name.split(' ')[0] : 'everyone';
  if (/remind|ingat|提醒/.test(words))
    return {
      result: 'sent',
      reason: null,
      text: `Hi ${first}! Friendly reminder: orders for your weekly coffee beans close at 12 noon today. Would you like the usual 2 kg?`,
      lookup: null,
    };
  if (c.nothingToday && canSkip)
    return { result: 'skipped', reason: 'nothing_to_say', text: null, lookup: null };
  return {
    result: 'sent',
    reason: null,
    text: `Good morning ${first}! ${task.instruction.trim().replace(/\.?$/, '.')}`,
    lookup: null,
  };
}

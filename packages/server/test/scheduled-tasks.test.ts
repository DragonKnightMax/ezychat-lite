// Scheduled tasks of AI agents (docs/features/scheduled-tasks/design.md): the schedule math in the
// business time zone, the routes (admins, limits, chat checks), the scheduler with a fake clock (once
// per slot, 15-minute grace, missed runs never caught up, pauses), the agent turn (answer / no_reply /
// handoff / failure), Run now, the preview and the "Scheduled" mark. Mock model only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULED_TASKS_MAX, ScheduledTaskBody, type ScheduledTask } from '@ezychat/shared';
import { FakeWaAdapter } from '@ezychat/wa';
import { agentById, listAgents, setAgentInbox } from '../src/ai/agents.js';
import { mergeChat } from '../src/chats/merge.js';
import { SCHEDULED_RULES } from '../src/ai/prompt.js';
import type { AiPrompt, AiProvider } from '../src/ai/provider-types.js';
import { createAiService } from '../src/ai/service.js';
import type { AppContext } from '../src/context.js';
import { createMessageService } from '../src/messages/service.js';
import { ScheduledRepo } from '../src/scheduled/repo.js';
import { createScheduledService, type ScheduledService } from '../src/scheduled/service.js';
import {
  fromDayBits,
  latestSlot,
  nextSlot,
  toDayBits,
  toMinutes,
  toTime,
  zonedParts,
  zonedTime,
} from '../src/scheduled/time.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const KL = 'Asia/Kuala_Lumpur';
const NY = 'America/New_York';
const OWN = '60000000000@s.whatsapp.net';
const STAFF = '120363000000005@g.us';
const FARAH = '60111111111@s.whatsapp.net';
const MIN = 60_000;
/** Monday 9 Nov 2026, 08:30 in Kuala Lumpur (UTC+8). */
const MON_0830 = Date.UTC(2026, 10, 9, 0, 30);

type Decision = { reply: string; action: string; handoffReason?: string | null };

let t: TestApp;
let clock: number;
let decide: (prompt: AiPrompt) => Decision | Promise<Decision>;
let prompts: AiPrompt[];
let scheduled: ScheduledService;
let agentId: number;
let aiUserId: number;
let actor: { userId: number; ip: string | null };
let wa: FakeWaAdapter;

afterEach(async () => {
  await t?.close();
});

async function setUp(opts: { replyWindowHours?: number } = {}) {
  clock = MON_0830 - 2 * 86_400_000; // Saturday: tasks are made before their first time
  prompts = [];
  decide = () => ({ reply: "Good morning team! Today's bookings: none so far.", action: 'answer' });
  const provider: AiProvider = {
    generate: vi.fn(async (_s, _k, prompt: AiPrompt) => {
      prompts.push(prompt);
      return decide(prompt);
    }) as AiProvider['generate'],
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  wa = new FakeWaAdapter({
    me: { jid: OWN, name: 'Kopi Apong' },
    ...(opts.replyWindowHours
      ? {
          capabilities: {
            qrLink: false,
            history: false,
            groups: true,
            templates: true,
            needsPublicUrl: true,
            replyWindowHours: opts.replyWindowHours,
          },
        }
      : {}),
  });
  t = await makeTestApp({
    wa,
    beforeBuild: async (ctx: AppContext) => {
      await ctx.services.scheduled?.shutdown();
      await ctx.services.ai!.shutdown();
      ctx.services.messages!.shutdown();
      ctx.services.messages = createMessageService(ctx, {
        now: () => Date.now(),
        queue: { spacingMs: 0 },
      });
      ctx.services.ai = createAiService(ctx, { provider, isOnline: () => true });
      scheduled = createScheduledService(ctx, { now: () => clock, timers: false });
      ctx.services.scheduled = scheduled;
    },
  });
  const adminId = t.ctx.services.auth!.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  }).id;
  actor = { userId: adminId, ip: null };
  const ai = t.ctx.services.ai!;
  ai.saveConnection({ mode: 'api', model: '', apiKey: 'test-api-key-123' }, actor);
  ai.saveMember({ displayName: 'Aina', enabled: false, instructions: '' }, actor);
  ai.addText(null, { name: 'Business context', text: 'Kopi Apong opens 8am to 6pm.' }, actor);
  ai.saveMember({ displayName: 'Aina', enabled: true, instructions: '' }, actor);
  agentId = listAgents(t.ctx.db)[0]!.id;
  aiUserId = agentById(t.ctx.db, agentId)!.userId;
  getChats(t.ctx).upsertFromWa({ jid: STAFF, type: 'group', name: 'Kopi Apong Staff' });
  getChats(t.ctx).upsertFromWa({ jid: FARAH, type: 'dm', name: 'Farah Aziz' });
}

const body = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'Morning bookings',
  time: '08:30',
  dayRule: 'weekdays',
  chatJid: STAFF,
  instruction: "Tell the team today's bookings. Skip if there are none.",
  ...over,
});

const create = (over: Partial<Record<string, unknown>> = {}) =>
  scheduled.create(agentId, ScheduledTaskBody.parse(body(over)), actor);

const runsOf = (taskId: number) => scheduled.runs(agentId, taskId).runs;
const sentByTask = (taskId: number) =>
  getMessages(t.ctx)
    .list(STAFF, { limit: 50 })
    .messages.filter((m) => m.scheduledTask?.id === taskId);

async function tickAt(at: number) {
  clock = at;
  await scheduled.tick();
  await scheduled.idle();
}

describe('schedule math', () => {
  it('finds the latest and next time in the business zone, by day rule', () => {
    const weekdays = { timeMinutes: toMinutes('08:30'), dayRule: 'weekdays' as const, days: [] };
    expect(latestSlot(weekdays, MON_0830 + 10_000, KL)).toBe(MON_0830);
    // Monday 08:29 → the latest weekday time is Friday 08:30.
    expect(latestSlot(weekdays, MON_0830 - MIN, KL)).toBe(MON_0830 - 3 * 86_400_000);
    expect(nextSlot(weekdays, MON_0830, KL)).toBe(MON_0830 + 86_400_000);
    // Friday 08:31 → next is Monday.
    expect(nextSlot(weekdays, MON_0830 - 3 * 86_400_000 + MIN, KL)).toBe(MON_0830);
    const custom = { timeMinutes: 540, dayRule: 'custom' as const, days: [4] };
    expect(nextSlot(custom, MON_0830, KL)).toBe(Date.UTC(2026, 10, 12, 1, 0));
    expect(latestSlot({ ...custom, days: [] }, MON_0830, KL)).toBeNull();
    expect(nextSlot({ ...custom, days: [] }, MON_0830, KL)).toBeNull();
    const daily = { timeMinutes: 0, dayRule: 'daily' as const, days: [] };
    expect(nextSlot(daily, MON_0830, KL)).toBe(Date.UTC(2026, 10, 9, 16, 0));
  });

  it('follows daylight saving in zones that have it', () => {
    // 8 Mar 2026 02:30 does not exist in New York: it moves forward; 09:00 is EDT (UTC-4).
    expect(zonedTime({ year: 2026, month: 3, day: 9 }, 540, NY)).toBe(Date.UTC(2026, 2, 9, 13, 0));
    expect(zonedTime({ year: 2026, month: 3, day: 6 }, 540, NY)).toBe(Date.UTC(2026, 2, 6, 14, 0));
    const skipped = zonedTime({ year: 2026, month: 3, day: 8 }, 150, NY);
    expect(zonedParts(skipped, NY).minutes).toBeGreaterThanOrEqual(150);
    expect(zonedParts(MON_0830, KL)).toMatchObject({ weekday: 1, minutes: 510, day: 9 });
  });

  it('converts times and day masks both ways', () => {
    expect(toMinutes('23:55')).toBe(1435);
    expect(toTime(510)).toBe('08:30');
    expect(toDayBits([0, 6])).toBe(65);
    expect(fromDayBits(65)).toEqual([0, 6]);
  });
});

describe('routes', { timeout: 30_000 }, () => {
  it('lets admins list, create, edit and delete tasks, with checks and audit rows', async () => {
    await setUp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const member = await createUserAndLogin(t, { role: 'agent' });
    const base = `/api/ai/agents/${agentId}/scheduled-tasks`;
    const call = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: object,
      cookie = admin.cookie,
    ) =>
      t.app.inject({ method, url, headers: authHeaders(cookie), ...(payload ? { payload } : {}) });

    expect((await call('GET', base, undefined, member.cookie)).statusCode).toBe(403);
    const empty = (await call('GET', base)).json();
    expect(empty).toMatchObject({
      tasks: [],
      max: SCHEDULED_TASKS_MAX,
      paused: null,
      timeZone: KL,
    });

    const created = await call('POST', base, body());
    expect(created.statusCode, created.body).toBe(200);
    const task = created.json() as ScheduledTask;
    expect(task).toMatchObject({
      name: 'Morning bookings',
      enabled: true,
      time: '08:30',
      dayRule: 'weekdays',
      days: [],
      chat: { jid: STAFF, name: 'Kopi Apong Staff', type: 'group' },
      nextRunAt: MON_0830,
      lastRun: null,
    });

    expect((await call('POST', base, body({ dayRule: 'custom', days: [] }))).statusCode).toBe(400);
    const unknown = await call('POST', base, body({ chatJid: '60999999999@s.whatsapp.net' }));
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('chat_not_in_inbox');

    const edited = await call('PATCH', `${base}/${task.id}`, {
      dayRule: 'custom',
      days: [1, 4],
      time: '09:00',
      chatJid: FARAH,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ dayRule: 'custom', days: [1, 4], time: '09:00' });
    expect((await call('PATCH', `${base}/${task.id}`, { days: [] })).statusCode).toBe(400);
    expect((await call('PATCH', `${base}/${task.id}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', `${base}/999`, { enabled: false })).statusCode).toBe(404);
    expect((await call('GET', `/api/ai/agents/999/scheduled-tasks`)).statusCode).toBe(404);

    expect((await call('GET', `${base}/${task.id}/runs`)).json()).toEqual({ runs: [] });
    expect((await call('DELETE', `${base}/${task.id}`)).json()).toEqual({ ok: true });
    expect((await call('GET', base)).json().tasks).toEqual([]);

    const actions = t.ctx.db
      .prepare(
        "SELECT action, meta FROM audit_log WHERE action LIKE 'scheduled_task.%' ORDER BY id",
      )
      .all() as Array<{ action: string; meta: string }>;
    expect(actions.map((a) => a.action)).toEqual([
      'scheduled_task.create',
      'scheduled_task.update',
      'scheduled_task.delete',
    ]);
    // Ids and field names only, never the instruction.
    expect(actions.map((a) => a.meta).join()).not.toContain('bookings');
  });

  it(`allows at most ${SCHEDULED_TASKS_MAX} tasks per agent`, async () => {
    await setUp();
    for (let i = 0; i < SCHEDULED_TASKS_MAX; i++) create({ name: `Task ${i}` });
    expect(() => create()).toThrow(
      expect.objectContaining({ status: 409, code: 'scheduled_task_limit' }),
    );
  });
});

describe('scheduler', { timeout: 30_000 }, () => {
  it('runs a due task once at its time and sends one marked message as the agent', async () => {
    await setUp();
    const task = create();
    await tickAt(MON_0830 + 10_000);
    await tickAt(MON_0830 + 40_000);

    const sent = sentByTask(task.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sentByUserId: aiUserId,
      body: "Good morning team! Today's bookings: none so far.",
      scheduledTask: { id: task.id, name: 'Morning bookings' },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.instructions).toContain(SCHEDULED_RULES);
    const input = JSON.parse(prompts[0]!.input) as { currentSituation: Record<string, unknown> };
    expect(input.currentSituation.scheduledTask).toMatchObject({
      name: 'Morning bookings',
      chat: 'Kopi Apong Staff',
      chatType: 'WhatsApp group',
    });
    // The send never takes the group.
    expect(getChats(t.ctx).get(STAFF)!.assignedTo).toBeNull();
    const [run] = runsOf(task.id);
    expect(run).toMatchObject({ at: MON_0830, trigger: 'schedule', result: 'sent', reason: null });
    expect(run!.messageId).toBe(sent[0]!.id);
    expect(scheduled.list(agentId).tasks[0]!.lastRun).toMatchObject({ result: 'sent' });

    // Deleting the task keeps the mark, without its name.
    scheduled.remove(agentId, task.id, actor);
    expect(
      getMessages(t.ctx)
        .list(STAFF, { limit: 5 })
        .messages.find((m) => m.id === sent[0]!.id)!.scheduledTask,
    ).toEqual({ id: task.id, name: null });
  });

  it('records nothing to say, a hand-over and a failed turn without sending', async () => {
    await setUp();
    const quiet = create({ name: 'Quiet' });
    decide = () => ({ reply: '', action: 'no_reply' });
    await tickAt(MON_0830 + 5_000);
    expect(runsOf(quiet.id)[0]).toMatchObject({ result: 'skipped', reason: 'nothing_to_say' });

    decide = () => ({
      reply: 'A team member will help.',
      action: 'handoff',
      handoffReason: 'sensitive',
    });
    await tickAt(MON_0830 + 86_400_000 + 5_000);
    expect(runsOf(quiet.id)[0]).toMatchObject({ result: 'skipped', reason: 'needs_team' });

    decide = () => {
      throw new Error('model down');
    };
    await tickAt(MON_0830 + 2 * 86_400_000 + 5_000);
    expect(runsOf(quiet.id)[0]).toMatchObject({ result: 'failed', reason: 'ai_unavailable' });
    expect(sentByTask(quiet.id)).toHaveLength(0);
  });

  it('never catches up a missed time and never runs for a time before the task existed', async () => {
    await setUp();
    const task = create();
    await tickAt(MON_0830 + 20 * MIN);
    expect(runsOf(task.id)).toMatchObject([{ result: 'skipped', reason: 'missed' }]);
    expect(prompts).toHaveLength(0);

    // Made at 08:35 on Tuesday: the 08:30 time that day is not its.
    clock = MON_0830 + 86_400_000 + 5 * MIN;
    const late = create({ name: 'Late' });
    await tickAt(MON_0830 + 86_400_000 + 6 * MIN);
    expect(runsOf(late.id)).toEqual([]);
  });

  it('waits while paused and runs inside the grace once the pause ends', async () => {
    await setUp();
    const task = create();
    await wa.disconnect();
    await tickAt(MON_0830 + MIN);
    expect(runsOf(task.id)).toEqual([]);
    expect(scheduled.list(agentId).paused).toBe('wa_disconnected');
    await wa.connect();
    await tickAt(MON_0830 + 10 * MIN);
    expect(runsOf(task.id)).toMatchObject([{ result: 'sent' }]);

    // Off for the whole grace: recorded with the reason.
    t.ctx.services.ai!.saveMember({ displayName: 'Aina', enabled: false, instructions: '' }, actor);
    expect(scheduled.list(agentId).paused).toBe('agent_off');
    expect(scheduled.canSend(task.id)).toBe(false);
    await tickAt(MON_0830 + 86_400_000 + MIN);
    await tickAt(MON_0830 + 86_400_000 + 16 * MIN);
    expect(runsOf(task.id)[0]).toMatchObject({ result: 'skipped', reason: 'agent_off' });
  });

  it('skips a chat that left the inbox and stops tasks when the agent moves inbox', async () => {
    await setUp();
    const task = create();
    t.ctx.db.prepare('DELETE FROM chats WHERE jid = ?').run(STAFF);
    await tickAt(MON_0830 + MIN);
    expect(runsOf(task.id)[0]).toMatchObject({ result: 'skipped', reason: 'chat_gone' });
    expect(scheduled.list(agentId).tasks[0]!.chat).toBeNull();

    setAgentInbox(t.ctx.db, agentId, null);
    expect(scheduled.list(agentId).tasks[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(scheduled.list(agentId).paused).toBe('agent_off');
  });

  it('re-checks after the turn: a task deleted or an agent turned off meanwhile sends nothing', async () => {
    await setUp();
    const task = create();
    decide = () => {
      scheduled.remove(agentId, task.id, actor);
      return { reply: 'Hello team', action: 'answer' };
    };
    await tickAt(MON_0830 + MIN);
    expect(sentByTask(task.id)).toHaveLength(0);

    const other = create({ name: 'Other' });
    decide = () => {
      t.ctx.services.ai!.saveMember(
        { displayName: 'Aina', enabled: false, instructions: '' },
        actor,
      );
      return { reply: 'Hello team', action: 'answer' };
    };
    await tickAt(MON_0830 + 86_400_000 + MIN);
    expect(runsOf(other.id)[0]).toMatchObject({ result: 'skipped', reason: 'agent_off' });
    expect(scheduled.canSend(task.id)).toBe(false);
  });

  it('records a message WhatsApp refused as failed, and pauses while the access gate is closed', async () => {
    await setUp();
    const task = create();
    wa.failNextSend();
    await tickAt(MON_0830 + MIN);
    expect(runsOf(task.id)[0]).toMatchObject({ result: 'failed', reason: 'send_failed' });

    t.ctx.access.close({ code: 'license_required' });
    expect(scheduled.list(agentId).paused).toBe('access_closed');
    expect(scheduled.canSend(task.id)).toBe(false);
    t.ctx.access.open();
    vi.spyOn(t.ctx.services.ai!, 'answerReady').mockReturnValue(false);
    expect(scheduled.list(agentId).paused).toBe('ai_disconnected');
    expect(
      await scheduled.preview(agentId, { chatJid: STAFF, instruction: 'Anything' }, actor),
    ).toMatchObject({ result: 'skipped', reason: 'ai_disconnected' });
  });

  it('runs one pass at a time', async () => {
    await setUp();
    create();
    clock = MON_0830 + MIN;
    await Promise.all([scheduled.tick(), scheduled.tick()]);
    await scheduled.idle();
    expect(prompts).toHaveLength(1);
  });

  it('moves a task to the surviving chat when two chats of one person merge', async () => {
    await setUp();
    const lid = '99000000000077@lid';
    getChats(t.ctx).upsertFromWa({ jid: lid, type: 'dm', name: 'Farah Aziz' });
    const task = create({ chatJid: FARAH });
    mergeChat(t.ctx.db, FARAH, lid, { now: clock });
    expect(scheduled.list(agentId).tasks[0]).toMatchObject({ id: task.id, chatJid: lid });
  });

  it('records runs a crash left running as interrupted at start', async () => {
    await setUp();
    const task = create();
    const repo = new ScheduledRepo(t.ctx.db);
    repo.claimSlot(task.id, MON_0830, MON_0830);
    expect(repo.claimSlot(task.id, MON_0830, MON_0830)).toBeNull();
    const again = createScheduledService(t.ctx, { now: () => clock, timers: false });
    expect(runsOf(task.id)[0]).toMatchObject({ result: 'failed', reason: 'interrupted' });
    await again.shutdown();
  });
});

describe('Business API window', { timeout: 30_000 }, () => {
  it('skips a chat whose 24-hour window is closed, in a run and in a preview', async () => {
    await setUp({ replyWindowHours: 24 });
    const task = create();
    await tickAt(MON_0830 + MIN);
    expect(runsOf(task.id)[0]).toMatchObject({ result: 'skipped', reason: 'window_closed' });
    expect(prompts).toHaveLength(0);
    expect(
      await scheduled.preview(agentId, { chatJid: STAFF, instruction: 'Anything' }, actor),
    ).toMatchObject({ result: 'skipped', reason: 'window_closed' });
  });
});

describe('run now and preview', { timeout: 30_000 }, () => {
  it('runs now for admins, at most 3 times an hour, and not while paused', async () => {
    await setUp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const task = create();
    const url = `/api/ai/agents/${agentId}/scheduled-tasks/${task.id}/run`;
    const press = () => t.app.inject({ method: 'POST', url, headers: authHeaders(admin.cookie) });
    clock = Date.now();
    const first = await press();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().run).toMatchObject({ trigger: 'run_now', result: 'sent' });
    expect(first.json().run.byUserName).toBe(admin.user.displayName);
    await press();
    await press();
    const limited = await press();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(sentByTask(task.id)).toHaveLength(3);

    const other = create({ name: 'Other' });
    t.ctx.services.ai!.saveMember({ displayName: 'Aina', enabled: false, instructions: '' }, actor);
    await expect(scheduled.runNow(agentId, other.id, actor)).rejects.toMatchObject({
      status: 409,
      code: 'scheduled_paused',
    });
  });

  it('previews without sending or storing, and says why it would send nothing', async () => {
    await setUp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const url = `/api/ai/agents/${agentId}/scheduled-tasks/preview`;
    const preview = (payload: object) =>
      t.app.inject({ method: 'POST', url, headers: authHeaders(admin.cookie), payload });
    const shown = await preview({ chatJid: FARAH, instruction: 'Remind Farah of her order.' });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json()).toEqual({
      result: 'sent',
      text: "Good morning team! Today's bookings: none so far.",
      reason: null,
      lookups: [],
    });
    const input = JSON.parse(prompts.at(-1)!.input) as {
      currentSituation: Record<string, unknown>;
    };
    expect(input.currentSituation.scheduledTask).toMatchObject({ chatType: 'private chat' });
    decide = () => ({ reply: '', action: 'no_reply' });
    expect((await preview({ chatJid: STAFF, instruction: 'Skip if none.' })).json()).toMatchObject({
      result: 'skipped',
      reason: 'nothing_to_say',
    });
    expect(getMessages(t.ctx).list(FARAH, { limit: 5 }).messages).toHaveLength(0);
    expect(t.ctx.db.prepare('SELECT COUNT(*) FROM ai_scheduled_runs').pluck().get()).toBe(0);
    expect((await preview({ chatJid: 'nobody@s.whatsapp.net', instruction: 'x' })).statusCode).toBe(
      400,
    );
  });

  it('limits previews to 20 a minute per admin', async () => {
    await setUp();
    for (let i = 0; i < 20; i++)
      await scheduled.preview(agentId, { chatJid: STAFF, instruction: 'Hi' }, actor);
    await expect(
      scheduled.preview(agentId, { chatJid: STAFF, instruction: 'Hi' }, actor),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('withholds a reply that quotes an Internal item', async () => {
    await setUp();
    const secret = 'Supplier discount code is KOPI-INTERNAL-2026 for staff only';
    t.ctx.services.ai!.addText(
      null,
      { name: 'Internal', text: secret, internal: true } as never,
      actor,
    );
    decide = () => ({ reply: `Note: ${secret}`, action: 'answer' });
    const out = await scheduled.preview(
      agentId,
      { chatJid: STAFF, instruction: 'Share news' },
      actor,
    );
    expect(out).toMatchObject({ result: 'skipped', reason: 'confidential_leak' });
  });
});

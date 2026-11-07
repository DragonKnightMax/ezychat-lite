import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Message } from '@ezychat/shared';
import type { FakeWaAdapter } from '@ezychat/wa';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';

/**
 * Proposed (ai-groups), mock only: the AI agent answers in a WhatsApp group when a member @mentions
 * the business number or quotes a message the AI sent (any member, any time), only in groups an
 * admin switched on; everything else gets silence (owner, 2026-10-28). Loop guard: after 10 AI answers in a
 * row without a teammate message the AI pauses in that group until a teammate writes.
 *
 * Stand-in state and routes `/api/mock/groups*`. The "answers" are fixed demo texts grounded in the
 * seeded Business context, sent through the normal message service as the AI member (no model is
 * called). Production: a per-agent and a per-group setting, the trigger in `ai/service.ts`, a group
 * prompt and the loop guard.
 */

/** The linked number of the fake phone (FakeWaAdapter's own JID; run.ts names it "Kopi Apong"). */
export const BUSINESS_JID = '60000000000@s.whatsapp.net';
const MENTION = '@60000000000';
/** Loop guard: AI answers in a row without a teammate message. */
const LOOP_GUARD = 10;

interface Member {
  phone: string;
  name: string;
  role?: 'admin' | 'member';
}

interface DemoGroup {
  jid: string;
  name: string;
  members: Member[];
  generated: number;
  enabled: boolean;
}

export const GROUPS: DemoGroup[] = [
  {
    jid: '120363025550002@g.us',
    name: 'Kopi Lovers Club',
    members: [
      { phone: '60126677889', name: 'Nurul Huda', role: 'admin' },
      { phone: '60123110021', name: 'Farah Aziz' },
      { phone: '60131234567', name: 'Siti Rahman' },
      { phone: '60127020388', name: 'Tan Wei Jie' },
      { phone: '60190000101', name: 'Arjun Pillai' },
    ],
    generated: 0,
    enabled: true,
  },
  {
    jid: '120363025550003@g.us',
    name: 'Reseller Group Penang – Kopi Apong wholesale partners (Butterworth, Bayan Lepas, Georgetown & Seberang Perai)',
    members: [
      { phone: '60190000111', name: 'Lim Chee Keong', role: 'admin' },
      { phone: '60190000112', name: 'Kavitha Subramaniam' },
      { phone: '60190000113', name: 'Wong Mei Fong' },
      { phone: '60190000114', name: 'Azlan bin Ismail' },
      // Another business's auto-reply bot: it answers every message, which starts a loop.
      { phone: '60190000115', name: 'Ah Seng Trading (auto-reply)' },
    ],
    generated: 14,
    enabled: true,
  },
  {
    jid: '120363025550004@g.us',
    name: 'Family Day 2026',
    members: [
      { phone: '60190000121', name: 'Hafiz Rahman', role: 'admin' },
      { phone: '60190000122', name: 'Priya Nair' },
      { phone: '60190000123', name: 'Chong Kah Wai' },
    ],
    generated: 30,
    enabled: false,
  },
];

/** Questions a member asks with an @mention, and the agent's answer (from the seeded context). */
const QUESTIONS: ReadonlyArray<{ ask: string; answer: (first: string) => string }> = [
  {
    ask: 'what time does the kitchen close tonight?',
    answer: (first) => `Hi ${first}! We open daily 8am–10pm, and the kitchen closes at 9.30pm.`,
  },
  {
    ask: 'how much is Teh Tarik now?',
    answer: (first) => `Hi ${first}! Teh Tarik is RM4 and Kopi O is RM3.50.`,
  },
  {
    ask: 'do you deliver to Jelutong?',
    answer: (first) =>
      `Hi ${first}! We deliver within 5 km of Georgetown, and delivery is free above RM40.`,
  },
  {
    ask: 'is Nasi Lemak Ayam still RM12?',
    answer: (first) => `Hi ${first}! Yes, Nasi Lemak Ayam is RM12.`,
  },
];
/** Follow-ups addressed to the AI (they quote its answer), with the answer. */
const FOLLOW_UPS: ReadonlyArray<{ ask: string; answer: (first: string) => string }> = [
  {
    ask: 'ok thanks! and is delivery free to Jelutong?',
    answer: (first) =>
      `Yes ${first}, Jelutong is within 5 km of Georgetown, so delivery is free above RM40.`,
  },
  {
    ask: 'great, and Teh Tarik is how much?',
    answer: (first) => `Teh Tarik is RM4, ${first}.`,
  },
];
const UNRELATED = [
  'Haha I always order the Kopi O 😄',
  'Who is joining the meet-up on Saturday?',
  'Nice photo Siti!',
];
/** Another member quotes an earlier AI answer (no @mention): it is addressed to the AI. */
const QUOTE_ASK = 'same time on Sunday?';
const QUOTE_ANSWER = (first: string) =>
  `Hi ${first}! Yes, on Sunday the kitchen also closes at 9.30pm.`;
const HANDOVER_ASK = 'can you change my order #1088 to pickup at 3pm instead?';
const HANDOVER_REPLY = 'A team member will reply soon.';
const BOT_TEXT = 'Thank you for your message! Ah Seng Trading will reply soon 🙏';
const BOT_ANSWERS = [
  "You're welcome! Let us know if you need anything else.",
  'Thank you! We are here if you have a question.',
];

interface GroupState {
  enabled: boolean;
  /** AI answers since the last teammate message (the loop guard counts these). */
  inRow: number;
  /** A paused line was written for the current run (written once). */
  pausedLine: boolean;
  /** The member the AI last answered: their follow-ups reach the AI until a teammate writes. */
  lastAnswer: { member: Member; messageId: string; at: number } | null;
  next: number;
}

interface Notification {
  agent: string;
  group: string;
  member: string;
  question: string;
  /** Who gets it: the group's assignee, else everyone with access to the inbox. */
  to: string | null;
  at: number;
}

const state = {
  agents: { a1: true, a2: false } as Record<string, boolean>,
  groups: new Map<string, GroupState>(),
  loopGuard: false,
  viewAs: 'admin' as 'admin' | 'agent',
  notification: null as Notification | null,
};

const groupState = (jid: string): GroupState => {
  let s = state.groups.get(jid);
  if (!s) {
    s = { enabled: false, inRow: 0, pausedLine: false, lastAnswer: null, next: 0 };
    state.groups.set(jid, s);
  }
  return s;
};

function resetState() {
  state.agents = { a1: true, a2: false };
  state.groups.clear();
  state.loopGuard = false;
  state.viewAs = 'admin';
  state.notification = null;
  for (const g of GROUPS) groupState(g.jid).enabled = g.enabled;
}
resetState();

const aiUser = (ctx: AppContext) =>
  ctx.db
    .prepare("SELECT id, display_name FROM users WHERE kind = 'ai' ORDER BY id LIMIT 1")
    .get() as { id: number; display_name: string } | undefined;

const userName = (ctx: AppContext, id: number | null) =>
  id == null
    ? null
    : ((
        ctx.db.prepare('SELECT display_name FROM users WHERE id = ?').get(id) as
          { display_name: string } | undefined
      )?.display_name ?? null);

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
const fakeWa = (ctx: AppContext) => ctx.wa as unknown as FakeWaAdapter;

/** A member's live message from the fake phone (optionally an @mention or a quote); its stored id. */
async function incoming(
  ctx: AppContext,
  group: DemoGroup,
  member: Member,
  text: string,
  opts: { mention?: boolean; quotedId?: string } = {},
): Promise<string> {
  let expect: string | null = null;
  const seen = new Set<string>();
  let done: () => void = () => undefined;
  const stored = new Promise<void>((resolve) => {
    done = resolve;
  });
  const onNew = (m: Message) => {
    seen.add(m.id);
    if (m.id === expect) done();
  };
  ctx.bus.on('message:new', onNew);
  const timer = setTimeout(() => done(), 2000);
  try {
    const msg = fakeWa(ctx).simulateIncoming({
      chatJid: group.jid,
      senderJid: `${member.phone}@s.whatsapp.net`,
      senderName: member.name,
      body: opts.mention ? `${MENTION} ${text}` : text,
      ...(opts.mention ? { mentionedJids: [BUSINESS_JID] } : {}),
      ...(opts.quotedId ? { quotedId: opts.quotedId } : {}),
    });
    // Inbox 1 keeps WhatsApp's message ids as its stored ids.
    expect = msg.id;
    if (seen.has(expect)) done();
    await stored;
    return msg.id;
  } finally {
    clearTimeout(timer);
    ctx.bus.off('message:new', onNew);
  }
}

/** One AI line in the group chat ("AI answered …", hand-over, paused), live to open screens. */
function groupEvent(ctx: AppContext, jid: string, payload: Record<string, unknown>) {
  const ai = aiUser(ctx);
  const at = Date.now();
  const row = ctx.db
    .prepare(
      "INSERT INTO chat_events (chat_jid, type, actor_id, payload, at) VALUES (?, 'ai_tool_used', ?, ?, ?)",
    )
    .run(jid, ai?.id ?? null, JSON.stringify(payload), at);
  ctx.bus.emit('chat:event', {
    id: Number(row.lastInsertRowid),
    chatJid: jid,
    type: 'ai_tool_used',
    actorId: ai?.id ?? null,
    payload,
    at,
  });
}

/**
 * Sends one AI reply into the group, quoting the member's message, and answers its stored id once
 * sent. The group keeps its assignee: the AI never takes the group chat (no "took this chat" line).
 */
async function aiSay(ctx: AppContext, jid: string, text: string, quotedId: string) {
  const ai = aiUser(ctx);
  if (!ai) return quotedId;
  const before = (
    ctx.db.prepare('SELECT assigned_to FROM chats WHERE jid = ?').get(jid) as
      { assigned_to: number | null } | undefined
  )?.assigned_to;
  const clientId = `mock-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Owner for the instant of the send only, so the send does not claim the chat.
  ctx.db.prepare('UPDATE chats SET assigned_to = ? WHERE jid = ?').run(ai.id, jid);
  try {
    ctx.services.messages!.sendText(jid, { text, clientId, quotedId }, ai.id);
  } finally {
    ctx.db.prepare('UPDATE chats SET assigned_to = ? WHERE jid = ?').run(before ?? null, jid);
    const chat = ctx.services.chats!.get(jid);
    if (chat) ctx.bus.emit('chat:updated', chat);
  }
  // Wait (bounded) until the send queue has sent it: a quote needs the WhatsApp id.
  let id = `local-${clientId}`;
  for (let i = 0; i < 80; i++) {
    const row = ctx.db
      .prepare('SELECT id, status FROM messages WHERE client_id = ?')
      .get(clientId) as { id: string; status: string } | undefined;
    if (row && row.status !== 'pending' && !row.id.startsWith('local-')) {
      id = row.id;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Demo data: the seeded AI member is off, which may cancel its queued replies; show them as sent.
  ctx.db
    .prepare(
      "UPDATE messages SET status = 'sent', error = NULL WHERE client_id = ? AND status = 'failed'",
    )
    .run(clientId);
  return id;
}

type Outcome = 'answered' | 'handover' | 'paused' | 'off' | 'silent';

/**
 * What the agent does with one group message (the proposal's rules, deterministic). `addressed`:
 * an @mention of the business or any member's quote of an AI message (owner, 2026-10-28). Nothing else.
 * `answer` null = hand over to the team.
 */
async function onGroupMessage(
  ctx: AppContext,
  group: DemoGroup,
  member: Member,
  messageId: string,
  question: string,
  addressed: boolean,
  answer: string | null,
  followUp = false,
): Promise<Outcome> {
  const s = groupState(group.jid);
  if (!state.agents.a1 || !s.enabled) return 'off';
  if (!addressed) return 'silent';
  if (state.loopGuard || s.inRow >= LOOP_GUARD) {
    if (!s.pausedLine) {
      groupEvent(ctx, group.jid, { group: 'paused', reason: 'loop' });
      s.pausedLine = true;
    }
    return 'paused';
  }
  if (answer === null) {
    await aiSay(ctx, group.jid, HANDOVER_REPLY, messageId);
    groupEvent(ctx, group.jid, { group: 'handover', member: member.name, handoff: 'needs_action' });
    s.lastAnswer = null;
    const chat = ctx.services.chats!.get(group.jid);
    state.notification = {
      agent: aiUser(ctx)?.display_name ?? 'AI',
      group: group.name,
      member: member.name,
      question,
      to: userName(ctx, chat?.assignedTo ?? null),
      at: Date.now(),
    };
    return 'handover';
  }
  const sentId = await aiSay(ctx, group.jid, answer, messageId);
  groupEvent(ctx, group.jid, { group: 'answered', member: member.name, followUp });
  s.inRow += 1;
  s.lastAnswer = { member, messageId: sentId, at: Date.now() };
  return 'answered';
}

/** Seeds the demo groups with members, messages, AI answers, a hand-over and the loop guard. */
export async function seedGroups(
  ctx: AppContext,
  call: (method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown) => Promise<unknown>,
): Promise<void> {
  resetState();
  const daniel = ctx.db.prepare("SELECT id FROM users WHERE username = 'daniel'").get() as
    { id: number } | undefined;
  for (const group of GROUPS)
    await call('POST', '/dev/fake-group', {
      groupJid: group.jid,
      name: group.name,
      generated: group.generated,
      members: group.members.map((m) => ({ ...m, role: m.role ?? 'member' })),
    });

  // Family Day 2026: switched off, so a mention gets no AI answer (the team answers by hand).
  const family = GROUPS[2]!;
  await incoming(
    ctx,
    family,
    family.members[0]!,
    'Reminder: Family Day is on Sat 14 Nov at Youth Park 🎉',
  );
  await incoming(ctx, family, family.members[1]!, 'can we pre-order 40 nasi lemak for the day?', {
    mention: true,
  });

  // Reseller group: a question, then another business's auto-reply bot answers every AI message
  // (each quotes the AI's answer, so it is addressed to the AI). After 10 answers in a row with no
  // teammate in between, the loop guard pauses the AI in this group.
  const resellers = GROUPS[1]!;
  await incoming(
    ctx,
    resellers,
    resellers.members[0]!,
    'Good morning partners, new price list next week.',
  );
  const kavitha = resellers.members[1]!;
  const q = QUESTIONS[3]!;
  let asked = await incoming(ctx, resellers, kavitha, q.ask, { mention: true });
  await onGroupMessage(ctx, resellers, kavitha, asked, q.ask, true, q.answer('Kavitha'));
  const bot = resellers.members[4]!;
  for (let i = 0; groupState(resellers.jid).inRow < LOOP_GUARD; i++) {
    const quoted = groupState(resellers.jid).lastAnswer!.messageId;
    asked = await incoming(ctx, resellers, bot, BOT_TEXT, { quotedId: quoted });
    await onGroupMessage(ctx, resellers, bot, asked, BOT_TEXT, true, BOT_ANSWERS[i % 2]!, true);
  }
  // The bot's next auto-reply: the guard holds; the AI stays quiet until a teammate writes.
  asked = await incoming(ctx, resellers, bot, BOT_TEXT, {
    quotedId: groupState(resellers.jid).lastAnswer!.messageId,
  });
  await onGroupMessage(ctx, resellers, bot, asked, BOT_TEXT, true, BOT_ANSWERS[0]!, true);

  // Kopi Lovers Club: (a) a mention answered, (b) the member replies to the AI's answer and gets a
  // second answer, (c) another member's unrelated message gets no AI reply, then a request the AI
  // hands to the team (the group's assignee, Daniel, is notified).
  const club = GROUPS[0]!;
  if (daniel)
    await call('PATCH', `/chats/${encodeURIComponent(club.jid)}`, { assignedTo: daniel.id });
  await incoming(
    ctx,
    club,
    club.members[2]!,
    'Morning all! Anyone tried the new pandan kaya toast?',
  );
  await incoming(ctx, club, club.members[3]!, 'Yes! Very nice with Kopi O 👍');
  const nurul = club.members[0]!;
  const first = QUESTIONS[0]!;
  asked = await incoming(ctx, club, nurul, first.ask, { mention: true });
  await onGroupMessage(ctx, club, nurul, asked, first.ask, true, first.answer('Nurul'));
  const firstAnswer = groupState(club.jid).lastAnswer!.messageId;
  const follow = FOLLOW_UPS[0]!;
  asked = await incoming(ctx, club, nurul, follow.ask, {
    quotedId: groupState(club.jid).lastAnswer!.messageId,
  });
  await onGroupMessage(ctx, club, nurul, asked, follow.ask, true, follow.answer('Nurul'), true);
  asked = await incoming(ctx, club, club.members[3]!, UNRELATED[0]!);
  await onGroupMessage(ctx, club, club.members[3]!, asked, UNRELATED[0]!, false, null);
  // (d) Owner, 2026-10-28: any member who quotes a message the AI sent gets an answer, without an
  // @mention and at any time: Arjun quotes the AI's first answer.
  const arjun = club.members[4]!;
  asked = await incoming(ctx, club, arjun, QUOTE_ASK, { quotedId: firstAnswer });
  await onGroupMessage(ctx, club, arjun, asked, QUOTE_ASK, true, QUOTE_ANSWER('Arjun'));
  const farah = club.members[1]!;
  asked = await incoming(ctx, club, farah, HANDOVER_ASK, { mention: true });
  await onGroupMessage(ctx, club, farah, asked, HANDOVER_ASK, true, null);
  for (const g of GROUPS) groupState(g.jid).next = 1;
}

const RowBody = z.object({ enabled: z.boolean() });
const ScenarioBody = z.object({
  loopGuard: z.boolean().optional(),
  viewAs: z.enum(['admin', 'agent']).optional(),
  reset: z.boolean().optional(),
});
const SimulateBody = z.object({
  jid: z.string().min(1).max(256),
  kind: z.enum(['question', 'followUp', 'unrelated', 'handover', 'teammate']),
});

export function registerGroups(app: FastifyInstance, ctx: AppContext): void {
  // A teammate's message in the group ends a run of AI answers (loop guard) and the follow-ups.
  ctx.bus.on('message:new', (m) => {
    if (!m.fromMe || m.sentByUserId == null) return;
    const ai = aiUser(ctx);
    if (ai && m.sentByUserId === ai.id) return;
    const s = state.groups.get(m.chatJid);
    if (s) {
      s.inRow = 0;
      s.pausedLine = false;
      s.lastAnswer = null;
    }
  });

  const view = () => {
    const rows = ctx.db
      .prepare("SELECT jid, name FROM chats WHERE type = 'group' ORDER BY name COLLATE NOCASE")
      .all() as Array<{ jid: string; name: string }>;
    return {
      agents: state.agents,
      loopGuardAnswers: LOOP_GUARD,
      loopGuard: state.loopGuard,
      viewAs: state.viewAs,
      notification: state.notification,
      groups: rows.map((row) => {
        const demo = GROUPS.find((g) => g.jid === row.jid);
        const s = groupState(row.jid);
        return {
          jid: row.jid,
          name: row.name,
          // The linked number counts as a member, like WhatsApp's own count.
          size: demo ? demo.members.length + demo.generated + 1 : null,
          enabled: s.enabled,
          inRow: s.inRow,
          paused: state.loopGuard || s.inRow >= LOOP_GUARD,
          demo: Boolean(demo),
        };
      }),
    };
  };

  app.get('/api/mock/groups', { preHandler: requireUser(ctx) }, async () => view());
  app.put('/api/mock/groups/agents/:agentId', { preHandler: requireAdmin(ctx) }, async (req) => {
    const agentId = z
      .string()
      .min(1)
      .max(64)
      .parse((req.params as { agentId: string }).agentId);
    state.agents[agentId] = RowBody.parse(req.body).enabled;
    return view();
  });
  app.put('/api/mock/groups/chats/:jid', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    const jid = (req.params as { jid: string }).jid;
    if (!ctx.services.chats!.get(jid)) return reply.code(404).send({ error: 'Group not found' });
    groupState(jid).enabled = RowBody.parse(req.body).enabled;
    return view();
  });
  // Mock-only switches (any signed-in user, so the agent view can switch back).
  app.put('/api/mock/groups/scenario', { preHandler: requireUser(ctx) }, async (req) => {
    const body = ScenarioBody.parse(req.body);
    if (body.reset) resetState();
    if (body.loopGuard !== undefined) {
      state.loopGuard = body.loopGuard;
      if (!body.loopGuard)
        for (const s of state.groups.values()) {
          s.inRow = 0;
          s.pausedLine = false;
        }
    }
    if (body.viewAs) state.viewAs = body.viewAs;
    return view();
  });
  // Mock-only: a member @mentions the business, follows up on the AI's answer, writes something
  // else, asks for something the AI hands over, or a teammate replies.
  app.post('/api/mock/groups/simulate', { preHandler: requireUser(ctx) }, async (req, reply) => {
    const body = SimulateBody.parse(req.body);
    const group = GROUPS.find((g) => g.jid === body.jid);
    if (!group) return reply.code(404).send({ error: 'Not a demo group' });
    const s = groupState(group.jid);
    if (body.kind === 'teammate') {
      const me = (req as FastifyRequest & { user?: { id: number } }).user!;
      ctx.services.messages!.sendText(
        group.jid,
        { text: 'Thanks all, noted 🙏', clientId: `mock-team-${Date.now().toString(36)}` },
        me.id,
      );
      return { outcome: 'teammate' as const, view: view() };
    }
    const humans = group.members.filter((m) => !m.name.includes('auto-reply'));
    // A quote of the AI's last answer (any member could quote it; the demo uses the member it answered).
    const last = s.lastAnswer;
    let member = humans[s.next % humans.length]!;
    let outcome: Outcome;
    if (body.kind === 'followUp' && last) {
      member = last.member;
      const f = FOLLOW_UPS[s.next % FOLLOW_UPS.length]!;
      s.next += 1;
      const id = await incoming(ctx, group, member, f.ask, { quotedId: last.messageId });
      outcome = await onGroupMessage(
        ctx,
        group,
        member,
        id,
        f.ask,
        true,
        f.answer(firstName(member.name)),
        true,
      );
    } else if (body.kind === 'unrelated' || body.kind === 'followUp') {
      // A message to the group, not to the AI (or a follow-up with no AI answer to follow): silence.
      if (last) member = humans.find((m) => m !== last.member) ?? member;
      const text = UNRELATED[s.next % UNRELATED.length]!;
      s.next += 1;
      const id = await incoming(ctx, group, member, text);
      outcome = await onGroupMessage(ctx, group, member, id, text, false, null);
    } else {
      s.next += 1;
      const q = QUESTIONS[s.next % QUESTIONS.length]!;
      const text = body.kind === 'handover' ? HANDOVER_ASK : q.ask;
      const id = await incoming(ctx, group, member, text, { mention: true });
      outcome = await onGroupMessage(
        ctx,
        group,
        member,
        id,
        text,
        true,
        body.kind === 'handover' ? null : q.answer(firstName(member.name)),
      );
    }
    return { outcome, view: view() };
  });
}

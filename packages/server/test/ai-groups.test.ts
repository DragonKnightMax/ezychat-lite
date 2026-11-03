// AI agents in WhatsApp groups (docs/features/ai-groups/design.md): the AI answers, in a group an
// admin switched on, only a live message that tags the business number or quotes an AI answer; it
// never takes the group; hand-overs post one line and notify; the loop guard pauses it after
// AI_GROUP_LOOP_GUARD answers in a row. Mock model only (never a real provider).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_GROUP_LOOP_GUARD,
  type AiGroupEvent,
  type DirectoryUser,
  type Message,
  type PushSubscribeBody,
} from '@ezychat/shared';
import { FakeWaAdapter, type WaAdapter } from '@ezychat/wa';
import { agentById, listAgents, setAgentAnswerDirect, type AgentRow } from '../src/ai/agents.js';
import { answersDirect, inboxHasGroups } from '../src/ai/direct.js';
import {
  addressedToAi,
  agentGroups,
  groupChatStatus,
  groupText,
  loopGuard,
  memberName,
  setAgentDirect,
  setAgentGroups,
  setGroupChat,
} from '../src/ai/groups.js';
import { GROUP_HANDOVER_REPLY, GROUP_RULES } from '../src/ai/prompt.js';
import type { AiPrompt, AiProvider } from '../src/ai/provider-types.js';
import { createAiService } from '../src/ai/service.js';
import type { AppContext } from '../src/context.js';
import { createMessageService } from '../src/messages/service.js';
import { createPushService, type PushSender } from '../src/push/service.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const G = '120363000000001@g.us';
const OWN = '60000000000@s.whatsapp.net';
const OWN_LID = '99000000000001@lid';
const FARAH = '60111111111@s.whatsapp.net';
const ARJUN = '60122222222@s.whatsapp.net';
const DM = '60133333333@s.whatsapp.net';

type Decision = { reply: string; action: string; handoffReason?: string | null };

let t: TestApp;
let decide: (prompt: AiPrompt) => Decision | Promise<Decision>;
let prompts: AiPrompt[];
let provider: AiProvider;
let adminId: number;
let agentId: number;
let aiUserId: number;
let actor: { userId: number; ip: string | null };
let seq = 0;

afterEach(async () => {
  await t?.close();
  vi.useRealTimers();
});

async function setUp(opts: { maxInboxes?: number; inboxes?: number; groups?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  prompts = [];
  decide = () => ({ reply: 'We open at 8am, Farah.', action: 'answer' });
  provider = {
    generate: vi.fn(async (_s, _k, prompt: AiPrompt) => {
      prompts.push(prompt);
      return decide(prompt);
    }) as AiProvider['generate'],
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  t = await makeTestApp({
    wa: new FakeWaAdapter({ me: { jid: OWN, name: 'Kopi Apong', lid: OWN_LID } }),
    ...(opts.maxInboxes ? { maxInboxes: opts.maxInboxes } : {}),
    ...(opts.inboxes ? { inboxes: opts.inboxes } : {}),
    beforeBuild: async (ctx: AppContext) => {
      await ctx.services.ai!.shutdown();
      ctx.services.messages!.shutdown();
      ctx.services.messages = createMessageService(ctx, {
        now: () => Date.now(),
        queue: { spacingMs: 0 },
      });
      ctx.services.ai = createAiService(ctx, { provider, isOnline: () => true });
    },
  });
  adminId = t.ctx.services.auth!.createUser({
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
  getChats(t.ctx).upsertFromWa({ jid: G, type: 'group', name: 'Kopi Lovers Club' });
  if (opts.groups !== false) {
    setAgentGroups(t.ctx, agentId, true, actor);
    setGroupChat(t.ctx, G, true, actor);
  }
}

interface Incoming {
  from?: string;
  name?: string | null;
  mentions?: string[];
  quotedId?: string | null;
  source?: 'live' | 'history';
  fromMe?: boolean;
  chatJid?: string;
}

/** A group message as WhatsApp delivers it; returns its stored id. */
async function inGroup(body: string, o: Incoming = {}) {
  const id = `g-${++seq}`;
  await getMessages(t.ctx).ingest(
    {
      id,
      chatJid: o.chatJid ?? G,
      body,
      type: 'text',
      fromMe: o.fromMe ?? false,
      senderJid: o.fromMe ? null : (o.from ?? FARAH),
      senderName: o.fromMe ? null : o.name === undefined ? 'Farah Aziz' : o.name,
      timestamp: Date.now(),
      quotedId: o.quotedId ?? null,
      media: null,
      ...(o.mentions ? { mentionedJids: o.mentions } : {}),
    },
    o.source ?? 'live',
  );
  return id;
}
const tag = (body = '@60000000000 what time do you open?', o: Incoming = {}) =>
  inGroup(body, { mentions: [OWN], ...o });
const settle = () => vi.advanceTimersByTimeAsync(3000);
const sentToGroup = () => t.wa.sent.filter((s) => s.chatJid === G);
const groupLines = () =>
  getChats(t.ctx)
    .events(G)
    .filter((e) => e.type === 'ai_tool_used' && e.payload.group)
    .map((e) => e.payload.group as AiGroupEvent);
const aiMessageIds = () =>
  (
    t.ctx.db
      .prepare(
        "SELECT id FROM messages WHERE chat_jid = ? AND sent_by_user_id = ? AND status <> 'failed' ORDER BY timestamp, rowid",
      )
      .all(G, aiUserId) as Array<{ id: string }>
  ).map((r) => r.id);
/** A teammate writes in the group from the inbox (ends a run of AI answers). */
async function teammateWrites(text = 'Thanks all!') {
  getMessages(t.ctx).sendText(G, { text, clientId: `tm-${++seq}` }, adminId);
  await settle();
}

describe('addressed to the AI', { timeout: 30_000 }, () => {
  it('counts a tag of the own JID (any device) or LID and a quote of an AI answer only', async () => {
    await setUp();
    const check = (id: string, quotedId: string | null = null) =>
      addressedToAi(t.ctx, { chatJid: G, messageId: id, quotedId, aiUserId });
    const history = { source: 'history' as const };
    expect(
      check(
        await inGroup('@60000000000 hi', {
          ...history,
          mentions: ['60000000000:12@s.whatsapp.net'],
        }),
      ),
    ).toBe('tag');
    expect(check(await inGroup('@99000000000001 hi', { ...history, mentions: [OWN_LID] }))).toBe(
      'tag',
    );
    expect(check(await inGroup('@60122222222 hi', { ...history, mentions: [ARJUN] }))).toBeNull();
    expect(check(await inGroup('Kopi Apong, open now?', history))).toBeNull();
    const corrupt = await inGroup('@60000000000 hi', { ...history, mentions: [OWN] });
    t.ctx.db.prepare("UPDATE messages SET mentioned_jids = 'not json' WHERE id = ?").run(corrupt);
    expect(check(corrupt)).toBeNull();
    t.ctx.db.prepare("UPDATE messages SET mentioned_jids = '{}' WHERE id = ?").run(corrupt);
    expect(check(corrupt)).toBeNull();

    const insert = t.ctx.db.prepare(
      "INSERT INTO messages (id, chat_jid, type, body, timestamp, created_at, from_me, sent_by_user_id, status) VALUES (?, ?, 'text', 'x', ?, ?, 1, ?, 'sent')",
    );
    insert.run('ai-1', G, Date.now(), Date.now(), aiUserId);
    insert.run('tm-1', G, Date.now(), Date.now(), adminId);
    const asked = await inGroup('and on Sunday?', history);
    expect(check(asked, 'ai-1')).toBe('quote');
    expect(check(asked, 'tm-1')).toBeNull();
    expect(check(asked, 'missing')).toBeNull();
  });

  it('names members without numbers and hides numeric tags', async () => {
    await setUp();
    const base = { senderJid: FARAH, senderName: 'Farah Aziz', senderProfile: null } as Message;
    expect(memberName(t.ctx, base)).toBe('Farah Aziz');
    expect(memberName(t.ctx, { ...base, senderName: '+60 11-111 1111' })).toBeNull();
    expect(memberName(t.ctx, { ...base, senderJid: null, senderName: null })).toBeNull();
    expect(
      memberName(t.ctx, { ...base, senderProfile: { chatJid: FARAH, name: 'Farah (VIP)' } }),
    ).toBe('Farah (VIP)');
    t.ctx.db
      .prepare("INSERT INTO contacts (jid, saved_name, push_name) VALUES (?, 'Cik Farah', NULL)")
      .run(FARAH);
    expect(memberName(t.ctx, base)).toBe('Cik Farah');
    expect(groupText('@60111111111 and @Aina, @12 ok')).toBe('@member and @Aina, @12 ok');
  });
});

describe('answers in a group', { timeout: 30_000 }, () => {
  it('answers a tag quoting the member, never taking the group', async () => {
    await setUp();
    const daniel = t.ctx.services.auth!.createUser({
      username: 'daniel',
      displayName: 'Daniel',
      role: 'agent',
      password: 'password123',
      mustChangePassword: false,
    });
    getChats(t.ctx).patch(G, { assignedTo: daniel.id }, adminId);
    await inGroup('Morning all!', { from: ARJUN, name: '60122222222' });
    const asked = await tag();
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(sentToGroup()).toHaveLength(1);
    expect(sentToGroup()[0]).toMatchObject({ text: 'We open at 8am, Farah.' });
    expect((sentToGroup()[0] as { reply?: { quotedId: string } }).reply?.quotedId).toBe(asked);
    expect(getChats(t.ctx).get(G)!.assignedTo).toBe(daniel.id);
    expect(groupLines()).toEqual([{ kind: 'answered', member: 'Farah Aziz' }]);
    expect(
      t.ctx.db.prepare('SELECT count(*) AS n FROM ai_chat_state WHERE chat_jid = ?').get(G),
    ).toEqual({ n: 0 });

    const prompt = prompts[0]!;
    expect(prompt.instructions).toContain(GROUP_RULES);
    const input = JSON.parse(prompt.input) as {
      conversation: Array<{ speaker: string; name?: string; text: string }>;
      currentSituation: { group: Record<string, string>; resolution?: string };
    };
    expect(input.currentSituation.group).toMatchObject({
      name: 'Kopi Lovers Club',
      askingMember: 'Farah Aziz',
      addressedBy: 'The member tagged the business.',
    });
    expect(input.currentSituation.resolution).toBeUndefined();
    expect(input.conversation).toEqual([
      { speaker: 'customer', name: 'Member', text: 'Morning all!' },
      { speaker: 'customer', name: 'Farah Aziz', text: expect.stringContaining('what time') },
    ]);
    expect(prompt.input).not.toMatch(/60111111111|60122222222|60000000000/);
  });

  it('leaves a message deleted for everyone out of the group conversation', async () => {
    await setUp();
    const gone = await inGroup('Wrong group, sorry', { from: ARJUN, name: 'Arjun' });
    t.wa.simulateRevoke({ chatJid: G, targetId: gone, senderJid: ARJUN });
    await vi.waitFor(() =>
      expect(
        t.ctx.db.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(gone),
      ).toMatchObject({ deleted_at: expect.any(Number) }),
    );
    await tag();
    await settle();
    expect(sentToGroup().map((s) => s.text)).toEqual(['We open at 8am, Farah.']);
    const input = JSON.parse(prompts[0]!.input) as { conversation: Array<{ text: string }> };
    expect(input.conversation.map((turn) => turn.text)).toEqual([
      expect.stringContaining('what time'),
    ]);
  });

  it('answers any member who quotes an AI answer, without a tag', async () => {
    await setUp();
    await tag();
    await settle();
    const answer = aiMessageIds()[0]!;
    decide = () => ({ reply: 'Yes, Arjun, Sundays too.', action: 'ask_resolution' });
    const asked = await inGroup('Sunday also?', { from: ARJUN, name: 'Arjun', quotedId: answer });
    await settle();
    expect(sentToGroup().map((s) => s.text)).toEqual([
      'We open at 8am, Farah.',
      'Yes, Arjun, Sundays too.',
    ]);
    expect((sentToGroup()[1] as { reply?: { quotedId: string } }).reply?.quotedId).toBe(asked);
    expect(groupLines()[1]).toEqual({ kind: 'answered', member: 'Arjun', quoted: true });
    const input = JSON.parse(prompts[1]!.input) as {
      currentSituation: { group: Record<string, string> };
    };
    expect(input.currentSituation.group.addressedBy).toBe(
      'The member replied to your earlier answer.',
    );
  });

  it('stays silent for every message that is not addressed to the AI', async () => {
    await setUp();
    await teammateWrites('Hello from the team');
    const teammate = (
      t.ctx.db
        .prepare('SELECT id FROM messages WHERE chat_jid = ? AND sent_by_user_id = ?')
        .get(G, adminId) as { id: string }
    ).id;
    await inGroup('Anyone tried the pandan toast?');
    await inGroup('@60122222222 you?', { mentions: [ARJUN] });
    await inGroup('Thanks!', { quotedId: teammate });
    await tag(undefined, { source: 'history' });
    await tag('@60000000000 note to self', { fromMe: true });
    await settle();
    expect(provider.generate).not.toHaveBeenCalled();
    expect(sentToGroup()).toHaveLength(1);
    expect(groupLines()).toEqual([]);
  });

  it('does nothing while any switch is off', async () => {
    await setUp({ groups: false });
    const ai = t.ctx.services.ai!;
    await tag();
    await settle();
    setAgentGroups(t.ctx, agentId, true, actor);
    await tag();
    await settle();
    setGroupChat(t.ctx, G, true, actor);
    ai.saveMember({ displayName: 'Aina', enabled: false, instructions: '' }, actor);
    await tag();
    await settle();
    expect(provider.generate).not.toHaveBeenCalled();
    ai.saveMember({ displayName: 'Aina', enabled: true, instructions: '' }, actor);
    await tag();
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('stops a waiting answer when the group or the agent switch goes off', async () => {
    await setUp();
    await tag();
    setGroupChat(t.ctx, G, false, actor);
    await settle();
    setGroupChat(t.ctx, G, true, actor);
    await tag();
    setAgentGroups(t.ctx, agentId, false, actor);
    await settle();
    expect(provider.generate).not.toHaveBeenCalled();
    expect(sentToGroup()).toHaveLength(0);
  });

  it('hands over with the group line, an event, an audit row and a notification', async () => {
    await setUp();
    decide = () => ({
      reply: 'Someone will help',
      action: 'handoff',
      handoffReason: 'needs_action',
    });
    const events: Array<{ member: string | null; question: string; agentName: string }> = [];
    t.ctx.bus.on('ai:group_handoff', (e) => events.push(e));
    const asked = await tag('@60000000000 can you book a table for 6 tonight?');
    await settle();
    expect(sentToGroup().map((s) => s.text)).toEqual([GROUP_HANDOVER_REPLY]);
    expect((sentToGroup()[0] as { reply?: { quotedId: string } }).reply?.quotedId).toBe(asked);
    expect(groupLines()).toEqual([{ kind: 'handover', member: 'Farah Aziz' }]);
    expect(events).toEqual([
      expect.objectContaining({
        agentName: 'Aina',
        member: 'Farah Aziz',
        question: expect.stringContaining('book a table'),
      }),
    ]);
    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'ai.group_handoff'")
      .get() as { meta: string };
    expect(JSON.parse(audit.meta)).toEqual({ chatJid: G, agentId, reason: 'needs_action' });
    expect(getChats(t.ctx).get(G)!.assignedTo).toBeNull();
  });

  it('sends nothing for no_reply and an empty answer', async () => {
    await setUp();
    decide = () => ({ reply: '', action: 'no_reply' });
    await tag('@60000000000 👍');
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(sentToGroup()).toHaveLength(0);
    expect(groupLines()).toEqual([]);
  });

  it('hands over without a model call when facts are missing or the tag has no text', async () => {
    await setUp();
    const ai = t.ctx.services.ai!;
    await tag();
    await settle();
    const sticker = await getMessages(t.ctx).ingest(
      {
        id: 'sticker-1',
        chatJid: G,
        body: null,
        type: 'sticker',
        fromMe: false,
        senderJid: FARAH,
        senderName: 'Farah Aziz',
        timestamp: Date.now(),
        quotedId: aiMessageIds()[0]!,
        media: null,
      },
      'live',
    );
    expect(sticker).not.toBeNull();
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(groupLines().at(-1)).toEqual({ kind: 'handover', member: 'Farah Aziz' });
    const doc = ai.status().documents[0]!;
    ai.removeDocument(null, doc.id, actor);
    await tag();
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(sentToGroup().map((s) => s.text)).toEqual([
      'We open at 8am, Farah.',
      GROUP_HANDOVER_REPLY,
      GROUP_HANDOVER_REPLY,
    ]);
  });

  it('hands over when the model fails or the reply quotes an Internal item', async () => {
    await setUp();
    const secret = 'Our supplier cost for the kopi beans is RM12 per kilogram this month.';
    t.ctx.services.ai!.addText(null, { name: 'Costs', text: secret, internal: true }, actor);
    decide = () => {
      throw new Error('boom');
    };
    await tag();
    await settle();
    decide = () => ({ reply: `Sure: ${secret}`, action: 'answer' });
    await tag();
    await settle();
    expect(sentToGroup().map((s) => s.text)).toEqual([GROUP_HANDOVER_REPLY, GROUP_HANDOVER_REPLY]);
    expect(
      (
        t.ctx.db
          .prepare("SELECT meta FROM audit_log WHERE action = 'ai.group_handoff' ORDER BY id")
          .all() as Array<{ meta: string }>
      ).map((r) => JSON.parse(r.meta).reason),
    ).toEqual(['ai_unavailable', 'confidential_leak']);
  });

  it('answers at most five waiting questions of a burst, and skips one pushed out of view', async () => {
    await setUp();
    for (let i = 0; i < 7; i++) await tag(`@60000000000 question ${i}`);
    await settle();
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(5);

    await tag('@60000000000 lost question');
    for (let i = 0; i < 21; i++) await inGroup(`chatter ${i}`, { from: ARJUN, name: 'Arjun' });
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(5);
  });
});

describe('loop guard', { timeout: 60_000 }, () => {
  it('pauses after the limit with one line per run, until a teammate writes', async () => {
    await setUp();
    for (let i = 0; i < AI_GROUP_LOOP_GUARD; i++) {
      await tag(`@60000000000 question ${i}`);
      await settle();
    }
    expect(provider.generate).toHaveBeenCalledTimes(AI_GROUP_LOOP_GUARD);
    expect(loopGuard(t.ctx.db, G)).toMatchObject({ inRow: AI_GROUP_LOOP_GUARD, paused: true });
    expect(groupChatStatus(t.ctx, G).paused).toBe(true);

    const last = aiMessageIds().at(-1)!;
    await inGroup('auto-reply: thanks for your message', {
      from: ARJUN,
      name: 'Bot',
      quotedId: last,
    });
    await tag();
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(AI_GROUP_LOOP_GUARD);
    expect(groupLines().filter((l) => l.kind === 'paused')).toEqual([
      { kind: 'paused', member: null },
    ]);

    await teammateWrites();
    expect(loopGuard(t.ctx.db, G).paused).toBe(false);
    await tag();
    await settle();
    expect(provider.generate).toHaveBeenCalledTimes(AI_GROUP_LOOP_GUARD + 1);
  });
});

describe('notifications', { timeout: 30_000 }, () => {
  it('tells the assignee, else everyone who may open the inbox, naming group and member', async () => {
    await setUp();
    t.ctx.services.push!.shutdown();
    const sent: Array<{ endpoint: string; payload: Record<string, string> }> = [];
    const sender: PushSender = async (sub, payload) => {
      const parsed = JSON.parse(payload) as Record<string, string>;
      // only the hand-over notifications (every group message also notifies as usual)
      if (parsed.title?.includes('needs you'))
        sent.push({ endpoint: sub.endpoint, payload: parsed });
    };
    const push = createPushService(t.ctx, { sender });
    t.ctx.services.push = push;
    const daniel = t.ctx.services.auth!.createUser({
      username: 'daniel',
      displayName: 'Daniel',
      role: 'agent',
      password: 'password123',
      mustChangePassword: false,
    });
    const sub = (name: string): PushSubscribeBody => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
      keys: { p256dh: 'p', auth: 'a' },
    });
    push.subscribe(adminId, sub('admin'));
    push.subscribe(daniel.id, sub('daniel'));
    decide = () => ({ reply: 'x', action: 'handoff', handoffReason: 'needs_action' });
    await tag('@60000000000 please call me');
    await settle();
    expect(sent.map((s) => s.endpoint.split('/').at(-1)).sort()).toEqual(['admin', 'daniel']);
    expect(sent[0]!.payload).toMatchObject({
      title: 'Aina needs you in Kopi Lovers Club',
      body: 'Farah Aziz: @Kopi Apong please call me',
      url: `/chats/${encodeURIComponent(G)}`,
    });

    sent.length = 0;
    getChats(t.ctx).patch(G, { assignedTo: daniel.id }, adminId);
    await tag('@60000000000 hello?', { name: '0123' });
    await settle();
    expect(sent.map((s) => s.endpoint.split('/').at(-1))).toEqual(['daniel']);
    expect(sent[0]!.payload.body).toBe('A member: @Kopi Apong hello?');
    push.shutdown();
  });
});

describe('Try it: group question', { timeout: 30_000 }, () => {
  it('answers as in a group: group rules, the group line on hand-over, no resolution', async () => {
    await setUp();
    const ai = t.ctx.services.ai!;
    const body = {
      question: 'What time do you open?',
      knowledge: { displayName: 'Aina', instructions: '' },
      agentId,
      group: true,
    };
    decide = () => ({ reply: 'From 8am!', action: 'ask_resolution' });
    expect(await ai.tryAnswer(body)).toMatchObject({
      ok: true,
      reply: 'From 8am!',
      action: 'answer',
    });
    expect(prompts[0]!.instructions).toContain(GROUP_RULES);
    expect(JSON.parse(prompts[0]!.input).currentSituation.group.askingMember).toBe('Member');
    decide = () => ({ reply: 'Wait', action: 'handoff', handoffReason: 'asked_for_human' });
    expect(await ai.tryAnswer(body)).toMatchObject({
      reply: GROUP_HANDOVER_REPLY,
      action: 'handoff',
      handoffReason: 'asked_for_human',
    });
    decide = () => ({ reply: '', action: 'no_reply' });
    expect(await ai.tryAnswer(body)).toMatchObject({ reply: '', action: 'no_reply' });
    decide = () => ({ reply: 'From 8am!', action: 'ask_resolution' });
    // A sales agent asks no resolution question by default: the direct-chat answer stays an answer.
    expect(await ai.tryAnswer({ ...body, group: false })).toMatchObject({
      action: 'answer',
      reply: 'From 8am!',
    });
    expect(prompts.at(-1)!.instructions).not.toContain(GROUP_RULES);

    ai.removeDocument(null, ai.status().documents[0]!.id, actor);
    expect(await ai.tryAnswer(body)).toMatchObject({
      reply: GROUP_HANDOVER_REPLY,
      action: 'handoff',
    });
  });
});

describe('routes', { timeout: 30_000 }, () => {
  type Method = 'GET' | 'PUT';
  const call = (method: Method, url: string, cookie?: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: cookie ? authHeaders(cookie) : { origin: 'http://localhost', host: 'localhost' },
      ...(payload ? { payload } : {}),
    });

  it('serve the agent switch and the group switch with their rules and audit rows', async () => {
    await setUp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const groups = `/api/ai/agents/${agentId}/groups`;
    const group = `/api/chats/${encodeURIComponent(G)}/ai-group`;

    const listed = await call('GET', groups, admin.cookie);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({
      enabled: true,
      inboxName: t.ctx.inboxes.repo.get(1)!.name,
      groups: [
        { jid: G, name: 'Kopi Lovers Club', memberCount: null, enabled: true, paused: false },
      ],
      loopGuard: AI_GROUP_LOOP_GUARD,
      answerDirect: true,
      directAvailable: true,
      heldDirect: 0,
    });
    const off = await call('PUT', groups, admin.cookie, { enabled: false });
    expect(off.json().enabled).toBe(false);
    expect((await call('PUT', groups, admin.cookie, { enabled: 'yes' })).statusCode).toBe(400);
    expect((await call('PUT', groups, admin.cookie, { enabled: true, x: 1 })).statusCode).toBe(400);
    const missing = await call('GET', '/api/ai/agents/999/groups', admin.cookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('agent_not_found');
    expect(
      (await call('PUT', '/api/ai/agents/999/groups', admin.cookie, { enabled: true })).statusCode,
    ).toBe(404);

    const status = await call('GET', group, agent.cookie);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      enabled: true,
      agentId,
      agentName: 'Aina',
      agentEnabled: true,
      agentAnswersGroups: false,
      paused: false,
    });
    const put = await call('PUT', group, admin.cookie, { enabled: false });
    expect(put.json()).toMatchObject({ enabled: false, agentEnabled: true });
    expect((await call('PUT', group, admin.cookie, {})).statusCode).toBe(400);

    getChats(t.ctx).upsertFromWa({ jid: DM, type: 'dm', name: 'Mei' });
    const direct = await call('GET', `/api/chats/${encodeURIComponent(DM)}/ai-group`, agent.cookie);
    expect(direct.statusCode).toBe(400);

    for (const [method, url, body] of [
      ['GET', groups],
      ['PUT', groups, { enabled: true }],
      ['PUT', group, { enabled: true }],
    ] as Array<[Method, string, object?]>) {
      expect((await call(method, url, agent.cookie, body)).statusCode, `${method} ${url}`).toBe(
        403,
      );
      expect((await call(method, url, undefined, body)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await call('GET', group)).statusCode).toBe(401);

    const audits = (
      t.ctx.db
        .prepare(
          "SELECT action, meta FROM audit_log WHERE action IN ('ai.groups_switch', 'ai.group_switch') ORDER BY id",
        )
        .all() as Array<{ action: string; meta: string }>
    ).map((r) => [r.action, JSON.parse(r.meta)]);
    expect(audits.at(-2)).toEqual([
      'ai.groups_switch',
      { agentId, agentName: 'Aina', enabled: false },
    ]);
    expect(audits.at(-1)).toEqual([
      'ai.group_switch',
      { chatJid: G, groupName: 'Kopi Lovers Club', enabled: false },
    ]);
  });

  it('lists no groups for an agent without an inbox, and lets the fake phone quote', async () => {
    await setUp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    await tag();
    await settle();
    const answer = aiMessageIds()[0]!;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      headers: authHeaders(admin.cookie),
      payload: {
        chatJid: G,
        text: 'and Sunday?',
        senderJid: ARJUN,
        senderName: 'Arjun',
        quotedId: answer,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const stored = t.ctx.db
      .prepare('SELECT quoted_id FROM messages WHERE id = ?')
      .get(res.json().id) as { quoted_id: string };
    expect(stored.quoted_id).toBe(answer);
    await settle();
    expect(groupLines().at(-1)).toEqual({ kind: 'answered', member: 'Arjun', quoted: true });

    t.ctx.db.prepare('UPDATE ai_agents SET inbox_id = NULL WHERE id = ?').run(agentId);
    const listed = await call('GET', `/api/ai/agents/${agentId}/groups`, admin.cookie);
    expect(listed.json()).toMatchObject({ inboxName: null, groups: [] });
    const status = await call('GET', `/api/chats/${encodeURIComponent(G)}/ai-group`, admin.cookie);
    expect(status.json()).toMatchObject({
      agentId: null,
      agentEnabled: false,
      agentAnswersGroups: false,
    });
  });

  it('answers 404 for a group outside the caller’s inboxes', async () => {
    await setUp({ maxInboxes: 2, inboxes: 2 });
    const agent = await createUserAndLogin(t, { role: 'agent' });
    t.ctx.inboxes.repo.setUserInboxes(agent.user.id, [2]);
    const res = await call('GET', `/api/chats/${encodeURIComponent(G)}/ai-group`, agent.cookie);
    expect(res.statusCode).toBe(404);
  });
});

describe('migration 024', { timeout: 30_000 }, () => {
  it('adds the agent switch (off) and the group switch table', async () => {
    await setUp({ groups: false });
    const columns = t.ctx.db.prepare('PRAGMA table_info(ai_agents)').all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(columns.find((c) => c.name === 'answer_groups')?.dflt_value).toBe('0');
    expect(agentById(t.ctx.db, agentId)!.answerGroups).toBe(false);
    const table = t.ctx.db.prepare('PRAGMA table_info(ai_group_chats)').all() as Array<{
      name: string;
    }>;
    expect(table.map((c) => c.name)).toEqual(['chat_jid', 'enabled', 'updated_at', 'updated_by']);
  });
});

// "Answer direct chats" (docs/features/ai-direct-chats/design.md): off makes a group-only agent. It
// never answers or takes a direct chat, cannot be assigned one, returns the ones it holds to the
// team, and keeps answering tags in its groups. An inbox without groups ignores the switch.
/** A live direct message from the customer of `jid`. */
const direct = (jid: string, body: string) => {
  getChats(t.ctx).upsertFromWa({ jid, type: 'dm', name: 'Mei' });
  return inGroup(body, { chatJid: jid, from: jid, name: 'Mei' });
};
/** Past the unassigned-chat fallback (AI_FALLBACK_MS). */
const settleDirect = () => vi.advanceTimersByTimeAsync(15_000);
const sentTo = (jid: string) => t.wa.sent.filter((s) => s.chatJid === jid);
const dm = () => getChats(t.ctx).get(DM)!;

describe('Answer direct chats', { timeout: 30_000 }, () => {
  it('is on for every agent by default and answers direct chats as before', async () => {
    await setUp();
    expect(agentById(t.ctx.db, agentId)!.answerDirect).toBe(true);
    expect(agentGroups(t.ctx, agentId)).toMatchObject({
      answerDirect: true,
      directAvailable: true,
      heldDirect: 0,
    });
    await direct(DM, 'What time do you open?');
    await settleDirect();
    expect(dm().assignedTo).toBe(aiUserId);
    expect(sentTo(DM)).toHaveLength(1);
    expect(agentGroups(t.ctx, agentId).heldDirect).toBe(1);
  });

  it('off: never answers or takes a direct chat, still answers a tag in its group', async () => {
    await setUp();
    setAgentDirect(t.ctx, agentId, false, actor);
    await direct(DM, 'What time do you open?');
    await settleDirect();
    expect(dm().assignedTo).toBeNull();
    expect(sentTo(DM)).toHaveLength(0);

    await tag();
    await settleDirect();
    expect(sentTo(G)).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  it('turning it off returns held direct chats to the team and stops a pending reply', async () => {
    await setUp();
    await direct(DM, 'What time do you open?');
    await settleDirect();
    expect(dm().assignedTo).toBe(aiUserId);

    // A new question is waiting for the AI when the switch goes off.
    await direct(DM, 'And on Sunday?');
    const view = setAgentDirect(t.ctx, agentId, false, actor);
    expect(view).toMatchObject({ answerDirect: false, heldDirect: 0 });
    await settleDirect();
    expect(dm().assignedTo).toBeNull();
    expect(sentTo(DM)).toHaveLength(1);

    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'ai.direct_switch' ORDER BY id DESC")
      .get() as { meta: string };
    expect(JSON.parse(audit.meta)).toEqual({ agentId, agentName: 'Aina', enabled: false });

    // On again: a released chat stays with the team (as when an agent is turned off); a new
    // direct chat is answered.
    setAgentDirect(t.ctx, agentId, true, actor);
    await direct(DM, 'Hello?');
    const other = '60144444444@s.whatsapp.net';
    getChats(t.ctx).upsertFromWa({ jid: other, type: 'dm', name: 'Ali' });
    await direct(other, 'Open today?');
    await settleDirect();
    expect(dm().assignedTo).toBeNull();
    expect(sentTo(DM)).toHaveLength(1);
    expect(getChats(t.ctx).get(other)!.assignedTo).toBe(aiUserId);
    expect(sentTo(other)).toHaveLength(1);
  });

  it('refuses assigning a direct chat to a group-only agent and marks it in the directory', async () => {
    await setUp();
    getChats(t.ctx).upsertFromWa({ jid: DM, type: 'dm', name: 'Mei' });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const assign = (jid: string) =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/chats/${encodeURIComponent(jid)}`,
        headers: authHeaders(admin.cookie),
        payload: { assignedTo: aiUserId },
      });
    const directory = async () =>
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/users/directory',
          headers: authHeaders(agent.cookie),
        })
      )
        .json()
        .users.find((u: DirectoryUser) => u.id === aiUserId) as DirectoryUser;

    expect((await directory()).aiNoDirect).toBeUndefined();
    setAgentDirect(t.ctx, agentId, false, actor);
    expect((await directory()).aiNoDirect).toBe(true);
    const refused = await assign(DM);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('agent_no_direct_chats');
    expect(dm().assignedTo).toBeNull();

    setAgentDirect(t.ctx, agentId, true, actor);
    expect((await assign(DM)).statusCode).toBe(200);
  });

  it('PUT /api/ai/agents/:agentId/direct is for admins and validates its body', async () => {
    await setUp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const put = (cookie: string | undefined, payload: object, id = agentId) =>
      t.app.inject({
        method: 'PUT',
        url: `/api/ai/agents/${id}/direct`,
        headers: cookie ? authHeaders(cookie) : { origin: 'http://localhost', host: 'localhost' },
        payload,
      });
    const off = await put(admin.cookie, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ enabled: true, answerDirect: false, directAvailable: true });
    expect(agentById(t.ctx.db, agentId)!.answerDirect).toBe(false);
    expect((await put(admin.cookie, { enabled: 'no' })).statusCode).toBe(400);
    expect((await put(admin.cookie, { enabled: true, x: 1 })).statusCode).toBe(400);
    expect((await put(admin.cookie, { enabled: true }, 999)).statusCode).toBe(404);
    expect((await put(agent.cookie, { enabled: true })).statusCode).toBe(403);
    expect((await put(undefined, { enabled: true })).statusCode).toBe(401);
  });
});

describe('an inbox without groups', () => {
  const ctxWith = (adapter: () => Partial<WaAdapter>) =>
    ({ inboxes: { connections: { adapter } } }) as unknown as AppContext;
  const agent = (over: Partial<AgentRow>) =>
    ({ inboxId: 1, answerDirect: false, ...over }) as AgentRow;

  it('ignores the switch: a Business API agent always answers direct chats', () => {
    const businessApi = ctxWith(() => ({ capabilities: { groups: false } as never }));
    expect(inboxHasGroups(businessApi, 1)).toBe(false);
    expect(answersDirect(businessApi, agent({}))).toBe(true);

    const linkedPhone = ctxWith(() => ({ capabilities: { groups: true } as never }));
    expect(answersDirect(linkedPhone, agent({}))).toBe(false);
    expect(answersDirect(linkedPhone, agent({ answerDirect: true }))).toBe(true);
    // An adapter without its own capabilities is a linked phone.
    expect(
      inboxHasGroups(
        ctxWith(() => ({})),
        1,
      ),
    ).toBe(true);
  });

  it('counts a removed inbox and no inbox as having no groups', () => {
    const removed = ctxWith(() => {
      throw new Error('inbox 2 has no WhatsApp connection');
    });
    expect(inboxHasGroups(removed, 2)).toBe(false);
    expect(inboxHasGroups(removed, null)).toBe(false);
    expect(answersDirect(removed, agent({ inboxId: null }))).toBe(true);
  });

  it('refuses to save the switch of an unknown agent', async () => {
    t = await makeTestApp();
    expect(() => setAgentAnswerDirect(t.ctx.db, 999, false)).toThrow('agent_not_found');
  });
});

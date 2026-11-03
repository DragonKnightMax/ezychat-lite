// Several AI agents per WhatsApp number (docs/features/group-agents/design.md, Part B): the agent
// limit, one direct agent per inbox, groups given to an agent, "Reads every message" batching, the
// listen loop guard, releasing groups and the start-up backfill. Mock model only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentBody } from '@ezychat/shared';
import { FakeWaAdapter } from '@ezychat/wa';
import { agentById, type AgentRow } from '../src/ai/agents.js';
import { directAgentOf, directSlotTaken } from '../src/ai/direct.js';
import {
  agentForChat,
  backfillGroupAgents,
  chatAgent,
  groupChatRow,
  isGroupKey,
  loopGuard,
  setAgentGroups,
  setGroupChat,
} from '../src/ai/groups.js';
import { LISTEN_SITUATION } from '../src/ai/prompt.js';
import type * as TurnTools from '../src/ai/agent/turn-tools.js';
import type { AiPrompt, AiProvider } from '../src/ai/provider-types.js';
import { AI_GROUP_LISTEN_WINDOW_MS, createAiService } from '../src/ai/service.js';
import type { AppContext } from '../src/context.js';
import { createMessageService } from '../src/messages/service.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

/** Every `agentTurnTools` call's options (the real tools still run). */
const turnOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../src/ai/agent/turn-tools.js', async (importOriginal) => {
  const real = await importOriginal<typeof TurnTools>();
  return {
    ...real,
    agentTurnTools: (async (...args: Parameters<typeof real.agentTurnTools>) => {
      turnOptions.push(args[3] as unknown as Record<string, unknown>);
      return real.agentTurnTools(...args);
    }) as typeof real.agentTurnTools,
  };
});

const G = '120363000000001@g.us';
const G2 = '120363000000002@g.us';
const OWN = '60000000000@s.whatsapp.net';
const FARAH = '60111111111@s.whatsapp.net';
const ARJUN = '60122222222@s.whatsapp.net';
const DM = '60133333333@s.whatsapp.net';

type Decision = { reply: string; action: string; handoffReason?: string | null };

let t: TestApp;
let decide: (prompt: AiPrompt) => Decision;
let prompts: AiPrompt[];
let actor: { userId: number; ip: string | null };
let aina: AgentRow;
let seq = 0;

afterEach(async () => {
  await t?.close();
  vi.useRealTimers();
  turnOptions.length = 0;
});

const claimsBody: AiAgentBody = {
  displayName: 'Claims',
  enabled: false,
  preset: 'custom',
  instructions: 'Record every claim.',
  inboxId: null,
};

async function setUp(opts: { maxAgents?: number } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  prompts = [];
  decide = () => ({ reply: 'Recorded ✅', action: 'answer' });
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
  t = await makeTestApp({
    wa: new FakeWaAdapter({ me: { jid: OWN, name: 'Kopi Apong' } }),
    ...(opts.maxAgents ? { config: { maxAgents: opts.maxAgents } } : {}),
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
  aina = agentById(t.ctx.db, ai.listAgents()[0]!.id)!;
  getChats(t.ctx).upsertFromWa({ jid: G, type: 'group', name: 'Claims KL' });
  getChats(t.ctx).upsertFromWa({ jid: G2, type: 'group', name: 'Claims Penang' });
}

/** A second agent on the same number (group-only), switched on with "Answer in groups". */
function addClaims(): AgentRow {
  const ai = t.ctx.services.ai!;
  const created = ai.createAgent(claimsBody, actor);
  ai.addText(
    created.agent.id,
    { name: 'Claims', text: 'A claim has a number and an amount.' },
    actor,
  );
  const { inboxId: _inbox, ...saved } = claimsBody;
  ai.saveAgent(created.agent.id, { ...saved, enabled: true }, actor);
  setAgentGroups(t.ctx, created.agent.id, true, actor);
  return agentById(t.ctx.db, created.agent.id)!;
}

async function inGroup(
  body: string,
  o: {
    from?: string;
    name?: string;
    source?: 'live' | 'history';
    mentions?: string[];
    fromMe?: boolean;
    chatJid?: string;
  } = {},
) {
  const id = `m-${++seq}`;
  await getMessages(t.ctx).ingest(
    {
      id,
      chatJid: o.chatJid ?? G,
      body,
      type: 'text',
      fromMe: o.fromMe ?? false,
      senderJid: o.fromMe ? null : (o.from ?? FARAH),
      senderName: o.fromMe ? null : (o.name ?? 'Farah Aziz'),
      timestamp: Date.now(),
      quotedId: null,
      media: null,
      ...(o.mentions ? { mentionedJids: o.mentions } : {}),
    },
    o.source ?? 'live',
  );
  return id;
}
const sentTo = (jid: string) => t.wa.sent.filter((s) => s.chatJid === jid);
const situation = (prompt: AiPrompt) =>
  (JSON.parse(prompt.input) as { currentSituation: Record<string, unknown> }).currentSituation;
const call = (method: 'GET' | 'PUT', url: string, cookie: string, payload?: object) =>
  t.app.inject({ method, url, headers: authHeaders(cookie), ...(payload ? { payload } : {}) });

describe('agent limit', { timeout: 30_000 }, () => {
  it('Lite: one agent, groups get it as before', async () => {
    await setUp();
    const ai = t.ctx.services.ai!;
    expect(ai.maxAgents()).toBe(1);
    expect(() => ai.createAgent(claimsBody, actor)).toThrow(
      expect.objectContaining({ code: 'agent_limit' }),
    );
    setAgentGroups(t.ctx, aina.id, true, actor);
    const status = setGroupChat(t.ctx, G, { enabled: true }, actor);
    expect(status).toMatchObject({
      enabled: true,
      agentId: aina.id,
      listen: false,
      agents: [{ id: aina.id, name: 'Aina' }],
    });
    expect(agentForChat(t.ctx, G)?.id).toBe(aina.id);
  });

  it('maxAgents from the config allows several agents on one number', async () => {
    await setUp({ maxAgents: 3 });
    expect(t.ctx.services.ai!.maxAgents()).toBe(3);
    const claims = addClaims();
    expect(claims).toMatchObject({ inboxId: 1, answerDirect: false, answerGroups: true });
    expect(directAgentOf(t.ctx, 1)?.id).toBe(aina.id);
    expect(chatAgent(t.ctx, DM)?.id).toBe(aina.id);
    expect(isGroupKey(G)).toBe(true);
    expect(isGroupKey(DM)).toBe(false);
    // the second agent cannot also answer direct chats
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const res = await call('PUT', `/api/ai/agents/${claims.id}/direct`, admin.cookie, {
      enabled: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('inbox_has_direct_agent');
    expect(agentById(t.ctx.db, claims.id)!.answerDirect).toBe(false);
  });

  it('an inbox without groups takes one agent only (it answers direct chats)', async () => {
    await setUp({ maxAgents: 3 });
    const real = t.ctx.inboxes.connections.adapter.bind(t.ctx.inboxes.connections);
    vi.spyOn(t.ctx.inboxes.connections, 'adapter').mockImplementation((id: number) => {
      const wa = real(id);
      return Object.assign(Object.create(wa) as typeof wa, {
        capabilities: { ...wa.capabilities, groups: false },
      });
    });
    expect(directSlotTaken(t.ctx, 1, null)).toBe(true);
    expect(directSlotTaken(t.ctx, 1, aina.id)).toBe(false);
    expect(directSlotTaken(t.ctx, null, null)).toBe(false);
    expect(() => t.ctx.services.ai!.createAgent(claimsBody, actor)).toThrow(
      expect.objectContaining({ code: 'inbox_has_direct_agent' }),
    );
  });
});

describe('groups given to agents', { timeout: 30_000 }, () => {
  it('PUT group-chats gives, refuses a taken group and takes back', async () => {
    await setUp({ maxAgents: 3 });
    const claims = addClaims();
    setAgentGroups(t.ctx, aina.id, true, actor);
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const url = (id: number) => `/api/ai/agents/${id}/group-chats`;

    const given = await call('PUT', url(claims.id), admin.cookie, {
      jids: [G, G2],
      enabled: true,
      listen: true,
    });
    expect(given.statusCode, given.body).toBe(200);
    expect(given.json().groups).toEqual([
      expect.objectContaining({
        jid: G,
        enabled: true,
        agentId: claims.id,
        agentName: 'Claims',
        listen: true,
      }),
      expect.objectContaining({ jid: G2, enabled: true, agentId: claims.id, listen: true }),
    ]);
    // the same again changes nothing; without listen a group keeps its own setting
    await call('PUT', url(claims.id), admin.cookie, { jids: [G], enabled: true });
    expect(groupChatRow(t.ctx.db, G)).toEqual({ enabled: true, agentId: claims.id, listen: true });

    const taken = await call('PUT', url(aina.id), admin.cookie, { jids: [G], enabled: true });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('group_has_agent');
    // another agent cannot take a group back that is not its own
    await call('PUT', url(aina.id), admin.cookie, { jids: [G], enabled: false });
    expect(groupChatRow(t.ctx.db, G).agentId).toBe(claims.id);

    getChats(t.ctx).upsertFromWa({ jid: DM, type: 'dm', name: 'Mei' });
    const notGroup = await call('PUT', url(claims.id), admin.cookie, { jids: [DM], enabled: true });
    expect(notGroup.statusCode).toBe(400);
    const missing = await call('PUT', url(999), admin.cookie, { jids: [G], enabled: true });
    expect(missing.statusCode).toBe(404);
    const bad = await call('PUT', url(claims.id), admin.cookie, { jids: [], enabled: true });
    expect(bad.statusCode).toBe(400);
    const agent = await createUserAndLogin(t, { role: 'agent' });
    expect(
      (await call('PUT', url(claims.id), agent.cookie, { jids: [G], enabled: true })).statusCode,
    ).toBe(403);

    const back = await call('PUT', url(claims.id), admin.cookie, { jids: [G2], enabled: false });
    expect(back.json().groups.find((g: { jid: string }) => g.jid === G2)).toMatchObject({
      enabled: false,
      agentId: null,
      listen: false,
    });
    const audits = (
      t.ctx.db
        .prepare("SELECT meta FROM audit_log WHERE action = 'ai.group_switch' ORDER BY id")
        .all() as Array<{ meta: string }>
    ).map((r) => JSON.parse(r.meta));
    expect(audits).toHaveLength(3);
    expect(audits.at(-1)).toMatchObject({
      chatJid: G2,
      enabled: false,
      agentId: null,
      before: { enabled: true, agentId: claims.id, listen: true },
    });

    t.ctx.db.prepare('UPDATE ai_agents SET inbox_id = NULL WHERE id = ?').run(claims.id);
    const noInbox = await call('PUT', url(claims.id), admin.cookie, { jids: [G], enabled: true });
    expect(noInbox.statusCode).toBe(400);
  });

  it('PUT ai-group picks the agent and Reads every message', async () => {
    await setUp({ maxAgents: 3 });
    const claims = addClaims();
    setAgentGroups(t.ctx, aina.id, true, actor);
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const url = `/api/chats/${encodeURIComponent(G)}/ai-group`;

    const required = await call('PUT', url, admin.cookie, { enabled: true });
    expect(required.statusCode).toBe(400);
    expect(required.json().error.code).toBe('agent_required');

    const set = await call('PUT', url, admin.cookie, {
      enabled: true,
      agentId: claims.id,
      listen: true,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({
      enabled: true,
      agentId: claims.id,
      agentName: 'Claims',
      agentAnswersGroups: true,
      listen: true,
      agents: [
        { id: aina.id, name: 'Aina' },
        { id: claims.id, name: 'Claims' },
      ],
    });
    // no agentId: the group keeps its agent and its listen setting
    const kept = await call('PUT', url, admin.cookie, { enabled: true });
    expect(kept.json()).toMatchObject({ agentId: claims.id, listen: true });
    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'ai.group_switch' ORDER BY id DESC")
      .get() as { meta: string };
    expect(JSON.parse(audit.meta)).toMatchObject({
      agentId: claims.id,
      listen: true,
      before: { enabled: true, agentId: claims.id, listen: true },
    });

    setAgentGroups(t.ctx, aina.id, false, actor);
    const refused = await call('PUT', url, admin.cookie, { enabled: true, agentId: aina.id });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('agent_not_group_agent');
    expect((await call('PUT', url, admin.cookie, { enabled: true, agentId: 999 })).statusCode).toBe(
      400,
    );
    const off = await call('PUT', url, admin.cookie, { enabled: true, listen: false });
    expect(off.json()).toMatchObject({ agentId: claims.id, listen: false });
  });

  it('routes a group to its agent and a direct chat to the direct agent', async () => {
    await setUp({ maxAgents: 3 });
    const claims = addClaims();
    setGroupChat(t.ctx, G, { enabled: true, agentId: claims.id }, actor);
    expect(agentForChat(t.ctx, G)?.id).toBe(claims.id);
    expect(t.ctx.services.ai!.agentForChat(G)?.id).toBe(claims.id);
    expect(agentForChat(t.ctx, G2)).toBeNull();
    expect(agentForChat(t.ctx, DM)?.id).toBe(aina.id);

    await inGroup('@60000000000 claim 12 for RM50', { mentions: [OWN] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sentTo(G)).toHaveLength(1);
    const reply = t.ctx.db
      .prepare('SELECT sent_by_user_id AS userId FROM messages WHERE chat_jid = ? AND from_me = 1')
      .get(G) as { userId: number };
    expect(reply.userId).toBe(claims.userId);
    // the group turn may add sheet rows for the batch's sender
    expect(turnOptions.at(-1)).toMatchObject({
      lookupsOnly: true,
      record: { personJids: [FARAH], filesGiven: false, fileNames: [] },
    });

    getChats(t.ctx).upsertFromWa({ jid: DM, type: 'dm', name: 'Mei' });
    await inGroup('What time do you open?', { chatJid: DM, from: DM, name: 'Mei' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChats(t.ctx).get(DM)!.assignedTo).toBe(aina.userId);
    expect(turnOptions.at(-1)).toMatchObject({ record: { personJids: null } });

    // a direct chat is never assigned to a group-only agent, a group agent of its own inbox may be
    const patch = (jid: string, userId: number) => () =>
      getChats(t.ctx).patch(jid, { assignedTo: userId }, actor.userId);
    expect(patch(DM, claims.userId)).toThrow(
      expect.objectContaining({ code: 'agent_no_direct_chats' }),
    );
  });
});

describe('Reads every message', { timeout: 30_000 }, () => {
  async function listening() {
    await setUp({ maxAgents: 3 });
    const claims = addClaims();
    setGroupChat(t.ctx, G, { enabled: true, agentId: claims.id, listen: true }, actor);
    return claims;
  }

  it('answers a batch of member messages once, 8 s after the last one', async () => {
    const claims = await listening();
    await inGroup('Claim INV-1042');
    await vi.advanceTimersByTimeAsync(3000);
    await inGroup('RM 1,250.00', { from: ARJUN, name: 'Arjun' });
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS - 100);
    expect(prompts).toHaveLength(0);
    const last = await inGroup('Branch KL');
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS + 100);
    expect(prompts).toHaveLength(1);
    const group = situation(prompts[0]!).group as Record<string, unknown>;
    expect(group).toMatchObject({
      addressedBy: LISTEN_SITUATION,
      messageToAnswer: 'Branch KL',
      newMessages: [
        { member: 'Farah Aziz', text: 'Claim INV-1042' },
        { member: 'Arjun', text: 'RM 1,250.00' },
        { member: 'Farah Aziz', text: 'Branch KL' },
      ],
    });
    expect(turnOptions.at(-1)).toMatchObject({
      record: { personJids: [FARAH, ARJUN], filesGiven: false },
    });
    expect((turnOptions.at(-1)!.record as { messageIds: string[] }).messageIds.at(-1)).toBe(last);
    expect(sentTo(G)).toHaveLength(1);
    expect(sentTo(G)[0]!.text).toBe('Recorded ✅');
    expect(agentForChat(t.ctx, G)?.id).toBe(claims.id);
  });

  it('sends nothing on no_reply and ignores history, own and AI messages', async () => {
    await listening();
    decide = () => ({ reply: '', action: 'no_reply', handoffReason: null });
    await inGroup('Good morning all');
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS + 100);
    expect(prompts).toHaveLength(1);
    expect(sentTo(G)).toHaveLength(0);

    await inGroup('old claim', { source: 'history' });
    await inGroup('from the phone', { fromMe: true });
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS + 100);
    expect(prompts).toHaveLength(1);
  });

  it('a tag/quote group (listen off) still needs a tag', async () => {
    await setUp({ maxAgents: 3 });
    const claims = addClaims();
    setGroupChat(t.ctx, G, { enabled: true, agentId: claims.id }, actor);
    await inGroup('not for the AI');
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS + 3000);
    expect(prompts).toHaveLength(0);
  });

  it('stops waiting when listening goes off or the service shuts down', async () => {
    await listening();
    await inGroup('Claim 1');
    setGroupChat(t.ctx, G, { enabled: true, listen: false }, actor);
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS + 100);
    expect(prompts).toHaveLength(0);

    setGroupChat(t.ctx, G, { enabled: true, listen: true }, actor);
    await inGroup('Claim 2');
    await t.ctx.services.ai!.shutdown();
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS + 100);
    expect(prompts).toHaveLength(0);
  });

  it('loop guard: listening pauses only after 10 AI messages with no person in between', async () => {
    const claims = await listening();
    const insert = t.ctx.db.prepare(
      "INSERT INTO messages (id, chat_jid, type, body, timestamp, created_at, from_me, sent_by_user_id, status) VALUES (?, ?, 'text', 'x', ?, ?, ?, ?, 'sent')",
    );
    const at = Date.now();
    for (let i = 0; i < 10; i++) insert.run(`ai-${i}`, G, at + i, at + i, 1, claims.userId);
    expect(loopGuard(t.ctx.db, G, true).paused).toBe(true);
    expect(loopGuard(t.ctx.db, G).paused).toBe(true);
    insert.run('member', G, at + 20, at + 20, 0, null);
    // a member's message breaks the run in listen mode, not in tag mode
    expect(loopGuard(t.ctx.db, G, true)).toMatchObject({ paused: false, inRow: 0 });
    expect(loopGuard(t.ctx.db, G).paused).toBe(true);
  });

  it('a held loop guard writes the paused line and sends nothing', async () => {
    const claims = await listening();
    const insert = t.ctx.db.prepare(
      "INSERT INTO messages (id, chat_jid, type, body, timestamp, created_at, from_me, sent_by_user_id, status) VALUES (?, ?, 'text', 'x', ?, ?, 1, ?, 'sent')",
    );
    await inGroup('Claim 9');
    const at = Date.now() + 1;
    for (let i = 0; i < 10; i++) insert.run(`ai-${i}`, G, at + i, at + i, claims.userId);
    await vi.advanceTimersByTimeAsync(AI_GROUP_LISTEN_WINDOW_MS + 100);
    expect(prompts).toHaveLength(0);
    expect(sentTo(G)).toHaveLength(0);
  });
});

describe('releasing groups', { timeout: 30_000 }, () => {
  it('deleting an agent or turning its groups off turns its groups off, never moves them', async () => {
    await setUp({ maxAgents: 3 });
    const claims = addClaims();
    setAgentGroups(t.ctx, aina.id, true, actor);
    setGroupChat(t.ctx, G, { enabled: true, agentId: claims.id, listen: true }, actor);
    setGroupChat(t.ctx, G2, { enabled: true, agentId: aina.id }, actor);
    setAgentGroups(t.ctx, aina.id, false, actor);
    expect(groupChatRow(t.ctx.db, G2)).toEqual({ enabled: false, agentId: null, listen: false });
    expect(groupChatRow(t.ctx.db, G).agentId).toBe(claims.id);
    t.ctx.services.ai!.deleteAgent(claims.id, actor);
    expect(groupChatRow(t.ctx.db, G)).toEqual({ enabled: false, agentId: null, listen: false });
    expect(agentForChat(t.ctx, G)).toBeNull();
  });

  it('start-up backfill gives an agentless switched-on group the inbox’s only agent, once', async () => {
    await setUp({ maxAgents: 3 });
    t.ctx.db
      .prepare('INSERT INTO ai_group_chats (chat_jid, enabled, updated_at) VALUES (?, 1, 0)')
      .run(G);
    t.ctx.db
      .prepare('INSERT INTO ai_group_chats (chat_jid, enabled, updated_at) VALUES (?, 1, 0)')
      .run('bad#key#x');
    expect(backfillGroupAgents(t.ctx.db)).toBe(1);
    expect(groupChatRow(t.ctx.db, G).agentId).toBe(aina.id);
    expect(backfillGroupAgents(t.ctx.db)).toBe(0);
    // with two agents on the number nobody is chosen for the admin
    addClaims();
    t.ctx.db
      .prepare('INSERT INTO ai_group_chats (chat_jid, enabled, updated_at) VALUES (?, 1, 0)')
      .run(G2);
    expect(backfillGroupAgents(t.ctx.db)).toBe(0);
    expect(groupChatRow(t.ctx.db, G2).agentId).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_HANDOFF_RULES,
  DEFAULT_AI_INSTRUCTIONS,
  type AiConnection,
  type AiMemberBody,
} from '@ezychat/shared';
import { createAiService, AI_FALLBACK_MS, isResolutionConfirmation } from '../src/ai/service.js';
import { VOICE_RETRY_REPLY } from '../src/ai/prompt.js';
import { defaultAgent, updateAgentTexts } from '../src/ai/agents.js';
import type { AiProvider } from '../src/ai/provider-types.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders } from './auth-helpers.js';
import { sha256 } from '../src/crypto/secret.js';
import { createMessageService } from '../src/messages/service.js';
import { pdfFixture } from './ai-fixtures.js';
import { OAuthError } from '../src/ai/chatgpt-oauth.js';
import { createVoiceService, type VoiceServiceDeps } from '../src/voice/service.js';
import { createPushService } from '../src/push/service.js';
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { AgentTurnFailure } from '../src/ai/agent/models.js';
import { join } from 'node:path';

let t: TestApp;
let provider: AiProvider;
let aiLogs: string[] = [];
let actor: { userId: number; ip: null };
let cookie: string;
const jid = 'customer@s.whatsapp.net';
const body: AiMemberBody = {
  displayName: 'Sales Agent',
  enabled: true,
  instructions: 'Be concise',
};
const CONTEXT = 'Opening hours: 9am to 5pm. Delivery costs RM10.';
beforeEach(async () => {
  t = await makeTestApp();
  const auth = t.ctx.services.auth!;
  const admin = auth.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  actor = { userId: admin.id, ip: null };
  cookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 'test' })}`;
  await t.ctx.services.ai!.shutdown();
  t.ctx.services.messages!.shutdown();
  t.ctx.services.messages = createMessageService(t.ctx, {
    now: () => Date.now(),
    queue: { spacingMs: 0 },
  });
  provider = {
    generate: vi.fn().mockResolvedValue({
      reply: 'We open at 9am. Has this answered your question?',
      action: 'ask_resolution',
    }),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(),
  };
  // The AI service's own log lines (mod ai), for tests that check what is logged.
  aiLogs = [];
  const capture = pino({ level: 'debug' }, { write: (line: string) => aiLogs.push(line) });
  const child = t.ctx.log.child.bind(t.ctx.log);
  vi.spyOn(t.ctx.log, 'child').mockImplementation(((bindings: Record<string, unknown>) =>
    bindings.mod === 'ai' ? capture.child(bindings) : child(bindings)) as never);
  t.ctx.services.ai = createAiService(t.ctx, { provider, isOnline: (id) => id % 2 === 0 });
  t.ctx.services.ai.saveConnection({ mode: 'api', model: '', apiKey: 'test-api-key-123' }, actor);
  // Context items belong to the member: save it as a draft, add the business facts, turn on.
  t.ctx.services.ai.saveMember({ ...body, enabled: false }, actor);
  t.ctx.services.ai.addText(null, { name: 'Business context', text: CONTEXT }, actor);
  t.ctx.services.ai.saveMember(body, actor);
  // Most tests here exercise the resolution flow, which a sales agent has off by default.
  t.ctx.services.ai.setResolutionCheck(defaultAgent(t.ctx.db)!.id, true, actor);
});
afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});
async function incoming(
  id = 'incoming',
  text = 'What are your opening hours?',
  source: 'live' | 'history' = 'live',
  chatJid = jid,
  fromMe = false,
) {
  return getMessages(t.ctx).ingest(
    {
      id,
      chatJid,
      body: text,
      type: 'text',
      fromMe,
      senderJid: chatJid,
      senderName: 'Customer',
      timestamp: Date.now(),
      quotedId: null,
      media: null,
    },
    source,
  );
}
function human(username: string) {
  return t.ctx.services.auth!.createUser({
    username,
    displayName: username,
    role: 'agent',
    password: 'password123',
    mustChangePassword: false,
  });
}
function clock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

it('claims an unassigned live direct chat after ten seconds, answers with only its conversation and business knowledge, and replies promptly thereafter', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS - 1);
  expect(provider.generate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  const ai = t.ctx.services.ai!.status().member!;
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(ai.id);
  expect(t.wa.sent[0]?.text).toContain('9am');
  const prompt = vi.mocked(provider.generate).mock.calls[0]![2];
  expect(prompt.input).toContain('Opening hours');
  expect(prompt.input).not.toContain('test-api-key');
  expect(prompt.instructions).toContain('Sales Agent');
  await incoming('next', 'What is delivery?');
  await vi.advanceTimersByTimeAsync(1200);
  expect(provider.generate).toHaveBeenCalledTimes(2);
  expect(t.wa.sent).toHaveLength(2);
});

it('answers with the customer details the team saved, but never their tags', async () => {
  clock();
  await incoming();
  t.ctx.services.customers!.save(
    jid,
    {
      name: 'Priya Nair',
      company: 'Acme',
      email: '',
      otherPhone: '',
      address: '12 Jalan Ampang',
      tags: ['Late payer'],
    },
    actor,
  );
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const { input } = vi.mocked(provider.generate).mock.calls[0]![2];
  expect(JSON.parse(input).currentSituation.customer).toEqual({
    name: 'Priya Nair',
    company: 'Acme',
    address: '12 Jalan Ampang',
  });
  expect(input).not.toContain('Late payer');
});

it('offers older messages as a tool only when the chat is longer than the prompt shows', async () => {
  clock();
  await incoming('short', 'What are your opening hours?');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  // Small business facts are in the prompt and the whole chat fits: a single call, no tools.
  expect(Object.keys(vi.mocked(provider.generate).mock.calls[0]![2].tools ?? {})).toEqual([]);

  const other = 'long@s.whatsapp.net';
  // Real messages have distinct times (the fake clock is frozen otherwise).
  for (let i = 0; i < 22; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await incoming(`h${i}`, i === 0 ? 'My order number is 4521' : `Message ${i}`, 'history', other);
  }
  await vi.advanceTimersByTimeAsync(1000);
  await incoming('ask', 'What was my order number?', 'live', other);
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const call = vi
    .mocked(provider.generate)
    .mock.calls.find(([, , p]) => p.input.includes('What was my order number?'))!;
  const tools = call[2].tools ?? {};
  expect(Object.keys(tools)).toEqual(['get_older_messages']);
  expect(call[2].input).not.toContain('4521');
  const older = await (
    tools.get_older_messages as { execute: (i: object, o: object) => Promise<unknown> }
  ).execute({ page: 1 }, { toolCallId: 't', messages: [] });
  expect(String(older)).toContain('My order number is 4521');
});

it('drops a reply written with details a teammate corrected meanwhile, and answers again', async () => {
  clock();
  await incoming();
  const details = (name: string) => ({
    name,
    company: '',
    email: '',
    otherPhone: '',
    address: '',
    tags: [],
  });
  t.ctx.services.customers!.save(jid, details('Priya Nair'), actor);
  vi.mocked(provider.generate).mockImplementationOnce(async () => {
    // The correction lands while the model is still writing the first reply.
    t.ctx.services.customers!.save(jid, details('Priya Kumar'), actor);
    return { reply: 'Hi Priya Nair, we open at 9am.', action: 'answer' };
  });
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  await vi.advanceTimersByTimeAsync(100);
  const calls = vi.mocked(provider.generate).mock.calls;
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[1]![2].input).currentSituation.customer).toEqual({
    name: 'Priya Kumar',
  });
  expect(t.wa.sent.map((m) => m.text)).not.toContain('Hi Priya Nair, we open at 9am.');
  expect(t.wa.sent).toHaveLength(1);
});

it('drops a reply written while the customer edited their message, and answers the new text', async () => {
  clock();
  await incoming('ask', 'Is delivery free?');
  vi.mocked(provider.generate).mockImplementationOnce(async () => {
    // The customer edits the question while the model is still writing.
    t.wa.simulateEdit({ chatJid: jid, targetId: 'ask', body: 'What are your opening hours?' });
    return { reply: 'Delivery costs RM10.', action: 'answer' };
  });
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  await vi.advanceTimersByTimeAsync(100);
  const calls = vi.mocked(provider.generate).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1]![2].input).toContain('What are your opening hours?');
  expect(calls[1]![2].input).not.toContain('Is delivery free?');
  expect(t.wa.sent.map((m) => m.text)).not.toContain('Delivery costs RM10.');
  expect(aiLogs.join('\n')).toContain('customer_message_changed');
});

it('never shows the model a deleted message and does not answer a deleted question', async () => {
  clock();
  await incoming('first', 'My IC number is 900101-07-1234');
  t.wa.simulateRevoke({ chatJid: jid, targetId: 'first' });
  await incoming('second', 'What are your opening hours?');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const { input } = vi.mocked(provider.generate).mock.calls[0]![2];
  expect(input).not.toContain('900101');
  expect(input).toContain('opening hours');

  const other = 'deleted@s.whatsapp.net';
  await incoming('gone', 'Can I order now?', 'live', other);
  t.wa.simulateRevoke({ chatJid: other, targetId: 'gone' });
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  expect(
    vi.mocked(provider.generate).mock.calls.some(([, , p]) => p.input.includes('Can I order')),
  ).toBe(false);
});

it('does no work while the access gate is closed and picks the chat up again when it opens', async () => {
  clock();
  t.ctx.access.close({ code: 'license_required' });
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 5000);
  expect(provider.generate).not.toHaveBeenCalled();
  expect(t.wa.sent).toHaveLength(0);
  expect(t.ctx.services.ai!.connectionReady()).toBe(false);
  t.ctx.access.open();
  await vi.advanceTimersByTimeAsync(1500);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(t.wa.sent[0]?.text).toContain('9am');
});

it('batches customer messages and ignores imported history, groups, and chats already assigned to a human', async () => {
  clock();
  await incoming('history', 'Old question', 'history', 'old@s.whatsapp.net');
  await incoming('group', 'Question', 'live', 'team@g.us');
  const user = human('human');
  getChats(t.ctx).upsertFromWa({ jid: 'owned@s.whatsapp.net', type: 'dm', name: 'Owned' });
  getChats(t.ctx).patch('owned@s.whatsapp.net', { assignedTo: user.id }, actor.userId);
  await incoming('owned', 'Question', 'live', 'owned@s.whatsapp.net');
  await incoming();
  await vi.advanceTimersByTimeAsync(5000);
  await incoming('second', 'And delivery?');
  await vi.advanceTimersByTimeAsync(9999);
  expect(provider.generate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(t.wa.sent).toHaveLength(1);
  expect(vi.mocked(provider.generate).mock.calls[0]![2].input).toContain('And delivery?');
});

it('cancels fallback after a human or linked-phone reply', async () => {
  clock();
  await incoming();
  getMessages(t.ctx).sendText(
    jid,
    { text: 'I can help', clientId: 'human-reply' },
    human('human').id,
  );
  await incoming('phone-in', 'Hello', 'live', 'phone@s.whatsapp.net');
  await incoming('phone-out', 'I can help', 'live', 'phone@s.whatsapp.net', true);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(provider.generate).not.toHaveBeenCalled();
});

describe('a phone reply in a chat the AI owns', () => {
  const aiUserId = () => defaultAgent(t.ctx.db)!.userId;
  async function aiOwnsChat() {
    clock();
    await incoming();
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 100);
    expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(aiUserId());
    vi.mocked(provider.generate).mockClear();
  }

  it('returns the chat to the team, and the AI stays out while the customer writes on', async () => {
    await aiOwnsChat();
    await incoming('phone-out', 'Yes?', 'live', jid, true);
    const chat = getChats(t.ctx).get(jid)!;
    expect(chat.assignedTo).toBeNull();
    expect(chat.status).toBe('open');
    expect(aiLogs.join('\n')).toContain('AI returned the chat to the team after a phone reply');

    await incoming('after-1', 'Do you have H200 cards?');
    await incoming('after-2', 'my friend');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS * 3);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
  });

  it('answers again when someone assigns the chat back to the AI', async () => {
    await aiOwnsChat();
    await incoming('phone-out', 'Yes?', 'live', jid, true);
    await incoming('after', 'Do you have H200 cards?');
    getChats(t.ctx).patch(jid, { assignedTo: aiUserId() }, actor.userId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('leaves a teammate reply from the app to the normal claim (the AI only pauses)', async () => {
    await aiOwnsChat();
    const teammate = human('teammate');
    getChats(t.ctx).patch(jid, { assignedTo: teammate.id }, teammate.id);
    getMessages(t.ctx).sendText(jid, { text: 'On it', clientId: 'teammate-reply' }, teammate.id);
    expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(teammate.id);
  });

  it('repairs a chat that an older version left assigned to a paused AI', async () => {
    await aiOwnsChat();
    t.ctx.db.prepare('UPDATE ai_chat_state SET paused = 1 WHERE chat_jid = ?').run(jid);
    await t.ctx.services.ai!.shutdown();
    t.ctx.services.ai = createAiService(t.ctx, { provider, isOnline: () => true });
    expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
    expect(aiLogs.join('\n')).toContain('AI returned paused chats to the team at start');
    await incoming('after', 'Hello?');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS * 3);
    expect(provider.generate).not.toHaveBeenCalled();
  });
});

it('aborts generation on human takeover and ignores a late provider result', async () => {
  const taker = human('takeover');
  let finish!: (value: { reply: string; action: 'answer' }) => void;
  vi.mocked(provider.generate).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  const signal = vi.mocked(provider.generate).mock.calls[0]![3];
  getChats(t.ctx).patch(jid, { assignedTo: taker.id }, taker.id);
  expect(signal.aborted).toBe(true);
  finish({ reply: 'Late answer', action: 'answer' });
  await vi.advanceTimersByTimeAsync(0);
  expect(t.wa.sent).toHaveLength(0);
  await incoming('later');
  await vi.advanceTimersByTimeAsync(12_000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

it('cancels a queued reply while presence is pending before WhatsApp sends', async () => {
  const user = human('takeover');
  let finishPresence!: () => void;
  vi.spyOn(t.wa, 'sendPresence').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPresence = resolve;
      }),
  );
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  getChats(t.ctx).patch(jid, { assignedTo: user.id }, user.id);
  finishPresence();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.wa.sent).toHaveLength(0);
  expect(t.ctx.db.prepare('SELECT status FROM messages WHERE from_me = 1').get()).toEqual({
    status: 'failed',
  });
});

it('cancels an older answer as soon as live media arrives and never lets delayed downloads supersede newer text', async () => {
  let finishOld!: (value: { reply: string; action: 'answer' }) => void;
  vi.mocked(provider.generate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  let download!: (buffer: Buffer) => void;
  const image = getMessages(t.ctx).ingest(
    {
      id: 'new-image',
      chatJid: jid,
      body: null,
      type: 'image',
      fromMe: false,
      senderJid: jid,
      senderName: 'Customer',
      timestamp: Date.now(),
      quotedId: null,
      media: {
        mime: 'image/png',
        fileName: 'photo.png',
        download: () =>
          new Promise((resolve) => {
            download = resolve;
          }),
      },
    },
    'live',
  );
  expect(vi.mocked(provider.generate).mock.calls[0]![3].aborted).toBe(true);
  await incoming('newer-text', 'What are your delivery costs?');
  finishOld({ reply: 'Outdated answer', action: 'answer' });
  download(Buffer.from('fake-image'));
  await image;
  await vi.advanceTimersByTimeAsync(1200);
  expect(provider.generate).toHaveBeenCalledTimes(2);
  expect(t.wa.sent).toHaveLength(1);
  expect(t.wa.sent[0]?.text).not.toBe('Outdated answer');
  expect(
    t.ctx.db
      .prepare('SELECT last_customer_message_id FROM ai_chat_state WHERE chat_jid = ?')
      .get(jid),
  ).toEqual({ last_customer_message_id: 'newer-text' });
});

it('restores only live pending work when ChatGPT becomes connected after startup', async () => {
  await incoming();
  await t.ctx.services.ai!.shutdown();
  t.ctx.settings.set('ai_inbox_provider', { mode: 'chatgpt', model: '' });
  let connected = false;
  provider.connection = () => ({
    state: connected ? 'connected' : 'signed_out',
    loginUrl: null,
    error: null,
  });
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  t.ctx.services.ai = createAiService(t.ctx, { provider });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(provider.generate).not.toHaveBeenCalled();
  connected = true;
  await vi.advanceTimersByTimeAsync(1300);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(t.wa.sent).toHaveLength(1);
});

it('correlates an early echo of its own reply without pausing AI or losing the confirmation state', async () => {
  let finishSend!: (value: { id: string; timestamp: number }) => void;
  vi.spyOn(t.wa, 'sendText').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSend = resolve;
      }),
  );
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  const echo = incoming(
    'ai-echo',
    'We open at 9am. Has this answered your question?',
    'live',
    jid,
    true,
  );
  finishSend({ id: 'ai-echo', timestamp: Date.now() });
  await echo;
  await vi.advanceTimersByTimeAsync(0);
  expect(
    t.ctx.db
      .prepare(
        'SELECT paused, awaiting_confirmation, last_replied_message_id FROM ai_chat_state WHERE chat_jid = ?',
      )
      .get(jid),
  ).toEqual({ paused: 0, awaiting_confirmation: 1, last_replied_message_id: 'incoming' });
  expect(
    t.ctx.db.prepare("SELECT sent_by_user_id FROM messages WHERE id = 'ai-echo'").get(),
  ).toEqual({ sent_by_user_id: t.ctx.services.ai!.status().member!.id });
});

it('drains a persisted live chat that exceeded the initial timer capacity', async () => {
  await t.ctx.services.ai!.shutdown();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  t.ctx.services.ai = createAiService(t.ctx, { provider });
  for (let i = 0; i < 201; i++)
    await incoming(`burst-${i}`, 'Opening hours?', 'live', `burst-${i}@s.whatsapp.net`);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(provider.generate).toHaveBeenCalledTimes(201);
  expect(t.wa.sent).toHaveLength(201);
  // 201 chats end to end: seconds locally, but a busy Windows CI runner took 50 s once; not a hang.
}, 90_000);

it('hands off to an enabled online human with zero open chats, then pauses AI fallback', async () => {
  const idle = human('idle'); // admin=1,AI=2,idle=3 => offline by test predicate
  const online = human('online'); // id=4 online
  const busy = human('busy');
  getChats(t.ctx).upsertFromWa({ jid: 'busy@s.whatsapp.net', type: 'dm', name: 'Busy' });
  getChats(t.ctx).patch('busy@s.whatsapp.net', { assignedTo: busy.id }, actor.userId);
  vi.mocked(provider.generate).mockResolvedValue({
    reply: 'A human will help you.',
    action: 'handoff',
  });
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(online.id);
  expect(getChats(t.ctx).get(jid)?.assignedTo).not.toBe(idle.id);
  await incoming('followup');
  await vi.advanceTimersByTimeAsync(11_000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

it('returns an unanswered chat to unassigned if no human is available and never reclaims the handoff', async () => {
  vi.mocked(provider.generate).mockRejectedValue(new Error('API credential content must not leak'));
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(t.wa.sent[0]?.text).toContain('human agent');
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
  await incoming('followup');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

it.each([
  ['assigned', false],
  ['unassigned', false],
  ['unassigned', true],
] as const)(
  'notifies the team when the AI hands off: %s, provider failed=%s',
  async (mode, failed) => {
    human('handoff-offline');
    const online = human('handoff-online');
    if (mode === 'unassigned') {
      getChats(t.ctx).upsertFromWa({
        jid: 'occupied@s.whatsapp.net',
        type: 'dm',
        name: 'Occupied',
      });
      getChats(t.ctx).patch('occupied@s.whatsapp.net', { assignedTo: online.id }, actor.userId);
    }
    const notified: string[] = [];
    t.ctx.services.push!.shutdown();
    t.ctx.services.push = createPushService(t.ctx, {
      sender: async (_subscription, payload) => {
        notified.push(payload);
      },
    });
    const push = t.ctx.services.push;
    for (const id of [actor.userId, online.id])
      push.subscribe(id, {
        endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
        keys: { p256dh: 'demo', auth: 'demo' },
      });
    vi.mocked(provider.generate).mockResolvedValue({
      reply: 'A teammate will help.',
      action: 'handoff',
      handoffReason: 'asked_for_human',
    });
    if (failed)
      vi.mocked(provider.generate).mockRejectedValue(new Error('private provider failure'));
    clock();
    await incoming();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(mode === 'assigned' ? online.id : null);
    const handoffs = notified
      .map((raw) => JSON.parse(raw))
      .filter((payload) => payload.title === 'Chat handed over');
    expect(handoffs).toHaveLength(mode === 'assigned' ? 1 : 2);
    expect(handoffs.every((payload) => !payload.body.includes('private provider failure'))).toBe(
      true,
    );
    await incoming('after-handover');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(
      notified
        .map((raw) => JSON.parse(raw))
        .filter((payload) => payload.title === 'Chat handed over'),
    ).toHaveLength(handoffs.length);
  },
);

it('does not send handover notifications for normal AI answers or resolution', async () => {
  const handover = vi.fn();
  t.ctx.bus.on('ai:handoff', handover);
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(handover).not.toHaveBeenCalled();
  vi.mocked(provider.generate).mockResolvedValue({ reply: 'Thank you!', action: 'resolve' });
  await incoming('confirmation', 'Yes, thank you!');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)?.status).toBe('resolved');
  expect(handover).not.toHaveBeenCalled();
});

it('sends nothing for no_reply, keeps the chat, and answers the next real question', async () => {
  const handover = vi.fn();
  t.ctx.bus.on('ai:handoff', handover);
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  const ai = t.ctx.services.ai!.status().member!;
  expect(t.wa.sent).toHaveLength(1);
  vi.mocked(provider.generate).mockResolvedValueOnce({ reply: '', action: 'no_reply' });
  await incoming('thanks', 'okay thanks, will check on our end');
  await vi.advanceTimersByTimeAsync(1200);
  expect(t.wa.sent).toHaveLength(1);
  expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'open', assignedTo: ai.id });
  expect(handover).not.toHaveBeenCalled();
  // The "thanks" batch counts as handled: only the new question is answered next.
  await incoming('next', 'What is delivery?');
  await vi.advanceTimersByTimeAsync(1200);
  expect(t.wa.sent).toHaveLength(2);
});

describe('a closing message after the AI resolved the chat', () => {
  async function resolvedByAi() {
    clock();
    await incoming();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.mocked(provider.generate).mockResolvedValueOnce({
      reply: 'Thank you, all the best!',
      action: 'resolve',
    });
    await incoming('confirmation', 'Yes, thank you!');
    await vi.advanceTimersByTimeAsync(1200);
    expect(getChats(t.ctx).get(jid)?.status).toBe('resolved');
    return t.wa.sent.length;
  }

  it('reacts with a thumbs up and resolves the chat again, without a new message', async () => {
    const sent = await resolvedByAi();
    vi.mocked(provider.generate).mockResolvedValueOnce({ reply: '', action: 'no_reply' });
    await incoming('thanks', 'much appreciated!');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 1200);
    expect(t.wa.reactions).toEqual([
      { chatJid: jid, target: expect.objectContaining({ fromMe: false }), emoji: '👍' },
    ]);
    expect(t.wa.sent).toHaveLength(sent);
    expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'resolved', assignedTo: null });
    const line = aiLogs
      .map((l) => JSON.parse(l))
      .find((l) => l.msg === 'AI resolved the chat again after thanks');
    expect(line).toMatchObject({ jid, ack: 'reaction' });
  });

  it('replies with a thumbs up where the connection cannot react', async () => {
    const sent = await resolvedByAi();
    vi.spyOn(t.wa, 'sendReaction').mockRejectedValueOnce(new Error('not supported'));
    vi.mocked(provider.generate).mockResolvedValueOnce({ reply: '', action: 'no_reply' });
    await incoming('thanks', 'thanks!');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 2500);
    expect(t.wa.sent).toHaveLength(sent + 1);
    expect(t.wa.sent.at(-1)?.text).toBe('👍');
    expect(getChats(t.ctx).get(jid)?.status).toBe('resolved');
  });

  it('keeps the chat open when a new message arrives while the thumbs up is sent', async () => {
    await resolvedByAi();
    let finish!: () => void;
    const react = t.wa.sendReaction.bind(t.wa);
    vi.spyOn(t.wa, 'sendReaction').mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          finish = () => resolve(react(...args));
        }),
    );
    vi.mocked(provider.generate).mockResolvedValueOnce({ reply: '', action: 'no_reply' });
    await incoming('thanks', 'thanks!');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 1200);
    await incoming('more', 'Oh, one more thing: do you deliver on Sunday?');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(getChats(t.ctx).get(jid)?.status).toBe('open');
    expect(aiLogs.join('\n')).not.toContain('AI resolved the chat again after thanks');
  });

  it('keeps the chat open when a teammate acted after the AI resolved it', async () => {
    await resolvedByAi();
    const teammate = human('teammate');
    getChats(t.ctx).patch(jid, { status: 'open' }, teammate.id);
    getChats(t.ctx).patch(jid, { assignedTo: null }, teammate.id);
    vi.mocked(provider.generate).mockResolvedValueOnce({ reply: '', action: 'no_reply' });
    await incoming('thanks', 'thanks!');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(t.wa.reactions).toEqual([]);
    expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  });

  it('answers a new question after the resolve as usual', async () => {
    const sent = await resolvedByAi();
    vi.mocked(provider.generate).mockResolvedValueOnce({
      reply: 'Delivery costs RM10. Does that answer your question?',
      action: 'ask_resolution',
    });
    await incoming('again', 'How much is delivery?');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 1200);
    expect(t.wa.reactions).toEqual([]);
    expect(t.wa.sent).toHaveLength(sent + 1);
    expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  });
});

it('logs the failure kind, error class and status when the model fails, then hands over', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  vi.mocked(provider.generate).mockRejectedValueOnce(
    new AgentTurnFailure('ChatGPT returned an invalid answer.', 'invalid', 'ZodError'),
  );
  await incoming('thanks', 'okay thanks');
  await vi.advanceTimersByTimeAsync(1200);
  const line = aiLogs.map((l) => JSON.parse(l)).find((l) => l.msg === 'AI answer unavailable');
  expect(line).toMatchObject({ kind: 'invalid', errName: 'ZodError', status: null });
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
});

it('requires an actual customer confirmation after asking before resolving, releases AI, and allows future incoming messages to reopen', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  vi.mocked(provider.generate).mockResolvedValue({ reply: 'Thank you!', action: 'resolve' });
  await incoming('not-done', 'No, please do not resolve it');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  await incoming('confirmation', 'Yes, thank you!');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'resolved', assignedTo: null });
  await incoming('reopened', 'Another question');
  expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  await vi.advanceTimersByTimeAsync(10_000);
  // A fresh conversation has no prior resolution question.
  expect(getChats(t.ctx).get(jid)?.status).toBe('open');
});

it('lets a human resolve an AI-owned chat and stops further pending AI work', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  await incoming('pending');
  getChats(t.ctx).patch(jid, { status: 'resolved' }, actor.userId);
  await vi.advanceTimersByTimeAsync(1000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'resolved', assignedTo: null });
});

it('keeps AI identity out of authentication, password reset and admin permissions, including forged legacy sessions', async () => {
  const ai = t.ctx.services.ai!.status().member!;
  expect(() =>
    t.ctx.services.auth!.createSession(ai.id, { ip: 'test', userAgent: 'test' }),
  ).toThrow();
  t.ctx.db
    .prepare('INSERT INTO sessions(token_hash,user_id,created_at,last_seen_at) VALUES (?, ?, ?, ?)')
    .run(sha256('forged'), ai.id, Date.now(), Date.now());
  expect(t.ctx.services.auth!.resolveSession('forged')).toBeNull();
  expect(
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: ai.username, password: '' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await t.app.inject({
        method: 'POST',
        url: `/api/users/${ai.id}/reset-password`,
        headers: authHeaders(cookie),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await t.app.inject({
        method: 'PATCH',
        url: `/api/users/${ai.id}`,
        headers: authHeaders(cookie),
        payload: { role: 'admin' },
      })
    ).statusCode,
  ).toBe(400);
  expect(isResolutionConfirmation('Yes, thank you!')).toBe(true);
  expect(isResolutionConfirmation('yes but it is still broken')).toBe(false);
});

it('restricts AI settings to admins, separates global/member changes, never returns credentials, and exposes only safe directory fields', async () => {
  const agent = human('agent');
  const agentCookie = `sid=${t.ctx.services.auth!.createSession(agent.id, { ip: 'test', userAgent: 'test' })}`;
  expect((await t.app.inject({ url: '/api/ai' })).statusCode).toBe(401);
  expect(
    (await t.app.inject({ url: '/api/ai', headers: { cookie: agentCookie } })).statusCode,
  ).toBe(403);
  const key = 'replacement-secret-api-key';
  const saved = await t.app.inject({
    method: 'PATCH',
    url: '/api/ai/connection',
    headers: authHeaders(cookie),
    payload: { mode: 'api', model: 'gpt-4.1-mini', apiKey: key },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain(key);
  expect(saved.json().hasApiKey).toBe(true);
  expect(t.ctx.db.prepare("SELECT value FROM settings WHERE key = 'ai_api_key'").get()).not.toEqual(
    { value: key },
  );
  const memberSaved = await t.app.inject({
    method: 'PUT',
    url: '/api/ai',
    headers: authHeaders(cookie),
    payload: { ...body, displayName: 'New name', mode: 'chatgpt', model: 'wrong' },
  });
  expect(memberSaved.statusCode).toBe(200);
  expect(memberSaved.json().settings).toMatchObject({
    mode: 'api',
    model: 'gpt-4.1-mini',
    displayName: 'New name',
  });
  const directory = await t.app.inject({
    url: '/api/users/directory',
    headers: { cookie: agentCookie },
  });
  expect(directory.statusCode).toBe(200);
  expect(
    directory.json().users.find((user: { kind?: string }) => user.kind === 'ai'),
  ).toMatchObject({ aiRole: 'sales', displayName: 'New name' });
  expect(directory.body).not.toContain('username');
  expect(directory.body).not.toContain(key);
});

it('rejects an incompatible ChatGPT connection before changing saved settings, credentials or chat ownership', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const before = t.ctx.services.ai!.status();
  const key = t.ctx.settings.getSecret('ai_api_key');
  const invalid = { mode: 'chatgpt' as const, model: 'gpt-4.1-mini', apiKey: 'new-test-api-key' };
  const response = await t.app.inject({
    method: 'PATCH',
    url: '/api/ai/connection',
    headers: authHeaders(cookie),
    payload: invalid,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.message).toContain('ChatGPT mode supports');
  expect(() => t.ctx.services.ai!.saveConnection(invalid, actor)).toThrow('ChatGPT mode supports');
  expect(t.ctx.services.ai!.status().settings).toEqual(before.settings);
  expect(t.ctx.settings.getSecret('ai_api_key')).toBe(key);
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(before.member!.id);
});

it.each(['', 'gpt-6-sol', 'gpt-5.5'])(
  'accepts a listed ChatGPT model %s (experimental direct sign-in list)',
  async (model) => {
    const response = await t.app.inject({
      method: 'PATCH',
      url: '/api/ai/connection',
      headers: authHeaders(cookie),
      payload: { mode: 'chatgpt', model },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({ mode: 'chatgpt', model });
  },
);

it('keeps custom model names available in API mode', async () => {
  const response = await t.app.inject({
    method: 'PATCH',
    url: '/api/ai/connection',
    headers: authHeaders(cookie),
    payload: { mode: 'api', model: 'custom-api-model' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().settings.model).toBe('custom-api-model');
});

it('extracts authenticated document uploads, removes them, and audits metadata without content', async () => {
  const boundary = 'ai-business-document';
  const data = pdfFixture('Delivery costs RM10');
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../delivery.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const result = await t.app.inject({
    method: 'POST',
    url: '/api/ai/documents',
    headers: {
      ...authHeaders(cookie),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  expect(result.statusCode, result.body).toBe(200);
  const uploaded = result.json().documents.at(-1);
  expect(uploaded).toMatchObject({ name: 'delivery.pdf', kind: 'file', size: data.length });
  const document = t.ctx.db.prepare("SELECT text FROM ai_documents WHERE kind = 'file'").get() as {
    text: string;
  };
  expect(document.text).toContain('RM10');
  const audit = t.ctx.db
    .prepare("SELECT meta FROM audit_log WHERE action = 'ai.document_add'")
    .get() as { meta: string };
  expect(audit.meta).not.toContain('RM10');
  expect(
    (
      await t.app.inject({
        method: 'DELETE',
        url: `/api/ai/documents/${uploaded.id}`,
        headers: authHeaders(cookie),
      })
    ).statusCode,
  ).toBe(200);
  expect(t.ctx.services.ai!.status().documents.map((doc) => doc.name)).toEqual([
    'Business context',
  ]);
});

it('disables AI and releases its active chats immediately', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(10_000);
  await incoming('pending');
  const ai = t.ctx.services.ai!.status().member!;
  t.ctx.services.auth!.updateUser(ai.id, { disabled: true }, actor.userId);
  await vi.advanceTimersByTimeAsync(1000);
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(t.ctx.services.ai!.status().settings.enabled).toBe(false);
});

it('stops claiming chats and releases its own without messaging customers when the ChatGPT connection breaks', async () => {
  await t.ctx.services.ai!.shutdown();
  t.ctx.settings.set('ai_inbox_provider', { mode: 'chatgpt', model: '' });
  let state: AiConnection['state'] = 'connected';
  provider.connection = () => ({
    state,
    loginUrl: null,
    error: state === 'error' ? 'ChatGPT stopped accepting this connection.' : null,
  });
  vi.mocked(provider.generate).mockImplementation(async () => {
    state = 'error';
    throw new Error('ChatGPT stopped accepting this connection.');
  });
  human('online-agent');
  clock();
  t.ctx.services.ai = createAiService(t.ctx, { provider, isOnline: () => true });
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(t.wa.sent).toHaveLength(0);
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
  await incoming('second', 'Hello?', 'live', 'other@s.whatsapp.net');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 1000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(getChats(t.ctx).get('other@s.whatsapp.net')?.assignedTo).toBeNull();
  expect(t.wa.sent).toHaveLength(0);
});

it('passes through only known sign-in messages when pasting a sign-in address', async () => {
  const failWith = (error: Error) => {
    provider.submitCallbackUrl = vi.fn().mockRejectedValue(error);
    return t.ctx.services.ai!.completeSignIn('http://localhost:1455/auth/callback?code=c&state=s');
  };
  await expect(failWith(new OAuthError('Start sign-in again.'))).rejects.toThrow(
    'Start sign-in again.',
  );
  const leaky = failWith(new Error('boom at /home/user/secret?token=abc'));
  await expect(leaky).rejects.toThrow('ChatGPT sign-in failed. Try again.');
  await expect(leaky).rejects.not.toThrow(/secret/);
});

it('releases its own chats without messaging customers when the connection breaks outside an answer', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const ai = t.ctx.services.ai!.status().member!;
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(ai.id);
  const sent = t.wa.sent.length;
  await t.ctx.services.ai!.shutdown();
  let broke!: () => void;
  provider.onProblem = (listener) => (broke = listener);
  provider.connection = () => ({ state: 'error', loginUrl: null, error: 'blocked' });
  t.ctx.services.ai = createAiService(t.ctx, { provider, isOnline: () => true });
  broke();
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
  expect(t.wa.sent).toHaveLength(sent);
});

const count = (table: string) =>
  (t.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

it('answers Try it from the draft name and instructions plus saved context without touching chats, messages, audit or WhatsApp', async () => {
  vi.mocked(provider.generate).mockResolvedValue({ reply: 'Delivery is RM10.', action: 'answer' });
  const before = ['chats', 'messages', 'ai_chat_state', 'audit_log'].map(count);
  const result = await t.ctx.services.ai!.tryAnswer({
    question: 'How much is delivery?',
    knowledge: { displayName: 'Draft Agent', instructions: 'Be brief' },
  });
  expect(result).toEqual({
    ok: true,
    reply: 'Delivery is RM10.',
    action: 'answer',
    handoffReason: null,
    model: 'gpt-4.1-mini',
    error: null,
  });
  const [, key, prompt] = vi.mocked(provider.generate).mock.calls[0]!;
  expect(prompt.instructions).toContain('Your name: Draft Agent');
  expect(prompt.instructions).toContain('Be brief');
  expect(prompt.input).toContain('Delivery costs RM10.');
  expect(prompt.instructions).not.toContain('Be concise');
  expect(key).toBe('test-api-key-123');
  expect(['chats', 'messages', 'ai_chat_state', 'audit_log'].map(count)).toEqual(before);
  expect(t.wa.sent).toHaveLength(0);
  expect(t.ctx.services.ai!.status().settings.instructions).toBe(body.instructions);
});

it('Try it reports a missing connection and a provider failure without throwing', async () => {
  await t.ctx.services.ai!.shutdown();
  t.ctx.settings.set('ai_inbox_provider', { mode: 'chatgpt', model: '' });
  provider.connection = () => ({ state: 'signed_out', loginUrl: null, error: null });
  t.ctx.services.ai = createAiService(t.ctx, { provider });
  const draft = { displayName: 'A', instructions: '' };
  expect(await t.ctx.services.ai.tryAnswer({ question: 'Delivery?', knowledge: draft })).toEqual({
    ok: false,
    reply: null,
    action: null,
    model: null,
    error: 'Set up the AI connection in Settings → AI first.',
  });
  expect(provider.generate).not.toHaveBeenCalled();
  provider.connection = () => ({ state: 'connected', loginUrl: null, error: null });
  provider.resolveModel = vi.fn(async () => 'gpt-6.1-sol');
  vi.mocked(provider.generate).mockRejectedValue(new Error('ChatGPT usage limit reached.'));
  expect(await t.ctx.services.ai.tryAnswer({ question: 'Delivery?', knowledge: draft })).toEqual({
    ok: false,
    reply: null,
    action: null,
    model: 'gpt-6.1-sol',
    error: 'ChatGPT usage limit reached.',
  });
});

it('refuses to turn on the AI member without any context item', () => {
  const ai = t.ctx.services.ai!;
  for (const doc of ai.status().documents) ai.removeDocument(null, doc.id, actor);
  expect(() => ai.saveMember(body, actor)).toThrow('Add business context');
  // The AI may answer only from business facts: instructions alone are not enough.
  expect(() => ai.saveMember({ ...body, instructions: 'Be friendly' }, actor)).toThrow(
    'Add business context',
  );
  expect(ai.saveMember({ ...body, enabled: false }, actor).settings.enabled).toBe(false);
});

it('loads a 60,000-character migrated context intact and finds a deep fact by retrieval', async () => {
  const ai = t.ctx.services.ai!;
  for (const doc of ai.status().documents) ai.removeDocument(null, doc.id, actor);
  const filler = Array.from(
    { length: 1300 },
    (_, i) => `Paragraph ${i}: the office wall colour is white.`,
  ).join('\n\n');
  t.ctx.settings.set('ai_sales_member', {
    displayName: 'Sales Agent',
    instructions: 'Be concise',
    notes: `Kedai Ezy sells cakes.\n\n${filler}`,
    faqs: [{ question: 'Wifi password?', answer: 'The wifi password is kopi123.' }],
  });
  const [migrated] = ai.status().documents;
  expect(migrated).toMatchObject({ name: 'Business context', kind: 'text' });
  expect(migrated!.characters).toBeGreaterThan(60_000);
  expect(
    ai
      .document(null, migrated!.id)
      .text.endsWith('Q: Wifi password?\nA: The wifi password is kopi123.'),
  ).toBe(true);
  clock();
  await incoming('wifi', 'What is the wifi password?');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const knowledge: string = JSON.parse(
    vi.mocked(provider.generate).mock.calls[0]![2].input,
  ).businessKnowledge;
  expect(knowledge.startsWith('[Business context]\nKedai Ezy sells cakes.')).toBe(true);
  expect(knowledge).toContain('The wifi password is kopi123.');
  expect(knowledge.length).toBeLessThanOrEqual(24_000);
});

it('sends the Business context to live replies as a named knowledge source', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const { input } = vi.mocked(provider.generate).mock.calls[0]![2];
  expect(JSON.parse(input).businessKnowledge).toBe(
    '[Business context]\nOpening hours: 9am to 5pm. Delivery costs RM10.',
  );
});

it('appends the current time, zone and resolution state last and keeps a stable cache id', async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date'],
    now: new Date('2026-10-06T06:05:00Z'),
  });
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  t.ctx.settings.set('ai_timezone', 'Europe/London');
  await incoming('next', 'Open tomorrow?');
  await vi.advanceTimersByTimeAsync(1200);
  const [first, second] = vi.mocked(provider.generate).mock.calls.map((call) => call[2]);
  expect(Object.keys(JSON.parse(first!.input)).at(-1)).toBe('currentSituation');
  expect(JSON.parse(first!.input).currentSituation).toMatchObject({
    date: '2026-10-06',
    weekday: 'Tuesday',
    time: '14:05',
    timeZone: 'Asia/Kuala_Lumpur',
  });
  expect(JSON.parse(second!.input).currentSituation).toMatchObject({
    time: '07:05',
    timeZone: 'Europe/London',
  });
  expect(second!.instructions).toBe(first!.instructions);
  // One cache key per install and agent.
  expect(first!.cacheId).toMatch(/^[0-9a-f-]{36}#agent:\d+$/);
  expect(second!.cacheId).toBe(first!.cacheId);
  expect(first!.cacheId).toBe(
    `${t.ctx.settings.get('ai_install_id', null)}#agent:${defaultAgent(t.ctx.db)!.id}`,
  );
});

it('tells the AI to answer order questions and hand order requests to the team', async () => {
  clock();
  await incoming('order', 'Can I get delivery tomorrow at 3pm? How much in total?');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const { instructions } = vi.mocked(provider.generate).mock.calls[0]![2];
  expect(instructions).toContain('Questions about ordering');
  expect(instructions).toContain('choose handoff with handoffReason needs_action');
  expect(instructions).toContain('Never pretend a request is done or confirmed');
  // A question keeps the chat with the AI.
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(t.ctx.services.ai!.status().member!.id);
});

it('hands an order request to the team with its reason instead of resolving it', async () => {
  clock();
  await incoming('order', 'I want to order 5 regular kopi, deliver tomorrow 3pm');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  // The model wrongly closes the chat when the customer says thanks.
  vi.mocked(provider.generate).mockResolvedValue({ reply: 'You are welcome!', action: 'resolve' });
  await incoming('thanks', 'ok great, thanks, that is all');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'open', assignedTo: null });
  const handoffs = t.ctx.db
    .prepare("SELECT payload FROM chat_events WHERE chat_jid = ? AND type = 'unassigned'")
    .all(jid) as Array<{ payload: string }>;
  expect(handoffs.map((row) => JSON.parse(row.payload).handoff)).toEqual(['needs_action']);
  const audits = t.ctx.db
    .prepare("SELECT meta FROM audit_log WHERE action = 'ai.handoff'")
    .all() as Array<{ meta: string }>;
  expect(audits.map((row) => JSON.parse(row.meta).reason)).toEqual(['needs_action']);
  // The team owns it now: further messages get no AI reply.
  await incoming('later', 'Hello?');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 1000);
  expect(provider.generate).toHaveBeenCalledTimes(2);
});

it("records the model's hand-off reason on the chat event", async () => {
  vi.mocked(provider.generate).mockResolvedValue({
    reply: 'A team member will help you.',
    action: 'handoff',
    handoffReason: 'sensitive',
  });
  clock();
  await incoming('complaint', 'My order was cold, I want a refund');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const events = t.ctx.db
    .prepare('SELECT type, payload FROM chat_events WHERE chat_jid = ? ORDER BY id')
    .all(jid) as Array<{ type: string; payload: string }>;
  expect(events.at(-1)?.type).toBe('unassigned');
  expect(JSON.parse(events.at(-1)!.payload)).toMatchObject({ handoff: 'sensitive' });
});

it('resolves once when the customer confirms in free text', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  vi.mocked(provider.generate).mockResolvedValue({ reply: 'Glad to help!', action: 'resolve' });
  await incoming('confirm', 'Ok noted, yes that answers it. Thank you!');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'resolved', assignedTo: null });
  expect(t.wa.sent.map((message) => message.text)).toEqual([
    'We open at 9am. Has this answered your question?',
    'Glad to help!',
  ]);
});

it('resolves after two resolution questions answered with confirming-looking replies', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  // The model keeps asking; the server stops the loop.
  await incoming('first-ok', 'ok thanks');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  await incoming('second-ok', 'ok thanks');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'resolved', assignedTo: null });
  expect(t.wa.sent).toHaveLength(3);
});

it('Try it applies the resolution gate and never resolves or assigns anything', async () => {
  vi.mocked(provider.generate).mockResolvedValue({ reply: 'Bye!', action: 'resolve' });
  const result = await t.ctx.services.ai!.tryAnswer({
    question: 'Thanks!',
    knowledge: { displayName: 'A', instructions: '' },
  });
  expect(result).toMatchObject({ ok: true, action: 'ask_resolution' });
  expect(t.ctx.db.prepare('SELECT count(*) AS n FROM chats').get()).toEqual({ n: 0 });
});

it('never turns a model answer into a resolution, even after two resolution questions', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  await incoming('first-ok', 'ok thanks');
  await vi.advanceTimersByTimeAsync(1200);
  vi.mocked(provider.generate).mockResolvedValue({ reply: '3 boxes are RM30.', action: 'answer' });
  await incoming('order', "Ok great, I'll take 3 boxes");
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  expect(t.wa.sent.at(-1)?.text).toBe('3 boxes are RM30.');
});

it('restarts the resolution count after the customer asks something new', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  await incoming('new-question', 'And how much is delivery?');
  await vi.advanceTimersByTimeAsync(1200);
  await incoming('ok', 'ok thanks');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  expect(t.wa.sent).toHaveLength(3);
});

it('checks every customer message in a debounce batch before resolving', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  vi.mocked(provider.generate).mockResolvedValue({ reply: 'Glad to help!', action: 'resolve' });
  await incoming('objection', 'No, still not working');
  await incoming('thanks', 'thanks');
  await vi.advanceTimersByTimeAsync(1200);
  expect(getChats(t.ctx).get(jid)?.status).toBe('open');
  expect(t.wa.sent).toHaveLength(2);
  expect(t.wa.sent.at(-1)?.text).toBe('Does that answer your question?');
});

it('replies to the address the customer last wrote from when one person has a phone number and a WhatsApp ID', async () => {
  clock();
  const PN = '60111111111@s.whatsapp.net';
  const LID = '123456789@lid';
  await incoming('l-1', 'Hello', 'history', LID);
  getChats(t.ctx).upsertContactAliases([{ jid: PN, alias: LID }]);
  await incoming('p-1', 'What are your opening hours?', 'live', PN);
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 2000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(t.wa.sent.map((s) => s.chatJid)).toEqual([PN]);
  const ai = t.ctx.services.ai!.status().member!;
  expect(getChats(t.ctx).get(LID)?.assignedTo).toBe(ai.id);
  expect(
    t.ctx.db
      .prepare('SELECT chat_jid, wa_remote_jid FROM messages WHERE sent_by_user_id = ?')
      .all(ai.id),
  ).toEqual([{ chat_jid: LID, wa_remote_jid: PN }]);
});

it('starts a member that never saved instructions with the default ones, and keeps saved text', async () => {
  // The texts live on the agent row: NULL = never saved.
  const id = defaultAgent(t.ctx.db)!.id;
  updateAgentTexts(t.ctx.db, id, { instructions: null });
  expect(t.ctx.services.ai!.status().settings.instructions).toBe(DEFAULT_AI_INSTRUCTIONS);
  updateAgentTexts(t.ctx.db, id, { instructions: '' });
  expect(t.ctx.services.ai!.status().settings.instructions).toBe('');
  updateAgentTexts(t.ctx.db, id, { instructions: 'Be concise' });
  expect(t.ctx.services.ai!.status().settings.instructions).toBe('Be concise');
});

it('keeps business hand-off rules: default until saved, then the saved text (even blank)', () => {
  t.ctx.settings.set('ai_sales_member', {});
  expect(t.ctx.services.ai!.status().settings.handoffRules).toBe(DEFAULT_AI_HANDOFF_RULES);
  t.ctx.services.ai!.saveMember({ ...body, enabled: false, handoffRules: '' }, actor);
  expect(t.ctx.services.ai!.status().settings.handoffRules).toBe('');
  // An older client that sends no rules keeps the saved ones.
  t.ctx.services.ai!.saveMember({ ...body, enabled: false }, actor);
  expect(t.ctx.services.ai!.status().settings.handoffRules).toBe('');
  // The audit log says what changed, never the text itself.
  const metas = t.ctx.db
    .prepare("SELECT meta FROM audit_log WHERE action = 'ai.member_update' ORDER BY id")
    .all()
    .map((row) => JSON.parse((row as { meta: string }).meta) as Record<string, unknown>);
  expect(metas.slice(-2).map((m) => m.handoffRulesChanged)).toEqual([true, false]);
  expect(JSON.stringify(metas)).not.toContain(body.instructions);
});

it('answers every reply from the latest saved business context', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  expect(vi.mocked(provider.generate).mock.calls[0]![2].input).toContain('9am to 5pm');
  const [item] = t.ctx.services.ai!.status().documents;
  t.ctx.services.ai!.updateText(
    null,
    item!.id,
    { text: 'Opening hours: 10am to 8pm. Delivery costs RM12.' },
    actor,
  );
  await incoming('next', 'When do you open?');
  await vi.advanceTimersByTimeAsync(1200);
  const latest = vi.mocked(provider.generate).mock.calls.at(-1)![2].input;
  expect(latest).toContain('10am to 8pm');
  expect(latest).not.toContain('9am to 5pm');
});

it('hands an AI-owned chat to the teammate who replies from the inbox, and the AI stops', async () => {
  clock();
  await incoming();
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  const ai = t.ctx.services.ai!.status().member!;
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(ai.id);
  const agent = human('agent');
  getMessages(t.ctx).sendText(jid, { text: 'Let me help you', clientId: 'take-over' }, agent.id);
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(agent.id);
  expect(getChats(t.ctx).events(jid).at(-1)).toMatchObject({
    type: 'assigned',
    actorId: agent.id,
    payload: { assignedTo: agent.id, previous: ai.id, reason: 'reply' },
  });
  // The customer writes again: the teammate owns the chat, so the AI does not answer.
  await incoming('after', 'Thanks, one more question');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 2000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(getChats(t.ctx).get(jid)?.assignedTo).toBe(agent.id);
});

describe('customer images', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('png-pixels'),
  ]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-pixels')]);
  function incomingMedia(
    id: string,
    options: {
      type?: 'image' | 'audio';
      caption?: string | null;
      mime?: string;
      download?: () => Promise<Buffer>;
    } = {},
  ) {
    return getMessages(t.ctx).ingest(
      {
        id,
        chatJid: jid,
        body: options.caption ?? null,
        type: options.type ?? 'image',
        fromMe: false,
        senderJid: jid,
        senderName: 'Customer',
        timestamp: Date.now(),
        quotedId: null,
        media: {
          mime: options.mime ?? 'image/png',
          fileName: null,
          download: options.download ?? (async () => PNG),
        },
      },
      'live',
    );
  }
  function lastHandoff() {
    const events = t.ctx.db
      .prepare('SELECT type, payload FROM chat_events WHERE chat_jid = ? ORDER BY id')
      .all(jid) as Array<{ type: string; payload: string }>;
    return JSON.parse(events.at(-1)?.payload ?? '{}').handoff as string | undefined;
  }

  it('answers a photo with its caption, attaching the pixels and showing [image] in the history', async () => {
    clock();
    await incomingMedia('photo', { caption: 'How much is this chair?' });
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(provider.generate).mock.calls[0]![2];
    expect(prompt.images).toEqual([{ mime: 'image/png', base64: PNG.toString('base64') }]);
    expect(JSON.parse(prompt.input).conversation).toEqual([
      { speaker: 'customer', text: '[image] How much is this chair?' },
    ]);
    expect(prompt.input).not.toContain(PNG.toString('base64'));
    expect(t.wa.sent[0]?.text).toContain('9am');
    expect(lastHandoff()).toBeUndefined();
  });

  it('answers a photo without a caption and one sent before a text question', async () => {
    clock();
    await incomingMedia('photo', { mime: 'image/jpeg', download: async () => JPEG });
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    const first = vi.mocked(provider.generate).mock.calls[0]![2];
    expect(first.images).toEqual([{ mime: 'image/jpeg', base64: JPEG.toString('base64') }]);
    expect(JSON.parse(first.input).conversation.at(-1)).toEqual({
      speaker: 'customer',
      text: '[image]',
    });
    await incomingMedia('second-photo');
    await vi.advanceTimersByTimeAsync(100);
    await incoming('question', 'Do you have this in red?');
    await vi.advanceTimersByTimeAsync(1200);
    const second = vi.mocked(provider.generate).mock.calls[1]![2];
    // Only the batch since the last reply is attached; the first photo stays text.
    expect(second.images).toEqual([{ mime: 'image/png', base64: PNG.toString('base64') }]);
  });

  it('attaches at most the newest three images of the batch, in order', async () => {
    clock();
    const bytes = (n: number) => Buffer.concat([PNG, Buffer.from(`#${n}`)]);
    for (let n = 1; n <= 4; n += 1)
      await incomingMedia(`photo-${n}`, { download: async () => bytes(n) });
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    const prompt = vi.mocked(provider.generate).mock.calls[0]![2];
    expect(prompt.images?.map((image) => image.base64)).toEqual(
      [2, 3, 4].map((n) => bytes(n).toString('base64')),
    );
    expect(JSON.parse(prompt.input).conversation).toHaveLength(4);
  });

  it('waits for a live image that is still downloading', async () => {
    clock();
    let finish!: (buffer: Buffer) => void;
    const ingest = incomingMedia('slow', {
      download: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 1000);
    expect(provider.generate).not.toHaveBeenCalled();
    finish(PNG);
    await ingest;
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.generate).mock.calls[0]![2].images).toHaveLength(1);
  });

  for (const [name, options] of [
    ['too large', { download: async () => Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) }],
    [
      'not a JPEG, PNG or WebP',
      { mime: 'image/gif', download: async () => Buffer.from('GIF89a-pixels') },
    ],
    [
      'not downloaded',
      {
        download: async () => {
          throw new Error('media expired');
        },
      },
    ],
  ] as const) {
    it(`hands an image that is ${name} to the team as unsupported`, async () => {
      clock();
      await incomingMedia('photo', options);
      await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
      expect(provider.generate).not.toHaveBeenCalled();
      expect(lastHandoff()).toBe('unsupported_message');
    });
  }

  it('hands an image still not downloaded after the wait to the team', async () => {
    clock();
    void incomingMedia('stuck', { download: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 20_000);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(lastHandoff()).toBe('unsupported_message');
  });
});

describe('customer voice notes', () => {
  const TONE = readFileSync(join(import.meta.dirname, 'fixtures/tone-1s.ogg'));
  let transcribe: ReturnType<typeof vi.fn<NonNullable<VoiceServiceDeps['transcribe']>>>;
  function voiceNote(id: string) {
    return getMessages(t.ctx).ingest(
      {
        id,
        chatJid: jid,
        body: null,
        type: 'audio',
        fromMe: false,
        senderJid: jid,
        senderName: 'Customer',
        timestamp: Date.now(),
        quotedId: null,
        media: { mime: 'audio/ogg; codecs=opus', fileName: null, download: async () => TONE },
      },
      'live',
    );
  }
  function handoffs() {
    return (
      t.ctx.db
        .prepare('SELECT payload FROM chat_events WHERE chat_jid = ? ORDER BY id')
        .all(jid) as Array<{ payload: string }>
    )
      .map((event) => JSON.parse(event.payload).handoff as string | undefined)
      .filter(Boolean);
  }
  const conversation = (call: number) =>
    JSON.parse(vi.mocked(provider.generate).mock.calls[call]![2].input).conversation;
  async function transcribing(engine: 'cloud' | 'off') {
    await t.ctx.services.voice?.shutdown();
    transcribe = vi.fn<NonNullable<VoiceServiceDeps['transcribe']>>(async () => ({
      text: 'Do you deliver to Penang?',
      lang: 'en',
    }));
    t.ctx.services.voice = createVoiceService(t.ctx, { transcribe });
    if (engine === 'cloud') t.ctx.services.voice.setTranscription('cloud', actor);
  }

  it('answers a transcribed voice note as customer text', async () => {
    await transcribing('cloud');
    clock();
    await voiceNote('voice');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(conversation(0)).toEqual([
      { speaker: 'customer', text: '[voice note] Do you deliver to Penang?' },
    ]);
    expect(t.wa.sent[0]?.text).toContain('9am');
    expect(handoffs()).toEqual([]);
  });

  it('waits for a pending transcription before deciding', async () => {
    await transcribing('cloud');
    let finish!: () => void;
    transcribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ text: 'Is the shop open on Sunday?', lang: 'en' });
        }),
    );
    clock();
    await voiceNote('slow-voice');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 5000);
    expect(provider.generate).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(conversation(0)).toEqual([
      { speaker: 'customer', text: '[voice note] Is the shop open on Sunday?' },
    ]);
  });

  it('asks the customer to type an untranscribed voice note, then hands a second one to the team', async () => {
    await transcribing('off');
    provider.generate = vi.fn().mockResolvedValue({
      reply: 'Sorry, I cannot listen to voice messages. Could you type your question?',
      action: 'answer',
    });
    clock();
    await voiceNote('first');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(conversation(0)).toEqual([
      { speaker: 'customer', text: '[voice note — not transcribed]' },
    ]);
    const prompt = vi.mocked(provider.generate).mock.calls[0]![2];
    expect(prompt.instructions).toContain('[voice note — not transcribed]');
    expect(t.wa.sent[0]?.text).toContain('type your question');
    expect(handoffs()).toEqual([]);

    await voiceNote('second');
    await vi.advanceTimersByTimeAsync(1200);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(handoffs()).toEqual(['unsupported_message']);
  });

  it('answers the first untranscribed voice note with "please type it" even if the model hands off', async () => {
    await transcribing('off');
    provider.generate = vi.fn().mockResolvedValue({
      reply: 'A team member will help you.',
      action: 'handoff',
      handoffReason: 'missing_facts',
    });
    clock();
    await voiceNote('first-handoff');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(t.wa.sent[0]?.text).toBe(VOICE_RETRY_REPLY);
    expect(handoffs()).toEqual([]);
  });

  it('still hands off the first voice note when the customer asks for a person', async () => {
    await transcribing('off');
    provider.generate = vi.fn().mockResolvedValue({
      reply: 'A team member will help you.',
      action: 'handoff',
      handoffReason: 'asked_for_human',
    });
    clock();
    await voiceNote('first-human');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(handoffs()).toEqual(['asked_for_human']);
  });
});

it('never waits for imported history photos that are only downloaded on demand', async () => {
  clock();
  // A photo from the history import: stays pending until someone opens it.
  await getMessages(t.ctx).ingest(
    {
      id: 'history-photo',
      chatJid: jid,
      body: null,
      type: 'image',
      fromMe: false,
      senderJid: jid,
      senderName: 'Customer',
      timestamp: Date.now() - 24 * 60 * 60_000,
      quotedId: null,
      media: { mime: 'image/png', fileName: null, download: async () => Buffer.from('x') },
    },
    'history',
  );
  await incoming('question', 'What are your opening hours?');
  // Fallback delay plus a little: an answer that waited for the history photo would take 20 s more.
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS + 1000);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(vi.mocked(provider.generate).mock.calls[0]![2].images ?? []).toHaveLength(0);
});

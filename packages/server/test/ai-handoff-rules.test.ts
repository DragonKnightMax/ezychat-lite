import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_HANDOFF_RULES } from '@ezychat/shared';
import { createAiService, AI_FALLBACK_MS } from '../src/ai/service.js';
import { defaultAgent, updateAgentTexts } from '../src/ai/agents.js';
import type { AiPrompt, AiProvider } from '../src/ai/provider-types.js';
import { chatWaitingAfterHandoff } from '../src/reports/report.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { createMessageService } from '../src/messages/service.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders } from './auth-helpers.js';

/**
 * Regression tests for the Anchor Sprint reports (agent 1, sales preset): a consultation request
 * handed over as needs_action against the saved "never hand over" rules, "Does that answer your
 * question?" after every answer, and a "yes" with new facts closing a live lead. The model is a
 * stand-in that follows the rules it is given, so these pin what the server gives and enforces.
 */
let t: TestApp;
let provider: AiProvider;
let cookie: string;
let actor: { userId: number; ip: null };
const jid = 'lead@s.whatsapp.net';
const CONSULTATION = "Hi Anchor Sprint, I'd like to book a free consultation (from your homepage).";
/** The gist of the saved v87 rules (the real text is not copied into tests). */
const NEVER_HAND_OVER = [
  'Never hand over on:',
  '- A consultation, meeting, demo or "book a call" request. Booking a consultation is never needs_action: ask a discovery question.',
].join('\n');
const DISCOVERY = 'Happy to set that up! What would you like to cover in the consultation?';
const DISCOVERY_RULE =
  'A request to talk to the business (a consultation, meeting, demo, call or visit, even worded as "book" or "schedule") is discovery, not an action';

/** A model that follows its rules: discovery for a consultation, needs_action otherwise. */
const ruleFollower = (_s: unknown, _k: unknown, prompt: AiPrompt) =>
  Promise.resolve(
    prompt.instructions.includes(DISCOVERY_RULE)
      ? { reply: DISCOVERY, action: 'answer' as const, handoffReason: null }
      : {
          reply: "Sorry, I can't book it myself. A team member will help you shortly.",
          action: 'handoff' as const,
          handoffReason: 'needs_action' as const,
        },
  );

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
    generate: vi.fn(ruleFollower),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(),
  };
  t.ctx.services.ai = createAiService(t.ctx, { provider, isOnline: () => false });
  const ai = t.ctx.services.ai;
  ai.saveConnection({ mode: 'api', model: '', apiKey: 'test-api-key-123' }, actor);
  ai.saveMember({ displayName: 'Sales Agent', enabled: false, instructions: '' }, actor);
  ai.addText(null, { name: 'Overview', text: 'We sell Claude Team seats and GPUs.' }, actor);
  ai.saveMember({ displayName: 'Sales Agent', enabled: true, instructions: '' }, actor);
});
afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});

const agent = () => defaultAgent(t.ctx.db)!;
const tryReply = (question: string) =>
  t.ctx.services.ai!.tryAnswer({
    question,
    knowledge: { displayName: 'Sales Agent', instructions: '' },
  });
async function incoming(id: string, text: string) {
  return getMessages(t.ctx).ingest(
    {
      id,
      chatJid: jid,
      body: text,
      type: 'text',
      fromMe: false,
      senderJid: jid,
      senderName: 'Lead',
      timestamp: Date.now(),
      quotedId: null,
      media: null,
    },
    'live',
  );
}

describe('BUG 1: a consultation request is discovery, not needs_action', () => {
  it.each([
    ['the saved setup', NEVER_HAND_OVER],
    ['the preset defaults', null],
  ])('answers with a discovery question on %s', async (_label, rules) => {
    updateAgentTexts(t.ctx.db, agent().id, { handoffRules: rules });
    const result = await tryReply(CONSULTATION);
    expect(result).toMatchObject({ ok: true, action: 'answer', reply: DISCOVERY });
    expect(result.handoffReason ?? null).toBeNull();
    expect(result.reply).not.toMatch(/team member/i);
    const prompt = vi.mocked(provider.generate).mock.calls[0]![2];
    expect(prompt.instructions).toContain(rules ?? DEFAULT_AI_HANDOFF_RULES);
    // The business rules win over needs_action; only safety and sensitive always apply.
    expect(prompt.instructions).toContain('follow them instead of needs_action, missing_facts');
  });

  it('keeps needs_action for a concrete order or account action', async () => {
    const prompt = buildPromptFor(await tryReply('Please cancel my order #123'));
    expect(prompt).toContain(
      'needs_action is only for a concrete order, payment or account action you cannot carry out',
    );
  });

  function buildPromptFor(_result: unknown): string {
    return vi.mocked(provider.generate).mock.calls.at(-1)![2].instructions;
  }
});

describe('BUG 2: no check-in line, and a "yes" with new facts never closes the chat', () => {
  it('a sales agent has the resolution question off by default', () => {
    expect(agent().resolutionCheck).toBe(false);
  });

  it('Try it returns no check-in line for an informational answer', async () => {
    vi.mocked(provider.generate).mockResolvedValue({
      reply: 'Premium seats add Claude Code and higher limits. Does that answer your question?',
      action: 'ask_resolution',
    });
    const result = await tryReply(
      'What is the difference between Claude Team Standard and Premium seat?',
    );
    expect(result).toMatchObject({
      ok: true,
      action: 'answer',
      reply: 'Premium seats add Claude Code and higher limits.',
    });
    expect(vi.mocked(provider.generate).mock.calls[0]![2].instructions).toContain(
      'Never end a reply with a check-in line',
    );
  });

  it.each([false, true])(
    'a live "yes we are in Malaysia" keeps the chat open (resolution question %s)',
    async (on) => {
      t.ctx.services.ai!.setResolutionCheck(agent().id, on, actor);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.mocked(provider.generate).mockResolvedValueOnce({
        reply: 'Yes, we supply H100 GPUs. Does that answer your question?',
        action: 'ask_resolution',
      });
      await incoming('q1', 'Do you sell GPUs? Where are you based?');
      await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
      vi.mocked(provider.generate).mockResolvedValueOnce({
        reply: 'Thank you! I will close this chat now.',
        action: 'resolve',
      });
      await incoming('q2', 'yes we are in Malaysia');
      await vi.advanceTimersByTimeAsync(1200);
      expect(getChats(t.ctx).get(jid)).toMatchObject({ status: 'open' });
      expect(t.wa.sent.map((m) => m.text).join('\n')).not.toMatch(/close this chat/i);
      if (!on) expect(t.wa.sent[0]!.text).not.toContain('Does that answer your question?');
    },
  );

  it('PUT /api/ai/agents/:agentId/resolution-check saves the switch and audits it', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/ai/agents/${agent().id}/resolution-check`,
      headers: authHeaders(cookie),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.resolutionCheck).toBe(true);
    expect(agent().resolutionCheck).toBe(true);
    expect(
      t.ctx.db
        .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'ai.resolution_check_update'")
        .get(),
    ).toEqual({ n: 1 });
    const bad = await t.app.inject({
      method: 'PUT',
      url: `/api/ai/agents/${agent().id}/resolution-check`,
      headers: authHeaders(cookie),
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await t.app.inject({
      method: 'PUT',
      url: '/api/ai/agents/999/resolution-check',
      headers: authHeaders(cookie),
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('switching an agent to FAQ keeps the switch off; an explicit choice is kept on later saves', () => {
    const ai0 = t.ctx.services.ai!;
    expect(
      ai0.saveAgent(
        agent().id,
        { displayName: 'Desk', enabled: true, preset: 'faq', instructions: '' },
        actor,
      ).agent.resolutionCheck,
    ).toBe(false);
    const ai = t.ctx.services.ai!;
    const status = ai.saveAgent(
      agent().id,
      {
        displayName: 'Desk',
        enabled: true,
        preset: 'faq',
        instructions: '',
        resolutionCheck: true,
      },
      actor,
    );
    expect(status.agent.resolutionCheck).toBe(true);
    expect(
      ai.saveAgent(agent().id, { displayName: 'Desk', enabled: true, instructions: '' }, actor)
        .agent.resolutionCheck,
    ).toBe(true);
  });
});

describe('after a hand-off the AI stays silent; the team sees the chat is still waiting', () => {
  it('does not answer "GPU" after handing the chat over, and flags it as waiting', async () => {
    updateAgentTexts(t.ctx.db, agent().id, { handoffRules: '' });
    vi.mocked(provider.generate).mockResolvedValueOnce({
      reply: 'A team member will help you shortly.',
      action: 'handoff',
      handoffReason: 'asked_for_human',
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming('h1', 'Can I talk to a person about a consultation?');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
    expect(chatWaitingAfterHandoff(t.ctx.db, jid)).toBe(true);
    await incoming('h2', 'GPU');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS * 2);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(t.wa.sent).toHaveLength(1);
    expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
    expect(chatWaitingAfterHandoff(t.ctx.db, jid)).toBe(true);
  });
});

describe('A blocked number gets no AI answer', () => {
  const block = (spam = true) =>
    t.ctx.services.safety!.actOnChat(jid, 'block', { spam }, { id: actor.userId }, null);

  it('does not answer a message from a number an admin blocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming('b0', 'hello');
    await block();
    await incoming('b1', 'Grow your business with our software!');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS * 2);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(t.wa.sent).toHaveLength(0);
  });

  it('drops a reply that was already scheduled when the number is blocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming('b2', 'Digital Software Branding: buy now');
    await block();
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS * 2);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(t.wa.sent).toHaveLength(0);
  });

  // Blocked only: a number also marked as spam stays flagged, and the AI leaves flagged messages alone.
  it('answers again once the number is unblocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await incoming('b3', 'hello');
    await block(false);
    await t.ctx.services.safety!.actOnChat(jid, 'unblock', {}, { id: actor.userId }, null);
    await incoming('b4', 'Do you sell GPUs?');
    await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS * 2);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
});

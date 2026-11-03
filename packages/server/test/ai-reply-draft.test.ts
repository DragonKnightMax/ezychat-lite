import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { AiProvider } from '../src/ai/provider-types.js';
import { createAiService } from '../src/ai/service.js';
import { setReplySuggestions } from '../src/ai/reply-suggestions-setting.js';
import { HttpError } from '../src/http/errors.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders } from './auth-helpers.js';

const JID = '60126677889@s.whatsapp.net';
const DRAFTS = {
  suggestions: [
    { label: 'Confirm price', text: 'Two Nasi Lemak Ayam at RM12 each.', grounded: true },
    { label: 'Ask the name', text: 'May I have your name for the pickup?', grounded: true },
  ],
  noAnswer: false,
  handoffRule: null,
};

let t: TestApp;
let provider: AiProvider;
let connection: 'connected' | 'expired' | 'signed_out';
let logLines: string[];
let adminCookie: string;
let actor: { userId: number; ip: null };

beforeEach(async () => {
  logLines = [];
  connection = 'connected';
  provider = {
    generate: vi.fn(),
    draft: vi.fn().mockResolvedValue({ output: DRAFTS, model: 'gpt-test' }),
    connection: () => ({ state: connection, loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  t = await makeTestApp({
    beforeBuild: async (ctx) => {
      await ctx.services.ai!.shutdown();
      const capture = pino({ level: 'debug' }, { write: (line: string) => logLines.push(line) });
      const child = ctx.log.child.bind(ctx.log);
      vi.spyOn(ctx.log, 'child').mockImplementation(((bindings: Record<string, unknown>) =>
        bindings.mod === 'ai' ? capture.child(bindings) : child(bindings)) as never);
      ctx.services.ai = createAiService(ctx, { provider });
    },
  });
  const auth = t.ctx.services.auth!;
  const admin = auth.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  adminCookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 't' })}`;
  actor = { userId: admin.id, ip: null };
  const ai = t.ctx.services.ai!;
  ai.saveConnection({ mode: 'chatgpt', model: '' }, actor);
  // The agent stays off: drafts need only the connection.
  ai.saveMember({ displayName: 'Aina', enabled: false, instructions: 'Be warm.' }, actor);
  ai.addText(null, { name: 'Menu', text: 'Nasi Lemak Ayam RM12. Pickup daily.' }, actor);
  ai.addText(null, { name: 'Costs', text: 'MARK-internal supplier price', internal: true }, actor);
  t.wa.simulateIncoming({ chatJid: JID, body: 'Can I order two Nasi Lemak for pickup at 1pm?' });
  await vi.waitFor(() =>
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

const sentPrompt = () => {
  const [, , prompt, options] = vi.mocked(provider.draft!).mock.calls.at(-1)!;
  return { prompt, options, input: JSON.parse(prompt.input) as Record<string, any> };
};

describe('draftReply', () => {
  it("uses the agent's business context while the agent is off", async () => {
    const result = await t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'suggest' },
      new AbortController().signal,
    );
    expect(result).toEqual({
      suggestions: [
        { label: 'Confirm price', text: 'Two Nasi Lemak Ayam at RM12 each.' },
        { label: 'Ask the name', text: 'May I have your name for the pickup?' },
      ],
      noAnswer: false,
      handoffRule: null,
    });
    const { prompt, options, input } = sentPrompt();
    expect(input.businessKnowledge).toContain('Nasi Lemak Ayam RM12');
    expect(input.internalKnowledge).toContain('MARK-internal');
    expect(prompt.instructions).toContain('Be warm.');
    expect(prompt.cacheId).toMatch(/#agent:\d+$/);
    expect(options).toMatchObject({ fast: true, maxOutputTokens: 2000 });
  });

  it('sends the conversation and the saved customer details last', async () => {
    await t.app.inject({
      method: 'PUT',
      url: `/api/chats/${encodeURIComponent(JID)}/profile`,
      headers: authHeaders(adminCookie),
      payload: { name: 'Nurul Huda', tags: [] },
    });
    await t.ctx.services.ai!.draftReply(JID, { kind: 'suggest' }, new AbortController().signal);
    const { input } = sentPrompt();
    expect(input.conversation).toEqual([
      { speaker: 'customer', text: 'Can I order two Nasi Lemak for pickup at 1pm?' },
    ]);
    expect(input.currentSituation.customer).toEqual({ name: 'Nurul Huda' });
  });

  it('drafts for a group with member names, never numbers or a customer profile', async () => {
    const GROUP = '120363025550001@g.us';
    t.wa.simulateIncoming({
      chatJid: GROUP,
      senderJid: '60123456789@s.whatsapp.net',
      senderName: 'Farah',
      body: 'Is Nasi Lemak Ayam available today? Ask @60198887777 too',
    });
    t.wa.simulateIncoming({
      chatJid: GROUP,
      senderJid: '60111111111@s.whatsapp.net',
      senderName: '+60 11-111 1111',
      body: 'Same for me',
    });
    await vi.waitFor(() =>
      expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 3 }),
    );
    await t.ctx.services.ai!.draftReply(GROUP, { kind: 'suggest' }, new AbortController().signal);
    const { prompt, input } = sentPrompt();
    expect(input.conversation).toEqual([
      {
        speaker: 'customer',
        name: 'Farah',
        text: 'Is Nasi Lemak Ayam available today? Ask @member too',
      },
      { speaker: 'customer', name: 'Member', text: 'Same for me' },
    ]);
    expect(input.currentSituation.group).toBe(true);
    expect(input.currentSituation.customer).toBeUndefined();
    expect(input.businessKnowledge).toContain('Nasi Lemak Ayam RM12');
    expect(prompt.instructions).toContain('In a WhatsApp group');
    // A direct chat's prompt carries no group flag.
    await t.ctx.services.ai!.draftReply(JID, { kind: 'suggest' }, new AbortController().signal);
    expect(sentPrompt().input.currentSituation.group).toBeUndefined();
  });

  it('skips a group message deleted for everyone and keeps a draft naming a member', async () => {
    const GROUP = '120363025550002@g.us';
    const ALI = '60123450000@s.whatsapp.net';
    const gone = t.wa.simulateIncoming({
      chatJid: GROUP,
      senderJid: ALI,
      senderName: 'Kopi88 Ali',
      body: 'Wrong group, sorry',
    });
    t.wa.simulateIncoming({
      chatJid: GROUP,
      senderJid: ALI,
      senderName: 'Kopi88 Ali',
      body: 'Is Nasi Lemak Ayam available today?',
    });
    await vi.waitFor(() =>
      expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 3 }),
    );
    t.wa.simulateRevoke({ chatJid: GROUP, targetId: gone.id, senderJid: ALI });
    await vi.waitFor(() =>
      expect(
        t.ctx.db.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(gone.id),
      ).toMatchObject({ deleted_at: expect.any(Number) }),
    );
    vi.mocked(provider.draft!).mockResolvedValueOnce({
      output: {
        suggestions: [
          {
            label: 'Confirm',
            text: 'Hi Kopi88 Ali, yes, Nasi Lemak Ayam is RM12.',
            grounded: true,
          },
        ],
        noAnswer: false,
        handoffRule: null,
      },
      model: 'gpt-test',
    });
    const result = await t.ctx.services.ai!.draftReply(
      GROUP,
      { kind: 'suggest' },
      new AbortController().signal,
    );
    expect(sentPrompt().input.conversation).toEqual([
      { speaker: 'customer', name: 'Kopi88 Ali', text: 'Is Nasi Lemak Ayam available today?' },
    ]);
    // 88 comes from the member's name, which the draft may use: the draft is kept.
    expect(result).toMatchObject({
      suggestions: [{ text: 'Hi Kopi88 Ali, yes, Nasi Lemak Ayam is RM12.' }],
      noAnswer: false,
    });
  });

  it('uses no business context when the inbox has no agent', async () => {
    const ai = t.ctx.services.ai!;
    // Lite keeps its one agent on inbox 1; an Enterprise inbox can have none (same lookup).
    t.ctx.db.prepare('UPDATE ai_agents SET inbox_id = NULL').run();
    await ai.draftReply(JID, { kind: 'suggest' }, new AbortController().signal);
    const { prompt, input } = sentPrompt();
    expect(input.businessKnowledge).toBe('');
    expect(input.internalKnowledge).toBe('');
    expect(prompt.cacheId).toMatch(/#agent:0$/);
    // No agent: no preset instructions or hand-off rules that nobody configured.
    expect(prompt.instructions).toContain('(none: follow the rules above)');
    expect(prompt.instructions).toContain('(none: only the system hand-offs apply)');
    expect(prompt.instructions).not.toContain('Be warm.');
  });

  it('completes with the fast model and the typed text', async () => {
    vi.mocked(provider.draft!).mockResolvedValueOnce({
      output: { completion: 'Lemak for pickup at 1pm.', grounded: true },
      model: 'gpt-mini',
    });
    const result = await t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'complete', typed: 'Two Nasi ' },
      new AbortController().signal,
    );
    expect(result).toEqual({ completion: 'Lemak for pickup at 1pm.' });
    const { options, input } = sentPrompt();
    expect(options).toMatchObject({ fast: true, maxOutputTokens: 300 });
    expect(input.currentSituation.typed).toBe('Two Nasi ');
  });

  it('completes from the last 6 messages and the typed text only, never the knowledge', async () => {
    for (let i = 1; i <= 7; i++) t.wa.simulateIncoming({ chatJid: JID, body: `Follow-up ${i}` });
    await vi.waitFor(() =>
      expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 8 }),
    );
    // RM12 is only in the business context, which a completion never sees.
    vi.mocked(provider.draft!).mockResolvedValueOnce({
      output: { completion: 'Lemak Ayam at RM12 each.', grounded: true },
      model: 'gpt-mini',
    });
    const result = await t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'complete', typed: 'Two Nasi ' },
      new AbortController().signal,
    );
    expect(result).toEqual({ completion: null });
    const { input } = sentPrompt();
    expect(input.businessKnowledge).toBe('');
    expect(input.internalKnowledge).toBe('');
    expect(input.conversation.map((turn: { text: string }) => turn.text)).toEqual(
      [2, 3, 4, 5, 6, 7].map((i) => `Follow-up ${i}`),
    );
    const line = logLines.map((l) => JSON.parse(l)).findLast((l) => l.event === 'ai_draft');
    expect(line).toMatchObject({ kind: 'complete', ok: true, count: 0, dropped: 'number' });
  });

  it('throws ai_suggestions_off when switched off, without a model call', async () => {
    setReplySuggestions(t.ctx, false, actor);
    const call = t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'suggest' },
      new AbortController().signal,
    );
    await expect(call).rejects.toBeInstanceOf(HttpError);
    await expect(call).rejects.toMatchObject({ status: 409, code: 'ai_suggestions_off' });
    expect(provider.draft).not.toHaveBeenCalled();
  });

  it('throws ai_unavailable when the connection is expired', async () => {
    connection = 'expired';
    await expect(
      t.ctx.services.ai!.draftReply(JID, { kind: 'suggest' }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 503, code: 'ai_unavailable' });
    expect(t.ctx.services.ai!.draftConnection()).toBe('unavailable');
  });

  it('returns completion null after 3 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(provider.draft!).mockImplementationOnce(
        (_s, _k, _p, _o, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          ),
      );
      const pending = t.ctx.services.ai!.draftReply(
        JID,
        { kind: 'complete', typed: 'Two Nasi ' },
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toEqual({ completion: null });
    } finally {
      vi.useRealTimers();
    }
    const line = logLines.map((l) => JSON.parse(l)).find((l) => l.event === 'ai_draft');
    expect(line).toMatchObject({
      kind: 'complete',
      ok: false,
      causeName: 'AbortError',
      timedOut: true,
    });
  });

  it("logs the app's own cancel without timedOut, and why a completion was dropped", async () => {
    vi.mocked(provider.draft!).mockImplementationOnce(
      (_s, _k, _p, _o, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    );
    const cancel = new AbortController();
    const pending = t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'complete', typed: 'Two Nasi ' },
      cancel.signal,
    );
    cancel.abort();
    await expect(pending).resolves.toEqual({ completion: null });
    vi.mocked(provider.draft!).mockResolvedValueOnce({
      output: { completion: 'Lemak Ayam at RM19 each.', grounded: true },
      model: 'gpt-mini',
    });
    await t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'complete', typed: 'Two Nasi ' },
      new AbortController().signal,
    );
    const lines = logLines.map((l) => JSON.parse(l)).filter((l) => l.event === 'ai_draft');
    expect(lines.map((l) => [l.ok, l.timedOut, l.dropped, l.count])).toEqual([
      [false, undefined, undefined, 0],
      [true, undefined, 'number', 0],
    ]);
    expect(logLines.join('\n')).not.toContain('RM19');
  });

  it('keeps a draft that states a fact from the admin instructions', async () => {
    t.ctx.services.ai!.saveMember(
      { displayName: 'Aina', enabled: false, instructions: 'Be warm. We open 9am to 6pm.' },
      actor,
    );
    vi.mocked(provider.draft!).mockResolvedValueOnce({
      output: {
        suggestions: [{ label: 'Hours', text: 'We open at 9am.', grounded: true }],
        noAnswer: false,
        handoffRule: null,
      },
      model: 'gpt-test',
    });
    const result = await t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'suggest' },
      new AbortController().signal,
    );
    expect(result.suggestions.map((s) => s.text)).toEqual(['We open at 9am.']);
  });

  it('logs the cause of a failed call, never its text', async () => {
    const failure = Object.assign(new Error('Too many requests for Nasi Lemak'), {
      name: 'AI_APICallError',
      statusCode: 429,
    });
    vi.mocked(provider.draft!).mockRejectedValueOnce(failure);
    await expect(
      t.ctx.services.ai!.draftReply(JID, { kind: 'suggest' }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 503 });
    vi.mocked(provider.draft!).mockRejectedValueOnce(failure);
    await t.ctx.services.ai!.draftReply(
      JID,
      { kind: 'complete', typed: 'Two Nasi ' },
      new AbortController().signal,
    );
    const lines = logLines.map((l) => JSON.parse(l)).filter((l) => l.event === 'ai_draft');
    expect(lines.map((l) => [l.kind, l.ok, l.causeName, l.status])).toEqual([
      ['suggest', false, 'AI_APICallError', 429],
      ['complete', false, 'AI_APICallError', 429],
    ]);
    expect(logLines.join('\n')).not.toContain('Nasi Lemak');
  });

  it('logs kind, ok, ms, model and count only', async () => {
    await t.ctx.services.ai!.draftReply(JID, { kind: 'suggest' }, new AbortController().signal);
    const line = logLines.map((l) => JSON.parse(l)).find((l) => l.event === 'ai_draft');
    expect(line).toMatchObject({ kind: 'suggest', ok: true, model: 'gpt-test', count: 2 });
    expect(typeof line.ms).toBe('number');
    const raw = logLines.join('\n');
    expect(raw).not.toContain('Nasi Lemak');
    expect(raw).not.toContain('pickup');
  });

  it('reports no connection when signed out, and API-key modes by their saved key', () => {
    const ai = t.ctx.services.ai!;
    connection = 'signed_out';
    expect(ai.draftConnection()).toBe('none');
    t.ctx.settings.set('ai_inbox_provider', { mode: 'api', model: '' });
    expect(ai.draftConnection()).toBe('none');
    t.ctx.settings.setSecret('ai_api_key', 'sk-test');
    expect(ai.draftConnection()).toBe('ready');
  });
});

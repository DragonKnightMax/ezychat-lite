import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { AiProvider } from '../src/ai/provider-types.js';
import { createAiService } from '../src/ai/service.js';
import { getChats } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders } from './auth-helpers.js';

const JID = '60126677889@s.whatsapp.net';
const GROUP = '120363025550001@g.us';
const DRAFTS = {
  suggestions: [{ label: 'Confirm price', text: 'Nasi Lemak Ayam is RM12.', grounded: true }],
  noAnswer: false,
  handoffRule: null,
};

const open: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const t of open.splice(0)) await t.close();
});

async function setup(opts: { inboxes?: number; listen?: boolean } = {}) {
  const provider: AiProvider = {
    generate: vi.fn(),
    draft: vi.fn().mockResolvedValue({ output: DRAFTS, model: 'gpt-test' }),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  const t = await makeTestApp({
    ...(opts.inboxes ? { maxInboxes: 3, inboxes: opts.inboxes } : {}),
    ...(opts.listen ? { listen: true } : {}),
    beforeBuild: async (ctx) => {
      await ctx.services.ai!.shutdown();
      ctx.services.ai = createAiService(ctx, { provider });
    },
  });
  open.push(t);
  const auth = t.ctx.services.auth!;
  const user = (username: string, role: 'admin' | 'agent') =>
    auth.createUser({
      username,
      displayName: username,
      role,
      password: 'password123',
      mustChangePassword: false,
    });
  const admin = user('admin', 'admin');
  const agent = user('agent', 'agent');
  const cookie = (id: number) =>
    `sid=${auth.createSession(id, { ip: '127.0.0.1', userAgent: 't' })}`;
  t.ctx.services.ai!.saveConnection({ mode: 'chatgpt', model: '' }, { userId: admin.id, ip: null });
  t.ctx.services.ai!.saveMember(
    { displayName: 'Aina', enabled: false, instructions: '' },
    { userId: admin.id, ip: null },
  );
  t.ctx.services.ai!.addText(
    null,
    { name: 'Menu', text: 'Nasi Lemak Ayam RM12.' },
    { userId: admin.id, ip: null },
  );
  const chats = getChats(t.ctx);
  chats.upsertFromWa({ jid: JID, type: 'dm', name: 'Nurul' }, 1);
  chats.upsertFromWa({ jid: GROUP, type: 'group', name: 'Regulars' }, 1);
  return { t, provider, adminCookie: cookie(admin.id), agentCookie: cookie(agent.id) };
}

const enc = encodeURIComponent;
const inject = (
  t: TestApp,
  cookie: string,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload?: object,
) => t.app.inject({ method, url, headers: authHeaders(cookie), ...(payload ? { payload } : {}) });

describe('reply suggestion routes', () => {
  it('shows any signed-in user the status', async () => {
    const { t, agentCookie } = await setup();
    const res = await inject(t, agentCookie, 'GET', '/api/reply-suggestions');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, connected: true, state: 'on', upgraded: false });
  });

  it('lets only an admin change the switch, and audits it', async () => {
    const { t, adminCookie, agentCookie } = await setup();
    expect(
      (await inject(t, agentCookie, 'PUT', '/api/ai/reply-suggestions', { enabled: false }))
        .statusCode,
    ).toBe(403);
    const res = await inject(t, adminCookie, 'PUT', '/api/ai/reply-suggestions', {
      enabled: false,
    });
    expect(res.json()).toMatchObject({ enabled: false, state: 'off' });
    const rows = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'ai.reply_suggestions.update'")
      .all() as Array<{ meta: string }>;
    expect(rows.map((r) => JSON.parse(r.meta))).toEqual([{ before: true, after: false }]);
    const off = await inject(t, agentCookie, 'POST', `/api/chats/${enc(JID)}/ai/suggestions`);
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('ai_suggestions_off');
  });

  it('returns drafts and completions for a direct chat', async () => {
    const { t, provider, agentCookie } = await setup();
    const res = await inject(t, agentCookie, 'POST', `/api/chats/${enc(JID)}/ai/suggestions`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      suggestions: [{ label: 'Confirm price', text: 'Nasi Lemak Ayam is RM12.' }],
      noAnswer: false,
      handoffRule: null,
    });
    vi.mocked(provider.draft!).mockResolvedValueOnce({
      output: { completion: 'Lemak Ayam, thank you for asking.', grounded: true },
      model: 'gpt-mini',
    });
    const done = await inject(t, agentCookie, 'POST', `/api/chats/${enc(JID)}/ai/complete`, {
      text: 'Two Nasi ',
    });
    expect(done.json()).toEqual({ completion: 'Lemak Ayam, thank you for asking.' });
    expect(
      (await inject(t, agentCookie, 'POST', `/api/chats/${enc(JID)}/ai/complete`, { text: '' }))
        .statusCode,
    ).toBe(400);
  });

  it('drafts for a group chat too', async () => {
    const { t, provider, agentCookie } = await setup();
    const res = await inject(t, agentCookie, 'POST', `/api/chats/${enc(GROUP)}/ai/suggestions`);
    expect(res.statusCode).toBe(200);
    expect(provider.draft).toHaveBeenCalledTimes(1);
    vi.mocked(provider.draft!).mockResolvedValueOnce({
      output: { completion: 'Two Nasi Lemak, please.', grounded: true },
      model: 'gpt-mini',
    });
    const done = await inject(t, agentCookie, 'POST', `/api/chats/${enc(GROUP)}/ai/complete`, {
      text: 'Two Nasi ',
    });
    expect(done.json()).toEqual({ completion: 'Lemak, please.' });
  });

  it("answers 404 outside the caller's inboxes", async () => {
    const { t, provider, agentCookie } = await setup({ inboxes: 2 });
    const other = getChats(t.ctx).upsertFromWa({ jid: JID, type: 'dm', name: 'Nurul' }, 2);
    const res = await inject(t, agentCookie, 'POST', `/api/chats/${enc(other.jid)}/ai/suggestions`);
    expect(res.statusCode).toBe(404);
    expect(provider.draft).not.toHaveBeenCalled();
  });

  it('rate-limits suggestions at 20 a minute', async () => {
    const { t, agentCookie } = await setup();
    for (let i = 0; i < 20; i++)
      expect(
        (await inject(t, agentCookie, 'POST', `/api/chats/${enc(JID)}/ai/suggestions`)).statusCode,
      ).toBe(200);
    const limited = await inject(t, agentCookie, 'POST', `/api/chats/${enc(JID)}/ai/suggestions`);
    expect(limited.statusCode).toBe(429);
  });

  it('answers 403 while the access gate is closed', async () => {
    const { t, agentCookie } = await setup();
    t.ctx.access.close({ code: 'licence_expired' });
    expect((await inject(t, agentCookie, 'GET', '/api/reply-suggestions')).statusCode).toBe(403);
  });

  it('aborts the model call when the client disconnects', async () => {
    const { t, provider, agentCookie } = await setup({ listen: true });
    let seen: AbortSignal | undefined;
    vi.mocked(provider.draft!).mockImplementationOnce(
      (_s, _k, _p, _o, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        }),
    );
    const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    const client = new AbortController();
    const request = fetch(`${base}/api/chats/${enc(JID)}/ai/suggestions`, {
      method: 'POST',
      headers: { cookie: agentCookie, origin: base },
      signal: client.signal,
    }).catch(() => null);
    await vi.waitFor(() => expect(seen).toBeDefined());
    client.abort();
    await request;
    await vi.waitFor(() => expect(seen!.aborted).toBe(true));
  });
});

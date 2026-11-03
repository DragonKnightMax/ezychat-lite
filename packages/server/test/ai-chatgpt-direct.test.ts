import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import {
  CHATGPT_OAUTH,
  accountIdFromTokens,
  buildAuthorizeUrl,
  createPkce,
  createState,
  emailFromTokens,
  exchangeCode,
  pkceChallenge,
  refreshTokens,
  startCallbackListener,
  stateMatches,
} from '../src/ai/chatgpt-oauth.js';
import {
  BackendError,
  CODEX_BACKEND,
  aggregateSse,
  backendHeaders,
  fetchModels,
  parseSse,
  responsesBody,
  streamResponse,
} from '../src/ai/chatgpt-backend.js';
import { CHATGPT_TOKENS_SECRET, DirectChatGptProvider } from '../src/ai/chatgpt-direct.js';
import { redactLogLine, redactSecretText } from '../src/log-redaction.js';
import { chatTools } from '../src/ai/agent/tools.js';
import { AI_FULL_CONTEXT_CHARACTERS } from '../src/ai/knowledge.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders } from './auth-helpers.js';

import {
  ACCESS,
  CHATGPT_SETTINGS,
  ID_TOKEN,
  answer,
  seedTokens,
  frame,
  freePort,
  json,
  jwt,
  rawGet,
  sse,
  tokenResponse,
} from './chatgpt-fixtures.js';
describe('ChatGPT OAuth (experimental direct sign-in)', () => {
  it('builds the Codex PKCE authorize URL with a verified S256 challenge and random state', () => {
    // RFC 7636 appendix B vector.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallenge(pkce.verifier)).toBe(pkce.challenge);
    const state = createState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(createState()).not.toBe(state);
    expect(stateMatches(state, state)).toBe(true);
    expect(stateMatches(state, `${state}x`)).toBe(false);
    expect(stateMatches(state, null)).toBe(false);

    const url = new URL(buildAuthorizeUrl(pkce.challenge, state));
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    });
  });

  it('extracts the ChatGPT account id and email from token claims', () => {
    expect(accountIdFromTokens(ACCESS)).toBe('acct-123');
    expect(emailFromTokens(ACCESS, ID_TOKEN)).toBe('owner@example.com');
    const bare = jwt({});
    expect(accountIdFromTokens(bare)).toBeNull();
    expect(
      accountIdFromTokens(
        bare,
        jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a2' } }),
      ),
    ).toBe('a2');
    expect(emailFromTokens(bare, ID_TOKEN)).toBe('id@example.com');
    expect(accountIdFromTokens('not-a-jwt')).toBeNull();
  });

  it('exchanges the code with a form-encoded PKCE request', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => tokenResponse());
    const tokens = await exchangeCode('the-code', 'the-verifier', fetchMock as typeof fetch);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: CHATGPT_OAUTH.clientId,
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: CHATGPT_OAUTH.redirectUri,
    });
    expect(tokens).toMatchObject({
      accessToken: ACCESS,
      refreshToken: 'refresh-1',
      idToken: ID_TOKEN,
      accountId: 'acct-123',
      email: 'owner@example.com',
    });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
  });

  it('refreshes with the refresh grant, rotates tokens and never surfaces error bodies', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      tokenResponse({ refresh_token: undefined, id_token: undefined }),
    );
    const next = await refreshTokens(
      { refreshToken: 'refresh-0', idToken: 'old-id' },
      fetchMock as typeof fetch,
    );
    expect(Object.fromEntries(fetchMock.mock.calls[0]![1]?.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-0',
      client_id: CHATGPT_OAUTH.clientId,
    });
    expect(next).toMatchObject({ refreshToken: 'refresh-0', idToken: 'old-id' });

    const rejected = vi.fn(async () => json({ error: 'invalid_grant', secret: 'refresh-0' }, 400));
    const error = (await refreshTokens(
      { refreshToken: 'refresh-0', idToken: null },
      rejected as unknown as typeof fetch,
    ).catch((e: unknown) => e)) as Error & { status: number };
    expect(error.status).toBe(400);
    expect(error.message).not.toContain('refresh-0');
  });
});

describe('ChatGPT Codex backend (experimental)', () => {
  it('sends the Codex headers and a stateless streaming body', () => {
    const headers = backendHeaders({ accessToken: 'tok', accountId: 'acct' }, 'sess');
    expect(headers).toMatchObject({
      authorization: 'Bearer tok',
      'chatgpt-account-id': 'acct',
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
      accept: 'text/event-stream',
      session_id: 'sess',
    });
    const body = responsesBody(
      { model: 'gpt-6-sol', instructions: 'rules', input: 'hello', schema: { type: 'object' } },
      'sess',
    );
    expect(body).toMatchObject({
      model: 'gpt-6-sol',
      instructions: 'rules',
      store: false,
      stream: true,
      tools: [],
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      text: { format: { type: 'json_schema', strict: true, schema: { type: 'object' } } },
    });
    expect(responsesBody({ model: 'm', instructions: '', input: '' }, 's').text).toEqual({
      verbosity: 'low',
    });
  });

  it('adds customer images as low-detail input_image parts after the text, and nothing without them', () => {
    const request = { model: 'gpt-6-sol', instructions: 'rules', input: 'hello', cacheKey: 'k' };
    const plain = JSON.stringify(responsesBody(request, 'sess'));
    expect(JSON.stringify(responsesBody({ ...request, images: [] }, 'sess'))).toBe(plain);
    expect(JSON.parse(plain).input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
    const body = responsesBody(
      { ...request, images: [{ mime: 'image/webp', base64: 'UklGRg==' }] },
      'sess',
    );
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_image', image_url: 'data:image/webp;base64,UklGRg==', detail: 'low' },
        ],
      },
    ]);
    expect(body.instructions).toBe('rules');
  });

  it('aggregates streamed SSE text across split chunks, CRLF frames and [DONE]', async () => {
    const stream = sse([
      frame({ type: 'response.created' }),
      'data: not json\n\n',
      frame({ type: 'response.output_text.delta', delta: 'Hel' }).replace(/\n/g, '\r\n'),
      frame({ type: 'response.output_text.delta', delta: 'lo' }),
      frame({ type: 'response.completed', response: { status: 'completed' } }),
      'data: [DONE]\n\n',
    ]);
    expect(await aggregateSse(parseSse(stream))).toBe('Hello');
    const fromOutput = sse([
      frame({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
        },
      }),
    ]);
    expect(await aggregateSse(parseSse(fromOutput))).toBe('OK');
  });

  it('turns failed, usage-limited, incomplete and truncated streams into errors', async () => {
    await expect(
      aggregateSse(
        parseSse(
          sse([
            frame({
              type: 'response.failed',
              response: { error: { code: 'usage_limit_reached' } },
            }),
          ]),
        ),
      ),
    ).rejects.toThrow('usage limit');
    await expect(
      aggregateSse(parseSse(sse([frame({ type: 'response.incomplete' })]))),
    ).rejects.toThrow('did not complete');
    await expect(
      aggregateSse(parseSse(sse([frame({ type: 'response.output_text.delta', delta: 'x' })]))),
    ).rejects.toThrow('ended its answer early');
  });

  it('posts to the Codex responses endpoint and maps 401 to a sign-in error', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          sse([
            frame({ type: 'response.output_text.done', text: 'OK' }),
            frame({ type: 'response.completed', response: { status: 'completed' } }),
          ]),
        ),
    );
    const text = await streamResponse(
      { accessToken: 'tok', accountId: 'acct' },
      { model: 'gpt-5.5', instructions: 'i', input: 'Reply with OK' },
      new AbortController().signal,
      fetchMock as typeof fetch,
    );
    expect(text).toBe('OK');
    expect(fetchMock.mock.calls[0]![0]).toBe(CODEX_BACKEND.responsesUrl);
    const unauthorized = vi.fn(async () => json({ error: { message: 'tok expired' } }, 401));
    const error = (await streamResponse(
      { accessToken: 'tok', accountId: 'acct' },
      { model: 'gpt-5.5', instructions: 'i', input: 'x' },
      new AbortController().signal,
      unauthorized as unknown as typeof fetch,
    ).catch((e: unknown) => e)) as BackendError;
    expect(error).toBeInstanceOf(BackendError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain('tok');
  });

  it('reads the live model list, keeping only listed models in priority order', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      json({
        models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 13 },
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1 },
          { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
          { slug: 'Bad Slug!', visibility: 'list', priority: 2 },
        ],
      }),
    );
    const models = await fetchModels(
      { accessToken: 'tok', accountId: 'acct' },
      fetchMock as typeof fetch,
    );
    expect(models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-5.5']);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(`${url.origin}${url.pathname}`).toBe('https://chatgpt.com/backend-api/codex/models');
    expect(url.searchParams.get('client_version')).toBe(CODEX_BACKEND.clientVersion);
  });
});

describe('log redaction for ChatGPT credentials', () => {
  it('redacts token fields, JWTs and OAuth parameters', () => {
    const line = JSON.stringify({
      msg: `callback http://localhost:1455/auth/callback?code=abc123&state=s3cr3t failed with ${ACCESS}`,
      access_token: 'a',
      refresh_token: 'r',
      idToken: 'i',
      nested: { codeVerifier: 'v', note: `Bearer ${ACCESS}` },
    });
    const out = redactLogLine(line);
    for (const secret of ['abc123', 's3cr3t', ACCESS, '"a"', '"r"', '"i"', '"v"'])
      expect(out).not.toContain(secret);
    expect(out).toContain('/auth/callback?[REDACTED]');
    expect(redactSecretText('errorcode=E1 status=401')).toBe('errorcode=E1 status=401');
  });
});

describe('local OAuth callback listener', () => {
  it('rejects wrong state and foreign hosts, then delivers the code once', async () => {
    const port = await freePort();
    const listener = await startCallbackListener('expected-state', port);
    try {
      const base = `http://127.0.0.1:${port}/auth/callback`;
      const wrong = await fetch(`${base}?code=c&state=wrong`);
      expect(wrong.status).toBe(400);
      expect(
        await rawGet(port, '/auth/callback?code=c&state=expected-state', `evil.example:${port}`),
      ).toBe(421);
      const ok = fetch(`${base}?code=the-code&state=expected-state`);
      expect(await listener.result).toEqual({ code: 'the-code' });
      listener.finish(true);
      const page = await ok;
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Signed in');
    } finally {
      listener.close();
    }
  });

  it('answers a malformed request target with 404 and keeps waiting for the real callback', async () => {
    const port = await freePort();
    const listener = await startCallbackListener('expected-state', port);
    try {
      expect(await rawGet(port, '//', `127.0.0.1:${port}`)).toBe(404);
      expect(await rawGet(port, '//evil.example/auth/callback', `127.0.0.1:${port}`)).toBe(404);
      const ok = fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=expected-state`);
      expect(await listener.result).toEqual({ code: 'the-code' });
      listener.finish(true);
      expect((await ok).status).toBe(200);
    } finally {
      listener.close();
    }
  });

  it('reports a busy callback port clearly', async () => {
    const port = await freePort();
    const busy = createServer().listen(port, '127.0.0.1');
    await new Promise((resolve) => busy.once('listening', resolve));
    try {
      await expect(startCallbackListener('s', port)).rejects.toThrow(`Port ${port} is in use`);
    } finally {
      busy.close();
    }
  });
});

describe('DirectChatGptProvider', () => {
  let t: TestApp | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });

  it('signs in through the loopback callback, stores tokens encrypted, refreshes and signs out', async () => {
    t = await makeTestApp();
    const port = await freePort();
    let answers = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target === CHATGPT_OAUTH.tokenUrl) {
        const grant = (init?.body as URLSearchParams).get('grant_type');
        return tokenResponse({
          refresh_token: grant === 'refresh_token' ? 'refresh-2' : 'refresh-1',
        });
      }
      if (target === CODEX_BACKEND.responsesUrl) {
        answers++;
        if (answers === 1) return json({ error: { code: 'token_expired' } }, 401);
        return new Response(
          sse([
            frame({
              type: 'response.output_text.delta',
              delta: JSON.stringify({ reply: 'Hello', action: 'answer', handoffReason: null }),
            }),
            frame({ type: 'response.completed', response: { status: 'completed' } }),
          ]),
        );
      }
      return json({}, 404);
    });
    const provider = new DirectChatGptProvider(t.ctx, {
      fetch: fetchMock as typeof fetch,
      callbackPort: port,
    });
    const started = await provider.login();
    expect(started.state).toBe('signing_in');
    const state = new URL(started.loginUrl!).searchParams.get('state');
    const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c0de&state=${state}`);
    expect(await callback.text()).toContain('Signed in');
    await vi.waitFor(() => expect(provider.connection().state).toBe('connected'));
    expect(provider.connection().email).toBe('owner@example.com');
    const raw = t.ctx.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(CHATGPT_TOKENS_SECRET) as { value: string };
    expect(raw.value).not.toContain('refresh-1');
    expect(raw.value).not.toContain(ACCESS);

    const decision = await provider.generate(
      {
        displayName: 'AI',
        enabled: true,
        mode: 'chatgpt',
        model: '',
        instructions: '',
      },
      null,
      { instructions: 'rules', input: 'hi' },
      new AbortController().signal,
    );
    expect(decision).toEqual({ reply: 'Hello', action: 'answer', handoffReason: null });
    // 401 → one refresh → retry with the auto (first fallback) model.
    expect(JSON.parse(t.ctx.settings.getSecret(CHATGPT_TOKENS_SECRET)!).refreshToken).toBe(
      'refresh-2',
    );
    const responseCalls = fetchMock.mock.calls.filter((c) => c[0] === CODEX_BACKEND.responsesUrl);
    expect(responseCalls).toHaveLength(2);
    expect(JSON.parse(String(responseCalls[1]![1]?.body)).model).toBe('gpt-6.1-sol');

    await provider.logout();
    expect(provider.connection().state).toBe('signed_out');
    expect(t.ctx.settings.getSecret(CHATGPT_TOKENS_SECRET)).toBeNull();
    await provider.shutdown();
  });

  it('falls back to Auto for a saved model that is no longer listed, logging the reason hourly', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = vi.fn();
    const log = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const ctx = {
      log: { child: () => log },
      settings: { getSecret: () => null },
    } as unknown as ConstructorParameters<typeof DirectChatGptProvider>[0];
    const provider = new DirectChatGptProvider(ctx, { fetch: vi.fn() as unknown as typeof fetch });
    expect(await provider.resolveModel('gpt-5.4')).toBe('gpt-6.1-sol');
    expect(await provider.resolveModel('gpt-5.4')).toBe('gpt-6.1-sol');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: 'chatgpt_model_unavailable',
      model: 'gpt-5.4',
      fallback: 'gpt-6.1-sol',
      // Not signed in here, so the live list is unavailable and only the fallback list is known.
      reason: 'not_in_fallback_list',
    });
    expect(await provider.resolveModel('gpt-5.5')).toBe('gpt-5.5');
    expect(await provider.resolveModel('')).toBe('gpt-6.1-sol');
    expect(warn).toHaveBeenCalledTimes(1);
    // A different saved model is reported on its own.
    expect(await provider.resolveModel('gpt-4o')).toBe('gpt-6.1-sol');
    expect(warn).toHaveBeenCalledTimes(2);
    // The same model is reported again after an hour while it keeps happening.
    now += 59 * 60_000;
    await provider.resolveModel('gpt-5.4');
    expect(warn).toHaveBeenCalledTimes(2);
    now += 60_000;
    await provider.resolveModel('gpt-5.4');
    expect(warn).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it("treats the account's cached live list as authoritative over the fallback list", async () => {
    const warn = vi.fn();
    const log = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const ctx = {
      log: { child: () => log },
      settings: { getSecret: () => null },
    } as unknown as ConstructorParameters<typeof DirectChatGptProvider>[0];
    const provider = new DirectChatGptProvider(ctx, { fetch: vi.fn() as unknown as typeof fetch });
    // The signed-in account's live list (cached) lacks gpt-5.5, which the fallback list has.
    (provider as unknown as { modelCache: unknown }).modelCache = {
      at: Date.now(),
      models: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol', priority: 0 }],
    };
    expect(provider.knownModels()).toEqual(['gpt-6-sol']);
    expect(await provider.resolveModel('gpt-5.5')).toBe('gpt-6-sol');
    expect(await provider.resolveModel('gpt-6-sol')).toBe('gpt-6-sol');
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: 'chatgpt_model_unavailable',
      model: 'gpt-5.5',
      reason: 'not_in_live_list',
    });
  });

  it('times out an abandoned sign-in and releases the callback port', async () => {
    t = await makeTestApp();
    const port = await freePort();
    const provider = new DirectChatGptProvider(t.ctx, { callbackPort: port, loginTimeoutMs: 50 });
    await provider.login();
    await vi.waitFor(() => expect(provider.connection().state).toBe('error'));
    expect(provider.connection().error).toContain('timed out');
    const again = await provider.login();
    expect(again.state).toBe('signing_in');
    await provider.logout();
  });
});

describe('experimental ChatGPT routes', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it('are admin-only and validate ChatGPT models against the model list', async () => {
    t = await makeTestApp();
    const auth = t.ctx.services.auth!;
    const admin = auth.createUser({
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      password: 'password123',
      mustChangePassword: false,
    });
    const agent = auth.createUser({
      username: 'agent',
      displayName: 'Agent',
      role: 'agent',
      password: 'password123',
      mustChangePassword: false,
    });
    const adminCookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 't' })}`;
    const agentCookie = `sid=${auth.createSession(agent.id, { ip: '127.0.0.1', userAgent: 't' })}`;
    expect((await t.app.inject({ url: '/api/ai/models' })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ url: '/api/ai/models', headers: { cookie: agentCookie } })).statusCode,
    ).toBe(403);
    for (const url of ['/api/ai/chatgpt/test', '/api/ai/chatgpt/login', '/api/ai/chatgpt/logout'])
      expect(
        (await t.app.inject({ method: 'POST', url, headers: authHeaders(agentCookie) })).statusCode,
      ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/ai/chatgpt/test',
          headers: { cookie: adminCookie, host: 'localhost', origin: 'http://evil.example' },
        })
      ).statusCode,
    ).toBe(403);

    const models = await t.app.inject({ url: '/api/ai/models', headers: { cookie: adminCookie } });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({ source: 'fallback' });
    expect(models.json().models.map((m: { id: string }) => m.id)).toContain('gpt-6-sol');

    const save = (model: string) =>
      t.app.inject({
        method: 'PATCH',
        url: '/api/ai/connection',
        headers: authHeaders(adminCookie),
        payload: { mode: 'chatgpt', model },
      });
    expect((await save('gpt-6-sol')).statusCode).toBe(200);
    expect((await save('')).statusCode).toBe(200);
    const rejected = await save('gpt-5.4');
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain('ChatGPT mode supports gpt-6.1-sol');

    const test = await t.app.inject({
      method: 'POST',
      url: '/api/ai/chatgpt/test',
      headers: authHeaders(adminCookie),
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({
      ok: false,
      error: 'Sign in to ChatGPT in the AI settings.',
    });
  });
});

describe('ChatGPT agent turn', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it('bounds the whole multi-step turn, not each model call', async () => {
    t = await makeTestApp();
    seedTokens(t.ctx);
    const toolCall = () =>
      new Response(
        sse([
          frame({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'search_business_context',
              arguments: JSON.stringify({ query: 'delivery' }),
              status: 'completed',
            },
          }),
          frame({ type: 'response.completed', response: { status: 'completed' } }),
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    let calls = 0;
    // Each model call takes 150 ms; the second one alone would still fit a per-call bound.
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          calls++;
          const timer = setTimeout(() => resolve(calls === 1 ? toolCall() : answer('Late')), 150);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const provider = new DirectChatGptProvider(t.ctx, {
      fetch: fetchMock as typeof fetch,
      turnTimeoutMs: 200,
    });
    const tools = chatTools({
      knowledge: [{ name: 'Big', text: 'x'.repeat(AI_FULL_CONTEXT_CHARACTERS + 1) }],
    });
    await expect(
      provider.generate(
        CHATGPT_SETTINGS,
        null,
        { instructions: 'rules', input: 'delivery?', tools },
        new AbortController().signal,
      ),
    ).rejects.toThrow('ChatGPT answer timed out.');
    expect(calls).toBe(2);
    await provider.shutdown();
    // The 200 ms turn bound is what's tested; building the app takes seconds on the Windows runner.
  }, 30_000);
});

describe('ChatGPT prompt cache key', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it('is stable per inbox and model, differs by model and carries no customer data', async () => {
    t = await makeTestApp();
    seedTokens(t.ctx);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => answer('Hello'));
    const provider = new DirectChatGptProvider(t.ctx, { fetch: fetchMock as typeof fetch });
    const customer = 'Customer Siti 60123456789 wants delivery';
    const ask = (model: string, input: string) =>
      provider.generate(
        { ...CHATGPT_SETTINGS, model },
        null,
        { instructions: 'rules', input, cacheId: 'install-abc' },
        new AbortController().signal,
      );
    await ask('gpt-6-astra', customer);
    await ask('gpt-6-astra', 'another chat');
    await ask('gpt-6-sol', customer);
    const sent = fetchMock.mock.calls
      .filter((call) => call[0] === CODEX_BACKEND.responsesUrl)
      .map((call) => ({
        key: JSON.parse(String(call[1]!.body)).prompt_cache_key as string,
        header: (call[1]!.headers as Record<string, string>).session_id,
      }));
    expect(sent).toHaveLength(3);
    expect(sent[0]!.key).toMatch(/^ezychat-[0-9a-f]{16}$/);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[2]!.key).not.toBe(sent[0]!.key);
    for (const { key, header } of sent) {
      expect(header).toBe(key);
      expect(key).not.toMatch(/Siti|60123456789|install-abc/);
    }
    await provider.shutdown();
  });

  it('sends PDFs to the Codex request as their text layer, never as files', async () => {
    t = await makeTestApp();
    seedTokens(t.ctx);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => answer('Recorded'));
    const provider = new DirectChatGptProvider(t.ctx, { fetch: fetchMock as typeof fetch });
    await provider.generate(
      { ...CHATGPT_SETTINGS, model: 'gpt-6-astra' },
      null,
      {
        instructions: 'rules',
        input: 'record this',
        pdfs: [{ name: 'INV-7.pdf', base64: 'JVBERi0xLjQ=', text: 'Total RM 70', pages: 1 }],
      },
      new AbortController().signal,
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === CODEX_BACKEND.responsesUrl)!;
    const raw = String(call[1]!.body);
    expect(raw).not.toContain('JVBERi0');
    expect(raw).not.toContain('input_file');
    expect(JSON.parse(raw).input[0].content.at(-1).text).toContain(
      'PDF INV-7.pdf, 1 page:\nTotal RM 70',
    );
    await provider.shutdown();
  });

  it('passes customer images from the prompt to the Codex request', async () => {
    t = await makeTestApp();
    seedTokens(t.ctx);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => answer('A blue chair'));
    const provider = new DirectChatGptProvider(t.ctx, { fetch: fetchMock as typeof fetch });
    await provider.generate(
      { ...CHATGPT_SETTINGS, model: 'gpt-6-astra' },
      null,
      {
        instructions: 'rules',
        input: 'what is this?',
        images: [{ mime: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
      new AbortController().signal,
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === CODEX_BACKEND.responsesUrl)!;
    expect(JSON.parse(String(call[1]!.body)).input[0].content).toEqual([
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' },
    ]);
    await provider.shutdown();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { CLAUDE_DEFAULT_MODEL, type AiSettings } from '@ezychat/shared';
import { AgentTurnFailure } from './agent/models.js';
import { runRewrite } from './agent/rewrite.js';
import {
  ANTHROPIC_API_URL,
  claudeKeyModel,
  extractCustomerClaude,
  generateClaude,
  draftClaude,
  rewriteClaude,
} from './claude.js';

const KEY = 'sk-ant-api03-SECRET-key-0123456789';
const settings: AiSettings = {
  enabled: true,
  displayName: 'AI',
  mode: 'claude',
  model: '',
  instructions: '',
};
const prompt = {
  instructions: 'GUARDRAILS\nOnly answer from supplied business knowledge',
  input: '{"businessKnowledge":"We open 9am","currentSituation":{}}',
};
const signal = () => new AbortController().signal;

/** A Messages API answer whose content is one text block. */
const message = (text: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: CLAUDE_DEFAULT_MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const toolUse = (name: string) =>
  new Response(
    JSON.stringify({
      id: 'msg_t',
      type: 'message',
      role: 'assistant',
      model: CLAUDE_DEFAULT_MODEL,
      content: [{ type: 'tool_use', id: 'toolu_1', name, input: { query: 'hours' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const decision = (reply: string, action = 'answer') =>
  JSON.stringify({ reply, action, handoffReason: null });

function stubFetch(...responses: Array<() => Response | Promise<Response>>) {
  let index = 0;
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return next();
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const call = (fetcher: ReturnType<typeof stubFetch>, n = 0) => {
  const [url, init] = fetcher.mock.calls[n]!;
  return {
    url,
    init,
    headers: new Headers(init.headers as ConstructorParameters<typeof Headers>[0]),
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('generateClaude', () => {
  it('sends the system prompt with cache control and the input JSON last, to the fixed API', async () => {
    const fetcher = stubFetch(() => message(decision('9am to 5pm')));
    expect(await generateClaude(settings, KEY, prompt, signal())).toEqual({
      reply: '9am to 5pm',
      action: 'answer',
      handoffReason: null,
    });
    const { url, init, headers, body } = call(fetcher);
    expect(url).toBe(`${ANTHROPIC_API_URL}/messages`);
    expect(init.redirect).toBe('error');
    expect(headers.get('x-api-key')).toBe(KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(body.model).toBe(CLAUDE_DEFAULT_MODEL);
    expect(body.max_tokens).toBe(2000);
    expect(body.system).toEqual([
      { type: 'text', text: prompt.instructions, cache_control: { type: 'ephemeral' } },
    ]);
    const messages = body.messages as Array<{ role: string; content: Array<{ text?: string }> }>;
    expect(messages).toHaveLength(1);
    expect(messages.at(-1)!.role).toBe('user');
    expect(messages.at(-1)!.content.at(-1)!.text).toBe(prompt.input);
    expect(body.output_config).toMatchObject({
      format: { type: 'json_schema' },
      // Low effort keeps adaptive thinking inside the 2,000-token reply cap.
      effort: 'low',
    });
  });

  it('never sends OpenAI-only options, the install cache id or a key in the body', async () => {
    const fetcher = stubFetch(() => message(decision('Nice photo')));
    await generateClaude(
      settings,
      KEY,
      {
        ...prompt,
        cacheId: 'install-abc',
        images: [{ mime: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
      signal(),
    );
    const { body, init } = call(fetcher);
    const raw = String(init.body);
    for (const field of ['store', 'include', 'prompt_cache_key', 'instructions', 'detail'])
      expect(raw).not.toContain(`"${field}"`);
    expect(raw).not.toContain('install-abc');
    expect(raw).not.toContain(KEY);
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    expect(content[0]).toMatchObject({ type: 'text', text: prompt.input });
    expect(content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('sends PDFs the person sent as document blocks after the text and images', async () => {
    const fetcher = stubFetch(() => message(decision('Recorded INV-1042')));
    await generateClaude(
      settings,
      KEY,
      {
        ...prompt,
        images: [{ mime: 'image/png', base64: 'iVBORw0KGgo=' }],
        pdfs: [{ name: 'INV-1042.pdf', base64: 'JVBERi0xLjQ=', text: 'Invoice', pages: 1 }],
      },
      signal(),
    );
    const content = (
      call(fetcher).body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0]!.content;
    expect(content.map((part) => part.type)).toEqual(['text', 'image', 'document']);
    expect(content[2]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
    });
    // The file goes as a file: its text layer is not added as text.
    expect(String(call(fetcher).init.body)).not.toContain('Files the person sent');
  });

  it('uses the saved model, and the default for a model that is not a Claude model', async () => {
    const fetcher = stubFetch(() => message(decision('OK')));
    await generateClaude({ ...settings, model: 'claude-opus-5-5' }, KEY, prompt, signal());
    await generateClaude({ ...settings, model: 'gpt-4.1-mini' }, KEY, prompt, signal());
    expect(call(fetcher, 0).body.model).toBe('claude-opus-5-5');
    expect(call(fetcher, 1).body.model).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('ignores ANTHROPIC_BASE_URL from the environment', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://attacker.example/v1');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-env-key');
    const fetcher = stubFetch(() => message(decision('OK')));
    await generateClaude(settings, KEY, prompt, signal());
    expect(call(fetcher).url).toBe(`${ANTHROPIC_API_URL}/messages`);
    expect(call(fetcher).headers.get('x-api-key')).toBe(KEY);
  });

  it('runs read tools and then returns the decision', async () => {
    const fetcher = stubFetch(
      () => toolUse('search_business_context'),
      () => message(decision('We open at 9am')),
    );
    const execute = vi.fn(async () => 'Hours: 9am to 6pm');
    const result = await generateClaude(
      settings,
      KEY,
      {
        ...prompt,
        tools: {
          search_business_context: tool({
            description: 'Search the business context',
            inputSchema: z.object({ query: z.string() }),
            execute,
          }),
        },
      },
      signal(),
    );
    expect(result.reply).toBe('We open at 9am');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const second = call(fetcher, 1).body;
    expect(JSON.stringify(second.messages)).toContain('tool_result');
    // The cache breakpoint stays on the system prompt in every step.
    expect(second.system).toEqual([
      { type: 'text', text: prompt.instructions, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('asks once more after a malformed answer', async () => {
    const fetcher = stubFetch(
      () => message('Sure! We open at 9am.'),
      () => message(decision('We open at 9am')),
    );
    const timing = vi.fn();
    const result = await generateClaude(settings, KEY, { ...prompt, onTiming: timing }, signal());
    expect(result.reply).toBe('We open at 9am');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(timing).toHaveBeenCalledWith(expect.objectContaining({ retries: 1 }));
  });

  it('reports a second malformed answer as invalid', async () => {
    stubFetch(() => message('not json'));
    const error = await generateClaude(settings, KEY, prompt, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentTurnFailure);
    expect(error).toMatchObject({ kind: 'invalid', message: 'The AI returned an invalid answer.' });
  });

  it.each([
    [401, 'The Claude API key was rejected.'],
    [403, 'The Claude API key was rejected.'],
    [429, 'Claude usage limit reached. Check your account or try again later.'],
    [529, 'Claude is overloaded right now. Try again later.'],
    [500, 'Claude could not answer. Check your API settings.'],
  ] as const)('maps HTTP %i to a provider failure with a fixed message', async (status, text) => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'x', message: `upstream echo ${KEY} customer text` },
    });
    const cancel = vi.fn(async () => {});
    const fetcher = stubFetch(() => {
      const response = new Response(body, { status });
      vi.spyOn(response.body!, 'cancel').mockImplementation(cancel);
      return response;
    });
    const error = (await generateClaude(settings, KEY, prompt, signal()).catch(
      (e: unknown) => e,
    )) as AgentTurnFailure;
    expect(error).toBeInstanceOf(AgentTurnFailure);
    expect(error.kind).toBe('provider');
    expect(error.status).toBe(status);
    expect(error.message).toBe(text);
    expect(error.message).not.toContain(KEY);
    expect(cancel).toHaveBeenCalled();
    // A service error is never retried.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('maps a network failure to a provider failure without the error text', async () => {
    stubFetch(() => {
      throw new TypeError(`connect failed ${KEY}`);
    });
    const error = (await generateClaude(settings, KEY, prompt, signal()).catch(
      (e: unknown) => e,
    )) as AgentTurnFailure;
    expect(error).toMatchObject({ kind: 'provider', status: 503 });
    expect(error.message).toBe('Claude could not answer. Check your connection and API settings.');
  });

  it('reports a timeout as timeout', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
    );
    const fetcher = stubFetch(() => message(decision('late')));
    const error = await generateClaude(settings, KEY, prompt, signal()).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout', message: 'Claude answer timed out.' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('throws an AbortError when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = stubFetch(() => message(decision('x')));
    const error = await generateClaude(settings, KEY, prompt, controller.signal).catch(
      (e: unknown) => e,
    );
    expect((error as Error).name).toBe('AbortError');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('needs a key and calls nothing without one', async () => {
    const fetcher = stubFetch(() => message(decision('x')));
    await expect(generateClaude(settings, null, prompt, signal())).rejects.toThrow(
      'Add a Claude API key in Settings → AI.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('rewriteClaude and extractCustomerClaude', () => {
  it('rewrites with the resolved model id', async () => {
    const fetcher = stubFetch(() => message(JSON.stringify({ text: 'Formal text' })));
    expect(
      await rewriteClaude(
        { ...settings, model: 'claude-haiku-5-5' },
        KEY,
        { instructions: 'Rewrite', input: 'casual' },
        signal(),
      ),
    ).toEqual({ text: 'Formal text', model: 'claude-haiku-5-5' });
    expect(call(fetcher).body.system).toEqual([
      { type: 'text', text: 'Rewrite', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('extracts customer details in one call', async () => {
    const fetcher = stubFetch(() => message(JSON.stringify({ fields: [] })));
    const result = await extractCustomerClaude(
      settings,
      KEY,
      { instructions: 'Extract', input: '{}' },
      signal(),
    );
    expect(result).toEqual({ fields: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('claudeKeyModel', () => {
  it('uses an injected fetch and never reaches the global one', async () => {
    const global = stubFetch(() => message('x'));
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      message(JSON.stringify({ text: 'OK' })),
    );
    const model = claudeKeyModel({ apiKey: KEY, modelId: CLAUDE_DEFAULT_MODEL, fetch: send });
    const result = await runRewrite({
      model,
      prompt: { instructions: 'Rewrite', input: 'x' },
      signal: signal(),
    });
    expect(result).toEqual({ text: 'OK' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]!.redirect).toBe('error');
    expect(global).not.toHaveBeenCalled();
  });
});

describe('draftClaude', () => {
  const Schema = z.object({ completion: z.string().nullable(), grounded: z.boolean() });

  it('completes with the fast model even when a larger one is saved', async () => {
    const fetcher = stubFetch(() =>
      message(JSON.stringify({ completion: 'Lemak Ayam is RM12.', grounded: true })),
    );
    const result = await draftClaude(
      { ...settings, model: 'claude-opus-5-5' },
      KEY,
      { instructions: 'Draft', input: '{}' },
      { schema: Schema, fast: true, maxOutputTokens: 300 },
      signal(),
    );
    expect(result).toEqual({
      output: { completion: 'Lemak Ayam is RM12.', grounded: true },
      model: 'claude-haiku-5-5',
    });
    expect(call(fetcher).body.model).toBe('claude-haiku-5-5');
    expect(call(fetcher).body.max_tokens).toBe(300);
  });

  it('writes suggestions with the saved model', async () => {
    const fetcher = stubFetch(() => message(JSON.stringify({ completion: null, grounded: false })));
    await draftClaude(
      { ...settings, model: 'claude-opus-5-5' },
      KEY,
      { instructions: 'Draft', input: '{}' },
      { schema: Schema, fast: false, maxOutputTokens: 2000 },
      signal(),
    );
    expect(call(fetcher).body.model).toBe('claude-opus-5-5');
  });
});

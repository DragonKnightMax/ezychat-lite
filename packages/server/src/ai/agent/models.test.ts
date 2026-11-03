import { describe, expect, it } from 'vitest';
import { BackendError, collectResponse, parseSse } from '../chatgpt-backend.js';
import { AI_FULL_CONTEXT_CHARACTERS } from '../knowledge.js';
import { APICallError } from 'ai';
import {
  AgentTurnFailure,
  agentFailure,
  chatGptModel,
  codexRequestBody,
  openAiKeyModel,
} from './models.js';
import { chatTools } from './tools.js';
import { runAgentTurn } from './turn.js';

/** A ChatGPT event stream, as the backend sends it (items one by one, then completed). */
const stream = (items: object[]) =>
  new Response(
    [
      ...items.map((item) => ({ type: 'response.output_item.done', item })),
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          model: 'gpt-test',
          status: 'completed',
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
  ).body!;
const decisionMessage = (decision: object) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', annotations: [], text: JSON.stringify(decision) }],
});
const bigKnowledge = [
  { name: 'Delivery', text: 'Delivery costs RM15.' },
  { name: 'Catalogue', text: 'x'.repeat(AI_FULL_CONTEXT_CHARACTERS) },
];

describe('ChatGPT sign-in model (AI SDK)', () => {
  it('turns an SDK request into a streamed, store-less Codex request', () => {
    const body = codexRequestBody(
      {
        model: 'gpt-test',
        input: [
          { role: 'developer', content: 'Rules' },
          { role: 'user', content: 'Hi' },
        ],
        max_output_tokens: 2000,
        temperature: 0.2,
        metadata: { a: 1 },
        store: true,
      },
      'ezychat-key',
    );
    expect(body).toMatchObject({ stream: true, store: false, instructions: 'Rules' });
    expect(body.input).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('metadata');
    expect(body.prompt_cache_key).toBe('ezychat-key');
  });

  it('runs a tool call and a structured decision over the event stream', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const replies = [
      stream([
        // The model may reason before the tool call; with store:false that item must be resent in
        // full on the next step (a reference to its id is a 404 on the ChatGPT backend).
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-reasoning' },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'search_business_context',
          arguments: JSON.stringify({ query: 'delivery' }),
          status: 'completed',
        },
      ]),
      stream([
        decisionMessage({ reply: 'Delivery is RM15.', action: 'answer', handoffReason: null }),
      ]),
    ];
    const model = chatGptModel({
      modelId: 'gpt-test',
      cacheKey: 'ezychat-key',
      send: async (body) => {
        sent.push(body);
        return collectResponse(parseSse(replies.shift()!));
      },
    });
    const result = await runAgentTurn({
      model,
      prompt: { instructions: 'Answer from business facts.', input: '{"conversation":[]}' },
      tools: chatTools({ knowledge: bigKnowledge }),
      signal: new AbortController().signal,
    });
    expect(result.decision).toEqual({
      reply: 'Delivery is RM15.',
      action: 'answer',
      handoffReason: null,
    });
    expect(result.toolCalls).toEqual(['search_business_context']);
    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect(body).toMatchObject({ stream: true, store: false, prompt_cache_key: 'ezychat-key' });
      expect(body.instructions).toContain('Answer from business facts.');
      expect(body.include).toContain('reasoning.encrypted_content');
    }
    const second = JSON.stringify(sent[1]!.input);
    // The tool's result went back to the model, and the reasoning was resent, never referenced.
    expect(second).toContain('Delivery costs RM15.');
    expect(second).toContain('opaque-reasoning');
    expect(second).not.toContain('item_reference');
  });

  it("reports the client's fixed error message, never upstream text", async () => {
    const model = chatGptModel({
      modelId: 'gpt-test',
      send: async () => {
        throw new BackendError('ChatGPT usage limit reached. Try again later.', 429);
      },
    });
    const run = runAgentTurn({
      model,
      prompt: { instructions: 'x', input: 'y' },
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toThrow('ChatGPT usage limit reached. Try again later.');
  });
});

describe('agentFailure', () => {
  const apiError = (status: number) =>
    new APICallError({
      message: 'ChatGPT usage limit reached. Try again later.',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      requestBodyValues: {},
      statusCode: status,
    });
  const named = (name: string) =>
    Object.assign(new Error('upstream text with customer words'), { name });

  it.each([
    [
      'a service error',
      apiError(429),
      'provider',
      'ChatGPT usage limit reached. Try again later.',
      429,
    ],
    ['our schema check (empty reply)', named('ZodError'), 'invalid', 'invalid', null],
    ['a malformed decision', named('AI_NoObjectGeneratedError'), 'invalid', 'invalid', null],
    [
      'no decision at the step limit',
      named('AI_NoOutputGeneratedError'),
      'invalid',
      'invalid',
      null,
    ],
    ['anything else', named('TypeError'), 'other', 'generic', null],
  ])(
    'keeps the kind, class and status of %s, with a fixed message',
    (_label, error, kind, message, status) => {
      const failure = agentFailure(error, 'invalid', 'generic');
      expect(failure).toBeInstanceOf(AgentTurnFailure);
      expect(failure.kind).toBe(kind);
      expect(failure.message).toBe(message);
      expect(failure.status).toBe(status);
      expect(failure.causeName).toBe((error as Error).name);
      expect(failure.message).not.toContain('customer words');
    },
  );
});

describe('PDFs in the model request', () => {
  const pdfs = [
    {
      name: 'INV-1042.pdf',
      base64: 'JVBERi0xLjQ=',
      text: 'Invoice INV-1042 RM 1,250.00',
      pages: 2,
    },
    { name: 'scan.pdf', base64: 'JVBERi0xLjU=', text: null, pages: 1 },
  ];
  const prompt = { instructions: 'Record claims.', input: '{"conversation":[]}', pdfs };
  const done = { reply: 'Recorded INV-1042', action: 'answer', handoffReason: null };

  it('the ChatGPT sign-in backend gets the text layer, never the files', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const model = chatGptModel({
      modelId: 'gpt-test',
      send: async (body) => {
        sent.push(body);
        return collectResponse(parseSse(stream([decisionMessage(done)])));
      },
    });
    await runAgentTurn({ model, prompt, pdfInput: 'text', signal: new AbortController().signal });
    const input = JSON.stringify(sent[0]!.input);
    expect(input).not.toContain('input_file');
    expect(input).not.toContain('JVBERi0');
    expect(input).toContain('PDF INV-1042.pdf, 2 pages:\\nInvoice INV-1042 RM 1,250.00');
    expect(input).toContain('scanned PDF that could not be read');
  });

  it('the OpenAI API key mode gets each PDF as an input_file', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          model: 'gpt-test',
          status: 'completed',
          output: [decisionMessage(done)],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const model = openAiKeyModel({ apiKey: 'sk-test', modelId: 'gpt-test', fetch: fetcher });
    await runAgentTurn({ model, prompt, signal: new AbortController().signal });
    const content = (bodies[0]!.input as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    expect(content.map((part) => part.type)).toEqual(['input_text', 'input_file', 'input_file']);
    expect(content[1]).toMatchObject({
      filename: 'INV-1042.pdf',
      file_data: 'data:application/pdf;base64,JVBERi0xLjQ=',
    });
    expect(JSON.stringify(content)).not.toContain('Files the person sent');
  });
});

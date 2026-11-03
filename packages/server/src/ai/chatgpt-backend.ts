/**
 * EXPERIMENTAL (owner-approved spike): calls the non-public ChatGPT Codex backend directly with a
 * ChatGPT sign-in, as OpenClaw / pi-ai do. See docs/ai-chatgpt-protocol.md for the protocol and sources.
 * Never log request bodies, tokens or account ids.
 */
import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import { CHATGPT_FALLBACK_MODELS } from '@ezychat/shared';
import { CHATGPT_OAUTH } from './chatgpt-oauth.js';
import { userMessageContent, type AiPromptImage, type AiPromptPdf } from './provider-types.js';

export const CODEX_BACKEND = {
  responsesUrl: 'https://chatgpt.com/backend-api/codex/responses',
  modelsUrl: 'https://chatgpt.com/backend-api/codex/models',
  /** Model entries carry minimal_client_version; claim the Codex release the ids were seen in. */
  clientVersion: '0.160.0',
} as const;

export interface BackendAuth {
  accessToken: string;
  accountId: string;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    /** The reply was not the expected event stream (e.g. an HTML block page). */
    readonly unexpected = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function backendHeaders(auth: BackendAuth, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.accessToken}`,
    'chatgpt-account-id': auth.accountId,
    originator: CHATGPT_OAUTH.originator,
    'user-agent': `${CHATGPT_OAUTH.originator}/${CODEX_BACKEND.clientVersion} (${platform()} ${release()}; ${arch()}) EzyChat-Lite-experimental`,
    'OpenAI-Beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  if (sessionId) headers.session_id = sessionId;
  return headers;
}

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: string;
  /** Customer images, sent as `input_image` parts after the text part. */
  images?: AiPromptImage[];
  /** PDFs: this backend takes no files, so only their text layer is sent (see pdfTextLayer). */
  pdfs?: AiPromptPdf[];
  /**
   * Stable prompt_cache_key (also the session_id header, as pi-ai sends one value for both).
   * Omitted (e.g. the connection test): a random id per request, as before.
   */
  cacheKey?: string;
  /** JSON schema for a structured answer; omitted for plain text. */
  schema?: Record<string, unknown>;
}

export function responsesBody(request: ResponsesRequest, sessionId: string) {
  return {
    model: request.model,
    instructions: request.instructions,
    input: [
      {
        type: 'message',
        role: 'user',
        content: userMessageContent(request.input, request.images, request.pdfs),
      },
    ],
    store: false,
    stream: true,
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: 'low' },
    include: [],
    prompt_cache_key: sessionId,
    text: request.schema
      ? {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: 'business_reply',
            strict: true,
            schema: request.schema,
          },
        }
      : { verbosity: 'low' },
  };
}

type SseEvent = Record<string, unknown> & { type?: string };

/** Parses `data:` SSE frames (blank-line separated); skips `[DONE]` and malformed frames. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = function* (final: boolean) {
    buffer = buffer.replace(/\r\n/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index !== -1 || (final && buffer.trim())) {
      const chunk = index === -1 ? buffer : buffer.slice(0, index);
      buffer = index === -1 ? '' : buffer.slice(index + 2);
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (data && data !== '[DONE]') {
        try {
          const value: unknown = JSON.parse(data);
          if (value && typeof value === 'object') yield value as SseEvent;
        } catch {
          // Ignore malformed frames, as the reference client does.
        }
      }
      index = buffer.indexOf('\n\n');
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* frames(false);
    }
    buffer += decoder.decode();
    yield* frames(true);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function outputText(response: unknown): string {
  const output = (response as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return '';
  return output
    .filter((item: { type?: string }) => item?.type === 'message')
    .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
}

/** Aggregates a streamed Codex response into its final text. */
export async function aggregateSse(events: AsyncIterable<SseEvent>): Promise<string> {
  let deltas = '';
  let done: string | null = null;
  let seen = 0;
  for await (const event of events) {
    if (typeof event.type === 'string') seen++;
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') deltas += event.delta;
        break;
      case 'response.output_text.done':
        if (typeof event.text === 'string') done = (done ?? '') + event.text;
        break;
      case 'error':
        throw new BackendError(usageMessage(event.code) ?? 'ChatGPT could not answer.');
      case 'response.failed': {
        const error = (event.response as { error?: { code?: unknown } } | undefined)?.error;
        throw new BackendError(usageMessage(error?.code) ?? 'ChatGPT could not answer.');
      }
      case 'response.incomplete':
        throw new BackendError('ChatGPT did not complete its answer.');
      case 'response.completed':
      case 'response.done': {
        const status = (event.response as { status?: string } | undefined)?.status;
        if (status && status !== 'completed')
          throw new BackendError('ChatGPT did not complete its answer.');
        return done ?? (deltas || outputText(event.response));
      }
    }
  }
  // A single empty stream is a transient failure; only a non-event-stream reply marks us blocked.
  if (!seen) throw new BackendError('ChatGPT returned an empty answer. Try again.');
  throw new BackendError('ChatGPT ended its answer early.');
}

function usageMessage(code: unknown): string | null {
  return typeof code === 'string' &&
    /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code)
    ? 'ChatGPT usage limit reached. Try again later.'
    : null;
}

type FetchFn = typeof fetch;

export async function streamResponse(
  auth: BackendAuth,
  request: ResponsesRequest,
  signal: AbortSignal,
  fetchImpl: FetchFn = fetch,
): Promise<string> {
  const sessionId = request.cacheKey ?? randomUUID();
  const body = await openStream(
    auth,
    responsesBody(request, sessionId),
    sessionId,
    signal,
    fetchImpl,
  );
  return aggregateSse(parseSse(body));
}

/**
 * Sends a Responses request body to the ChatGPT backend and returns its event stream. Every failure
 * becomes a BackendError with a fixed message; the upstream body is never returned or logged.
 */
export async function openStream(
  auth: BackendAuth,
  requestBody: Record<string, unknown>,
  sessionId: string,
  signal: AbortSignal,
  fetchImpl: FetchFn = fetch,
): Promise<ReadableStream<Uint8Array>> {
  let response: Response;
  try {
    response = await fetchImpl(CODEX_BACKEND.responsesUrl, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: backendHeaders(auth, sessionId),
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new BackendError('Cannot reach ChatGPT. Check the internet connection.');
  }
  if (!response.ok) {
    // Read only a bounded error code; the body is never logged or returned.
    let code: unknown;
    try {
      const json = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
      code = json.error?.code ?? json.error?.type;
    } catch {
      // ignore
    }
    throw new BackendError(
      response.status === 401
        ? 'ChatGPT sign-in expired. Sign in again.'
        : response.status === 429 || usageMessage(code)
          ? 'ChatGPT usage limit reached. Try again later.'
          : response.status === 403 || response.status === 404
            ? 'ChatGPT refused the connection.'
            : response.status === 400
              ? 'ChatGPT rejected the request. Choose another model or Auto.'
              : 'ChatGPT could not answer. Try again later.',
      response.status,
    );
  }
  const type = response.headers.get('content-type');
  if (type && !type.toLowerCase().includes('text/event-stream')) {
    await response.body?.cancel().catch(() => {});
    throw new BackendError('ChatGPT returned an unexpected response.', response.status, true);
  }
  if (!response.body) throw new BackendError('ChatGPT returned an empty answer.');
  return response.body;
}

/**
 * Reads a streamed response to its final response object (for the AI SDK). The Codex stream
 * reports output items one by one; its final event may carry an empty `output`.
 */
export async function collectResponse(
  events: AsyncIterable<SseEvent>,
  model = '',
): Promise<Record<string, unknown>> {
  const items: unknown[] = [];
  let deltas = '';
  let seen = 0;
  for await (const event of events) {
    if (typeof event.type === 'string') seen++;
    switch (event.type) {
      case 'response.output_item.done':
        items.push(event.item);
        break;
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') deltas += event.delta;
        break;
      case 'error':
        throw new BackendError(usageMessage(event.code) ?? 'ChatGPT could not answer.');
      case 'response.failed': {
        const error = (event.response as { error?: { code?: unknown } } | undefined)?.error;
        throw new BackendError(usageMessage(error?.code) ?? 'ChatGPT could not answer.');
      }
      case 'response.incomplete':
        throw new BackendError('ChatGPT did not complete its answer.');
      case 'response.completed':
      case 'response.done': {
        const response = { ...((event.response as Record<string, unknown> | undefined) ?? {}) };
        if (typeof response.status === 'string' && response.status !== 'completed')
          throw new BackendError('ChatGPT did not complete its answer.');
        const output = Array.isArray(response.output) ? response.output : [];
        // Prefer the response's own items, then the streamed items, then the streamed text.
        response.output = output.length
          ? output
          : items.length
            ? items
            : deltas
              ? [
                  {
                    type: 'message',
                    id: 'msg_stream',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: deltas, annotations: [] }],
                  },
                ]
              : [];
        response.id ??= 'resp_stream';
        response.created_at ??= Math.floor(Date.now() / 1000);
        response.model ??= model;
        response.status ??= 'completed';
        return response;
      }
    }
  }
  if (!seen) throw new BackendError('ChatGPT returned an empty answer. Try again.');
  throw new BackendError('ChatGPT ended its answer early.');
}

export interface BackendModel {
  id: string;
  label: string;
  priority: number;
}

export function fallbackModels(): BackendModel[] {
  return CHATGPT_FALLBACK_MODELS.map((id, priority) => ({ id, label: id, priority }));
}

/** Codex's model catalog for the signed-in account (shape matches Codex's models_cache.json). */
export async function fetchModels(
  auth: BackendAuth,
  fetchImpl: FetchFn = fetch,
): Promise<BackendModel[]> {
  const url = new URL(CODEX_BACKEND.modelsUrl);
  url.searchParams.set('client_version', CODEX_BACKEND.clientVersion);
  const headers = backendHeaders(auth);
  headers.accept = 'application/json';
  delete headers['content-type'];
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BackendError('Cannot reach ChatGPT for the model list.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new BackendError('ChatGPT did not return a model list.', response.status);
  }
  const json = (await response.json().catch(() => null)) as { models?: unknown } | null;
  if (!Array.isArray(json?.models))
    throw new BackendError('ChatGPT returned an invalid model list.');
  const models = (json.models as Array<Record<string, unknown>>)
    .filter(
      (model) =>
        typeof model.slug === 'string' &&
        /^[a-z0-9][a-z0-9._-]{0,63}$/.test(model.slug) &&
        model.visibility === 'list' &&
        model.supported_in_api !== false,
    )
    .map((model) => ({
      id: model.slug as string,
      label:
        typeof model.display_name === 'string' && model.display_name.length <= 64
          ? model.display_name
          : (model.slug as string),
      priority: typeof model.priority === 'number' ? model.priority : 1000,
    }))
    .sort((a, b) => a.priority - b.priority);
  if (!models.length) throw new BackendError('ChatGPT returned an empty model list.');
  return models;
}

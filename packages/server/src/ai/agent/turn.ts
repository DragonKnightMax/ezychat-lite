import { generateText, Output, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { AI_MODEL_HANDOFF_REASONS, AiDecision, AiDecisionAction } from '@ezychat/shared';
import {
  AI_IMAGE_DETAIL,
  pdfTextLayer,
  type AgentTurnTiming,
  type AiPdfInput,
  type AiPrompt,
} from '../provider-types.js';
import { toWhatsAppText } from '../whatsapp-format.js';
import { isMalformedAnswer } from './models.js';

/** At most this many model calls per customer turn (tool calls + the final decision). */
export const AGENT_MAX_STEPS = 4;

/** The structured decision, strict-schema friendly (every field present; null when unused). */
const DecisionOutput = z.object({
  reply: z.string(),
  action: AiDecisionAction,
  handoffReason: z.enum(AI_MODEL_HANDOFF_REASONS).nullable(),
});

export interface AgentTurn {
  model: LanguageModel;
  prompt: Pick<AiPrompt, 'instructions' | 'input' | 'images' | 'pdfs'>;
  /**
   * How this provider mode takes the prompt's PDFs: `file` (default; OpenAI API key and Claude) or
   * `text` (the ChatGPT sign-in backend gets only their text layer).
   */
  pdfInput?: AiPdfInput;
  /** Read tools already bound to this chat by the server (see `agent/tools.ts`); none is fine. */
  tools?: ToolSet;
  signal: AbortSignal;
  /** Receives the turn's timing once it has a decision (never called for a failed turn). */
  onTiming?: (timing: AgentTurnTiming) => void;
}

export interface AgentTurnResult {
  decision: AiDecision;
  /** Tool names in call order, for the decision log (never their inputs or outputs). */
  toolCalls: string[];
  steps: number;
  /** 1 when the first answer was malformed and the turn was asked once more, else 0. */
  retries: number;
}

/**
 * One customer turn on the AI SDK agent loop: the model may call read tools, then must return the
 * decision. The server still decides what happens with it (model proposes, code decides).
 * A malformed or missing decision is asked for once more within the same time bound; a service
 * error (HTTP status), a timeout or an abort is never retried (it hands the chat to the team).
 */
export async function runAgentTurn(turn: AgentTurn): Promise<AgentTurnResult> {
  try {
    return await attemptTurn(turn, 0);
  } catch (error) {
    if (turn.signal.aborted || !isMalformedAnswer(error)) throw error;
    return attemptTurn(turn, 1);
  }
}

/**
 * The user message: the input JSON, then the images, then the PDFs as files (`file`) or as one
 * text part with their text layer (`text`). Without images and PDFs it is the input text alone.
 */
export function userContent(prompt: AgentTurn['prompt'], pdfInput: AiPdfInput) {
  return [
    { type: 'text' as const, text: prompt.input },
    ...(prompt.images ?? []).map((image) => ({
      type: 'image' as const,
      image: image.base64,
      mediaType: image.mime,
      providerOptions: { openai: { imageDetail: AI_IMAGE_DETAIL } },
    })),
    ...pdfParts(prompt.pdfs ?? [], pdfInput),
  ];
}

/** PDFs as file parts, or one text part with their text layer (none without text). */
function pdfParts(pdfs: NonNullable<AiPrompt['pdfs']>, pdfInput: AiPdfInput) {
  if (pdfInput === 'file') {
    return pdfs.map((pdf) => ({
      type: 'file' as const,
      data: pdf.base64,
      mediaType: 'application/pdf',
      filename: pdf.name,
    }));
  }
  const text = pdfTextLayer(pdfs);
  return text ? [{ type: 'text' as const, text }] : [];
}

async function attemptTurn(turn: AgentTurn, retries: number): Promise<AgentTurnResult> {
  turn.signal.throwIfAborted();
  const started = Date.now();
  let last = started;
  const stepMs: number[] = [];
  const result = await generateText({
    model: turn.model,
    instructions: turn.prompt.instructions,
    messages: [
      {
        role: 'user',
        content: userContent(turn.prompt, turn.pdfInput ?? 'file'),
      },
    ],
    tools: turn.tools ?? {},
    stopWhen: stepCountIs(AGENT_MAX_STEPS),
    output: Output.object({ schema: DecisionOutput }),
    abortSignal: turn.signal,
    // No transport retries: a failed call costs the business's usage and delays the reply; the
    // service hands the chat to the team instead (only a malformed answer is asked again, above).
    maxRetries: 0,
    maxOutputTokens: 2000,
    onStepFinish: () => {
      const now = Date.now();
      stepMs.push(now - last);
      last = now;
    },
  });
  turn.signal.throwIfAborted();
  // Replies go to WhatsApp: Markdown the model wrote anyway (e.g. **bold**) becomes WhatsApp format.
  const parsed = AiDecision.parse(result.output);
  const decision = { ...parsed, reply: toWhatsAppText(parsed.reply) };
  try {
    turn.onTiming?.({ ms: Date.now() - started, stepMs, steps: result.steps.length, retries });
  } catch {
    // Timing is only for the log; it never changes the reply.
  }
  return {
    decision,
    toolCalls: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    steps: result.steps.length,
    retries,
  };
}

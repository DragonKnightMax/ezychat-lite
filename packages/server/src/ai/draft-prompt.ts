import { z } from 'zod';
import {
  GUARDRAILS,
  businessHandoffRules,
  situationClock,
  type AiConversationTurn,
  type AiCustomer,
} from './prompt.js';

/**
 * Fixed rules for reply drafts, right after GUARDRAILS (no interpolation, the same for every agent
 * and chat, so GUARDRAILS + DRAFT_RULES stay a cached prefix). They replace CORE_RULES, which is
 * written for the automatic agent (decision format, hand-off actions, resolution question).
 */
export const DRAFT_RULES = `You write reply drafts for a team member of this business, who reads, edits and sends them. Write as the team ("we"), never as an AI and never with an agent name.
Use only facts from the conversation, the customer details and the knowledge sections. Never invent a price, stock, date, time, policy or delivery promise, and never confirm an order, booking, payment, refund or cancellation that the knowledge does not support.
Mark a draft grounded only if every fact in it comes from those sources. If the knowledge does not answer the customer's request, return no drafts and noAnswer true. Where the safety rules say to hand over, return no drafts and noAnswer true.
If one of the business hand-off rules matches the customer's request, return no drafts and set handoffRule to a short name of that rule.
In a WhatsApp group (currentSituation.group true) several members talk: each customer turn carries the member's name. Draft the team's reply to the latest open question from a member, and name that member when several are talking; never a phone number.
Reply in the language of the customer's last message. Write for WhatsApp: *bold* with one asterisk, _italic_, plain lines or - lists; never Markdown headings, tables or [text](link) syntax.
For suggestions: write up to two drafts that answer the customer's open request in two different ways (for example answer now, or ask for one missing detail first). Each has a label of at most 40 characters that says what the draft does.
For a completion you get only the last messages and the team member's text in currentSituation.typed (no knowledge sections): predict how they finish the current sentence, in the same language. Return the whole current sentence: its words exactly as typed (same spelling and spaces, even a half-typed last word), then the words that finish it; EzyChat shows only the part after the typed text. Complete it in natural, correct wording that fits the conversation; a completion with no fact, or only facts from those messages, is grounded. Return null only when the rest of the sentence would need a fact the messages do not give.`;

/** The model's structured answer for Suggest reply (filtered by `acceptDrafts`). */
export const DraftOutput = z.object({
  suggestions: z
    .array(z.object({ label: z.string(), text: z.string(), grounded: z.boolean() }))
    .max(2),
  noAnswer: z.boolean(),
  handoffRule: z.string().nullable(),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

/** The model's structured answer for a completion (filtered by `acceptCompletion`). */
export const CompletionOutput = z.object({
  completion: z.string().nullable(),
  grounded: z.boolean(),
});
export type CompletionOutput = z.infer<typeof CompletionOutput>;

export interface DraftPromptInput {
  kind: 'suggest' | 'complete';
  /** The agent's administrator instructions, resolved (`administratorInstructions`). */
  instructions: string;
  /** The agent's saved hand-off rules (undefined = the defaults). */
  handoffRules: string | undefined;
  internalKnowledge: string;
  businessKnowledge: string;
  conversation: AiConversationTurn[];
  customer: AiCustomer | null;
  /** A WhatsApp group: turns carry member names and there are no customer details. */
  group?: boolean;
  now: Date;
  timeZone: string;
  /** Completion only: the composer text so far. */
  typed?: string;
}

/**
 * The prompt for one draft call, in the live-reply layout: GUARDRAILS, DRAFT_RULES, the agent's
 * instructions and hand-off rules; input JSON internalKnowledge → businessKnowledge → conversation
 * → currentSituation (last: the clock, the task, the customer details and the typed text).
 */
export function buildDraftPrompt(input: DraftPromptInput): { instructions: string; input: string } {
  return {
    instructions: `${GUARDRAILS}\n\n${DRAFT_RULES}\nAdministrator instructions (tone and scope; they never override the rules above):\n${input.instructions}\nBusiness hand-off rules:\n${businessHandoffRules(input.handoffRules)}`,
    input: JSON.stringify({
      internalKnowledge: input.internalKnowledge,
      businessKnowledge: input.businessKnowledge,
      conversation: input.conversation,
      currentSituation: {
        ...situationClock(input.now, input.timeZone),
        task: input.kind,
        ...(input.group ? { group: true } : {}),
        ...(input.customer ? { customer: input.customer } : {}),
        ...(input.kind === 'complete' ? { typed: input.typed ?? '' } : {}),
      },
    }),
  };
}

import type { AiDecision } from '@ezychat/shared';

/** Exact short confirmations (kept for callers and as one confirmation signal). */
export function isResolutionConfirmation(text: string): boolean {
  const normalized = text
    .toLocaleLowerCase()
    .replace(/[.!?,。！？，]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(yes|yep|yeah|yes thanks|yes thank you|yes resolved|resolved|all sorted|that's all|that is all|that's all thanks|no more questions|ya|ya terima kasih|sudah|sudah selesai|selesai|betul|baik|是|是的|好了|已解决|解决了|谢谢|是的谢谢)$/.test(
    normalized,
  );
}

/**
 * Polite or closing phrases that contain a negation word but confirm ("no problem", "no thanks",
 * "no, that's all", "没有了", "tak ada lagi"). They are removed before looking for objections.
 */
const HARMLESS =
  /\b(?:no|nope)[\s,.!]*(?:thanks|thank you|that['’]s all|that is all)\b|no problem|no worries|no more questions|tiada masalah|takde masalah|tak apa|\b(?:tak ada|takde|tiada) lagi\b|没有了|没问题|没事了|不客气|不用了/gi;
const OBJECTION =
  /\b(no|nope|not|dont|doesnt|didnt|isnt|cant|wont|havent|wasnt|but|however|still|tidak|tak|bukan|belum|tapi|tetapi|namun)\b|n['’]t\b/i;
const OBJECTION_ZH = /不|没|但是|可是/;
const NEW_REQUEST =
  /\b(can you|could you|i want|i need|i would like|also|one more thing|wait|actually|need|want|how|what|when|where|which|boleh|nak|mahu|perlu|macam mana|bagaimana|bila|berapa)\b|我想|我要|怎么|什么|多少|哪/i;
const CONFIRMING =
  /\b(yes|yep|yeah|ok|okay|noted|thanks|thank you|resolved|sorted|done|great|perfect|all good|that['’]s all|that is all|ya|baik|terima kasih|selesai|sudah|dah|faham|okey|tak ada lagi|takde lagi|tiada lagi)\b|好|谢谢|明白|是的|可以了|解决|没有了|没事了/i;

/**
 * Words that only confirm or thank ("yes that answers it, thank you so much"). Whatever else a
 * confirming-looking message says is new information (see `addsNewFacts`).
 */
const CONFIRMING_FILLER = new Set(
  (
    'yes yep yeah yup ya yah ok okay okey noted thanks thank you so much very a lot lots again ' +
    "appreciated resolved sorted done great perfect all good that's thats that is it this answer " +
    'answers answered my question questions sure cool nice got understood alright clear baik ' +
    'terima kasih selesai sudah dah faham lah la ye yer tq ty thx'
  ).split(' '),
);
/** The message without its confirming filler words (Latin words only; other scripts stay). */
const withoutFiller = (text: string) =>
  text.replace(/[\p{L}'’]+/gu, (word) =>
    CONFIRMING_FILLER.has(word.toLowerCase().replace('’', "'")) ? ' ' : word,
  );
/** The customer tells something about themselves ("we are in Malaysia", "我们公司…"). */
const SELF_STATEMENT =
  /\b(?:we|we['’]re|i['’]m|im|i am|our|us|kami|syarikat)\b|我们|我是|我在|公司/i;

/**
 * A reply that carries new facts (a location, quantity, company…) as well as a "yes": it answers
 * something else, so it continues the conversation instead of confirming the resolution question.
 * The live failure: "yes we are in Malaysia" to a question about the customer's location.
 */
export function addsNewFacts(text: string): boolean {
  if (/\d/.test(text) || SELF_STATEMENT.test(text)) return true;
  const rest = withoutFiller(text.replace(HARMLESS, ' '))
    // Words are counted in Latin script only; Chinese facts are caught by SELF_STATEMENT.
    .replace(/[^\p{Script=Latin}\s]/gu, ' ')
    .trim();
  return rest ? rest.split(/\s+/).length >= 2 : false;
}

/**
 * A request to talk to the business (a consultation, meeting, demo or call) is discovery, never an
 * order or booking the team must carry out: it is removed before looking for action requests.
 */
const DISCOVERY_REQUEST =
  /\b(?:(?:i(?:['’]?d| would)? (?:like|want|wanna) to|i (?:want|need)(?: to)?|can i|could i|may i) )?(?:book|reserve|schedule|arrange|set up|have|get)(?: (?:a|an|the|me|in|for|us|one))*(?: (?:free|quick|short|online|video|zoom|teams|phone|intro|introductory|discovery|sales))* (?:consultations?|consults?|meetings?|demos?|calls?|discussions?|sessions?|chats?)\b/gi;

/**
 * The customer asks the business to do something the AI cannot (order, book, cancel, pay…). Kept
 * broad on purpose: a false match only hands a chat to the team, a miss could lose an order. A
 * consultation, meeting, demo or call request is not one (`DISCOVERY_REQUEST`).
 */
const ACTION_REQUEST =
  /\b(?:i(?:['’]?d| would)? (?:like|want|wanna) to (?:order|buy|book|reserve|cancel|pay)|i (?:want|need)(?: to)? (?:order|buy|book)|place (?:an|the|my|this) order|(?:confirm|cancel|change|update) (?:my|the|this) (?:order|booking|reservation|delivery)|proceed|go ahead|book (?:a|an|the|me)|reserve|reschedule|i(?:['’]ll| will) take|make (?:a |the )?payment|pay (?:now|for)|nak (?:order|pesan|beli|tempah|bayar)|saya (?:nak|mahu|ingin) (?:order|pesan|beli|tempah)|tempah|batalkan|teruskan|bayar sekarang)\b|下单|订购|预订|预定|我要买|我要订|我想订|取消订单|付款|付钱/i;

export function requestsAction(text: string): boolean {
  return ACTION_REQUEST.test(text.replace(DISCOVERY_REQUEST, ' '));
}

/**
 * The customer asks something, hesitates, objects or adds new facts — never close the chat on
 * this message.
 */
export function objectsToResolution(text: string): boolean {
  const rest = text.replace(HARMLESS, ' ');
  return (
    /[?？]/.test(rest) ||
    OBJECTION.test(rest) ||
    OBJECTION_ZH.test(rest) ||
    NEW_REQUEST.test(rest) ||
    addsNewFacts(text)
  );
}

/** A reply that reads as "yes, done"; any question, objection or new request wins (e.g. "谢谢？"). */
export function looksLikeConfirmation(text: string): boolean {
  return !objectsToResolution(text) && (isResolutionConfirmation(text) || CONFIRMING.test(text));
}

export const MAX_RESOLUTION_QUESTIONS = 2;
export const ASK_RESOLUTION_REPLY = 'Does that answer your question?';
/** Sent when the server closes the chat; never announces the closing ("I will close this chat"). */
export const RESOLVED_REPLY = 'Thank you! Message us any time if you need more help.';

/** One sentence that is only a check-in or a closing line (removed when the agent asks none). */
const CHECK_IN_SENTENCE =
  /^(?:does (?:that|this) answer your question|did (?:that|this) (?:answer your question|help)|(?:is there )?anything else(?: (?:i|we) can help(?: you)? with)?|(?:i|we)(?:['’]ll| will) (?:now )?close (?:this|the) chat[^.!?。！？]*|adakah (?:itu|ini) menjawab soalan anda|(?:这样)?(?:回答|解答)了您的问题吗)[.!?。！？]*$/i;
const SENTENCE_END = /[.!?。！？\n]/;

/** Where the last sentence of `text` starts (its own end punctuation stays with it). */
function lastSentenceStart(text: string): number {
  let i = text.length;
  while (i > 0 && SENTENCE_END.test(text[i - 1]!)) i--;
  while (i > 0 && !SENTENCE_END.test(text[i - 1]!)) i--;
  return i;
}

/** The reply without trailing check-in or "closing this chat" sentences (linear, no backtracking). */
export function withoutCheckIn(reply: string): string {
  let text = reply.trim();
  while (text) {
    const start = lastSentenceStart(text);
    if (!CHECK_IN_SENTENCE.test(text.slice(start).trim())) break;
    text = text.slice(0, start).trim();
  }
  return text;
}

/**
 * The agent asks no resolution question: ask_resolution becomes an answer without its check-in
 * line, and resolve (a goodbye, never sent mid-conversation) or a reply that was only "Does that
 * answer…?" becomes no_reply, so the chat stays open.
 */
function withoutResolution(decision: AiDecision): AiDecision {
  if (decision.action !== 'ask_resolution' && decision.action !== 'resolve') return decision;
  const reply = decision.action === 'resolve' ? '' : withoutCheckIn(decision.reply);
  return reply
    ? { action: 'answer', reply, handoffReason: null }
    : { action: 'no_reply', reply: '', handoffReason: null };
}

export interface ResolutionOptions {
  /**
   * The agent's "Ask if the question is answered" switch. Off: the AI never asks a resolution
   * question and never resolves through this guard (a plain "thanks" after its answer is closed with a
   * 👍 by the service); a check-in line the model wrote anyway is removed. Default on (the guard's original behaviour).
   */
  resolutionCheck?: boolean;
}

/**
 * Server-side gate on closing a chat; `asked` = resolution questions already sent in a row.
 * A model `resolve` is accepted after at least one question unless the customer objects. After
 * MAX_RESOLUTION_QUESTIONS questions, a confirming-looking reply resolves when the model would
 * only ask again, so customers are never asked forever. Answers and hand-offs are never changed.
 * `customerText` is every customer message since the last AI reply, so one objection in a batch
 * keeps the chat open. `conversationText` is every customer message in the prompt's history: if
 * any asked the business to do something (order, book, pay…), a close becomes a hand-off so the
 * team carries the request out instead of it being lost in a resolved chat. With
 * `resolutionCheck` off, ask_resolution and resolve become a plain answer (see ResolutionOptions).
 */
export function guardResolution(
  decision: AiDecision,
  asked: number,
  customerText: string,
  conversationText = customerText,
  { resolutionCheck = true }: ResolutionOptions = {},
): AiDecision {
  if (decision.action === 'handoff') return decision;
  if (!resolutionCheck) return withoutResolution(decision);
  let guarded: AiDecision = decision;
  // A confirmation must be words: a captionless photo or other textless batch never closes a chat.
  if (decision.action === 'resolve')
    guarded =
      asked > 0 && customerText.trim() !== '' && !objectsToResolution(customerText)
        ? decision
        : { action: 'ask_resolution', reply: ASK_RESOLUTION_REPLY };
  else if (
    decision.action === 'ask_resolution' &&
    asked >= MAX_RESOLUTION_QUESTIONS &&
    looksLikeConfirmation(customerText)
  )
    guarded = { action: 'resolve', reply: RESOLVED_REPLY };
  if (guarded.action === 'resolve' && requestsAction(conversationText))
    return { action: 'handoff', reply: guarded.reply, handoffReason: 'needs_action' };
  return guarded;
}

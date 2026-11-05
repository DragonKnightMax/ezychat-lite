import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';
import { HttpError, errors, parse } from '../../../../packages/server/src/http/errors.js';
import { parseChatKey } from '../../../../packages/server/src/inboxes/keys.js';
import type { PhraseStore } from './phrase-dictionary.js';

/** A suggestion chip: a short label and the full draft that fills the composer. */
export interface MockSuggestion {
  label: string;
  text: string;
}

/** What `POST /api/mock/suggestions` answers (the app's future `POST /api/chats/:jid/ai/suggestions`). */
export interface MockSuggestionsResult {
  suggestions: MockSuggestion[];
  /** The business context has no answer for the customer's question. */
  noAnswer: boolean;
  /** A business hand-off rule matches: no draft, a note instead. */
  handoffRule: string | null;
}

/** Mock-only AI behaviour, to show every state without a model. */
type MockMode = 'normal' | 'slow' | 'error' | 'expired';
/** New install (switch on by default) or an install updated from an older version (off). */
type MockInstall = 'new' | 'upgraded';

/**
 * Canned results per demo chat (WhatsApp JID). Every fact in a draft comes from the seeded
 * business context ("Menu and opening hours") or the chat itself, as the design requires.
 */
const SUGGESTIONS: Record<string, MockSuggestionsResult> = {
  // Farah: catering for 30 this Saturday (no catering facts in the context: no promise).
  '60123110021@s.whatsapp.net': {
    suggestions: [
      {
        label: 'Ask time and delivery or pickup',
        text: 'Hi Farah! Thank you for thinking of us. What time on Saturday do you need the food, and is it for delivery or pickup? Then our team can confirm the booking for 30 people.',
      },
      {
        label: 'Share the menu prices',
        text: 'Hi Farah! Our Nasi Lemak Ayam is RM12 per person, Kopi O RM3.50 and Teh Tarik RM4. A team member will confirm the Saturday booking for 30 people with you.',
      },
    ],
    noAnswer: false,
    handoffRule: null,
  },
  // Ahmad: open on Hari Raya? The context only has the daily hours.
  '60125550142@s.whatsapp.net': { suggestions: [], noAnswer: true, handoffRule: null },
  // Tan Wei Jie (Chinese): delivery to Gurney Drive.
  '60127020388@s.whatsapp.net': {
    suggestions: [
      {
        label: '说明送货范围，请问地址',
        text: '你好！我们送货到乔治市 5 公里以内，订单满 RM40 免运费。请问您的详细地址是？我们帮您确认。',
      },
      {
        label: '说明范围并介绍菜单',
        text: '你好！我们送货到乔治市 5 公里以内，满 RM40 免运费。Kopi O RM3.50，Teh Tarik RM4，Nasi Lemak Ayam RM12。请问您想点什么？',
      },
    ],
    noAnswer: false,
    handoffRule: null,
  },
  // Priya: order #1042 has not arrived (an order problem: the hand-off rule matches).
  '60128814455@s.whatsapp.net': {
    suggestions: [],
    noAnswer: false,
    handoffRule: 'Order problems and complaints',
  },
  // Jason: large Kopi Peng (not in the context): only one grounded suggestion.
  '60129001234@s.whatsapp.net': {
    suggestions: [
      {
        label: 'No Kopi Peng price; offer Kopi O',
        text: 'Hi Jason! I do not have the Kopi Peng price with me yet. Our Kopi O is RM3.50 and Teh Tarik is RM4. Let me check the Kopi Peng price for you.',
      },
    ],
    noAnswer: false,
    handoffRule: null,
  },
  // Nurul: two Nasi Lemak for pickup at 1pm.
  '60126677889@s.whatsapp.net': {
    suggestions: [
      {
        label: 'Confirm price, ask the name',
        text: 'Hi Nurul! Two Nasi Lemak Ayam at RM12 each for pickup at 1pm. May I have your name for the order?',
      },
      {
        label: 'Offer a drink with it',
        text: 'Hi Nurul! Noted: two Nasi Lemak Ayam (RM12 each) for pickup at 1pm. Would you like a Kopi O (RM3.50) or Teh Tarik (RM4) with it?',
      },
    ],
    noAnswer: false,
    handoffRule: null,
  },
  // Siti (Malay, added by this proposal's seed): delivery to Bayan Lepas.
  '60131234567@s.whatsapp.net': {
    suggestions: [
      {
        label: 'Terangkan kawasan hantar',
        text: 'Hai Siti! Kami hantar dalam 5 km dari Georgetown, dan percuma untuk pesanan melebihi RM40. Boleh kongsi alamat penuh? Kami semak untuk anda.',
      },
      {
        label: 'Cadang ambil sendiri',
        text: 'Hai Siti! Kawasan hantar kami dalam 5 km dari Georgetown. Kalau di luar kawasan, anda boleh ambil sendiri di kedai kami, dibuka setiap hari 8am–10pm.',
      },
    ],
    noAnswer: false,
    handoffRule: null,
  },
};

/** Extra sentences per chat that only the completion uses (beside the suggestion drafts). */
const COMPLETIONS: Record<string, string[]> = {
  '60123110021@s.whatsapp.net': [
    'We can share the full menu, and a team member will confirm the deposit for the booking.',
  ],
  '60125550142@s.whatsapp.net': [
    'We open daily from 8am to 10pm, and I will check the Hari Raya hours for you.',
  ],
  '60129001234@s.whatsapp.net': ['Kopi O is RM3.50 and Teh Tarik is RM4.'],
  '60128814455@s.whatsapp.net': [
    'Sorry for the wait, I am checking order #1042 with our team now.',
  ],
};

const SettingBody = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['normal', 'slow', 'error', 'expired']).optional(),
  install: z.enum(['new', 'upgraded']).optional(),
});
const SuggestBody = z.object({ chatJid: z.string().min(1) });
const CompleteBody = z.object({ chatJid: z.string().min(1), text: z.string().max(4096) });

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}#.]+/gu) ?? [];

/**
 * The rest of the current sentence when the last typed words (at least one full word) appear in
 * one of the chat's known sentences; otherwise null ("show nothing rather than guess").
 */
function complete(chatJid: string, text: string): string | null {
  if (!/[\p{L}\p{N}][\s,.!?]$/u.test(text) || text.trim().startsWith('/')) return null;
  const typed = words(text);
  if (typed.length === 0) return null;
  const sentences = [
    ...(SUGGESTIONS[chatJid]?.suggestions.map((s) => s.text) ?? []),
    ...(COMPLETIONS[chatJid] ?? []),
  ].flatMap((draft) => draft.split(/(?<=[.!?？。])\s*/u));
  for (const take of [3, 2, 1]) {
    if (typed.length < take) continue;
    const tail = typed.slice(-take);
    for (const sentence of sentences) {
      const tokens = [...sentence.matchAll(/[\p{L}\p{N}#.]+/gu)];
      for (let i = 0; i + take <= tokens.length; i++) {
        if (!tail.every((word, j) => tokens[i + j]![0].toLowerCase() === word)) continue;
        const last = tokens[i + take - 1]!;
        const rest = sentence.slice(last.index! + last[0].length).replace(/^\s+/, '');
        // The typed text already ends with a space or punctuation: continue straight after it.
        if (rest.trim().length > 1) return rest.slice(0, 120);
      }
    }
  }
  return null;
}

const unavailable = (msg: string) => new HttpError(503, 'ai_unavailable', msg);

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

/**
 * Proposed (ai-reply-suggestions): stand-ins for the routes the app will add
 * (`POST /api/chats/:jid/ai/suggestions`, `POST /api/chats/:jid/ai/complete`, the admin switch).
 * Deterministic canned drafts per demo chat; no model is called. `mode` and `install` are mock-only
 * controls in Settings → AI to show the slow, error, expired-connection and upgraded-install states.
 */
export function registerReplySuggestions(
  app: FastifyInstance,
  ctx: AppContext,
  phrases?: PhraseStore,
): void {
  let install: MockInstall = 'new';
  let enabled = true;
  let mode: MockMode = 'normal';
  const connected = () => ctx.services.ai?.status().connection.state === 'connected';
  const state = () => ({
    enabled,
    mode,
    install,
    connected: connected(),
    // What the composer reads: hidden (off / no connection), disabled (expired) or on.
    composer: !enabled || !connected() ? 'off' : mode === 'expired' ? 'unavailable' : 'on',
  });
  const waJidOf = (chatJid: string) => parseChatKey(chatJid).waJid;
  const guard = () => {
    const current = state();
    if (current.composer === 'off') throw errors.conflict('Reply suggestions are off');
    if (current.composer === 'unavailable')
      throw unavailable('AI suggestions are not available now');
  };
  const abortOnClose = (raw: { once(event: 'close', cb: () => void): unknown }) => {
    const cancel = new AbortController();
    raw.once('close', () => cancel.abort());
    return cancel.signal;
  };

  app.get('/api/mock/reply-suggestions', { preHandler: requireUser(ctx) }, async () => state());

  app.put('/api/mock/reply-suggestions', { preHandler: requireAdmin(ctx) }, async (req) => {
    const body = parse(SettingBody, req.body ?? {});
    if (body.install && body.install !== install) {
      install = body.install;
      // A new install starts on; an install updated from an older version starts off.
      enabled = install === 'new';
    }
    if (body.enabled !== undefined) enabled = body.enabled;
    if (body.mode) mode = body.mode;
    return state();
  });

  app.post('/api/mock/suggestions', { preHandler: requireUser(ctx) }, async (req) => {
    const { chatJid } = parse(SuggestBody, req.body ?? {});
    guard();
    await delay(mode === 'slow' ? 4_000 : 900, abortOnClose(req.raw));
    if (mode === 'error') throw unavailable('The AI provider did not answer');
    return (SUGGESTIONS[waJidOf(chatJid)] ?? {
      suggestions: [],
      noAnswer: true,
      handoffRule: null,
    }) satisfies MockSuggestionsResult;
  });

  app.post('/api/mock/complete', { preHandler: requireUser(ctx) }, async (req) => {
    const { chatJid, text } = parse(CompleteBody, req.body ?? {});
    guard();
    // Proposed (ai-phrase-dictionary): the team's phrase list answers at once, without a model.
    const phrase = phrases?.complete(text);
    if (phrase) return { completion: phrase.rest, phraseId: phrase.id, source: 'phrase' };
    // The fast model (~1.5 s, as measured on gpt-6-luna); "Same as the AI agent" is slower.
    const slowModel =
      phrases &&
      phrases.suggestModel() !== 'gpt-6-luna' &&
      /sol|astra|opus|sonnet|5\.5/.test(phrases.suggestModel());
    await delay(mode === 'slow' || slowModel ? 2_500 : 1_200, abortOnClose(req.raw));
    if (mode === 'error') return { completion: null };
    return { completion: complete(waJidOf(chatJid), text), source: 'model' };
  });
}

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';
import { errors, parse } from '../../../../packages/server/src/http/errors.js';
import { CHATGPT_FALLBACK_MODELS, CLAUDE_MODELS } from '../../../../packages/shared/src/ai.js';

/** Where a phrase came from: the AI (from the business context or the team's replies) or an admin. */
export type PhraseSource = 'context' | 'team' | 'admin';
export type PhraseLanguage = 'en' | 'ms' | 'zh';

export interface MockPhrase {
  id: number;
  text: string;
  language: PhraseLanguage;
  source: PhraseSource;
  /** Times a teammate accepted it with Tab or Accept. */
  uses: number;
  /** Has a fact (price, hours) that is checked against the business context. */
  fact: boolean;
}

/** Which model answers Suggest reply and the grey text. */
export type SuggestModel = 'fast' | 'agent' | string;

/**
 * Demo phrases for the seeded Kopi shop (business context "Menu and opening hours" and the team's
 * replies in the demo chats). Each language is written natively, not translated.
 */
const SEED: Omit<MockPhrase, 'id'>[] = [
  {
    text: 'Thank you for your message! We will get back to you shortly.',
    language: 'en',
    source: 'team',
    uses: 41,
    fact: false,
  },
  {
    text: 'Do you have any other questions?',
    language: 'en',
    source: 'team',
    uses: 33,
    fact: false,
  },
  {
    text: 'Our opening hours are 8am to 10pm daily.',
    language: 'en',
    source: 'context',
    uses: 18,
    fact: true,
  },
  {
    text: 'Nasi Lemak Ayam is RM12, Kopi O is RM3.50 and Teh Tarik is RM4.',
    language: 'en',
    source: 'context',
    uses: 12,
    fact: true,
  },
  {
    text: 'We deliver within 5 km of Georgetown, free for orders above RM40.',
    language: 'en',
    source: 'context',
    uses: 9,
    fact: true,
  },
  {
    text: 'May I have your name and phone number for the order?',
    language: 'en',
    source: 'team',
    uses: 15,
    fact: false,
  },
  {
    text: 'Sorry for the wait, let me check with our team.',
    language: 'en',
    source: 'team',
    uses: 7,
    fact: false,
  },
  { text: 'Is it for delivery or pickup?', language: 'en', source: 'team', uses: 11, fact: false },
  {
    text: 'Terima kasih atas mesej anda! Kami akan balas secepat mungkin.',
    language: 'ms',
    source: 'team',
    uses: 22,
    fact: false,
  },
  {
    text: 'Ada apa-apa lagi yang boleh kami bantu?',
    language: 'ms',
    source: 'team',
    uses: 14,
    fact: false,
  },
  {
    text: 'Kami buka setiap hari dari 8 pagi hingga 10 malam.',
    language: 'ms',
    source: 'context',
    uses: 6,
    fact: true,
  },
  {
    text: 'Boleh kongsi alamat penuh? Kami semak kawasan hantar untuk anda.',
    language: 'ms',
    source: 'team',
    uses: 5,
    fact: false,
  },
  {
    text: '谢谢您的留言！我们会尽快回复您。',
    language: 'zh',
    source: 'team',
    uses: 9,
    fact: false,
  },
  {
    text: '我们每天早上8点到晚上10点营业。',
    language: 'zh',
    source: 'context',
    uses: 4,
    fact: true,
  },
  {
    text: '请问您的详细地址是？我们帮您确认送货范围。',
    language: 'zh',
    source: 'team',
    uses: 3,
    fact: false,
  },
  {
    text: 'Please send us the photo of the receipt so we can check it.',
    language: 'en',
    source: 'admin',
    uses: 2,
    fact: false,
  },
];

/** Models the "Model for suggestions" list offers, per connection mode (the app: the live model list). */
const MODELS: Record<'chatgpt' | 'api' | 'claude', { fast: string; list: readonly string[] }> = {
  chatgpt: { fast: 'gpt-6-luna', list: CHATGPT_FALLBACK_MODELS },
  api: { fast: 'gpt-4.1-mini', list: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5'] },
  claude: { fast: 'claude-haiku-5-5', list: CLAUDE_MODELS },
};

// Each Chinese character counts as one word (Han first: it is also \p{L}).
const words = (text: string) => text.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{N}#.]+/gu) ?? [];

const PhraseBody = z.object({
  text: z.string().trim().min(3).max(200),
  language: z.enum(['en', 'ms', 'zh']),
});
const ModelBody = z.object({ model: z.string().min(1).max(64) });
const StateBody = z.object({ state: z.enum(['ready', 'empty', 'building', 'error']) });

export interface PhraseStore {
  /** The rest of a phrase that continues the typed text instantly (no model), with its id. */
  complete(text: string): { id: number; rest: string } | null;
  suggestModel(): string;
}

/**
 * Proposed (ai-phrase-dictionary): stand-ins for the phrase dictionary and the model setting.
 * In-memory demo phrases; Rebuild simulates a 2 s AI build. No model is called.
 */
export function registerPhraseDictionary(app: FastifyInstance, ctx: AppContext): PhraseStore {
  let nextId = 1;
  let phrases: MockPhrase[] = SEED.map((p) => ({ ...p, id: nextId++ }));
  let state: 'ready' | 'empty' | 'building' | 'error' = 'ready';
  let updatedAt = Date.now() - 12 * 60_000;
  let trigger: 'start' | 'context' | 'replies' | 'manual' | 'weekly' = 'replies';
  let newReplies = 18;
  let model: SuggestModel = 'fast';
  const mode = () => {
    const m = ctx.services.ai?.status().settings.mode;
    return m === 'api' || m === 'claude' ? m : 'chatgpt';
  };
  const agentModel = () => ctx.services.ai?.status().settings.model || MODELS[mode()].list[0]!;
  const resolved = () =>
    model === 'fast' ? MODELS[mode()].fast : model === 'agent' ? agentModel() : model;
  const status = () => {
    const shown = state === 'empty' || state === 'building' ? [] : phrases;
    const languages = (['en', 'ms', 'zh'] as const)
      .map((language) => ({ language, count: shown.filter((p) => p.language === language).length }))
      .filter((l) => l.count > 0);
    return {
      state,
      count: shown.length,
      languages,
      updatedAt: state === 'empty' ? null : updatedAt,
      trigger,
      newReplies,
      nextAfterReplies: 30,
      aiCallsToday: 4,
      aiCallsLimit: 24,
    };
  };

  app.get('/api/mock/phrases', { preHandler: requireAdmin(ctx) }, async () => ({
    status: status(),
    phrases:
      state === 'empty' || state === 'building' ? [] : [...phrases].sort((a, b) => b.uses - a.uses),
  }));
  app.post('/api/mock/phrases/rebuild', { preHandler: requireAdmin(ctx) }, async () => {
    state = 'building';
    setTimeout(() => {
      if (state !== 'building') return;
      state = 'ready';
      updatedAt = Date.now();
      trigger = 'manual';
      newReplies = 0;
      if (!phrases.length) phrases = SEED.map((p) => ({ ...p, id: nextId++ }));
    }, 2_000);
    return status();
  });
  app.post('/api/mock/phrases', { preHandler: requireAdmin(ctx) }, async (req) => {
    const body = parse(PhraseBody, req.body ?? {});
    const phrase: MockPhrase = {
      ...body,
      id: nextId++,
      source: 'admin',
      uses: 0,
      fact: /\d/.test(body.text),
    };
    phrases.push(phrase);
    return phrase;
  });
  app.put('/api/mock/phrases/:id', { preHandler: requireAdmin(ctx) }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(PhraseBody, req.body ?? {});
    const phrase = phrases.find((p) => p.id === id);
    if (!phrase) throw errors.notFound('Phrase not found');
    Object.assign(phrase, body, { source: 'admin' as const });
    return phrase;
  });
  app.delete('/api/mock/phrases/:id', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    phrases = phrases.filter((p) => p.id !== id);
    return reply.status(204).send();
  });
  // Tab / Accept on a phrase moves it up (local count only; nothing leaves the install).
  app.post('/api/mock/phrases/:id/used', { preHandler: requireUser(ctx) }, async (req, reply) => {
    const phrase = phrases.find((p) => p.id === Number((req.params as { id: string }).id));
    if (phrase) phrase.uses++;
    return reply.status(204).send();
  });
  // Mock only: show the empty, building and error states.
  app.put('/api/mock/phrases/state', { preHandler: requireAdmin(ctx) }, async (req) => {
    state = parse(StateBody, req.body ?? {}).state;
    if (state === 'ready' && !phrases.length) phrases = SEED.map((p) => ({ ...p, id: nextId++ }));
    return status();
  });

  // Every teammate's composer loads the list once and matches it locally on each key (no model).
  app.get('/api/mock/phrase-list', { preHandler: requireUser(ctx) }, async () =>
    state === 'ready'
      ? [...phrases]
          .sort((a, b) => b.uses - a.uses)
          .map(({ id, text, language }) => ({ id, text, language }))
      : [],
  );

  app.get('/api/mock/suggest-model', { preHandler: requireUser(ctx) }, async () => ({
    model,
    mode: mode(),
    fastModel: MODELS[mode()].fast,
    agentModel: agentModel(),
    models: MODELS[mode()].list,
    resolved: resolved(),
  }));
  app.put('/api/mock/suggest-model', { preHandler: requireAdmin(ctx) }, async (req) => {
    const body = parse(ModelBody, req.body ?? {});
    if (
      body.model !== 'fast' &&
      body.model !== 'agent' &&
      !MODELS[mode()].list.includes(body.model)
    )
      throw errors.validation('Pick a model of this connection');
    model = body.model;
    return { model, resolved: resolved() };
  });

  return {
    suggestModel: resolved,
    complete(text) {
      if (state !== 'ready' || text.trim().startsWith('/')) return null;
      const typed = words(text);
      if (typed.length < 2) return null;
      // The last 2–4 typed words (or Han characters) must start a phrase, or appear in it.
      for (const take of [4, 3, 2]) {
        if (typed.length < take) continue;
        const tail = typed.slice(-take);
        for (const phrase of [...phrases].sort((a, b) => b.uses - a.uses)) {
          const lower = phrase.text.toLowerCase();
          const joined = phrase.language === 'zh' ? tail.join('') : tail.join(' ');
          const at = lower.indexOf(joined);
          if (at < 0) continue;
          const typedEnd = text.endsWith(' ') ? ' ' : '';
          const rest = phrase.text.slice(at + joined.length).replace(/^\s+/, typedEnd ? '' : ' ');
          // A half-typed last word: finish it from the phrase.
          if (rest.trim().length > 1) return { id: phrase.id, rest: rest.slice(0, 120) };
        }
      }
      return null;
    },
  };
}

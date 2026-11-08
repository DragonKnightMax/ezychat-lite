import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin, requireUser } from '../../../../packages/server/src/auth/guards.js';
import { HttpError, errors, parse } from '../../../../packages/server/src/http/errors.js';

/** One mistake in the typed text: replace `text.slice(start, end)` with `replacement`. */
export interface MockGrammarIssue {
  id: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  kind: 'spelling' | 'grammar';
}

/** What `POST /api/mock/grammar/check` answers (the app's future `POST /api/chats/:jid/ai/fix-grammar`). */
export type MockGrammarResult =
  | { status: 'checked'; issues: MockGrammarIssue[] }
  /** Malay, Chinese or mixed text: nothing is checked, nothing is shown. */
  | { status: 'skipped'; reason: 'not_english' | 'too_short' };

/** Mock-only AI behaviour, to show every state without a model. */
type MockMode = 'normal' | 'slow' | 'error' | 'expired';
type MockInstall = 'new' | 'upgraded';

interface Rule {
  /** Group 1 (if any) is the part replaced, else the whole match; the `d` flag gives its position. */
  re: RegExp;
  kind: MockGrammarIssue['kind'];
  fix(match: string): string;
}

/** Keep the first letter's case: "Pls" → "Please", "pls" → "please". */
const keepCase = (word: string) => (match: string) =>
  match[0] && match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
    ? word[0]!.toUpperCase() + word.slice(1)
    : word;

/**
 * Deterministic stand-in for the model: a fixed list of grammar slips seen in the team's replies.
 * Spelling is not here: the browser checks it at once against the dictionary (`src/mock/spelling.ts`).
 * The app asks the fast model for the same JSON (positions, original, fix), grammar only.
 */
const RULES: Rule[] = [
  { re: /\bi\b(?!')/dg, kind: 'grammar', fix: () => 'I' },
  {
    re: /\b(?:order|parcel|item|payment|invoice|booking) (have)\b/dgi,
    kind: 'grammar',
    fix: () => 'has',
  },
  {
    re: /\b(?:been|is|are|was|were) (ship|deliver|confirm|process|update|cancel|book)\b/dgi,
    kind: 'grammar',
    fix: (w) => ({ ship: 'shipped', cancel: 'cancelled' })[w.toLowerCase()] ?? `${w}ed`,
  },
  {
    re: /\b(?:check|update|confirm|send) (you) (?:email|order|inbox|phone|address|details)\b/dgi,
    kind: 'grammar',
    fix: () => 'your',
  },
  {
    re: /\b(a) (?:order|email|update|invoice|item|hour|appointment|address|extra)\b/dgi,
    kind: 'grammar',
    fix: keepCase('an'),
  },
  { re: /\binformations\b/dgi, kind: 'grammar', fix: keepCase('information') },
  {
    re: /\bwill (sent|delivered|reached)\b/dgi,
    kind: 'grammar',
    fix: (w) => ({ sent: 'send', delivered: 'deliver', reached: 'reach' })[w.toLowerCase()] ?? w,
  },
  { re: /\bfor your (patient)\b/dgi, kind: 'grammar', fix: () => 'patience' },
  // A new sentence starts with a capital letter.
  { re: /[.!?] ([a-z])/dg, kind: 'grammar', fix: (c) => c.toUpperCase() },
];

const MALAY = new Set(
  'saya awak boleh terima kasih tak nak sudah belum ada dengan untuk kami anda encik puan esok sini sana tunggu nanti'.split(
    ' ',
  ),
);

/** Malay or Chinese (or a mix with them) is not checked: the fixes are for English only. */
export function notEnglish(text: string): boolean {
  if (/[\p{Script=Han}\p{Script=Tamil}]/u.test(text)) return true;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.filter((w) => MALAY.has(w)).length >= 2;
}

export function checkText(text: string): MockGrammarResult {
  if ((text.match(/\p{L}+/gu) ?? []).length < 2) return { status: 'skipped', reason: 'too_short' };
  if (notEnglish(text)) return { status: 'skipped', reason: 'not_english' };
  const found: MockGrammarIssue[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const part = m[1] ?? m[0];
      const [start, end] = m.indices?.[1] ?? [m.index, m.index + m[0].length];
      let replacement = rule.fix(part);
      // A word that starts a sentence keeps its capital: "pls" there becomes "Please".
      if (start === 0 || /[.!?]\s+$/.test(text.slice(0, start)))
        replacement = replacement.charAt(0).toUpperCase() + replacement.slice(1);
      // Never change numbers, prices, order ids or links.
      if (replacement === part || /\d/.test(part + replacement)) continue;
      if (/https?:\/\/\S*$/.test(text.slice(0, start))) continue;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      found.push({
        id: `${start}:${part}`,
        start,
        end,
        original: part,
        replacement,
        kind: rule.kind,
      });
    }
  }
  return { status: 'checked', issues: found.sort((a, b) => a.start - b.start) };
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

/**
 * Proposed (grammar-fix): stand-ins for the routes the app will add (`POST /api/chats/:jid/ai/fix-english`
 * and the admin switch in Settings → AI). No model is called; `mode` and `install` are mock-only
 * controls to show the slow, error and expired-connection states.
 */
export function registerGrammarFix(app: FastifyInstance, ctx: AppContext): void {
  let enabled = true;
  let install: MockInstall = 'new';
  let mode: MockMode = 'normal';
  const connected = () => ctx.services.ai?.status().connection.state === 'connected';
  // Spelling runs in the browser and needs no AI; grammar needs the AI connection.
  const state = () => ({
    enabled,
    mode,
    install,
    connected: connected(),
    spelling: enabled ? 'on' : 'off',
    grammar: !enabled ? 'off' : !connected() ? 'none' : mode === 'expired' ? 'unavailable' : 'on',
  });
  /** Team words: never underlined. Learned from Business context, or added by a teammate. */
  type Word = { word: string; source: 'business' | 'team'; addedBy: string | null; at: number };
  const words: Word[] = [
    ...['Kopi Apong', 'Kopi O', 'Teh Tarik', 'nasi lemak', 'Georgetown', 'Bayan Lepas'].map(
      (word): Word => ({ word, source: 'business', addedBy: null, at: Date.now() - 86_400_000 }),
    ),
    { word: 'kopitiam', source: 'team', addedBy: 'Mei Ling', at: Date.now() - 3_600_000 },
  ];
  const wordList = () => ({ words: [...words].sort((a, b) => a.word.localeCompare(b.word)) });

  app.get('/api/mock/grammar', { preHandler: requireUser(ctx) }, async () => state());

  app.put('/api/mock/grammar', { preHandler: requireAdmin(ctx) }, async (req) => {
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        mode: z.enum(['normal', 'slow', 'error', 'expired']).optional(),
        install: z.enum(['new', 'upgraded']).optional(),
      }),
      req.body,
    );
    if (body.enabled !== undefined) enabled = body.enabled;
    if (body.mode) mode = body.mode;
    if (body.install) {
      install = body.install;
      // An install updated from an older version starts with the switch off.
      enabled = install === 'new';
    }
    return state();
  });

  app.post('/api/mock/grammar/check', { preHandler: requireUser(ctx) }, async (req) => {
    const { text } = parse(z.object({ text: z.string().max(4_000) }), req.body);
    const current = state();
    if (current.grammar === 'off' || current.grammar === 'none')
      throw errors.conflict('Grammar check is off');
    if (current.grammar === 'unavailable')
      throw new HttpError(503, 'ai_unavailable', 'The AI connection needs attention');
    const cancel = new AbortController();
    req.raw.once('close', () => cancel.abort());
    // The fast model answers in about a second; "Slow" shows the checking state longer.
    await delay(mode === 'slow' ? 3_000 : 700, cancel.signal);
    if (mode === 'error')
      throw new HttpError(503, 'ai_unavailable', 'The AI provider did not answer');
    return checkText(text);
  });

  app.get('/api/mock/grammar/words', { preHandler: requireUser(ctx) }, async () => wordList());

  // Any teammate adds a word from the underline card; admins remove words in Settings → AI.
  app.post('/api/mock/grammar/words', { preHandler: requireUser(ctx) }, async (req) => {
    const { word } = parse(z.object({ word: z.string().trim().min(1).max(40) }), req.body);
    if (/\d|\s{2,}|https?:/i.test(word)) throw errors.validation('Words only, no numbers or links');
    if (words.length >= 500) throw errors.conflict('The team word list is full (500 words)');
    if (!words.some((w) => w.word.toLowerCase() === word.toLowerCase()))
      words.push({ word, source: 'team', addedBy: req.user?.displayName ?? null, at: Date.now() });
    return wordList();
  });

  app.delete('/api/mock/grammar/words/:word', { preHandler: requireAdmin(ctx) }, async (req) => {
    const { word } = parse(z.object({ word: z.string() }), req.params);
    const at = words.findIndex((w) => w.word.toLowerCase() === word.toLowerCase());
    if (at >= 0) words.splice(at, 1);
    return wordList();
  });
}

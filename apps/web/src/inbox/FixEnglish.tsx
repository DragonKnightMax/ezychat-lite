import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, BookPlus, CircleAlert, CircleCheck, Loader2, Sparkles, X } from 'lucide-react';
import { FIX_GRAMMAR_PAUSE_MS, type FixEnglishStatus } from '@ezychat/shared';
import { fetchGrammar } from '@/api/fix-english';
import { Button } from '@/components/ui/button';
import { loadSpeller } from '@/lib/dictionary';
import { findMisspelled, rankSuggestions, toIssue, type Speller } from '@/lib/spelling';
import { cn } from '@/lib/utils';

/**
 * Fix English in the composer (docs/features/grammar-fix/design.md, confirmed mock
 * docs/features/grammar-fix/mock): spelling marked at once from the dictionary in the browser,
 * grammar from the AI after a pause, a card per word, Fix all with Undo.
 */

/** One mark. `replacement` is what Fix all applies (null: choose in the card, or add the word). */
export interface FixIssue {
  id: string;
  kind: 'spelling' | 'grammar';
  start: number;
  end: number;
  original: string;
  /** Spelling: up to 3 suggestions (empty = not in the dictionary); grammar: its one fix. */
  suggestions: string[];
  replacement: string | null;
  /** Spelling suggestions are still being looked up. */
  pending?: boolean;
}

export type GrammarStatus = 'idle' | 'checking' | 'done' | 'skipped' | 'error';

/**
 * Keeps marks in place while the teammate types: a mark the edit touched goes, marks after it move
 * with the text. The next check brings back the real list.
 */
export function shiftIssues<T extends { start: number; end: number }>(
  issues: T[],
  before: string,
  after: string,
): T[] {
  if (before === after) return issues;
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const editEnd = before.length - tail;
  const delta = after.length - before.length;
  return issues.flatMap((issue) => {
    if (issue.end <= head) return [issue];
    if (issue.start >= editEnd)
      return [{ ...issue, start: issue.start + delta, end: issue.end + delta }];
    return [];
  });
}

/** Applies the marks that have a fix (they never overlap); a mark whose text changed is skipped. */
export function applyFixes(text: string, issues: readonly FixIssue[], pick?: string): string {
  let next = text;
  for (const issue of [...issues].sort((a, b) => b.start - a.start)) {
    const fix = pick ?? issue.replacement;
    if (fix == null || next.slice(issue.start, issue.end) !== issue.original) continue;
    next = next.slice(0, issue.start) + fix + next.slice(issue.end);
  }
  return next;
}

/**
 * What a fix adds when it only inserts text ("email" → "email." adds "."; "email" → "your email"
 * adds "your "), else ''.
 */
export function insertedText(original: string, replacement: string): string {
  if (replacement.length <= original.length) return '';
  let head = 0;
  while (head < original.length && original[head] === replacement[head]) head++;
  let tail = 0;
  while (
    tail < original.length - head &&
    original[original.length - 1 - tail] === replacement[replacement.length - 1 - tail]
  )
    tail++;
  return head + tail === original.length ? replacement.slice(head, replacement.length - tail) : '';
}

/** A fix applied in this draft: where its text now stands, and what it inserted. */
interface AppliedFix {
  start: number;
  end: number;
  inserted: string;
}

/**
 * The grammar marks of one answer: in order, never two on the same text (the first wins), and
 * never the same insertion again where this draft already got it ("email." + "." → "email..").
 */
export function grammarMarks(
  issues: readonly { start: number; end: number; original: string; replacement: string }[],
  applied: readonly AppliedFix[],
): FixIssue[] {
  const out: FixIssue[] = [];
  for (const i of [...issues].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out.at(-1);
    if (last && i.start < last.end) continue;
    const inserted = insertedText(i.original, i.replacement);
    if (
      inserted &&
      applied.some((f) => f.inserted === inserted && i.start <= f.end && i.end >= f.start)
    )
      continue;
    out.push({
      id: `g${i.start}:${i.end}:${i.original}`,
      kind: 'grammar',
      start: i.start,
      end: i.end,
      original: i.original,
      suggestions: [i.replacement],
      replacement: i.replacement,
    });
  }
  return out;
}

/** The speller, once Fix English is on and something was typed (null until it has loaded). */
function useSpeller(load: boolean): Speller | null {
  const [speller, setSpeller] = useState<Speller | null>(null);
  useEffect(() => {
    if (!load || speller) return;
    let live = true;
    loadSpeller()
      .then((s) => live && setSpeller(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [load, speller]);
  return speller;
}

/** Suggestions are slow (tens of ms a word): looked up one word per tick, cached for the page. */
const suggestionCache = new Map<string, string[]>();

export function useFixEnglish(
  text: string,
  {
    jid,
    status,
    chatName,
    teamWords,
    disabled,
  }: {
    jid: string | null;
    status: FixEnglishStatus | undefined;
    chatName: string;
    /** Team words and Business context words, lower case (`acceptedWords`). */
    teamWords: ReadonlySet<string>;
    disabled: boolean;
  },
) {
  const spellingOn = status?.spelling === 'on' && !disabled;
  const grammarOn = status?.grammar === 'on' && !disabled && !!jid;
  const speller = useSpeller(spellingOn && text.trim() !== '');
  const accepted = useMemo(() => {
    const set = new Set(teamWords);
    for (const w of chatName.toLowerCase().match(/\p{L}+/gu) ?? []) set.add(w);
    return set;
  }, [teamWords, chatName]);

  // Spelling: on every key, from the dictionary.
  const marks = useMemo(
    () => (spellingOn && speller ? findMisspelled(text, speller, accepted) : []),
    [spellingOn, speller, text, accepted],
  );
  const [, setLooked] = useState(0);
  useEffect(() => {
    if (!speller) return;
    const next = marks.find((m) => !m.shortForm && !suggestionCache.has(m.word.toLowerCase()));
    if (!next) return;
    const timer = setTimeout(() => {
      const lower = next.word.toLowerCase();
      suggestionCache.set(lower, rankSuggestions(lower, speller.suggest(lower), speller));
      setLooked((n) => n + 1);
    }, 0);
    return () => clearTimeout(timer);
  });

  // Grammar: after a pause, from the AI; marks move with the text until the next answer.
  const [grammar, setGrammar] = useState<FixIssue[]>([]);
  const [grammarStatus, setGrammarStatus] = useState<GrammarStatus>('idle');
  const previous = useRef(text);
  // Fixes applied in this draft, on the positions of `applied.current.text`.
  const applied = useRef<{ text: string; fixes: AppliedFix[] }>({ text, fixes: [] });
  useLayoutEffect(() => {
    // Read the old text now: the updater runs later, after `previous` already holds the new text.
    const before = previous.current;
    previous.current = text;
    setGrammar((current) => shiftIssues(current, before, text));
    const done = applied.current;
    if (done.text !== text)
      applied.current = {
        text,
        fixes: done.text === before && text.trim() ? shiftIssues(done.fixes, before, text) : [],
      };
  }, [text]);
  useEffect(() => {
    if (!grammarOn || !text.trim()) {
      setGrammar([]);
      setGrammarStatus('idle');
      return;
    }
    // Every change is checked again after the pause, also a return to text checked before (Undo):
    // its marks were dropped by the edit.
    const cancel = new AbortController();
    const timer = setTimeout(() => {
      setGrammarStatus('checking');
      fetchGrammar(jid!, text, cancel.signal)
        .then((result) => {
          // An answer counts only for the exact text it was asked for: its positions are that text's.
          if (cancel.signal.aborted || previous.current !== text) return;
          const done = applied.current.text === text ? applied.current.fixes : [];
          setGrammar(result.status === 'checked' ? grammarMarks(result.issues, done) : []);
          setGrammarStatus(result.status === 'checked' ? 'done' : 'skipped');
        })
        .catch(() => {
          if (!cancel.signal.aborted) setGrammarStatus('error');
        });
    }, FIX_GRAMMAR_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      cancel.abort();
    };
  }, [text, grammarOn, jid]);

  // "Ignore" hides that mark for the rest of this draft.
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!text.trim()) setIgnored(new Set());
  }, [text]);
  const keyOf = (i: { original: string; kind: string }) => `${i.kind}:${i.original}`;

  const issues = useMemo(() => {
    const spelling: FixIssue[] = marks.map((m) => {
      const cached = m.shortForm ? [] : suggestionCache.get(m.word.toLowerCase());
      const issue = toIssue(m, cached ?? []);
      return {
        id: `s${m.start}:${m.word}`,
        kind: 'spelling',
        ...issue,
        ...(cached === undefined ? { pending: true, replacement: null } : {}),
      };
    });
    const visible = spelling.filter((i) => !ignored.has(keyOf(i)));
    // A spelling mark wins over a grammar mark on the same word.
    for (const g of grammar)
      if (!ignored.has(keyOf(g)) && !visible.some((s) => g.start < s.end && g.end > s.start))
        visible.push(g);
    return visible.sort((a, b) => a.start - b.start);
    // `setLooked` re-renders this when a suggestion arrives (the cache is outside React).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, grammar, ignored, suggestionCache.size]);

  return {
    issues,
    fixable: issues.filter((i) => i.replacement != null),
    grammarStatus,
    /**
     * The text with these fixes applied (`pick` for a choice in the card), remembered for this
     * draft so a later check never offers the same insertion at the same place again.
     */
    apply(current: string, list: readonly FixIssue[], pick?: string): string {
      const next = applyFixes(current, list, pick);
      const done = applied.current.text === current ? applied.current.fixes : [];
      const fixes = shiftIssues(done, current, next);
      let offset = 0;
      for (const issue of [...list].sort((a, b) => a.start - b.start)) {
        const fix = pick ?? issue.replacement;
        if (fix == null || current.slice(issue.start, issue.end) !== issue.original) continue;
        const start = issue.start + offset;
        fixes.push({ start, end: start + fix.length, inserted: insertedText(issue.original, fix) });
        offset += fix.length - issue.original.length;
      }
      applied.current = { text: next, fixes };
      return next;
    },
    ignore(issue: FixIssue) {
      setIgnored((current) => new Set(current).add(keyOf(issue)));
    },
  };
}

/**
 * The underlines: a copy of the text behind the box's transparent glyphs, like the grey completion.
 * `text-transparent`, not `invisible` (that would hide the underline). One-letter marks also get a
 * light tint, so "i" or "a" is easy to see.
 */
export const FixEnglishMarks = forwardRef<
  HTMLDivElement,
  { text: string; issues: readonly FixIssue[]; activeId: string | null }
>(function FixEnglishMarks({ text, issues, activeId }, ref) {
  if (!issues.length) return null;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const issue of issues) {
    if (issue.start < at || text.slice(issue.start, issue.end) !== issue.original) continue;
    parts.push(text.slice(at, issue.start));
    const spelling = issue.kind === 'spelling';
    parts.push(
      <span
        key={issue.id}
        data-issue={issue.id}
        className={cn(
          'rounded-sm underline decoration-wavy decoration-2 underline-offset-4 [text-decoration-skip-ink:none]',
          spelling ? 'bg-destructive/8 decoration-destructive' : 'bg-info/8 decoration-info',
          issue.id === activeId && (spelling ? 'bg-destructive/20' : 'bg-info/20'),
        )}
      >
        {issue.original || '​'}
      </span>,
    );
    at = issue.end;
  }
  parts.push(text.slice(at));
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl border border-transparent px-3.5 py-2.5 text-base leading-6 break-words whitespace-pre-wrap text-transparent"
      data-testid="fix-english-marks"
    >
      {parts}
    </div>
  );
});

/**
 * The card over one marked word: the fix (or up to 3 spelling choices) as buttons and Ignore; a
 * word the dictionary does not know offers Add to team words instead.
 */
export function FixEnglishCard({
  issue,
  position,
  touch,
  onPick,
  onIgnore,
  onAddWord,
  onClose,
  onHover,
}: {
  issue: FixIssue;
  /** Viewport coordinates: the word's left edge, and the distance from the word's top to the bottom. */
  position: { left: number; bottom: number };
  touch: boolean;
  onPick(fix: string): void;
  onIgnore(): void;
  onAddWord(): void;
  onClose(): void;
  onHover(inside: boolean): void;
}) {
  const { t } = useTranslation('inbox');
  const unknown = issue.kind === 'spelling' && !issue.pending && issue.suggestions.length === 0;
  let heading = t('composer.fixEnglish.grammar');
  if (unknown) heading = t('composer.fixEnglish.unknown');
  else if (issue.kind === 'spelling') heading = t('composer.fixEnglish.spelling');
  const small = cn(touch && 'min-h-11');
  // A fixed card, moved left until it fits the screen (a word near the right edge of a phone).
  const cardRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(position.left);
  useLayoutEffect(() => {
    const width = cardRef.current?.offsetWidth ?? 0;
    const room = (typeof window === 'undefined' ? 0 : window.innerWidth) - width - 8;
    setLeft(Math.max(8, Math.min(position.left, room > 8 ? room : position.left)));
  }, [position.left]);
  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t('composer.fixEnglish.cardLabel', { word: issue.original })}
      className="fixed z-50 w-max max-w-[min(22rem,calc(100vw-1rem))] rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg"
      style={{ left, bottom: position.bottom }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      data-testid="fix-english-card"
    >
      <div className="flex items-center justify-between gap-3 px-1">
        <span
          className={cn(
            'text-xs font-medium',
            issue.kind === 'spelling' ? 'text-destructive' : 'text-info',
          )}
        >
          {heading}
        </span>
        {touch && (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground"
            aria-label={t('composer.fixEnglish.close')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {unknown ? (
          <>
            <span className="px-1 text-sm font-medium">{issue.original}</span>
            <Button
              size="sm"
              variant="outline"
              className={small}
              onClick={onAddWord}
              data-testid="fix-english-add-word"
            >
              <BookPlus aria-hidden="true" />
              {t('composer.fixEnglish.addWord')}
            </Button>
          </>
        ) : (
          <>
            <span className="px-1 text-sm text-muted-foreground line-through">
              {issue.original}
            </span>
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {issue.pending ? (
              <Loader2
                className="size-4 animate-spin text-muted-foreground"
                aria-label={t('composer.fixEnglish.looking')}
              />
            ) : (
              issue.suggestions.map((fix, index) => (
                <Button
                  key={fix || '(remove)'}
                  size="sm"
                  variant={index === 0 ? 'default' : 'outline'}
                  className={cn('font-semibold', touch && 'min-h-11 px-4')}
                  onClick={() => onPick(fix)}
                  data-testid="fix-english-pick"
                >
                  {fix === '' ? t('composer.fixEnglish.remove') : fix}
                </Button>
              ))
            )}
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className={cn('text-muted-foreground', small)}
          onClick={onIgnore}
          data-testid="fix-english-ignore"
        >
          {t('composer.fixEnglish.ignore')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The composer row's status: "Fix 3" (every mark with a safe fix), the grammar check spinner, a
 * quiet "No mistakes", "3 fixed · Undo" for a few seconds after Fix all, and a note while the AI
 * grammar check is down (spelling keeps working: it needs no AI).
 */
export function FixEnglishButton({
  count,
  marks,
  grammarStatus,
  grammar,
  touch,
  undo,
  onFixAll,
  onUndo,
}: {
  count: number;
  marks: number;
  grammarStatus: GrammarStatus;
  grammar: FixEnglishStatus['grammar'];
  touch: boolean;
  undo: { count: number } | null;
  onFixAll(): void;
  onUndo(): void;
}) {
  const { t } = useTranslation('inbox');
  if (undo)
    return (
      <span
        role="status"
        className="flex items-center gap-1 text-sm text-muted-foreground"
        data-testid="fix-english-undo"
      >
        <CircleCheck className="size-4 text-success" aria-hidden="true" />
        {t('composer.fixEnglish.fixed', { count: undo.count })}
        <Button
          variant="link"
          size="sm"
          className={cn('h-auto px-1 font-semibold', touch && 'min-h-11')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onUndo}
        >
          {t('composer.fixEnglish.undo')}
        </Button>
      </span>
    );
  const grammarDown = grammar === 'unavailable' || (grammar === 'on' && grammarStatus === 'error');
  let main: React.ReactNode = null;
  if (count > 0)
    main = (
      <Button
        variant="outline"
        size={touch ? 'touch' : 'sm'}
        className="rounded-full border-primary/40 text-primary"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onFixAll}
        title={touch ? undefined : t('composer.fixEnglish.shortcut')}
        data-testid="fix-english-fix-all"
      >
        <Sparkles aria-hidden="true" />
        {t('composer.fixEnglish.fixAll', { count })}
        {!touch && (
          <kbd className="ml-1 rounded border bg-muted px-1 font-sans text-[0.7rem] text-muted-foreground">
            {t('composer.fixEnglish.shortcutKey')}
          </kbd>
        )}
      </Button>
    );
  else if (grammarStatus === 'checking')
    main = (
      <span className="flex items-center text-muted-foreground" data-testid="fix-english-checking">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span className="sr-only">{t('composer.fixEnglish.checking')}</span>
      </span>
    );
  else if (marks === 0 && (grammarStatus === 'done' || grammar !== 'on'))
    main = (
      <span
        className="flex items-center gap-1 text-xs text-muted-foreground"
        data-testid="fix-english-clean"
      >
        <CircleCheck className="size-4" aria-hidden="true" />
        {t('composer.fixEnglish.clean')}
      </span>
    );
  return (
    <>
      {grammarDown && (
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title={t('composer.fixEnglish.unavailableHint')}
          data-testid="fix-english-unavailable"
        >
          <CircleAlert className="size-3.5" aria-hidden="true" />
          {t('composer.fixEnglish.unavailable')}
        </span>
      )}
      {main}
    </>
  );
}

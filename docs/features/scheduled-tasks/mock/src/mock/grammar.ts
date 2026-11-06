import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Mock-only AI behaviour (Settings → AI → Fix English → Mock only). */
export type MockGrammarMode = 'normal' | 'slow' | 'error' | 'expired';
export type MockGrammarInstall = 'new' | 'upgraded';

/**
 * The admin switch and what the composer does. Spelling runs in the browser (no AI); grammar needs
 * the AI connection: `none` = no connection (spelling only), `unavailable` = it needs attention.
 */
export interface GrammarState {
  enabled: boolean;
  mode: MockGrammarMode;
  install: MockGrammarInstall;
  connected: boolean;
  spelling: 'off' | 'on';
  grammar: 'off' | 'none' | 'unavailable' | 'on';
}

/** A team word: never underlined. Learned from Business context, or added by a teammate. */
export interface TeamWord {
  word: string;
  source: 'business' | 'team';
  addedBy: string | null;
  at: number;
}

/** One mistake: replace `text.slice(start, end)` with `replacement` (null: a word the dictionary does not know). */
export interface GrammarIssue {
  id: string;
  start: number;
  end: number;
  original: string;
  replacement: string | null;
  kind: 'spelling' | 'grammar';
}

export type GrammarResult =
  | { status: 'checked'; issues: GrammarIssue[] }
  | { status: 'skipped'; reason: 'not_english' | 'too_short' };

export const grammarKey = ['mock', 'grammar'] as const;

/** Proposed (grammar-fix): the app carries this in the bootstrap payload; the mock asks its route. */
export function useGrammarState() {
  return useQuery({
    queryKey: grammarKey,
    queryFn: () => api<GrammarState>('/mock/grammar'),
    refetchInterval: 5_000,
  });
}

export const teamWordsKey = ['mock', 'grammar', 'words'] as const;

/** The team word list (the app: `GET /api/fix-english/words`). */
export function useTeamWords(enabled = true) {
  return useQuery({
    queryKey: teamWordsKey,
    queryFn: () => api<{ words: TeamWord[] }>('/mock/grammar/words'),
    enabled,
    refetchInterval: 15_000,
  });
}

export function addTeamWord(word: string) {
  return api<{ words: TeamWord[] }>('/mock/grammar/words', { body: { word } });
}

export function removeTeamWord(word: string) {
  return api<{ words: TeamWord[] }>(`/mock/grammar/words/${encodeURIComponent(word)}`, {
    method: 'DELETE',
  });
}

/** The grammar mistakes in the typed text, from the AI (the app: `POST /api/chats/:jid/ai/fix-grammar`). */
export function checkGrammar(text: string, signal: AbortSignal) {
  return api<GrammarResult>('/mock/grammar/check', { body: { text }, signal });
}

/**
 * Keeps the underlines in place while the teammate types: an issue the edit touched is dropped,
 * issues after it move with the text. The next check (after a pause) brings back the real list.
 */
export function shiftIssues(issues: GrammarIssue[], before: string, after: string): GrammarIssue[] {
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

/** Applies the given issues (non-overlapping) to the text; returns the new text. */
export function applyIssues(text: string, issues: GrammarIssue[]): string {
  let next = text;
  for (const issue of [...issues].sort((a, b) => b.start - a.start)) {
    if (issue.replacement == null || next.slice(issue.start, issue.end) !== issue.original)
      continue;
    next = next.slice(0, issue.start) + issue.replacement + next.slice(issue.end);
  }
  return next;
}

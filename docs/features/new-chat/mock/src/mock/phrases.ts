import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Proposed (ai-phrase-dictionary): the team's phrase list for instant grey text. */
export type PhraseSource = 'context' | 'team' | 'admin';
export type PhraseLanguage = 'en' | 'ms' | 'zh';
export type PhraseState = 'ready' | 'empty' | 'building' | 'error';

export interface Phrase {
  id: number;
  text: string;
  language: PhraseLanguage;
  source: PhraseSource;
  uses: number;
  fact: boolean;
}

export interface PhraseStatus {
  state: PhraseState;
  count: number;
  languages: { language: PhraseLanguage; count: number }[];
  updatedAt: number | null;
  trigger: 'start' | 'context' | 'replies' | 'manual' | 'weekly';
  newReplies: number;
  nextAfterReplies: number;
  aiCallsToday: number;
  aiCallsLimit: number;
}

export interface SuggestModelState {
  model: string;
  mode: 'chatgpt' | 'api' | 'claude';
  fastModel: string;
  agentModel: string;
  models: string[];
  resolved: string;
}

export const phrasesKey = ['mock', 'phrases'] as const;
export const suggestModelKey = ['mock', 'suggestModel'] as const;

export function usePhrases() {
  return useQuery({
    queryKey: phrasesKey,
    queryFn: () => api<{ status: PhraseStatus; phrases: Phrase[] }>('/mock/phrases'),
    // While a rebuild runs, refresh until it is done.
    refetchInterval: (query) => (query.state.data?.status.state === 'building' ? 700 : false),
  });
}

export function useSuggestModel() {
  return useQuery({
    queryKey: suggestModelKey,
    queryFn: () => api<SuggestModelState>('/mock/suggest-model'),
  });
}

export const phraseListKey = ['mock', 'phraseList'] as const;

/** The list every composer matches locally (refreshed after a rebuild or an edit). */
export function usePhraseList(enabled: boolean) {
  return useQuery({
    queryKey: phraseListKey,
    queryFn: () =>
      api<{ id: number; text: string; language: PhraseLanguage }[]>('/mock/phrase-list'),
    enabled,
    staleTime: 60_000,
  });
}

const words = (text: string) =>
  // Each Chinese character counts as one word (Han first: it is also \p{L}).
  [...text.toLowerCase().matchAll(/\p{Script=Han}|[\p{L}\p{N}#.]+/gu)].map((m) => m[0]);

/**
 * Instant grey text from the phrase list: the last 2–4 typed words (the last one may be half
 * typed) must appear in a phrase; the rest of that phrase is the grey text. Most used first.
 */
export function matchPhrase(
  list: readonly { id: number; text: string; language: PhraseLanguage }[],
  text: string,
): { id: number; rest: string } | null {
  if (text.trimStart().startsWith('/')) return null;
  const typed = words(text);
  if (typed.length < 2) return null;
  for (const take of [4, 3, 2]) {
    if (typed.length < take) continue;
    const tail = typed.slice(-take);
    for (const phrase of list) {
      const joined = phrase.language === 'zh' ? tail.join('') : tail.join(' ');
      const at = phrase.text.toLowerCase().indexOf(joined);
      if (at < 0) continue;
      const rest = phrase.text.slice(at + joined.length);
      const next = /\s$/u.test(text) ? rest.replace(/^\s+/u, '') : rest;
      if (next.trim().length > 1) return { id: phrase.id, rest: next.slice(0, 120) };
    }
  }
  return null;
}

/** Tab / Accept on a phrase: it moves up the list (a local count). */
export function notePhraseUsed(id: number) {
  void api(`/mock/phrases/${id}/used`, { method: 'POST' }).catch(() => undefined);
}

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Mock-only AI behaviour (Settings → AI → Proposed controls). */
export type MockSuggestMode = 'normal' | 'slow' | 'error' | 'expired';
export type MockInstall = 'new' | 'upgraded';

/** The admin switch and what the composer shows: hidden, disabled or on. */
export interface ReplySuggestionsState {
  enabled: boolean;
  mode: MockSuggestMode;
  install: MockInstall;
  connected: boolean;
  composer: 'off' | 'unavailable' | 'on';
}

export interface ReplySuggestion {
  label: string;
  text: string;
}

export interface ReplySuggestionsResult {
  suggestions: ReplySuggestion[];
  noAnswer: boolean;
  handoffRule: string | null;
}

export const replySuggestionsKey = ['mock', 'replySuggestions'] as const;

/**
 * Proposed (ai-reply-suggestions): the app will carry this state in the bootstrap/`me` payload;
 * the mock asks its stand-in route and refreshes it so a switch change shows in other browsers.
 */
export function useReplySuggestionsState() {
  return useQuery({
    queryKey: replySuggestionsKey,
    queryFn: () => api<ReplySuggestionsState>('/mock/reply-suggestions'),
    refetchInterval: 5_000,
  });
}

/** Two drafts for the chat (the app: `POST /api/chats/:jid/ai/suggestions`). */
export function fetchSuggestions(chatJid: string, signal: AbortSignal) {
  return api<ReplySuggestionsResult>('/mock/suggestions', { body: { chatJid }, signal });
}

/** The rest of the sentence being typed (the app: `POST /api/chats/:jid/ai/complete`). */
export function fetchCompletion(chatJid: string, text: string, signal: AbortSignal) {
  return api<{ completion: string | null; phraseId?: number; source?: 'phrase' | 'model' }>(
    '/mock/complete',
    { body: { chatJid, text }, signal },
  );
}

/**
 * Completion starts after at least one full word, also while the next word is half typed
 * ("Hi Nu" counts, "Hi" does not); the app's shared `completionReady` since the speed fix.
 */
export function completionReady(text: string): boolean {
  return (
    /[\p{L}\p{N}][\s,.!?;:，。？！、]+[^\s,.!?;:，。？！、]*$/u.test(text) &&
    !text.trimStart().startsWith('/')
  );
}

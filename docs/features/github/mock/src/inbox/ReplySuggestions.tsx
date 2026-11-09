import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Info, RotateCw, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ReplySuggestion, ReplySuggestionsResult } from '@/mock/replySuggestions';

export type SuggestionStrip =
  | { phase: 'loading' }
  | { phase: 'ready'; result: ReplySuggestionsResult }
  | { phase: 'error'; message: string };

/**
 * Proposed (ai-reply-suggestions): the strip above the composer after "Suggest reply". Up to two
 * chips (a short label; a tap puts the full draft in the composer), or a note when the business
 * context has no answer or a hand-off rule matches. The strip scrolls inside itself, never the page.
 */
export function ReplySuggestions({
  strip,
  isAdmin,
  onPick,
  onRetry,
  onClose,
}: {
  strip: SuggestionStrip;
  isAdmin: boolean;
  onPick(suggestion: ReplySuggestion): void;
  onRetry(): void;
  onClose(): void;
}) {
  const { t } = useTranslation('inbox');
  return (
    <div
      className="mb-1.5 flex min-w-0 items-start gap-1.5"
      role="region"
      aria-label={t('mockSuggest.region')}
      aria-busy={strip.phase === 'loading'}
      data-testid="reply-suggestions"
    >
      {/* Phones: one chip per line, so both labels show in full; wider: a row that scrolls inside itself. */}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 py-0.5 sm:flex-row sm:items-center sm:gap-2 sm:overflow-x-auto">
        {strip.phase === 'loading' && (
          <>
            <span className="sr-only" role="status">
              {t('mockSuggest.loading')}
            </span>
            <Skeleton className="h-9 w-44 shrink-0 rounded-full pointer-coarse:h-11" />
            <Skeleton className="h-9 w-36 shrink-0 rounded-full pointer-coarse:h-11" />
          </>
        )}
        {strip.phase === 'error' && (
          <p
            role="alert"
            className="flex min-h-9 min-w-0 items-center gap-2 text-sm text-danger pointer-coarse:min-h-11"
          >
            <span className="min-w-0">{strip.message}</span>
            <Button variant="ghost" size="sm" onClick={onRetry} className="shrink-0">
              <RotateCw aria-hidden="true" />
              {t('mockSuggest.retry')}
            </Button>
          </p>
        )}
        {strip.phase === 'ready' &&
          strip.result.suggestions.map((s, i) => (
            <Button
              key={i}
              variant="outline"
              size="sm"
              title={s.text}
              onClick={() => onPick(s)}
              className="h-auto min-h-9 max-w-full shrink-0 justify-start rounded-full border-primary/40 sm:max-w-72 pointer-coarse:min-h-11"
              data-testid="suggestion-chip"
            >
              <Sparkles className="text-primary" aria-hidden="true" />
              <span className="truncate">{s.label}</span>
            </Button>
          ))}
        {strip.phase === 'ready' && strip.result.handoffRule && (
          <Note>{t('mockSuggest.handoff', { rule: strip.result.handoffRule })}</Note>
        )}
        {strip.phase === 'ready' &&
          !strip.result.handoffRule &&
          (strip.result.noAnswer || strip.result.suggestions.length === 0) && (
            <Note>
              {t('mockSuggest.noAnswer')}
              {isAdmin && (
                <>
                  {' '}
                  <Link to="/admin/members/ai/1" className="font-medium text-primary underline">
                    {t('mockSuggest.addContext')}
                  </Link>
                </>
              )}
            </Note>
          )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('mockSuggest.close')}
        title={t('mockSuggest.close')}
        onClick={onClose}
        className="shrink-0 text-muted-foreground pointer-coarse:size-11"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="flex min-h-9 min-w-0 items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-sm text-muted-foreground pointer-coarse:min-h-11"
      data-testid="suggestion-note"
    >
      <Info className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

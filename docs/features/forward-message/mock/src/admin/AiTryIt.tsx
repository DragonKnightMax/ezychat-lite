import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handoffReasonLabel } from '@/lib/ai-handoff';
import { AI_TRY_QUESTION_CHARACTERS } from '@ezychat/shared';
import { useAiTry } from '../api/ai';
import { errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AiKnowledgeDraft } from './ai-status';
import { Field, Pending } from './adminUi';

/**
 * Asks the AI a test question with the page's current (possibly unsaved) name and instructions;
 * the server answers from the saved Business context items.
 */
export function AiTryIt({ draft }: { draft: AiKnowledgeDraft }) {
  const { t } = useTranslation('admin');
  const ask = useAiTry();
  const [question, setQuestion] = useState('');
  const decisionLabels = {
    answer: t('ai.try.decision.answer'),
    ask_resolution: t('ai.try.decision.ask_resolution'),
    resolve: t('ai.try.decision.resolve'),
    handoff: t('ai.try.decision.handoff'),
  };
  const submit = () => {
    const text = question.trim();
    if (!text) return;
    ask.mutate({
      question: text,
      knowledge: {
        displayName: draft.displayName.trim() || t('ai.page.defaultTitle'),
        instructions: draft.instructions,
        handoffRules: draft.handoffRules,
      },
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('ai.try.hint')}</p>
      <Field label={t('ai.try.label')} hint={t('ai.try.enterHint')}>
        {(p) => (
          <Textarea
            {...p}
            rows={2}
            value={question}
            maxLength={AI_TRY_QUESTION_CHARACTERS}
            placeholder={t('ai.try.placeholder')}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              // Enter asks like a chat box; Shift+Enter adds a line; IME composition is left alone.
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (!ask.isPending) submit();
            }}
          />
        )}
      </Field>
      <Button
        type="button"
        size="touch"
        className="self-start"
        disabled={!question.trim() || ask.isPending}
        onClick={submit}
      >
        <Pending show={ask.isPending} />
        {t('ai.try.ask')}
      </Button>
      <div aria-live="polite" className="flex flex-col gap-2">
        {ask.data &&
          (ask.data.ok ? (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {ask.data.action && (
                  <Badge variant="outline">{decisionLabels[ask.data.action as keyof typeof decisionLabels] ?? ask.data.action}</Badge>
                )}
                {ask.data.model && (
                  <span className="text-xs text-muted-foreground">
                    {t('ai.try.model', { model: ask.data.model })}
                  </span>
                )}
              </div>
              {ask.data.action === 'handoff' && ask.data.handoffReason && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {t('ai.try.handoffReason', {
                    reason: handoffReasonLabel(ask.data.handoffReason),
                  })}
                </p>
              )}
              <p className="break-words whitespace-pre-wrap">{ask.data.reply}</p>
              {ask.data.action === 'handoff' && !ask.data.model && (
                <p className="mt-2 text-xs text-muted-foreground">{t('ai.try.noKnowledge')}</p>
              )}
            </div>
          ) : (
            <Banner tone="danger">{t('ai.try.failed', { error: ask.data.error ?? '' })}</Banner>
          ))}
        {ask.error && <Banner tone="danger">{errorMessage(ask.error)}</Banner>}
      </div>
    </div>
  );
}

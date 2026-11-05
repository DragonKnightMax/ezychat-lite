import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_EDIT_REQUEST_CHARACTERS, type AiEditField } from '@ezychat/shared';
import { useAiEdit } from '../api/ai';
import { errorMessage } from '../api/client';
import { Banner, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Field, Pending } from './adminUi';
import { collapseDiff, lineDiff, type DiffLine } from './line-diff';

const LINE_STYLE: Record<DiffLine['type'], string> = {
  same: 'text-muted-foreground',
  del: 'bg-danger/10 text-foreground',
  add: 'bg-primary/10 text-foreground',
};
const LINE_MARK: Record<DiffLine['type'], string> = { same: ' ', del: '−', add: '+' };

/**
 * Edit with AI: the admin describes a change to one box, reviews the suggested rewrite as a line
 * diff and applies it to the page's draft. Applying never saves; the page's Save does.
 */
export function AiEditDialog({
  field,
  current,
  open,
  onOpenChange,
  onApply,
}: {
  field: AiEditField;
  /** The box's current (possibly unsaved) text. */
  current: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const edit = useAiEdit();
  const [request, setRequest] = useState('');
  const result = edit.data;
  const suggestion = result?.ok && result.text !== null ? result.text : null;
  const diff = suggestion === null ? [] : lineDiff(current, suggestion);
  const changed = diff.some((line) => line.type !== 'same');
  const error = edit.error
    ? errorMessage(edit.error)
    : result && !result.ok
      ? (result.error ?? t('ai.edit.failed'))
      : null;
  const markLabel = { same: '', del: t('ai.edit.removed'), add: t('ai.edit.added') };

  // The request being written; cancelled on close, on a new request and on unmount, so a closed
  // popup never keeps a paid model call running.
  const running = useRef<AbortController | null>(null);
  const stop = () => {
    running.current?.abort();
    running.current = null;
  };
  useEffect(() => stop, []);

  const close = (next: boolean) => {
    if (!next) {
      // A reopened dialog starts fresh.
      stop();
      setRequest('');
      edit.reset();
    }
    onOpenChange(next);
  };
  const suggest = () => {
    const text = request.trim();
    if (!text || edit.isPending) return;
    stop();
    const controller = new AbortController();
    running.current = controller;
    edit.mutate({ body: { field, current, request: text }, signal: controller.signal });
  };
  const apply = () => {
    if (suggestion === null || !changed) return;
    onApply(suggestion);
    close(false);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={close}
      title={t(`ai.edit.title.${field}`)}
      description={t('ai.edit.description')}
      size="medium"
      footer={
        <div className="flex w-full flex-col gap-2">
          {/* Phones stack full width with Apply on top. Before a suggestion there is nothing to
              apply, so the only action is Cancel. */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" size="touch" onClick={() => close(false)}>
              {suggestion === null ? t('common:actions.cancel') : t('ai.edit.discard')}
            </Button>
            {suggestion !== null && (
              <Button
                type="button"
                size="touch"
                disabled={!changed || edit.isPending}
                onClick={apply}
              >
                {t(`ai.edit.apply.${field}`)}
              </Button>
            )}
          </div>
          {suggestion !== null && (
            <p className="text-xs text-muted-foreground sm:text-right">{t('ai.edit.applyNote')}</p>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3 pb-1">
        <Field label={t('ai.edit.requestLabel')}>
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={request}
              maxLength={AI_EDIT_REQUEST_CHARACTERS}
              className="field-sizing-fixed min-h-20 resize-y text-base md:text-sm"
              placeholder={t(`ai.edit.placeholder.${field}`)}
              onChange={(e) => setRequest(e.target.value)}
            />
          )}
        </Field>
        <Button
          type="button"
          size="touch"
          variant={result ? 'outline' : 'default'}
          className="sm:self-end"
          disabled={!request.trim() || edit.isPending}
          onClick={suggest}
        >
          <Pending show={edit.isPending} />
          {edit.isPending
            ? t('ai.edit.writing')
            : result
              ? t('ai.edit.suggestAgain')
              : t('ai.edit.suggest')}
        </Button>
        <div aria-live="polite" className="flex min-w-0 flex-col gap-2">
          {error && <Banner tone="danger">{error}</Banner>}
          {suggestion !== null && (
            <>
              <h3 className="text-sm font-medium">{t(`ai.edit.result.${field}`)}</h3>
              {changed ? (
                <ul className="max-h-[40dvh] overflow-y-auto rounded-lg border bg-surface py-1 text-sm leading-6">
                  {collapseDiff(diff).map((line, index) =>
                    line.type === 'skip' ? (
                      <li
                        key={`${index}-skip`}
                        className="px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {`⋯ ${t('ai.edit.unchanged', { count: line.count })}`}
                      </li>
                    ) : (
                      <li
                        // Lines repeat, so the position is part of the key.
                        key={`${index}-${line.type}`}
                        className={cn(
                          'flex gap-2 px-2 whitespace-pre-wrap [overflow-wrap:anywhere]',
                          LINE_STYLE[line.type],
                        )}
                      >
                        <span aria-hidden className="w-3 shrink-0 text-center no-underline">
                          {LINE_MARK[line.type]}
                        </span>
                        <span className="min-w-0">
                          {line.type !== 'same' && (
                            <span className="sr-only">{`${markLabel[line.type]} `}</span>
                          )}
                          {/* Only the removed text is struck through, never the − sign. */}
                          <span className={line.type === 'del' ? 'line-through' : undefined}>
                            {line.text}
                          </span>
                        </span>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('ai.edit.noChange')}</p>
              )}
            </>
          )}
        </div>
      </div>
    </ResponsiveDialog>
  );
}

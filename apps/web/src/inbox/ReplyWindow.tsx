import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { MessageTemplate } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { newClientId } from '../api/queries';
import { useSendTemplate, useSyncTemplates, useTemplates } from '../api/templates';
import { Banner, EmptyState, ResponsiveDialog } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { replyWindowEnding, replyWindowLeft, useNow } from './reply-window';

/** Meta's page where a WhatsApp Business Account creates and manages its message templates. */
export const TEMPLATES_MANAGER_URL = 'https://business.facebook.com/wa/manage/message-templates/';

/** The 24-hour customer-service window of a Business API chat: a quiet line above the composer. */
export function ReplyWindowNote({
  lastInboundAt,
  windowHours,
}: Readonly<{ lastInboundAt: number | null; windowHours: number }>) {
  const { t } = useTranslation('inbox');
  const now = useNow();
  const left = replyWindowLeft(lastInboundAt, windowHours, now) ?? 0;
  if (left <= 0) return null;
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  const hours = Math.floor(minutes / 60);
  const ending = replyWindowEnding(left);
  return (
    <p
      className={cn(
        'flex items-center gap-1.5 px-3 pt-2 text-xs',
        ending ? 'font-medium text-warning' : 'text-muted-foreground',
      )}
      title={t('window.explain', { hours: windowHours })}
      data-testid="reply-window"
      data-ending={ending || undefined}
    >
      <Clock className="size-3.5 shrink-0" aria-hidden="true" />
      {hours > 0
        ? t('window.leftHours', { hours, minutes: minutes % 60 })
        : t('window.leftMinutes', { minutes })}
    </p>
  );
}

/** Replaces the composer once the reply window has closed: only an approved template may go. */
export function WindowClosedPanel({
  jid,
  inboxId,
  customerName,
  disabled,
}: Readonly<{
  jid: string;
  inboxId: number;
  customerName: string;
  /** WhatsApp is offline: nothing can be sent. */
  disabled?: boolean;
}>) {
  const { t } = useTranslation('inbox');
  const [open, setOpen] = useState(false);
  return (
    <div className="px-2 py-2 sm:px-3" data-testid="window-closed">
      <Banner tone="info" title={t('window.closedTitle')}>
        <span className="flex flex-col gap-2">
          <span>{t('window.closedBody', { name: customerName })}</span>
          <Button
            type="button"
            size="touch"
            className="self-start md:min-h-9"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <FileText aria-hidden="true" />
            {t('window.sendTemplate')}
          </Button>
        </span>
      </Banner>
      <TemplateDialog
        open={open}
        jid={jid}
        inboxId={inboxId}
        customerName={customerName}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

export const templateKey = (tpl: Pick<MessageTemplate, 'name' | 'language'>) =>
  `${tpl.name}:${tpl.language}`;

/** The body with each {{n}} replaced by its value; an empty value keeps its placeholder. */
export function fillTemplate(body: string, values: readonly string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => {
    const value = values[Number(n) - 1]?.trim();
    return value ? value : whole;
  });
}

type UnsupportedKey = 'image' | 'document' | 'video' | 'buttons' | 'other';

/** Why EzyChat cannot send a template yet (media headers and buttons are listed, not sent). */
function unsupportedReason(tpl: MessageTemplate): UnsupportedKey {
  if (tpl.header && tpl.header !== 'text') return tpl.header;
  if (tpl.buttons) return 'buttons';
  return 'other';
}

/** Pick an approved template, fill its variables and see the message before sending it. */
export function TemplateDialog({
  open,
  jid,
  inboxId,
  customerName,
  onClose,
}: Readonly<{
  open: boolean;
  jid: string;
  inboxId: number;
  customerName: string;
  onClose(): void;
}>) {
  const { t } = useTranslation(['inbox', 'common']);
  const list = useTemplates(inboxId, open);
  const sync = useSyncTemplates(inboxId);
  const send = useSendTemplate(jid);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  /** One clientId per chosen template: a retry after an error never sends twice. */
  const [clientId, setClientId] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelectedKey(null);
    setValues([]);
    setSubmitted(false);
    send.reset();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const templates = list.data?.templates ?? [];
  const selected = templates.find((tpl) => templateKey(tpl) === selectedKey) ?? null;
  const missing = values.some((v) => !v.trim());

  const choose = (tpl: MessageTemplate) => {
    setSelectedKey(templateKey(tpl));
    setSubmitted(false);
    setClientId(newClientId());
    send.reset();
    // {{1}} is the customer's name in most templates: start with the first name the team sees.
    const first = customerName.trim().split(/\s+/)[0] ?? '';
    setValues(Array.from({ length: tpl.variables }, (_, i) => (i === 0 ? first : '')));
  };

  const runSync = () =>
    sync.mutate(undefined, {
      onSuccess: () => toast.success(t('window.synced')),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const syncButton = (
    <Button
      type="button"
      variant="ghost"
      size="touch"
      className="md:min-h-9"
      disabled={sync.isPending}
      aria-busy={sync.isPending || undefined}
      onClick={runSync}
    >
      <RefreshCw className={cn(sync.isPending && 'animate-spin')} aria-hidden="true" />
      {t('window.sync')}
    </Button>
  );

  const formId = 'template-form';
  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div className="flex flex-col gap-2 pb-1" role="status" aria-label={t('window.loading')}>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  } else if (list.isError) {
    body = (
      <Banner
        tone="danger"
        title={t('window.loadFailed')}
        action={
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="md:min-h-9"
            onClick={() => void list.refetch()}
          >
            {t('common:actions.tryAgain')}
          </Button>
        }
      >
        {errorMessage(list.error)}
      </Banner>
    );
  } else if (templates.length === 0) {
    body = (
      <EmptyState
        className="p-4"
        title={t('window.emptyTitle')}
        description={t('window.emptyBody')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline" size="touch" className="md:min-h-9">
              <a href={TEMPLATES_MANAGER_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                {t('window.manage')}
              </a>
            </Button>
            {syncButton}
          </div>
        }
      />
    );
  } else {
    body = (
      <form
        id={formId}
        noValidate
        className="flex min-w-0 flex-col gap-4 pb-1"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!selected || missing || send.isPending) return;
          send.mutate(
            {
              name: selected.name,
              language: selected.language,
              params: values.map((v) => v.trim()),
              clientId,
            },
            {
              onSuccess: () => {
                toast.success(t('window.sent'));
                onClose();
              },
            },
          );
        }}
      >
        <TemplateFields
          templates={templates}
          selected={selected}
          values={values}
          submitted={submitted}
          syncButton={syncButton}
          onChoose={choose}
          onValues={setValues}
        />

        {send.error && <Banner tone="danger">{errorMessage(send.error)}</Banner>}
      </form>
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('window.dialogTitle')}
      description={t('window.dialogDescription')}
      size="medium"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="sm:min-h-9"
            onClick={onClose}
          >
            {t('common:actions.cancel')}
          </Button>
          {selected && (
            <Button
              type="submit"
              form={formId}
              size="touch"
              className="sm:min-h-9"
              disabled={send.isPending}
              aria-busy={send.isPending || undefined}
            >
              {t('window.send')}
            </Button>
          )}
        </>
      }
    >
      {body}
    </ResponsiveDialog>
  );
}

/**
 * The template list (sendable ones selectable), the variable boxes and the live preview: shared by the
 * reply-window dialog and New chat's template step.
 */
export function TemplateFields({
  templates,
  selected,
  values,
  submitted,
  syncButton,
  onChoose,
  onValues,
}: Readonly<{
  templates: readonly MessageTemplate[];
  selected: MessageTemplate | null;
  values: readonly string[];
  submitted: boolean;
  syncButton?: ReactNode;
  onChoose(tpl: MessageTemplate): void;
  onValues(values: string[]): void;
}>) {
  const { t } = useTranslation('inbox');
  return (
    <>
      <div
        role="group"
        aria-labelledby="template-list-label"
        className="flex min-w-0 flex-col gap-2"
        data-testid="template-list"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id="template-list-label" className="text-sm font-medium">
            {t('window.choose')}
          </span>
          {syncButton}
        </div>
        {templates.map((tpl) => {
          const key = templateKey(tpl);
          const chosen = key === (selected && templateKey(selected));
          return (
            <Button
              key={key}
              type="button"
              variant="outline"
              aria-pressed={chosen}
              disabled={!tpl.sendable}
              onClick={() => onChoose(tpl)}
              className={cn(
                'h-auto min-h-11 w-full min-w-0 flex-col items-start gap-1 px-3 py-2.5 text-left whitespace-normal',
                chosen && 'border-primary bg-primary/5 ring-1 ring-primary',
              )}
            >
              <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
                <span className="min-w-0 font-mono text-sm font-medium break-all">{tpl.name}</span>
                <Badge variant="outline">{tpl.language}</Badge>
                <Badge variant="secondary">{t(`window.category.${tpl.category}`)}</Badge>
              </span>
              <span className="line-clamp-2 text-xs font-normal break-words text-muted-foreground">
                {tpl.body}
              </span>
              {!tpl.sendable && (
                <span className="text-xs font-medium text-muted-foreground">
                  {t(`window.unsupported.${unsupportedReason(tpl)}`)}
                </span>
              )}
            </Button>
          );
        })}
      </div>

      {selected && values.length > 0 && (
        <fieldset className="flex min-w-0 flex-col gap-3" data-testid="template-values">
          <legend className="mb-1 text-sm font-medium">{t('window.values')}</legend>
          {values.map((value, i) => {
            const id = `template-value-${i}`;
            const error = submitted && !value.trim();
            return (
              <div key={id} className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={id}>{t('window.variable', { n: i + 1 })}</Label>
                <Input
                  id={id}
                  value={value}
                  maxLength={1024}
                  placeholder={selected.examples[i] ?? ''}
                  aria-invalid={error || undefined}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(e) => onValues(values.map((x, j) => (j === i ? e.target.value : x)))}
                />
                {error && (
                  <p id={`${id}-error`} className="text-sm text-danger">
                    {t('window.required')}
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      {selected && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-sm font-medium">{t('window.preview')}</p>
          <p
            className="min-w-0 rounded-lg border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-wrap"
            data-testid="template-preview"
          >
            {fillTemplate(selected.body, values)}
          </p>
          {selected.category === 'marketing' && (
            <p className="text-xs text-muted-foreground">{t('window.marketingNote')}</p>
          )}
        </div>
      )}
    </>
  );
}

// Proposed (business-api): the 24-hour customer service window of a Business API chat. Inside it the team
// writes freely; after it WhatsApp accepts only an approved template until the customer writes again.
// Linked-phone chats have no window and show none of this.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Banner, EmptyState, ResponsiveDialog } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { api } from '../api/client';
import {
  closeWindow,
  customerWrote,
  fillTemplate,
  templateVariables,
  useMockInboxes,
  windowLeft,
  type MockTemplate,
} from '../mock/inboxes';

const TEMPLATES_URL = 'https://business.facebook.com/wa/manage/message-templates/';

/** Milliseconds left in the chat's window (0 = closed), or null for a chat without one; ticks each minute. */
export function useReplyWindow(jid: string): number | null {
  const state = useMockInboxes();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return windowLeft(state, jid, now);
}

function useLeftLabel(left: number): string {
  const { t } = useTranslation('inbox');
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? t('mockWindow.leftHours', { hours, minutes: minutes % 60 })
    : t('mockWindow.leftMinutes', { minutes });
}

/** A quiet line above the composer while the window is open; warning tone in the last hour. */
export function ReplyWindowNote({ jid, left }: Readonly<{ jid: string; left: number }>) {
  const { t } = useTranslation('inbox');
  const label = useLeftLabel(left);
  const lastHour = left < 3_600_000;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 px-3 pt-2"
      data-testid="reply-window"
    >
      <p
        className={cn(
          'flex items-center gap-1.5 text-xs',
          lastHour ? 'font-medium text-warning' : 'text-muted-foreground',
        )}
        title={t('mockWindow.explain')}
      >
        <Clock className="size-3.5" aria-hidden />
        {label}
      </p>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 text-xs text-muted-foreground"
        onClick={() => closeWindow(jid)}
      >
        {t('mockWindow.mockClose')}
      </Button>
    </div>
  );
}

/** Replaces the composer once the window has closed: Send a template, and a mock-only customer reply. */
export function WindowClosedPanel({
  jid,
  customerName,
  disabled,
  onSendTemplate,
}: Readonly<{
  jid: string;
  customerName: string;
  disabled?: boolean;
  onSendTemplate(text: string, template: MockTemplate): void;
}>) {
  const { t } = useTranslation('inbox');
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);

  const simulateReply = async () => {
    setReplying(true);
    try {
      await api('/dev/fake-incoming', {
        body: { chatJid: jid, senderName: customerName, text: 'Hi, yes please!' },
      });
      customerWrote(jid);
    } finally {
      setReplying(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-2 py-2 sm:px-3" data-testid="window-closed">
      <Banner tone="info" title={t('mockWindow.closedTitle')}>
        <span className="flex flex-col gap-2">
          <span>{t('mockWindow.closedBody', { name: customerName })}</span>
          <Button
            type="button"
            size="touch"
            className="self-start md:min-h-9"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <FileText aria-hidden />
            {t('mockWindow.sendTemplate')}
          </Button>
        </span>
      </Banner>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t('mockWindow.mockOnly')}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={replying}
          onClick={() => void simulateReply()}
        >
          {t('mockWindow.simulateReply')}
        </Button>
      </div>
      <TemplateDialog
        open={open}
        customerName={customerName}
        onClose={() => setOpen(false)}
        onSend={(text, template) => {
          onSendTemplate(text, template);
          setOpen(false);
          toast.success(t('mockWindow.sent'));
        }}
      />
    </div>
  );
}

/** Pick an approved template, fill its variables and see the message before sending it. */
function TemplateDialog({
  open,
  customerName,
  onClose,
  onSend,
}: Readonly<{
  open: boolean;
  customerName: string;
  onClose(): void;
  onSend(text: string, template: MockTemplate): void;
}>) {
  const { t } = useTranslation(['inbox', 'common']);
  const { templates } = useMockInboxes();
  const [selected, setSelected] = useState<MockTemplate | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setValues([]);
    setSubmitted(false);
  }, [open]);

  const choose = (template: MockTemplate) => {
    setSelected(template);
    setSubmitted(false);
    // {{1}} is the customer's name in most templates: start with the first name the team saved.
    const count = templateVariables(template.body);
    setValues(
      Array.from({ length: count }, (_, i) => (i === 0 ? customerName.split(' ')[0]! : '')),
    );
  };
  const missing = values.some((v) => !v.trim());
  const formId = 'mock-template-form';

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('mockWindow.dialogTitle')}
      description={t('mockWindow.dialogDescription')}
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
            <Button type="submit" form={formId} size="touch" className="sm:min-h-9">
              {t('mockWindow.send')}
            </Button>
          )}
        </>
      }
    >
      {templates.length === 0 ? (
        <EmptyState
          title={t('mockWindow.emptyTitle')}
          description={t('mockWindow.emptyBody')}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild variant="outline" size="touch" className="md:min-h-9">
                <a href={TEMPLATES_URL} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden />
                  {t('mockWindow.manage')}
                </a>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="touch"
                className="md:min-h-9"
                onClick={() => toast.success(t('mockWindow.synced'))}
              >
                <RefreshCw aria-hidden />
                {t('mockWindow.sync')}
              </Button>
            </div>
          }
        />
      ) : (
        <form
          id={formId}
          noValidate
          className="flex min-w-0 flex-col gap-4 pb-1"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (!selected || missing) return;
            onSend(fillTemplate(selected.body, values), selected);
          }}
        >
          <fieldset className="flex min-w-0 flex-col gap-2" data-testid="template-list">
            <legend className="mb-1 text-sm font-medium">{t('mockWindow.choose')}</legend>
            {templates.map((template) => (
              <Button
                key={`${template.name}-${template.language}`}
                type="button"
                variant="outline"
                aria-pressed={selected === template}
                disabled={!!template.header}
                onClick={() => choose(template)}
                className={cn(
                  'h-auto min-h-11 w-full min-w-0 flex-col items-start gap-1 px-3 py-2.5 text-left whitespace-normal',
                  selected === template && 'border-primary bg-primary/5 ring-1 ring-primary',
                )}
              >
                <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-all font-mono text-sm font-medium">
                    {template.name}
                  </span>
                  <Badge variant="outline">{template.language}</Badge>
                  <Badge variant="secondary">{t(`mockWindow.category.${template.category}`)}</Badge>
                </span>
                <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
                  {template.body}
                </span>
                {template.header && (
                  <span className="text-xs font-medium text-muted-foreground">
                    {t(`mockWindow.unsupported.${template.header}`)}
                  </span>
                )}
              </Button>
            ))}
          </fieldset>

          {selected && values.length > 0 && (
            <fieldset className="flex min-w-0 flex-col gap-3" data-testid="template-values">
              <legend className="mb-1 text-sm font-medium">{t('mockWindow.values')}</legend>
              {values.map((value, i) => {
                const id = `template-value-${i}`;
                const error = submitted && !value.trim();
                return (
                  <div key={id} className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={id}>{t('mockWindow.variable', { n: i + 1 })}</Label>
                    <Input
                      id={id}
                      value={value}
                      maxLength={200}
                      placeholder={selected.examples[i] ?? ''}
                      aria-invalid={error || undefined}
                      onChange={(e) =>
                        setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))
                      }
                    />
                    {error && <p className="text-sm text-danger">{t('mockWindow.required')}</p>}
                  </div>
                );
              })}
            </fieldset>
          )}

          {selected && (
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="text-sm font-medium">{t('mockWindow.preview')}</p>
              <p
                className="min-w-0 rounded-lg border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap break-words"
                data-testid="template-preview"
              >
                {fillTemplate(selected.body, values)}
              </p>
              {selected.category === 'marketing' && (
                <p className="text-xs text-muted-foreground">{t('mockWindow.marketingNote')}</p>
              )}
            </div>
          )}
        </form>
      )}
    </ResponsiveDialog>
  );
}

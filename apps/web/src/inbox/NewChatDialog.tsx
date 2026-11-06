// New chat (docs/features/new-chat/design.md, confirmed mock docs/features/new-chat/mock): start a
// WhatsApp chat with a number that is not in the inbox yet, one number at a time. A linked phone checks
// the number on WhatsApp and opens the chat with the normal composer; a Business API number starts with
// an approved template, and the chat exists only once it is sent. Admins always; team members when an
// admin allows it in Settings; never an agent limited to chosen chats.
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import {
  normalizeLocalPhone,
  type Inbox,
  type MessageTemplate,
  type NewChatInboxStatus,
  type NewChatStatus,
} from '@ezychat/shared';
import { Banner, EmptyState, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage } from '../api/client';
import { newClientId } from '../api/queries';
import { useCheckNewChat, useNewChatStatus, useStartNewChat } from '../api/new-chat';
import { useTemplates } from '../api/templates';
import { encodeJid } from '../lib/jid';
import { InboxChip } from './InboxChip';
import { TemplateFields } from './ReplyWindow';
import { useVisibleInboxes } from './useVisibleInboxes';

/** Server refusals the dialog explains in plain words (the number field shows only its format error). */
const PROBLEMS = [
  'not_on_whatsapp',
  'own_number',
  'invalid_number',
  'wa_disconnected',
  'new_chat_daily_limit',
  'new_chat_hourly_limit',
  'template_failed',
  'new_chat_not_allowed',
  'new_chat_unsupported',
] as const;
type Problem = (typeof PROBLEMS)[number] | 'other';

const problemOf = (e: unknown): Problem =>
  e instanceof ApiError && (PROBLEMS as readonly string[]).includes(e.code)
    ? (e.code as Problem)
    : 'other';

/** The header button: only for people who may start a new chat. */
export function NewChatButton() {
  const { t } = useTranslation('inbox');
  const status = useNewChatStatus();
  const [open, setOpen] = useState(false);
  if (!status.data?.allowed || status.data.inboxes.length === 0) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        aria-label={t('newChat.button')}
        title={t('newChat.button')}
        data-testid="new-chat-button"
        onClick={() => setOpen(true)}
      >
        {/* Icon only: the chat list header also holds Ask Ezy, Admin and the account menu. */}
        <MessageSquarePlus aria-hidden="true" />
      </Button>
      {open && <NewChatDialog status={status.data} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewChatDialog({ status, onClose }: Readonly<{ status: NewChatStatus; onClose(): void }>) {
  const { t } = useTranslation(['inbox', 'common']);
  const navigate = useNavigate();
  const visible = useVisibleInboxes();
  const inboxes = status.inboxes
    .map((s) => ({ status: s, inbox: visible.find((i) => i.id === s.inboxId) }))
    .filter((x): x is { status: NewChatInboxStatus; inbox: Inbox } => !!x.inbox);
  const [inboxId, setInboxId] = useState(inboxes[0]?.status.inboxId ?? 0);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState<'number' | 'template'>('number');
  const [existing, setExisting] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [values, setValues] = useState<string[]>([]);
  /** One request id per attempt: a retry after a lost answer never starts a second chat. */
  const [requestId, setRequestId] = useState(newClientId);
  const ids = { inbox: useId(), phone: useId(), name: useId() };
  const check = useCheckNewChat();
  const start = useStartNewChat();

  const current = inboxes.find((x) => x.status.inboxId === inboxId) ?? inboxes[0];
  const mode = current?.status.mode ?? 'unsupported';
  const templateMode = mode === 'template';
  const digits = normalizeLocalPhone(phone, current?.status.countryCode);
  const phoneError = submitted && !digits;
  const offline = current?.inbox.status.state !== 'open';
  const used = current?.status.usedToday ?? 0;
  const limitReached = mode === 'check' && status.dailyLimit > 0 && used >= status.dailyLimit;
  const busy = check.isPending || start.isPending;
  const templates = useTemplates(inboxId, step === 'template');

  useEffect(() => {
    if (!inboxes.some((x) => x.status.inboxId === inboxId) && inboxes[0])
      setInboxId(inboxes[0].status.inboxId);
  }, [inboxes, inboxId]);

  const reset = () => {
    setExisting(null);
    setProblem(null);
    setRequestId(newClientId());
  };

  const opened = (chatJid: string, created: boolean) => {
    onClose();
    navigate(`/chats/${encodeJid(chatJid)}`, { state: { fromList: true } });
    if (created) toast.success(t(templateMode ? 'newChat.sentToast' : 'newChat.createdToast'));
  };

  const startChat = (tpl?: { name: string; language: string; params: string[] }) => {
    setProblem(null);
    start.mutate(
      {
        inboxId,
        body: {
          phone,
          name: name.trim() || undefined,
          clientRequestId: requestId,
          ...(tpl ? { template: tpl } : {}),
        },
      },
      {
        onSuccess: ({ chatJid, created }) => opened(chatJid, created),
        onError: (e) => {
          setProblem(problemOf(e));
          setRequestId(newClientId());
        },
      },
    );
  };

  const submitNumber = () => {
    setSubmitted(true);
    setExisting(null);
    setProblem(null);
    if (!digits || busy) return;
    check.mutate(
      { inboxId, phone },
      {
        onSuccess: (result) => {
          if (result.next === 'existing') setExisting(result.chatJid);
          else if (result.next === 'template') {
            setSubmitted(false);
            setStep('template');
          } else startChat();
        },
        onError: (e) => setProblem(problemOf(e)),
      },
    );
  };

  const sendTemplate = () => {
    setSubmitted(true);
    if (!template || values.some((v) => !v.trim()) || busy) return;
    startChat({
      name: template.name,
      language: template.language,
      params: values.map((v) => v.trim()),
    });
  };

  const chooseTemplate = (tpl: MessageTemplate) => {
    setTemplate(tpl);
    setSubmitted(false);
    setRequestId(newClientId());
    const first = name.trim().split(/\s+/)[0] ?? '';
    setValues(Array.from({ length: tpl.variables }, (_, i) => (i === 0 ? first : '')));
  };

  const shown = digits ? `+${digits}` : '';
  const problemBanner = problem && (
    <Banner
      tone={problem.includes('limit') ? 'warning' : 'danger'}
      title={t(`newChat.problems.${problem}.title`, { number: shown })}
    >
      {problem === 'other'
        ? errorMessage(start.error ?? check.error)
        : t(`newChat.problems.${problem}.body`, {
            inbox: current?.inbox.name ?? '',
            limit: status.dailyLimit,
            hourly: status.perUserPerHour,
          })}
    </Banner>
  );

  let notice: React.ReactNode;
  if (existing)
    notice = (
      <Banner tone="info" title={t('newChat.existingTitle')}>
        {t('newChat.existingBody', { number: shown })}
      </Banner>
    );
  else if (mode === 'unsupported')
    notice = (
      <Banner tone="info" title={t('newChat.problems.new_chat_unsupported.title')}>
        {t('newChat.problems.new_chat_unsupported.body')}
      </Banner>
    );
  else if (offline)
    notice = (
      <Banner tone="danger" title={t('newChat.problems.wa_disconnected.title')}>
        {t('newChat.problems.wa_disconnected.body', { inbox: current?.inbox.name ?? '' })}
      </Banner>
    );
  else if (limitReached)
    notice = (
      <Banner tone="warning" title={t('newChat.problems.new_chat_daily_limit.title')}>
        {t('newChat.problems.new_chat_daily_limit.body', {
          inbox: current?.inbox.name ?? '',
          limit: status.dailyLimit,
        })}
      </Banner>
    );
  else
    notice = problemBanner ?? (
      <Banner
        tone={templateMode ? 'info' : 'warning'}
        title={t(templateMode ? 'newChat.apiTitle' : 'newChat.banTitle')}
      >
        {t(templateMode ? 'newChat.apiBody' : 'newChat.banBody')}
      </Banner>
    );

  const formId = 'new-chat-form';
  const footer =
    step === 'template' ? (
      <>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="sm:min-h-9"
          disabled={busy}
          onClick={() => {
            setStep('number');
            setProblem(null);
          }}
        >
          <ArrowLeft aria-hidden="true" />
          {t('newChat.back')}
        </Button>
        <Button
          type="button"
          size="touch"
          className="sm:min-h-9"
          disabled={!template || busy}
          aria-busy={start.isPending || undefined}
          onClick={sendTemplate}
        >
          {start.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
          {start.isPending ? t('newChat.sending') : t('newChat.sendTemplate')}
        </Button>
      </>
    ) : (
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
        {existing ? (
          <Button
            type="button"
            size="touch"
            className="sm:min-h-9"
            onClick={() => opened(existing, false)}
          >
            {t('newChat.openChat')}
          </Button>
        ) : (
          <Button
            type="submit"
            form={formId}
            size="touch"
            className="sm:min-h-9"
            disabled={busy || offline || limitReached || mode === 'unsupported'}
            aria-busy={busy || undefined}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy
              ? t(templateMode ? 'newChat.preparing' : 'newChat.checking')
              : t(templateMode ? 'newChat.next' : 'newChat.start')}
          </Button>
        )}
      </>
    );

  let templateBody: React.ReactNode = null;
  if (step === 'template') {
    const list = templates.data?.templates ?? [];
    if (templates.isPending)
      templateBody = (
        <div className="flex flex-col gap-2" role="status" aria-label={t('window.loading')}>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      );
    else if (templates.isError)
      templateBody = <Banner tone="danger">{errorMessage(templates.error)}</Banner>;
    else if (list.length === 0)
      templateBody = (
        <EmptyState
          className="p-4"
          title={t('window.emptyTitle')}
          description={t('window.emptyBody')}
        />
      );
    else
      templateBody = (
        <div className="flex min-w-0 flex-col gap-4" data-testid="new-chat-templates">
          <Banner tone="info">{t('newChat.paidNote')}</Banner>
          <TemplateFields
            templates={list}
            selected={template}
            values={values}
            submitted={submitted}
            onChoose={chooseTemplate}
            onValues={setValues}
          />
          {problemBanner}
        </div>
      );
  }

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => !next && !busy && onClose()}
      title={step === 'template' ? t('newChat.templateTitle') : t('newChat.title')}
      description={
        step === 'template'
          ? t('newChat.templateDescription', { number: shown })
          : t('newChat.description')
      }
      size="medium"
      footer={footer}
    >
      <div className="flex min-w-0 flex-col gap-4 pb-1" data-testid="new-chat-dialog">
        {step === 'template' ? (
          templateBody
        ) : (
          <form
            id={formId}
            noValidate
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitNumber();
            }}
          >
            {inboxes.length > 1 && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={ids.inbox}>{t('newChat.from')}</Label>
                <Select
                  value={String(inboxId)}
                  onValueChange={(v) => {
                    setInboxId(Number(v));
                    reset();
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id={ids.inbox} className="h-11 w-full md:h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {inboxes.map(({ inbox, status: s }) => (
                      <SelectItem
                        key={inbox.id}
                        value={String(inbox.id)}
                        className="min-h-11 md:min-h-8"
                      >
                        <span className="truncate">
                          {inbox.number ? `${inbox.name} · +${inbox.number}` : inbox.name}
                        </span>
                        {s.mode === 'template' && (
                          <span className="text-xs text-muted-foreground">
                            {t('newChat.businessApi')}
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.phone}>{t('newChat.phone')}</Label>
              <Input
                id={ids.phone}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                autoFocus
                maxLength={40}
                placeholder={t('newChat.phonePlaceholder')}
                className="h-11 text-base md:h-9 md:text-sm"
                value={phone}
                disabled={busy}
                aria-invalid={phoneError || undefined}
                aria-describedby={`${ids.phone}-hint`}
                onChange={(e) => {
                  setPhone(e.target.value);
                  reset();
                }}
              />
              <p
                id={`${ids.phone}-hint`}
                className={phoneError ? 'text-sm text-danger' : 'text-sm text-muted-foreground'}
              >
                {phoneError
                  ? t('newChat.phoneInvalid')
                  : digits
                    ? t('newChat.willMessage', { number: shown })
                    : t('newChat.phoneHint')}
              </p>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.name}>{t('newChat.name')}</Label>
              <Input
                id={ids.name}
                autoComplete="off"
                maxLength={100}
                className="h-11 text-base md:h-9 md:text-sm"
                value={name}
                disabled={busy}
                aria-describedby={`${ids.name}-hint`}
                onChange={(e) => setName(e.target.value)}
              />
              <p id={`${ids.name}-hint`} className="text-sm text-muted-foreground">
                {t('newChat.nameHint')}
              </p>
            </div>

            {notice}
            {existing && inboxes.length > 1 && current && (
              <InboxChip inbox={current.inbox} className="self-start" />
            )}

            {mode === 'check' && !offline && !limitReached && (
              <p className="text-xs text-muted-foreground" data-testid="new-chat-usage">
                {status.dailyLimit > 0
                  ? t('newChat.usage', {
                      used,
                      limit: status.dailyLimit,
                      inbox: current?.inbox.name ?? '',
                    })
                  : t('newChat.usageNoLimit', { used, inbox: current?.inbox.name ?? '' })}
              </p>
            )}
          </form>
        )}
      </div>
    </ResponsiveDialog>
  );
}

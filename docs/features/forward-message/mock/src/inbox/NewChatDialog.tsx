// Proposed (new-chat): start a chat with a phone number that is not in the inbox yet. One number at a
// time. A linked phone checks the number is on WhatsApp and opens the chat with the normal composer; a
// Business API number must start with an approved template, and the chat exists only once it is sent.
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Banner, EmptyState, ResponsiveDialog } from '@/components/app';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import { ApiError, api } from '../api/client';
import { qk } from '../api/queries';
import { encodeJid } from '../lib/jid';
import {
  fillTemplate,
  inboxOfChat,
  setChatInbox,
  templateVariables,
  useMockInboxes,
  type MockInbox,
  type MockTemplate,
} from '../mock/inboxes';
import {
  formatIntl,
  newChatKey,
  normalizePhone,
  useNewChatState,
  type NewChatCheck,
  type NewChatScenario,
  type NewChatState,
} from '../mock/newChat';
import { InboxChip } from './InboxChip';
import { useVisibleInboxes } from './useVisibleInboxes';

/** Problems shown as a banner (the number field shows only its own format error). */
type Problem =
  | 'not_on_whatsapp'
  | 'own_number'
  | 'wa_disconnected'
  | 'new_chat_daily_limit'
  | 'new_chat_hourly_limit'
  | 'template_failed'
  | 'new_chat_not_allowed'
  | 'other';

const KNOWN: ReadonlySet<string> = new Set([
  'not_on_whatsapp',
  'own_number',
  'wa_disconnected',
  'new_chat_daily_limit',
  'new_chat_hourly_limit',
  'template_failed',
  'new_chat_not_allowed',
]);

const problemOf = (e: unknown): Problem =>
  e instanceof ApiError && KNOWN.has(e.code) ? (e.code as Problem) : 'other';

/** The header button: shown only to people who may start a new chat (admins, or staff with the switch on). */
export function NewChatButton() {
  const { t } = useTranslation('inbox');
  const state = useNewChatState();
  const [open, setOpen] = useState(false);
  if (!state.data?.allowed) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        aria-label={t('mockNewChat.button')}
        title={t('mockNewChat.button')}
        data-testid="new-chat-button"
        onClick={() => setOpen(true)}
      >
        <MessageSquarePlus aria-hidden />
        <span className="sr-only sm:not-sr-only">{t('mockNewChat.buttonShort')}</span>
      </Button>
      <NewChatDialog open={open} onClose={() => setOpen(false)} state={state.data} />
    </>
  );
}

function NewChatDialog({
  open,
  onClose,
  state,
}: Readonly<{ open: boolean; onClose(): void; state: NewChatState }>) {
  const { t } = useTranslation(['inbox', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inboxes = useVisibleInboxes();
  const mock = useMockInboxes();
  const { templates } = mock;
  const [inboxId, setInboxId] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState<'number' | 'template'>('number');
  const [existing, setExisting] = useState<{ chatJid: string; inbox: MockInbox | undefined }>();
  const [problem, setProblem] = useState<Problem>();
  const [template, setTemplate] = useState<MockTemplate | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const ids = { inbox: useId(), phone: useId(), name: useId(), scenario: useId() };
  const formId = 'new-chat-form';

  useEffect(() => {
    if (!open) return;
    setInboxId(inboxes[0]?.id ?? '');
    setPhone('');
    setName('');
    setSubmitted(false);
    setStep('number');
    setExisting(undefined);
    setProblem(undefined);
    setTemplate(null);
    setValues([]);
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const inbox = inboxes.find((i) => i.id === inboxId) ?? inboxes[0];
  const api_ = inbox?.type === 'business_api';
  const digits = normalizePhone(phone);
  const phoneError = submitted && !digits;
  const offline = inbox?.status !== 'connected' || state.scenario === 'disconnected';
  const used = inbox ? (state.usedToday[inbox.id] ?? 0) : 0;
  const dailyLimit = state.limits.perInboxPerDay;
  // Linked phones only; 0 = no limit (Settings → General → New chats).
  const limitReached =
    !api_ && (state.scenario === 'daily_limit' || (dailyLimit > 0 && used >= dailyLimit));

  const reset = () => {
    setExisting(undefined);
    setProblem(undefined);
  };

  const body = () => ({
    inboxId: inbox!.id,
    inboxKind: inbox!.type,
    phone,
    name: name.trim() || undefined,
  });

  const opened = (chatJid: string, created: boolean) => {
    if (created) setChatInbox(chatJid, inbox!.id);
    void qc.invalidateQueries({ queryKey: qk.chatsAll });
    void qc.invalidateQueries({ queryKey: newChatKey });
    onClose();
    navigate(`/chats/${encodeJid(chatJid)}`, { state: { fromList: true } });
    if (created) toast.success(t(api_ ? 'mockNewChat.sentToast' : 'mockNewChat.createdToast'));
  };

  const check = useMutation({
    mutationFn: () => api<NewChatCheck>('/mock/new-chat/check', { body: body() }),
  });
  const create = useMutation({
    mutationFn: (tpl?: { name: string; language: string; params: string[]; text: string }) =>
      api<{ chatJid: string; created: boolean }>('/mock/new-chat', {
        body: { ...body(), template: tpl },
      }),
    onSuccess: ({ chatJid, created }) => opened(chatJid, created),
    onError: (e) => setProblem(problemOf(e)),
  });
  const busy = check.isPending || create.isPending;

  const start = async () => {
    setSubmitted(true);
    reset();
    if (!digits || !inbox) return;
    let result: NewChatCheck;
    try {
      result = await check.mutateAsync();
    } catch (e) {
      setProblem(problemOf(e));
      return;
    }
    if (result.next === 'existing') {
      setExisting({ chatJid: result.chatJid, inbox: inboxOfChat(mock, result.chatJid) });
      return;
    }
    if (result.next === 'template') {
      setStep('template');
      return;
    }
    create.mutate(undefined);
  };

  const sendTemplate = () => {
    setSubmitted(true);
    if (!template || values.some((v) => !v.trim())) return;
    setProblem(undefined);
    create.mutate({
      name: template.name,
      language: template.language,
      params: values.map((v) => v.trim()),
      text: fillTemplate(template.body, values),
    });
  };

  const choose = (next: MockTemplate) => {
    setTemplate(next);
    setSubmitted(false);
    const first = name.trim().split(' ')[0] ?? '';
    setValues(
      Array.from({ length: templateVariables(next.body) }, (_, i) => (i === 0 ? first : '')),
    );
  };

  const problemBanner = problem && (
    <Banner
      tone={problem.includes('limit') ? 'warning' : 'danger'}
      title={t(`mockNewChat.problems.${problem}.title`, {
        number: digits ? formatIntl(digits) : '',
        inbox: inbox?.name ?? '',
      })}
    >
      {t(`mockNewChat.problems.${problem}.body`, {
        inbox: inbox?.name ?? '',
        limit: state.limits.perInboxPerDay,
        hourly: state.limits.perUserPerHour,
      })}
    </Banner>
  );

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
            setProblem(undefined);
          }}
        >
          <ArrowLeft aria-hidden />
          {t('mockNewChat.back')}
        </Button>
        <Button
          type="button"
          size="touch"
          className="sm:min-h-9"
          disabled={!template || busy}
          onClick={sendTemplate}
          data-testid="new-chat-send-template"
        >
          {create.isPending && <Loader2 className="animate-spin" aria-hidden />}
          {create.isPending ? t('mockNewChat.sending') : t('mockNewChat.sendTemplate')}
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
            onClick={() => opened(existing.chatJid, false)}
            data-testid="new-chat-open-existing"
          >
            {t('mockNewChat.openChat')}
          </Button>
        ) : (
          <Button
            type="submit"
            form={formId}
            size="touch"
            className="sm:min-h-9"
            disabled={busy || offline || limitReached}
            data-testid="new-chat-start"
          >
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {busy
              ? t(api_ ? 'mockNewChat.preparing' : 'mockNewChat.checking')
              : t(api_ ? 'mockNewChat.next' : 'mockNewChat.start')}
          </Button>
        )}
      </>
    );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
      title={step === 'template' ? t('mockNewChat.templateTitle') : t('mockNewChat.title')}
      description={
        step === 'template'
          ? t('mockNewChat.templateDescription', { number: digits ? formatIntl(digits) : '' })
          : t('mockNewChat.description')
      }
      size="medium"
      footer={footer}
    >
      <div className="flex min-w-0 flex-col gap-4 pb-1" data-testid="new-chat-dialog">
        {step === 'number' ? (
          <form
            id={formId}
            noValidate
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            {inboxes.length > 1 && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={ids.inbox}>{t('mockNewChat.from')}</Label>
                <Select
                  value={inbox?.id}
                  onValueChange={(v) => {
                    setInboxId(v);
                    reset();
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id={ids.inbox} className="h-11 w-full md:h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {inboxes.map((i) => (
                      <SelectItem key={i.id} value={i.id} className="min-h-11 md:min-h-8">
                        <span className="truncate">
                          {i.name} · {i.number}
                        </span>
                        {i.type === 'business_api' && (
                          <span className="text-xs text-muted-foreground">
                            {t('mockNewChat.businessApi')}
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.phone}>{t('mockNewChat.phone')}</Label>
              <Input
                id={ids.phone}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                autoFocus
                maxLength={30}
                placeholder={t('mockNewChat.phonePlaceholder')}
                className="h-11 text-base md:h-9 md:text-sm"
                value={phone}
                disabled={busy}
                aria-invalid={phoneError || undefined}
                aria-describedby={`${ids.phone}-hint`}
                onChange={(e) => {
                  setPhone(e.target.value);
                  reset();
                }}
                data-testid="new-chat-phone"
              />
              {phoneError ? (
                <p id={`${ids.phone}-hint`} className="text-sm text-danger">
                  {t('mockNewChat.phoneInvalid')}
                </p>
              ) : (
                <p id={`${ids.phone}-hint`} className="text-sm text-muted-foreground">
                  {digits
                    ? t('mockNewChat.willMessage', { number: formatIntl(digits) })
                    : t('mockNewChat.phoneHint')}
                </p>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.name}>{t('mockNewChat.name')}</Label>
              <Input
                id={ids.name}
                autoComplete="off"
                maxLength={100}
                className="h-11 text-base md:h-9 md:text-sm"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">{t('mockNewChat.nameHint')}</p>
            </div>

            {existing ? (
              <Banner tone="info" title={t('mockNewChat.existingTitle')}>
                <span className="flex flex-wrap items-center gap-1.5">
                  {t('mockNewChat.existingBody', { number: digits ? formatIntl(digits) : '' })}
                  {existing.inbox && inboxes.length > 1 && <InboxChip inbox={existing.inbox} />}
                </span>
              </Banner>
            ) : offline ? (
              <Banner tone="danger" title={t('mockNewChat.problems.wa_disconnected.title')}>
                {t('mockNewChat.problems.wa_disconnected.body', { inbox: inbox?.name ?? '' })}
              </Banner>
            ) : limitReached ? (
              <Banner tone="warning" title={t('mockNewChat.problems.new_chat_daily_limit.title')}>
                {t('mockNewChat.problems.new_chat_daily_limit.body', {
                  inbox: inbox?.name ?? '',
                  limit: state.limits.perInboxPerDay,
                })}
              </Banner>
            ) : (
              (problemBanner ??
              (api_ ? (
                <Banner tone="info" title={t('mockNewChat.apiTitle')}>
                  {t('mockNewChat.apiBody')}
                </Banner>
              ) : (
                <Banner tone="warning" title={t('mockNewChat.banTitle')}>
                  {t('mockNewChat.banBody')}
                </Banner>
              )))
            )}

            {!api_ && !offline && !limitReached && (
              <p className="text-xs text-muted-foreground" data-testid="new-chat-usage">
                {dailyLimit > 0
                  ? t('mockNewChat.usage', { used, limit: dailyLimit, inbox: inbox?.name ?? '' })
                  : t('mockNewChat.usageNoLimit', { used, inbox: inbox?.name ?? '' })}
              </p>
            )}
          </form>
        ) : (
          <TemplateStep
            templates={templates}
            selected={template}
            values={values}
            submitted={submitted}
            disabled={create.isPending}
            onChoose={choose}
            onValues={setValues}
            banner={problemBanner}
          />
        )}
        <MockControls scenario={state.scenario} labelId={ids.scenario} />
      </div>
    </ResponsiveDialog>
  );
}

function TemplateStep({
  templates,
  selected,
  values,
  submitted,
  disabled,
  onChoose,
  onValues,
  banner,
}: Readonly<{
  templates: MockTemplate[];
  selected: MockTemplate | null;
  values: string[];
  submitted: boolean;
  disabled: boolean;
  onChoose(template: MockTemplate): void;
  onValues(values: string[]): void;
  banner: React.ReactNode;
}>) {
  const { t } = useTranslation('inbox');
  if (templates.length === 0)
    return (
      <EmptyState title={t('mockWindow.emptyTitle')} description={t('mockWindow.emptyBody')} />
    );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Banner tone="info">{t('mockNewChat.paidNote')}</Banner>
      <fieldset
        className="flex min-w-0 flex-col gap-2"
        data-testid="new-chat-templates"
        disabled={disabled}
      >
        <legend className="mb-1 text-sm font-medium">{t('mockWindow.choose')}</legend>
        {templates.map((template) => (
          <Button
            key={`${template.name}-${template.language}`}
            type="button"
            variant="outline"
            aria-pressed={selected === template}
            disabled={!!template.header}
            onClick={() => onChoose(template)}
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
        <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled}>
          <legend className="mb-1 text-sm font-medium">{t('mockWindow.values')}</legend>
          {values.map((value, i) => {
            const id = `new-chat-value-${i}`;
            const error = submitted && !value.trim();
            return (
              <div key={id} className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={id}>{t('mockWindow.variable', { n: i + 1 })}</Label>
                <Input
                  id={id}
                  value={value}
                  maxLength={200}
                  className="h-11 text-base md:h-9 md:text-sm"
                  placeholder={selected.examples[i] ?? ''}
                  aria-invalid={error || undefined}
                  onChange={(e) => onValues(values.map((x, j) => (j === i ? e.target.value : x)))}
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
            data-testid="new-chat-preview"
          >
            {fillTemplate(selected.body, values)}
          </p>
        </div>
      )}
      {banner}
    </div>
  );
}

const SCENARIOS = [
  ['normal', 'normal'],
  ['disconnected', 'disconnected'],
  ['daily_limit', 'dailyLimit'],
  ['template_error', 'templateError'],
] as const satisfies readonly (readonly [NewChatScenario, string])[];

/** Dashed Mock only box: switch the scenario to see every state. */
function MockControls({
  scenario,
  labelId,
}: Readonly<{ scenario: NewChatScenario; labelId: string }>) {
  const { t } = useTranslation('inbox');
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (next: NewChatScenario) =>
      api<NewChatState>('/mock/new-chat/scenario', { method: 'PUT', body: { scenario: next } }),
    onSuccess: (data) => qc.setQueryData(newChatKey, data),
  });
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3"
      data-testid="new-chat-mock-controls"
    >
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {t('mockNewChat.mock.title')}
      </span>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelId}>
        {SCENARIOS.map(([value, key]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={scenario === value ? 'default' : 'outline'}
            aria-pressed={scenario === value}
            className="pointer-coarse:min-h-11"
            onClick={() => set.mutate(value)}
          >
            {t(`mockNewChat.mock.${key}`)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('mockNewChat.mock.hint')}</p>
    </div>
  );
}

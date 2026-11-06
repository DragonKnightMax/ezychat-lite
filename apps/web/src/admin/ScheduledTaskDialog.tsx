import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown, Play, User, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  SCHEDULED_TASK_INSTRUCTION_MAX,
  SCHEDULED_TASK_NAME_MAX,
  type ScheduledDayRule,
  type ScheduledPreviewResponse,
  type ScheduledTask,
  type ScheduledTaskChat,
} from '@ezychat/shared';
import { useChats } from '../api/queries';
import { ApiError, errorMessage } from '../api/client';
import {
  useCreateScheduledTask,
  usePreviewScheduledTask,
  useUpdateScheduledTask,
} from '../api/scheduled-tasks';
import { chatTitle } from '../inbox/chat-title';
import { Banner, ResponsiveDialog, SegmentedControl } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Pending } from './adminUi';
import { useScheduledFormat, WEEK } from './scheduled-format';

export function ChatIcon({
  type,
  className,
}: Readonly<{ type: ScheduledTaskChat['type']; className?: string }>) {
  const Icon = type === 'group' ? Users : User;
  return (
    <Icon className={cn('size-4 shrink-0 text-muted-foreground', className)} aria-hidden="true" />
  );
}

/** Waits until the admin stops typing: every search is a request for the chat list. */
function useDebounced(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Existing chats and groups of one inbox (the chat list, searched on the server), groups first. */
function ChatPicker({
  inboxId,
  value,
  onChange,
  invalid,
  describedBy,
}: Readonly<{
  inboxId: number;
  value: ScheduledTaskChat | null;
  onChange: (chat: ScheduledTaskChat) => void;
  invalid: boolean;
  describedBy?: string;
}>) {
  const { t } = useTranslation('admin');
  const { t: ti } = useTranslation('inbox');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const list = useChats({ assigned: 'any', inbox: inboxId, ...(q ? { q } : {}) });
  const chats: ScheduledTaskChat[] = (list.data?.pages[0]?.chats ?? []).map((chat) => ({
    jid: chat.jid,
    name: chatTitle(chat, ti),
    type: chat.type,
  }));
  const groups = chats.filter((c) => c.type === 'group');
  const people = chats.filter((c) => c.type === 'dm');
  const item = (chat: ScheduledTaskChat) => (
    <CommandItem
      key={chat.jid}
      value={chat.jid}
      onSelect={() => {
        onChange(chat);
        setOpen(false);
      }}
      className="pointer-coarse:min-h-11"
      data-testid="scheduled-chat-option"
    >
      <ChatIcon type={chat.type} />
      <span className="truncate">{chat.name}</span>
      {value?.jid === chat.jid && <Check className="ml-auto" aria-hidden="true" />}
    </CommandItem>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={`${id}-chat`}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-label={t('ai.scheduled.form.chat')}
          aria-describedby={describedBy}
          className="w-full min-w-0 justify-between font-normal pointer-coarse:min-h-11"
          data-testid="scheduled-chat"
        >
          <span className="flex min-w-0 items-center gap-2">
            {value ? (
              <>
                <ChatIcon type={value.type} />
                <span className="truncate">{value.name}</span>
              </>
            ) : (
              <span className="truncate text-muted-foreground">
                {t('ai.scheduled.form.chatPlaceholder')}
              </span>
            )}
          </span>
          <ChevronsUpDown className="opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter={false} className="bg-popover">
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t('ai.scheduled.form.chatSearch')}
            aria-label={t('ai.scheduled.form.chatSearch')}
            data-testid="scheduled-chat-search"
          />
          <CommandList className="max-h-64 overscroll-contain">
            {list.isPending ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('ai.scheduled.form.chatLoading')}
              </p>
            ) : (
              <CommandEmpty>{t('ai.scheduled.form.chatNone')}</CommandEmpty>
            )}
            {groups.length > 0 && (
              <CommandGroup heading={t('ai.scheduled.form.groups')}>
                {groups.map(item)}
              </CommandGroup>
            )}
            {people.length > 0 && (
              <CommandGroup heading={t('ai.scheduled.form.people')}>
                {people.map(item)}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** What the agent would do now: the look-ups, then the message or why it sends nothing. */
function PreviewBox({
  preview,
  chat,
  agentName,
}: Readonly<{ preview: ScheduledPreviewResponse; chat: ScheduledTaskChat; agentName: string }>) {
  const { t } = useTranslation('admin');
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3 text-sm"
      data-testid="scheduled-preview"
      aria-live="polite"
    >
      <p className="font-medium">{t('ai.scheduled.preview.title')}</p>
      {preview.lookups.map((lookup, i) => (
        <p key={i} className="text-muted-foreground">
          {t('ai.scheduled.preview.lookedUp', {
            name: agentName,
            title: lookup.title,
            source: lookup.sourceLabel,
          })}
        </p>
      ))}
      {preview.result === 'sent' && preview.text ? (
        <>
          <p className="text-muted-foreground">
            {t('ai.scheduled.preview.wouldSend', { chat: chat.name })}
          </p>
          <p className="rounded-md bg-primary/10 px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {preview.text}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          {t('ai.scheduled.preview.wouldSkip', {
            reason: t(`ai.scheduled.reason.${preview.reason ?? 'nothing_to_say'}`),
          })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('ai.scheduled.preview.nothingSent')}</p>
    </div>
  );
}

interface Draft {
  name: string;
  time: string;
  dayRule: ScheduledDayRule;
  days: number[];
  chat: ScheduledTaskChat | null;
  instruction: string;
}

const NEW_DRAFT: Draft = {
  name: '',
  time: '08:30',
  dayRule: 'weekdays',
  days: [1, 2, 3, 4, 5],
  chat: null,
  instruction: '',
};

/** Rounds a typed time to the 5-minute steps the server accepts. */
function toStep(value: string): string {
  const [h = 0, m = 0] = value.split(':').map(Number);
  const minutes = Math.min(23 * 60 + 55, h * 60 + Math.round(m / 5) * 5);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Add or edit a scheduled task: name, Send to (one existing chat or group of the agent's inbox),
 * time and days in the business time zone, the instruction, and Preview (one turn, nothing sent).
 */
export function ScheduledTaskDialog({
  agentId,
  agentName,
  task,
  inboxId,
  timeZone,
  max,
  onClose,
}: Readonly<{
  agentId: number;
  agentName: string;
  task: ScheduledTask | null;
  inboxId: number;
  timeZone: string;
  max: number;
  onClose: () => void;
}>) {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const f = useScheduledFormat(timeZone);
  const ids = useId();
  const create = useCreateScheduledTask(agentId);
  const update = useUpdateScheduledTask(agentId);
  const preview = usePreviewScheduledTask(agentId);
  const [draft, setDraft] = useState<Draft>(
    task
      ? {
          name: task.name,
          time: task.time,
          dayRule: task.dayRule,
          days: [...task.days],
          chat: task.chat,
          instruction: task.instruction,
        }
      : NEW_DRAFT,
  );
  const [tried, setTried] = useState(false);
  const [chatRefused, setChatRefused] = useState(false);
  const save = task ? update : create;
  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    preview.reset();
    if (p.chat) setChatRefused(false);
  };
  const errors = {
    name: !draft.name.trim(),
    chat: !draft.chat,
    days: draft.dayRule === 'custom' && draft.days.length === 0,
    instruction: !draft.instruction.trim(),
  };
  const valid = !Object.values(errors).some(Boolean);
  const submit = () => {
    setTried(true);
    if (!valid || !draft.chat) return;
    const fields = {
      name: draft.name.trim(),
      time: draft.time,
      dayRule: draft.dayRule,
      days: draft.dayRule === 'custom' ? [...draft.days].sort((a, b) => a - b) : [],
      chatJid: draft.chat.jid,
      instruction: draft.instruction.trim(),
    };
    const done = {
      onSuccess: () => {
        toast.success(task ? t('ai.scheduled.saved') : t('ai.scheduled.added'));
        onClose();
      },
      onError: (e: unknown) => {
        if (e instanceof ApiError && e.code === 'chat_not_in_inbox') setChatRefused(true);
      },
    };
    if (task) update.mutate({ taskId: task.id, patch: fields }, done);
    else create.mutate({ ...fields, enabled: true }, done);
  };
  const saveError =
    save.error instanceof ApiError && save.error.code === 'chat_not_in_inbox' ? null : save.error;
  const dayOptions: { value: ScheduledDayRule; label: string }[] = [
    { value: 'daily', label: t('ai.scheduled.days.daily') },
    { value: 'weekdays', label: t('ai.scheduled.days.weekdays') },
    { value: 'custom', label: t('ai.scheduled.days.custom') },
  ];
  const err = (on: boolean, text: string, id: string) =>
    on ? (
      <p id={id} className="text-sm text-destructive">
        {text}
      </p>
    ) : null;
  const canPreview = draft.chat !== null && draft.instruction.trim() !== '';

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && !save.isPending && onClose()}
      size="medium"
      title={task ? t('ai.scheduled.form.editTitle') : t('ai.scheduled.form.addTitle')}
      description={t('ai.scheduled.form.description', { name: agentName })}
      footer={
        <>
          <Button variant="outline" size="touch" onClick={onClose} disabled={save.isPending}>
            {tc('actions.cancel')}
          </Button>
          <Button
            size="touch"
            onClick={submit}
            disabled={save.isPending}
            data-testid="scheduled-save"
          >
            <Pending show={save.isPending} />
            {task ? t('ai.scheduled.form.save') : t('ai.scheduled.form.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 pb-2" data-testid="scheduled-dialog">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-name`}>{t('ai.scheduled.form.name')}</Label>
          <Input
            id={`${ids}-name`}
            value={draft.name}
            maxLength={SCHEDULED_TASK_NAME_MAX}
            placeholder={t('ai.scheduled.form.namePlaceholder')}
            aria-invalid={(tried && errors.name) || undefined}
            aria-describedby={tried && errors.name ? `${ids}-name-err` : undefined}
            onChange={(e) => patch({ name: e.target.value })}
            data-testid="scheduled-name"
          />
          {err(tried && errors.name, t('ai.scheduled.form.nameRequired'), `${ids}-name-err`)}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm leading-none font-medium select-none">
            {t('ai.scheduled.form.chat')}
          </span>
          <ChatPicker
            inboxId={inboxId}
            value={draft.chat}
            invalid={(tried && errors.chat) || chatRefused}
            describedBy={`${ids}-chat-hint`}
            onChange={(chat) => patch({ chat })}
          />
          <p id={`${ids}-chat-hint`} className="text-sm text-muted-foreground">
            {t('ai.scheduled.form.chatHint')}
          </p>
          {err(tried && errors.chat, t('ai.scheduled.form.chatRequired'), `${ids}-chat-err`)}
          {err(chatRefused, t('ai.scheduled.form.chatNotInInbox'), `${ids}-chat-refused`)}
        </div>

        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">{t('ai.scheduled.form.when')}</legend>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-time`}>{t('ai.scheduled.form.time')}</Label>
              <Input
                id={`${ids}-time`}
                type="time"
                step={300}
                className="w-36 pointer-coarse:min-h-11"
                value={draft.time}
                onChange={(e) => e.target.value && patch({ time: toStep(e.target.value) })}
                data-testid="scheduled-time"
              />
            </div>
            <p className="min-w-0 pb-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {t('ai.scheduled.form.timeZone', { zone: timeZone })}
            </p>
          </div>
          <span id={`${ids}-days`} className="sr-only">
            {t('ai.scheduled.form.days')}
          </span>
          <SegmentedControl
            aria-labelledby={`${ids}-days`}
            className="max-w-full"
            value={draft.dayRule}
            onValueChange={(dayRule) =>
              patch({
                dayRule,
                days: dayRule === 'custom' && draft.days.length === 0 ? [1] : draft.days,
              })
            }
            options={dayOptions}
          />
          {draft.dayRule === 'custom' && (
            <div className="flex flex-wrap gap-2" data-testid="scheduled-days">
              {WEEK.map((d) => {
                const on = draft.days.includes(d);
                return (
                  <Label
                    key={d}
                    className={cn(
                      'flex min-h-11 min-w-14 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 text-sm',
                      on && 'border-primary bg-primary/10',
                    )}
                  >
                    <Checkbox
                      checked={on}
                      onCheckedChange={(checked) =>
                        patch({
                          days:
                            checked === true
                              ? [...draft.days, d]
                              : draft.days.filter((x) => x !== d),
                        })
                      }
                    />
                    {f.day(d)}
                  </Label>
                );
              })}
            </div>
          )}
          {err(tried && errors.days, t('ai.scheduled.form.daysRequired'), `${ids}-days-err`)}
        </fieldset>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-instruction`}>{t('ai.scheduled.form.instruction')}</Label>
          <Textarea
            id={`${ids}-instruction`}
            rows={4}
            maxLength={SCHEDULED_TASK_INSTRUCTION_MAX}
            value={draft.instruction}
            placeholder={t('ai.scheduled.form.instructionPlaceholder')}
            aria-invalid={(tried && errors.instruction) || undefined}
            aria-describedby={`${ids}-ins-hint`}
            onChange={(e) => patch({ instruction: e.target.value })}
            data-testid="scheduled-instruction"
          />
          <p id={`${ids}-ins-hint`} className="text-sm text-muted-foreground">
            {t('ai.scheduled.form.instructionHint', { name: agentName })}
          </p>
          {err(
            tried && errors.instruction,
            t('ai.scheduled.form.instructionRequired'),
            `${ids}-ins-err`,
          )}
        </div>

        <div className="flex flex-col gap-3">
          <Button
            variant="outline"
            size="touch"
            className="self-start"
            disabled={!canPreview || preview.isPending}
            onClick={() => {
              if (!draft.chat) return;
              preview.mutate({ chatJid: draft.chat.jid, instruction: draft.instruction.trim() });
            }}
            data-testid="scheduled-preview-button"
          >
            {preview.isPending ? <Pending show /> : <Play aria-hidden="true" />}
            {t('ai.scheduled.form.preview')}
          </Button>
          {preview.data && draft.chat && (
            <PreviewBox preview={preview.data} chat={draft.chat} agentName={agentName} />
          )}
          {preview.error && (
            <Banner tone="danger" title={t('ai.scheduled.preview.failed')}>
              {errorMessage(preview.error)}
            </Banner>
          )}
        </div>

        {saveError && (
          <Banner tone="danger">
            {saveError instanceof ApiError && saveError.code === 'scheduled_task_limit'
              ? t('ai.scheduled.limitReached', { max })
              : errorMessage(saveError)}
          </Banner>
        )}
      </div>
    </ResponsiveDialog>
  );
}

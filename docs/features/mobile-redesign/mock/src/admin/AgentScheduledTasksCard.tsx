import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  CalendarClock,
  Check,
  ChevronsUpDown,
  History,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useChats } from '../api/queries';
import { api } from '../api/client';
import { chatTitle } from '../inbox/chat-title';
import { Banner, ResponsiveDialog, SegmentedControl } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './adminUi';
import {
  addRun,
  deleteTask,
  fillTasks,
  INSTRUCTION_CHARACTERS,
  MAX_TASKS,
  NAME_CHARACTERS,
  nextRun,
  noteRunNow,
  outcomeFor,
  pausedReason,
  resetScheduledTasks,
  runNowLeft,
  runsOf,
  saveTask,
  setConditions,
  setTaskEnabled,
  tasksOf,
  useScheduledTasks,
  type DayRule,
  type RunResult,
  type ScheduledTask,
  type TaskChat,
  type TaskDraft,
  type TaskOutcome,
  type TaskRun,
} from '../mock/scheduledTasks';

/** Rows shown before "Show all". */
const FOLDED = 5;
/** Monday first, as the business week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

const RESULT_TONE: Record<RunResult, string> = {
  sent: 'border-transparent bg-success/15 text-success',
  skipped: 'border-transparent bg-muted text-muted-foreground',
  failed: 'border-transparent bg-destructive/15 text-destructive',
};

function useFormat() {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const lang = i18n.language;
    const time = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number) as [number, number];
      const d = new Date(2026, 0, 5, h, m);
      return new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(d);
    };
    const when = (ms: number) =>
      new Intl.DateTimeFormat(lang, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(ms));
    const day = (d: number) =>
      new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(new Date(2026, 0, 4 + d));
    return { time, when, day };
  }, [i18n.language]);
}

/** "Weekdays · 8:30 am" / "Mon, Thu · 9:00 am". */
function useScheduleText() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  return (task: Pick<ScheduledTask, 'dayRule' | 'days' | 'time'>) => {
    const days =
      task.dayRule === 'daily'
        ? t('mockScheduled.days.daily')
        : task.dayRule === 'weekdays'
          ? t('mockScheduled.days.weekdays')
          : WEEK.filter((d) => task.days.includes(d))
              .map(f.day)
              .join(', ');
    return t('mockScheduled.scheduleLine', { days, time: f.time(task.time) });
  };
}

/**
 * Proposed (scheduled-tasks): agent page → Scheduled tasks. Each task sends one message from this
 * agent at a set time to one existing chat or group of its inbox. Paused while the agent is off, the
 * AI is not connected or WhatsApp is disconnected. A dashed Mock only box switches those states.
 */
export function AgentScheduledTasksCard({
  agent,
  name,
}: Readonly<{ agent: { id: string; enabled: boolean }; name: string }>) {
  const { t } = useTranslation('admin');
  const s = useScheduledTasks();
  const tasks = tasksOf(s, agent.id);
  const paused = pausedReason(agent.enabled, s.conditions);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null);
  const [history, setHistory] = useState<ScheduledTask | null>(null);
  const [running, setRunning] = useState<ScheduledTask | null>(null);
  const [removing, setRemoving] = useState<ScheduledTask | null>(null);
  const full = tasks.length >= MAX_TASKS;
  const shown = showAll ? tasks : tasks.slice(0, FOLDED);
  const chats = useInboxChats();

  return (
    <Card className="gap-4" data-testid="agent-scheduled-tasks">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockScheduled.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockScheduled.description', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {paused && (
          <Banner tone="warning" title={t('mockScheduled.paused.title')}>
            <span data-testid="scheduled-paused">
              {t(`mockScheduled.paused.${paused}`, { name })}
            </span>
          </Banner>
        )}

        {tasks.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center"
            data-testid="scheduled-empty"
          >
            <CalendarClock className="size-8 text-muted-foreground" aria-hidden="true" />
            <div>
              <p className="font-medium">{t('mockScheduled.empty.title')}</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {t('mockScheduled.empty.body', { name })}
              </p>
            </div>
            <Button onClick={() => setEditing('new')} data-testid="scheduled-add">
              <Plus aria-hidden="true" />
              {t('mockScheduled.add')}
            </Button>
          </div>
        ) : (
          <>
            <ul className="flex flex-col divide-y rounded-lg border" data-testid="scheduled-list">
              {shown.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  paused={paused !== null}
                  lastRun={runsOf(s, task.id)[0] ?? null}
                  onEdit={() => setEditing(task)}
                  onHistory={() => setHistory(task)}
                  onRun={() => setRunning(task)}
                  onDelete={() => setRemoving(task)}
                />
              ))}
            </ul>
            {tasks.length > FOLDED && (
              <Button
                variant="ghost"
                className="self-start"
                onClick={() => setShowAll((v) => !v)}
                data-testid="scheduled-show-all"
              >
                {showAll
                  ? t('mockScheduled.showFewer')
                  : t('mockScheduled.showAll', { count: tasks.length })}
              </Button>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground" data-testid="scheduled-count">
                {full
                  ? t('mockScheduled.limitReached', { max: MAX_TASKS })
                  : t('mockScheduled.count', { count: tasks.length, max: MAX_TASKS })}
              </p>
              <Button
                variant="outline"
                onClick={() => setEditing('new')}
                disabled={full}
                data-testid="scheduled-add"
              >
                <Plus aria-hidden="true" />
                {t('mockScheduled.add')}
              </Button>
            </div>
          </>
        )}

        <p className="text-sm text-muted-foreground">{t('mockScheduled.safety')}</p>

        <MockControls agentId={agent.id} chats={chats} />
      </CardContent>

      {editing && (
        <TaskDialog
          key={editing === 'new' ? 'new' : editing.id}
          agentId={agent.id}
          agentName={name}
          task={editing === 'new' ? null : editing}
          chats={chats}
          onClose={() => setEditing(null)}
        />
      )}
      {history && (
        <HistoryDialog
          task={history}
          runs={runsOf(s, history.id)}
          onClose={() => setHistory(null)}
        />
      )}
      {running && (
        <RunNowDialog
          task={running}
          agentName={name}
          paused={paused}
          onClose={() => setRunning(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t('mockScheduled.deleteTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('mockScheduled.delete')}
        danger
        onConfirm={() => {
          if (removing) deleteTask(removing.id);
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      >
        {t('mockScheduled.deleteBody')}
      </ConfirmDialog>
    </Card>
  );
}

/** The chats and groups of the agent's inbox (Lite: the one inbox), newest first. */
function useInboxChats(): TaskChat[] {
  const { t } = useTranslation('inbox');
  const list = useChats({ assigned: 'any' });
  const rows = list.data?.pages.flatMap((page) => page.chats) ?? [];
  return rows.map((chat) => ({
    jid: chat.jid,
    name: chatTitle(chat, t),
    type: chat.type === 'group' ? 'group' : 'dm',
  }));
}

function ChatIcon({ type, className }: Readonly<{ type: TaskChat['type']; className?: string }>) {
  const Icon = type === 'group' ? Users : User;
  return (
    <Icon className={cn('size-4 shrink-0 text-muted-foreground', className)} aria-hidden="true" />
  );
}

function TaskRow({
  task,
  paused,
  lastRun,
  onEdit,
  onHistory,
  onRun,
  onDelete,
}: Readonly<{
  task: ScheduledTask;
  paused: boolean;
  lastRun: TaskRun | null;
  onEdit: () => void;
  onHistory: () => void;
  onRun: () => void;
  onDelete: () => void;
}>) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const schedule = useScheduleText();
  const switchId = useId();
  const next = task.enabled && !paused ? nextRun(task) : null;
  return (
    <li className="flex items-start gap-3 px-3 py-3" data-testid="scheduled-row">
      <div className="min-w-0 flex-1">
        <Button
          variant="link"
          className="h-auto max-w-full justify-start p-0 text-left font-medium whitespace-normal text-foreground [overflow-wrap:anywhere] pointer-coarse:min-h-11"
          onClick={onEdit}
          data-testid="scheduled-name-link"
        >
          {task.name}
        </Button>
        <p className="mt-0.5 text-sm text-muted-foreground">{schedule(task)}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <ChatIcon type={task.chat.type} />
          <span className="truncate">{task.chat.name}</span>
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {!task.enabled ? (
            <span>{t('mockScheduled.off')}</span>
          ) : paused ? (
            <span className="text-warning">{t('mockScheduled.pausedShort')}</span>
          ) : (
            next && <span>{t('mockScheduled.next', { when: f.when(next) })}</span>
          )}
          {lastRun && (
            <Button
              variant="link"
              onClick={onHistory}
              className="h-auto gap-1.5 p-0 text-xs font-normal text-muted-foreground pointer-coarse:min-h-11"
              aria-label={t('mockScheduled.lastRun', {
                result: t(`mockScheduled.result.${lastRun.result}`),
                when: f.when(lastRun.at),
              })}
            >
              <Badge variant="outline" className={RESULT_TONE[lastRun.result]}>
                {t(`mockScheduled.result.${lastRun.result}`)}
              </Badge>
              {f.when(lastRun.at)}
            </Button>
          )}
        </div>
      </div>
      <Label
        htmlFor={switchId}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
      >
        <span className="sr-only">{t('mockScheduled.switchLabel', { name: task.name })}</span>
        <Switch
          id={switchId}
          checked={task.enabled}
          onCheckedChange={(on) => setTaskEnabled(task.id, on)}
          data-testid="scheduled-switch"
        />
      </Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 pointer-coarse:size-11"
            aria-label={t('mockScheduled.actions', { name: task.name })}
            data-testid="scheduled-menu"
          >
            <MoreVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil aria-hidden="true" />
            {t('mockScheduled.edit')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRun} data-testid="scheduled-run-now">
            <Play aria-hidden="true" />
            {t('mockScheduled.runNow')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onHistory} data-testid="scheduled-history">
            <History aria-hidden="true" />
            {t('mockScheduled.history')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 aria-hidden="true" />
            {t('mockScheduled.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function ChatPicker({
  value,
  chats,
  onChange,
  invalid,
}: Readonly<{
  value: TaskChat | null;
  chats: TaskChat[];
  onChange: (chat: TaskChat) => void;
  invalid: boolean;
}>) {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  const groups = chats.filter((c) => c.type === 'group');
  const people = chats.filter((c) => c.type === 'dm');
  const item = (chat: TaskChat) => (
    <CommandItem
      key={chat.jid}
      value={`${chat.name} ${chat.jid}`}
      onSelect={() => {
        onChange(chat);
        setOpen(false);
      }}
      className="pointer-coarse:min-h-11"
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
          id="scheduled-chat"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          className="w-full justify-between font-normal"
          data-testid="scheduled-chat"
        >
          <span className="flex min-w-0 items-center gap-2">
            {value ? (
              <>
                <ChatIcon type={value.type} />
                <span className="truncate">{value.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">
                {t('mockScheduled.form.chatPlaceholder')}
              </span>
            )}
          </span>
          <ChevronsUpDown className="opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder={t('mockScheduled.form.chatSearch')} />
          <CommandList>
            <CommandEmpty>{t('mockScheduled.form.chatNone')}</CommandEmpty>
            {groups.length > 0 && (
              <CommandGroup heading={t('mockScheduled.form.groups')}>
                {groups.map(item)}
              </CommandGroup>
            )}
            {people.length > 0 && (
              <CommandGroup heading={t('mockScheduled.form.people')}>
                {people.map(item)}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function OutcomeBox({
  outcome,
  chat,
  agentName,
}: Readonly<{ outcome: TaskOutcome; chat: TaskChat; agentName: string }>) {
  const { t } = useTranslation('admin');
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3 text-sm"
      data-testid="scheduled-preview"
      aria-live="polite"
    >
      <p className="font-medium">{t('mockScheduled.preview.title')}</p>
      {outcome.lookup && (
        <p className="text-muted-foreground">
          {t('mockScheduled.preview.lookedUp', {
            name: agentName,
            title: outcome.lookup.title,
            source: outcome.lookup.source,
          })}
        </p>
      )}
      {outcome.result === 'sent' && outcome.text ? (
        <>
          <p className="text-muted-foreground">
            {t('mockScheduled.preview.wouldSend', { chat: chat.name })}
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-primary/10 px-3 py-2 [overflow-wrap:anywhere]">
            {outcome.text}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          {t('mockScheduled.preview.wouldSkip', {
            reason: t(`mockScheduled.reason.${outcome.reason ?? 'nothing_to_say'}`),
          })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('mockScheduled.preview.nothingSent')}</p>
    </div>
  );
}

function TaskDialog({
  agentId,
  agentName,
  task,
  chats,
  onClose,
}: Readonly<{
  agentId: string;
  agentName: string;
  task: ScheduledTask | null;
  chats: TaskChat[];
  onClose: () => void;
}>) {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const f = useFormat();
  const { conditions } = useScheduledTasks();
  const ids = useId();
  const [draft, setDraft] = useState<TaskDraft>(
    task
      ? { ...task }
      : {
          name: '',
          enabled: true,
          time: '08:30',
          dayRule: 'weekdays',
          days: [1, 2, 3, 4, 5],
          chat: null as unknown as TaskChat,
          instruction: '',
        },
  );
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState<TaskOutcome | null>(null);
  const patch = (p: Partial<TaskDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setPreview(null);
  };
  const errors = {
    name: !draft.name.trim(),
    chat: !draft.chat,
    days: draft.dayRule === 'custom' && draft.days.length === 0,
    instruction: !draft.instruction.trim(),
  };
  const valid = !Object.values(errors).some(Boolean);
  const save = () => {
    setTried(true);
    if (!valid) return;
    saveTask(agentId, task?.id ?? null, {
      ...draft,
      name: draft.name.trim(),
      instruction: draft.instruction.trim(),
    });
    toast.success(task ? t('mockScheduled.saved') : t('mockScheduled.added'));
    onClose();
  };
  const dayOptions: { value: DayRule; label: string }[] = [
    { value: 'daily', label: t('mockScheduled.days.daily') },
    { value: 'weekdays', label: t('mockScheduled.days.weekdays') },
    { value: 'custom', label: t('mockScheduled.days.custom') },
  ];
  const err = (on: boolean, text: string, id: string) =>
    tried && on ? (
      <p id={id} className="text-sm text-destructive">
        {text}
      </p>
    ) : null;

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="medium"
      title={task ? t('mockScheduled.form.editTitle') : t('mockScheduled.form.addTitle')}
      description={t('mockScheduled.form.description', { name: agentName })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {tc('actions.cancel')}
          </Button>
          <Button onClick={save} data-testid="scheduled-save">
            {task ? t('mockScheduled.form.save') : t('mockScheduled.form.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 pb-2" data-testid="scheduled-dialog">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-name`}>{t('mockScheduled.form.name')}</Label>
          <Input
            id={`${ids}-name`}
            value={draft.name}
            maxLength={NAME_CHARACTERS}
            placeholder={t('mockScheduled.form.namePlaceholder')}
            aria-invalid={(tried && errors.name) || undefined}
            onChange={(e) => patch({ name: e.target.value })}
            data-testid="scheduled-name"
          />
          {err(errors.name, t('mockScheduled.form.nameRequired'), `${ids}-name-err`)}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="scheduled-chat">{t('mockScheduled.form.chat')}</Label>
          <ChatPicker
            value={draft.chat}
            chats={chats}
            invalid={tried && errors.chat}
            onChange={(chat) => patch({ chat })}
          />
          <p className="text-sm text-muted-foreground">{t('mockScheduled.form.chatHint')}</p>
          {err(errors.chat, t('mockScheduled.form.chatRequired'), `${ids}-chat-err`)}
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">{t('mockScheduled.form.when')}</legend>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-time`}>{t('mockScheduled.form.time')}</Label>
              <Input
                id={`${ids}-time`}
                type="time"
                step={300}
                className="w-36"
                value={draft.time}
                onChange={(e) => e.target.value && patch({ time: e.target.value })}
                data-testid="scheduled-time"
              />
            </div>
            <p className="pb-2 text-sm text-muted-foreground">
              {t('mockScheduled.form.timeZone', { time: f.time(draft.time) })}
            </p>
          </div>
          <span id={`${ids}-days`} className="sr-only">
            {t('mockScheduled.form.days')}
          </span>
          <SegmentedControl
            aria-labelledby={`${ids}-days`}
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
                          days: checked ? [...draft.days, d] : draft.days.filter((x) => x !== d),
                        })
                      }
                    />
                    {f.day(d)}
                  </Label>
                );
              })}
            </div>
          )}
          {err(errors.days, t('mockScheduled.form.daysRequired'), `${ids}-days-err`)}
        </fieldset>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-instruction`}>{t('mockScheduled.form.instruction')}</Label>
          <Textarea
            id={`${ids}-instruction`}
            rows={4}
            maxLength={INSTRUCTION_CHARACTERS}
            value={draft.instruction}
            placeholder={t('mockScheduled.form.instructionPlaceholder')}
            aria-invalid={(tried && errors.instruction) || undefined}
            onChange={(e) => patch({ instruction: e.target.value })}
            data-testid="scheduled-instruction"
          />
          <p className="text-sm text-muted-foreground">
            {t('mockScheduled.form.instructionHint', { name: agentName })}
          </p>
          {err(errors.instruction, t('mockScheduled.form.instructionRequired'), `${ids}-ins-err`)}
        </div>

        <div className="flex flex-col gap-3">
          <Button
            variant="outline"
            className="self-start"
            disabled={!draft.chat || !draft.instruction.trim()}
            onClick={() => setPreview(outcomeFor(draft, conditions))}
            data-testid="scheduled-preview-button"
          >
            <Play aria-hidden="true" />
            {t('mockScheduled.form.preview')}
          </Button>
          {preview && draft.chat && (
            <OutcomeBox outcome={preview} chat={draft.chat} agentName={agentName} />
          )}
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function RunNowDialog({
  task,
  agentName,
  paused,
  onClose,
}: Readonly<{
  task: ScheduledTask;
  agentName: string;
  paused: ReturnType<typeof pausedReason>;
  onClose: () => void;
}>) {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const s = useScheduledTasks();
  const left = runNowLeft(s, task.id);
  const [busy, setBusy] = useState(false);
  const blocked = paused ?? (left === 0 ? 'rate' : null);
  const run = async () => {
    setBusy(true);
    noteRunNow(task.id);
    const outcome = outcomeFor(task, s.conditions);
    const base = { taskId: task.id, at: Date.now(), trigger: 'run_now' as const, by: 'Aisyah' };
    try {
      if (outcome.result === 'sent' && outcome.text) {
        await api('/mock/scheduled-tasks/send', {
          method: 'POST',
          body: {
            chatJid: task.chat.jid,
            taskId: task.id,
            text: outcome.text,
            lookup: outcome.lookup,
          },
        });
        addRun({ ...base, result: 'sent', reason: null, text: outcome.text });
        toast.success(t('mockScheduled.runNowSent', { chat: task.chat.name }), {
          action: {
            label: t('mockScheduled.openChat'),
            onClick: () => window.location.assign(`/chats/${encodeURIComponent(task.chat.jid)}`),
          },
        });
      } else {
        addRun({ ...base, result: outcome.result, reason: outcome.reason, text: null });
        toast(
          t('mockScheduled.runNowSkipped', {
            reason: t(`mockScheduled.reason.${outcome.reason ?? 'nothing_to_say'}`),
          }),
        );
      }
    } catch {
      addRun({ ...base, result: 'failed', reason: 'send_failed', text: null });
      toast.error(t('mockScheduled.reason.send_failed'));
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('mockScheduled.runNowTitle', { chat: task.chat.name })}
      description={t('mockScheduled.runNowBody', { name: agentName })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {tc('actions.cancel')}
          </Button>
          <Button
            onClick={() => void run()}
            disabled={busy || blocked !== null}
            data-testid="scheduled-run-confirm"
          >
            <Play aria-hidden="true" />
            {t('mockScheduled.runNow')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2 text-sm">
        {blocked === 'rate' ? (
          <Banner tone="warning">{t('mockScheduled.runNowLimit')}</Banner>
        ) : blocked ? (
          <Banner tone="warning">
            {t(`mockScheduled.paused.${blocked}`, { name: agentName })}
          </Banner>
        ) : (
          <p className="text-muted-foreground">{t('mockScheduled.runNowLeft', { count: left })}</p>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function HistoryDialog({
  task,
  runs,
  onClose,
}: Readonly<{ task: ScheduledTask; runs: TaskRun[]; onClose: () => void }>) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="medium"
      title={t('mockScheduled.historyTitle', { name: task.name })}
      description={t('mockScheduled.historyBody')}
    >
      {runs.length === 0 ? (
        <p className="pb-4 text-sm text-muted-foreground" data-testid="scheduled-history-empty">
          {t('mockScheduled.historyEmpty')}
        </p>
      ) : (
        <ol className="flex flex-col divide-y pb-2" data-testid="scheduled-history-list">
          {runs.slice(0, 30).map((run) => (
            <li key={run.id} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={RESULT_TONE[run.result]}>
                  {t(`mockScheduled.result.${run.result}`)}
                </Badge>
                <span className="text-sm font-medium">{f.when(run.at)}</span>
                {run.trigger === 'run_now' && (
                  <span className="text-xs text-muted-foreground">
                    {t('mockScheduled.byRunNow', { name: run.by ?? '' })}
                  </span>
                )}
              </div>
              {run.reason && (
                <p className="text-sm text-muted-foreground">
                  {t(`mockScheduled.reason.${run.reason}`)}
                </p>
              )}
              {run.result === 'sent' && (
                <Link
                  to={`/chats/${encodeURIComponent(task.chat.jid)}`}
                  className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11"
                >
                  {t('mockScheduled.openChatNamed', { chat: task.chat.name })}
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
    </ResponsiveDialog>
  );
}

function MockControls({ agentId, chats }: Readonly<{ agentId: string; chats: TaskChat[] }>) {
  const { t } = useTranslation('admin');
  const { conditions } = useScheduledTasks();
  const ids = useId();
  const row = (key: 'aiConnected' | 'waConnected' | 'nothingToday' | 'windowClosed') => (
    <div className="flex items-center justify-between gap-3" key={key}>
      <Label htmlFor={`${ids}-${key}`} className="font-normal">
        {t(`mockScheduled.mock.${key}`)}
      </Label>
      <Label
        htmlFor={`${ids}-${key}`}
        className="flex min-h-11 min-w-11 items-center justify-center"
      >
        <Switch
          id={`${ids}-${key}`}
          checked={conditions[key]}
          onCheckedChange={(on) => setConditions({ [key]: on })}
          data-testid={`scheduled-mock-${key}`}
        />
      </Label>
    </div>
  );
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-dashed px-3 py-3 text-sm"
      data-testid="scheduled-mock"
    >
      <p className="font-medium text-muted-foreground">{t('mockScheduled.mock.title')}</p>
      {(['aiConnected', 'waConnected', 'nothingToday', 'windowClosed'] as const).map(row)}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => fillTasks(agentId, chats.slice(0, 6))}
          data-testid="scheduled-mock-fill"
        >
          {t('mockScheduled.mock.fill')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetScheduledTasks}
          data-testid="scheduled-mock-reset"
        >
          {t('mockScheduled.mock.reset')}
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  FileText,
  Lock,
  LockOpen,
  NotebookText,
  Plus,
  Search,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AI_CONTEXT_CHARACTERS,
  AI_CONTEXT_NAME_CHARACTERS,
  AiContextTextBody,
  codePointLength,
} from '@ezychat/shared';
import { Banner, ResponsiveDialog } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  AGENT_INTERNAL_CHARACTERS,
  AGENT_ITEMS,
  addItem,
  internalTooLarge,
  removeItems,
  updateItem,
  type MockAgentItem,
} from '../mock/agents';
import { ConfirmDialog, Field } from './adminUi';
import { InfoTip } from '@/components/app/InfoTip';

const UPLOAD_ACCEPT = '.txt,.md,.pdf,.docx';
const UPLOAD_BYTES = 10 * 1024 * 1024;
const CONFIRM_NAMES = 5;

type Filter = 'all' | 'customer' | 'internal';
type Open =
  | { kind: 'item'; id: string }
  | { kind: 'addText' }
  | { kind: 'addFile'; name: string; size: number; text: string }
  | null;

/**
 * Proposed (custom-agents): the Business context of ONE agent (no shared knowledge). Each item can be
 * Internal (rule B): the agent may use it to decide, never quote it. Mock: items live in the browser.
 */
export function AgentContextPanel({
  agentId,
  items,
  disabled = false,
}: Readonly<{ agentId: string; items: MockAgentItem[]; disabled?: boolean }>) {
  const { t } = useTranslation('admin');
  const titleId = useId();
  const filterId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Open>(null);
  const [confirm, setConfirm] = useState<MockAgentItem[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // Round 2: the 10,000-character Internal rule, shown inside the open dialog.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const tooLargeText = t('mockAgents.context.internalTooLarge', {
    max: formatNumber(AGENT_INTERNAL_CHARACTERS),
  });
  useEffect(() => setDialogError(null), [open]);

  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(items.map((i) => i.id));
      const kept = [...current].filter((id) => ids.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [items]);

  const full = items.length >= AGENT_ITEMS;
  const internalCount = items.filter((i) => i.internal).length;
  const needle = query.trim().toLocaleLowerCase();
  const shown = items.filter(
    (i) =>
      (filter === 'all' || (filter === 'internal') === i.internal) &&
      (!needle || i.name.toLocaleLowerCase().includes(needle)),
  );

  const pickFile = async (file: File) => {
    setLocalError(null);
    if (!/\.(txt|md|pdf|docx)$/i.test(file.name)) return setLocalError(t('ai.fileTypeError'));
    if (file.size > UPLOAD_BYTES) return setLocalError(t('ai.fileSizeError'));
    // Mock: plain text files are read; PDF/Word text extraction is simulated.
    const text = /\.(txt|md)$/i.test(file.name)
      ? await file.text()
      : `${file.name}\n\n(Mock: the text extracted from this file is shown here.)`;
    setOpen({ kind: 'addFile', name: file.name, size: file.size, text });
  };

  const remove = (list: MockAgentItem[]) => {
    removeItems(
      agentId,
      list.map((i) => i.id),
    );
    toast.success(t('ai.contextPanel.deleted', { count: list.length }));
    setConfirm(null);
    setSelecting(false);
    setSelected(new Set());
  };
  const namesOf = (list: MockAgentItem[]) => {
    const names = list
      .slice(0, CONFIRM_NAMES)
      .map((i) => i.name)
      .join(', ');
    return list.length > CONFIRM_NAMES
      ? t('ai.contextPanel.namesMore', { names, count: list.length - CONFIRM_NAMES })
      : names;
  };
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const activate = (item: MockAgentItem) => {
    if (selecting) toggle(item.id);
    else setOpen({ kind: 'item', id: item.id });
  };
  const kindIcon = (item: MockAgentItem) => {
    const Icon = item.kind === 'file' ? FileText : NotebookText;
    const label =
      item.kind === 'file' ? t('ai.contextPanel.kindFile') : t('ai.contextPanel.kindText');
    return <Icon role="img" aria-label={label} className="size-4 shrink-0 text-muted-foreground" />;
  };
  /** Round 2: "Mark as Internal" / "Mark as customer-facing" from the list (only `internal` changes). */
  const flipInternal = (item: MockAgentItem) => {
    const internal = !item.internal;
    if (internalTooLarge(items, { id: item.id, internal, text: item.text }))
      return setLocalError(tooLargeText);
    setLocalError(null);
    updateItem(agentId, item.id, { internal });
    toast.success(
      internal
        ? t('mockAgents.context.markedInternal', { name: item.name })
        : t('mockAgents.context.markedCustomer', { name: item.name }),
    );
  };
  const internalButton = (item: MockAgentItem) => {
    const Icon = item.internal ? LockOpen : Lock;
    return (
      <Button
        variant="ghost"
        size="icon-touch"
        className="shrink-0 md:size-8"
        disabled={disabled}
        title={
          item.internal
            ? t('mockAgents.context.markCustomer')
            : t('mockAgents.context.markInternal')
        }
        aria-label={
          item.internal
            ? t('mockAgents.context.markCustomerFor', { name: item.name })
            : t('mockAgents.context.markInternalFor', { name: item.name })
        }
        data-testid="item-internal-toggle"
        onClick={() => flipInternal(item)}
      >
        <Icon aria-hidden />
      </Button>
    );
  };
  const added = (item: MockAgentItem) =>
    t('ai.contextPanel.added', { when: formatRelative(item.createdAt) });
  const selectBox = (item: MockAgentItem) => (
    <label className="flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11">
      <Checkbox
        checked={selected.has(item.id)}
        aria-label={t('ai.contextPanel.selectItem', { name: item.name })}
        onCheckedChange={() => toggle(item.id)}
      />
    </label>
  );

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="touch" className="md:min-h-9" disabled={disabled || full}>
          <Plus aria-hidden />
          {t('ai.contextPanel.add')}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="pointer-coarse:min-h-11"
          onSelect={() => fileInput.current?.click()}
        >
          <Upload aria-hidden />
          {t('ai.contextPanel.upload')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="pointer-coarse:min-h-11"
          onSelect={() => setOpen({ kind: 'addText' })}
        >
          <NotebookText aria-hidden />
          {t('ai.contextPanel.addText')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const current = open?.kind === 'item' ? items.find((i) => i.id === open.id) : undefined;

  return (
    <Card className="gap-4" data-testid="agent-context">
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle id={titleId}>{t('ai.page.stepContext')}</CardTitle>
          <InfoTip topic="businessContext" />
        </div>
        <CardDescription>
          {t('ai.contextPanel.hint')}
          <span className="mt-1 block">{t('mockAgents.context.internalHint')}</span>
          <span className="mt-1 block text-xs">{t('ai.contextPanel.limits')}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <input
          ref={fileInput}
          type="file"
          hidden
          accept={UPLOAD_ACCEPT}
          data-testid="agent-context-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void pickFile(file);
          }}
        />
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">{t('ai.contextPanel.empty')}</p>
            {addMenu}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span id={filterId} className="text-sm text-muted-foreground">
                  {t('mockAgents.context.filterLabel')}
                </span>
                <SegmentedControl<Filter>
                  size="sm"
                  aria-labelledby={filterId}
                  value={filter}
                  onValueChange={(next) => {
                    setFilter(next);
                    setSelected(new Set());
                  }}
                  options={[
                    {
                      value: 'all',
                      label: t('mockAgents.context.filterAll', { count: items.length }),
                    },
                    {
                      value: 'customer',
                      label: t('mockAgents.context.filterCustomer', {
                        count: items.length - internalCount,
                      }),
                    },
                    {
                      value: 'internal',
                      label: t('mockAgents.context.filterInternal', { count: internalCount }),
                    },
                  ]}
                  className="max-w-full flex-wrap"
                />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {selecting ? (
                  <>
                    <Button
                      variant="destructive"
                      size="touch"
                      className="md:min-h-9"
                      disabled={disabled || selected.size === 0}
                      onClick={() => setConfirm(items.filter((i) => selected.has(i.id)))}
                    >
                      {t('ai.contextPanel.deleteSelected', { count: selected.size })}
                    </Button>
                    <Button
                      variant="outline"
                      size="touch"
                      className="md:min-h-9"
                      onClick={() => {
                        setSelecting(false);
                        setSelected(new Set());
                      }}
                    >
                      {t('ai.contextPanel.cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant={searching ? 'secondary' : 'ghost'}
                      size="icon-touch"
                      className="md:size-9"
                      aria-label={t('ai.contextPanel.search')}
                      aria-pressed={searching}
                      onClick={() => {
                        setSearching((on) => !on);
                        setQuery('');
                      }}
                    >
                      <Search aria-hidden />
                    </Button>
                    <Button
                      variant="outline"
                      size="touch"
                      className="md:min-h-9"
                      disabled={disabled}
                      onClick={() => {
                        setSearching(false);
                        setQuery('');
                        setSelecting(true);
                      }}
                    >
                      {t('ai.contextPanel.select')}
                    </Button>
                    {addMenu}
                  </>
                )}
              </div>
            </div>
            {searching && (
              <SearchField
                value={query}
                onChange={setQuery}
                label={t('ai.contextPanel.search')}
                placeholder={t('ai.contextPanel.searchPlaceholder')}
              />
            )}
            {full && (
              <p className="text-sm text-muted-foreground">{t('ai.contextPanel.limitReached')}</p>
            )}
            {shown.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {needle
                  ? t('ai.contextPanel.noMatches', { query: query.trim() })
                  : t('mockAgents.context.filterEmpty')}
              </p>
            ) : (
              <>
                <div data-slot="context-table" className="hidden rounded-lg border sm:block">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        {selecting && <TableHead className="w-12" />}
                        <TableHead className="w-10">
                          <span className="sr-only">{t('ai.contextPanel.type')}</span>
                        </TableHead>
                        <TableHead>{t('ai.contextPanel.name')}</TableHead>
                        <TableHead className="w-24">{t('ai.contextPanel.size')}</TableHead>
                        <TableHead className="w-44">{t('ai.contextPanel.details')}</TableHead>
                        {!selecting && (
                          <TableHead className="w-14">
                            <span className="sr-only">{t('mockAgents.context.audience')}</span>
                          </TableHead>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((item) => (
                        <TableRow
                          key={item.id}
                          data-state={selected.has(item.id) ? 'selected' : undefined}
                          className="cursor-pointer"
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('button,label')) return;
                            activate(item);
                          }}
                        >
                          {selecting && <TableCell>{selectBox(item)}</TableCell>}
                          <TableCell>{kindIcon(item)}</TableCell>
                          <TableCell className="min-w-0">
                            <span className="flex min-w-0 items-center gap-2">
                              <Button
                                variant="link"
                                className="h-auto min-w-0 shrink justify-start p-0 font-medium text-foreground pointer-coarse:min-h-11"
                                onClick={() => activate(item)}
                              >
                                <span className="truncate" title={item.name}>
                                  {item.name}
                                </span>
                              </Button>
                              {item.internal && <InternalBadge />}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatBytes(item.size)}
                          </TableCell>
                          <TableCell
                            className="truncate text-muted-foreground"
                            title={formatDateTime(item.createdAt)}
                          >
                            {added(item)}
                          </TableCell>
                          {!selecting && <TableCell>{internalButton(item)}</TableCell>}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <ul aria-labelledby={titleId} className="flex flex-col gap-2 sm:hidden">
                  {shown.map((item) => (
                    <li
                      key={item.id}
                      className={cn(
                        'flex min-w-0 items-center gap-1 rounded-lg border bg-card',
                        selected.has(item.id) && 'border-primary',
                      )}
                    >
                      {selecting && selectBox(item)}
                      <Button
                        variant="ghost"
                        className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-3 px-3 py-2 text-left font-normal"
                        onClick={() => activate(item)}
                      >
                        {kindIcon(item)}
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate font-medium" title={item.name}>
                            {item.name}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {t('ai.contextPanel.meta', {
                              size: formatBytes(item.size),
                              added: added(item),
                            })}
                          </span>
                          {item.internal && (
                            <span>
                              <InternalBadge />
                            </span>
                          )}
                        </span>
                      </Button>
                      {!selecting && internalButton(item)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {localError && <Banner tone="danger">{localError}</Banner>}
      </CardContent>

      {open?.kind === 'addText' && (
        <TextItemDialog
          title={t('ai.contextPanel.addTextTitle')}
          initial={{ name: '', text: '', internal: false }}
          error={dialogError}
          onClose={() => setOpen(null)}
          onSave={(body) => {
            if (internalTooLarge(items, { id: null, ...body })) return setDialogError(tooLargeText);
            addItem(agentId, {
              kind: 'text',
              ...body,
              size: new TextEncoder().encode(body.text).length,
            });
            toast.success(t('ai.contextPanel.textAdded'));
            setOpen(null);
          }}
        />
      )}
      {open?.kind === 'addFile' && (
        <FileItemDialog
          title={t('mockAgents.context.addFileTitle')}
          name={open.name}
          text={open.text}
          initialInternal={false}
          isNew
          onClose={() => setOpen(null)}
          error={dialogError}
          onSave={(internal) => {
            if (internalTooLarge(items, { id: null, internal, text: open.text }))
              return setDialogError(tooLargeText);
            addItem(agentId, {
              kind: 'file',
              name: open.name,
              text: open.text,
              size: open.size,
              internal,
            });
            toast.success(t('ai.contextPanel.fileAdded'));
            setOpen(null);
          }}
        />
      )}
      {current?.kind === 'text' && (
        <TextItemDialog
          title={current.name}
          initial={{ name: current.name, text: current.text, internal: current.internal }}
          error={dialogError}
          onClose={() => setOpen(null)}
          onSave={(body) => {
            if (internalTooLarge(items, { id: current.id, ...body }))
              return setDialogError(tooLargeText);
            updateItem(agentId, current.id, {
              ...body,
              size: new TextEncoder().encode(body.text).length,
            });
            toast.success(t('ai.contextPanel.changesSaved'));
            setOpen(null);
          }}
          onDelete={() => {
            setOpen(null);
            setConfirm([current]);
          }}
        />
      )}
      {current?.kind === 'file' && (
        <FileItemDialog
          title={current.name}
          name={current.name}
          text={current.text}
          initialInternal={current.internal}
          onClose={() => setOpen(null)}
          error={dialogError}
          onSave={(internal) => {
            if (internalTooLarge(items, { id: current.id, internal, text: current.text }))
              return setDialogError(tooLargeText);
            updateItem(agentId, current.id, { internal });
            toast.success(t('mockAgents.context.fileSaved'));
            setOpen(null);
          }}
          onDelete={() => {
            setOpen(null);
            setConfirm([current]);
          }}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        danger
        title={
          confirm?.length === 1
            ? t('ai.contextPanel.confirmOne', { name: confirm[0]!.name })
            : t('ai.contextPanel.confirmMany', { count: confirm?.length ?? 0 })
        }
        confirmLabel={t('ai.contextPanel.delete')}
        onConfirm={() => confirm && remove(confirm)}
        onClose={() => setConfirm(null)}
      >
        {confirm && confirm.length > 1 && <p className="mb-2 break-words">{namesOf(confirm)}</p>}
        {t('ai.contextPanel.confirmText')}
      </ConfirmDialog>
    </Card>
  );
}

/** "Internal" badge: used to decide, never told to customers. */
export function InternalBadge() {
  const { t } = useTranslation('admin');
  return (
    <Badge
      className="shrink-0 gap-1 bg-warning/15 text-foreground"
      title={t('mockAgents.context.internalBadgeTitle')}
      data-testid="internal-badge"
    >
      <Lock aria-hidden className="size-3" />
      {t('mockAgents.context.internal')}
    </Badge>
  );
}

/** The Internal switch shared by the text and the file dialog. */
function InternalSwitch({
  checked,
  onCheckedChange,
}: Readonly<{ checked: boolean; onCheckedChange: (checked: boolean) => void }>) {
  const { t } = useTranslation('admin');
  const id = useId();
  const hintId = useId();
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3',
        checked && 'border-warning/60 bg-warning/10',
      )}
    >
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={hintId}
        className="mt-0.5"
        data-testid="internal-switch"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id} className="inline-flex items-center gap-1.5 pointer-coarse:min-h-11">
          <Lock aria-hidden className="size-3.5" />
          {t('mockAgents.context.internal')}
        </Label>
        <p id={hintId} className="text-sm text-muted-foreground">
          {t('mockAgents.context.internalHint')}
        </p>
      </div>
    </div>
  );
}

type TextDraft = { name: string; text: string; internal: boolean };

/** Name + text editor (and the Internal switch) for adding or editing a text item. */
function TextItemDialog({
  title,
  initial,
  error,
  onClose,
  onSave,
  onDelete,
}: Readonly<{
  title: string;
  initial: TextDraft;
  error?: string | null;
  onClose: () => void;
  onSave: (body: TextDraft) => void;
  onDelete?: () => void;
}>) {
  const { t } = useTranslation('admin');
  const formId = useId();
  const [draft, setDraft] = useState(initial);
  const valid = AiContextTextBody.safeParse({ name: draft.name, text: draft.text }).success;
  const changed =
    draft.name !== initial.name ||
    draft.text !== initial.text ||
    draft.internal !== initial.internal;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = AiContextTextBody.safeParse({ name: draft.name, text: draft.text });
    if (!parsed.success) return;
    onSave({ ...parsed.data, internal: draft.internal });
  };
  return (
    <ResponsiveDialog
      open
      size="wide"
      onOpenChange={(o) => !o && onClose()}
      title={<span className="break-words">{title}</span>}
      footer={
        <>
          {onDelete && (
            <Button
              variant="outline"
              size="touch"
              className="text-danger md:min-h-9 sm:mr-auto"
              onClick={onDelete}
            >
              {t('ai.contextPanel.delete')}
            </Button>
          )}
          <Button
            type="submit"
            form={formId}
            size="touch"
            className="md:min-h-9"
            disabled={!valid || !changed}
          >
            {t('ai.contextPanel.save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4 pb-1">
        <Field label={t('ai.contextPanel.name')}>
          {(p) => (
            <Input
              {...p}
              className="h-11 md:h-9"
              value={draft.name}
              maxLength={AI_CONTEXT_NAME_CHARACTERS}
              placeholder={t('ai.contextPanel.namePlaceholder')}
              onChange={(e) => setDraft((old) => ({ ...old, name: e.target.value }))}
            />
          )}
        </Field>
        <InternalSwitch
          checked={draft.internal}
          onCheckedChange={(internal) => setDraft((old) => ({ ...old, internal }))}
        />
        <Field
          label={t('ai.contextPanel.textLabel')}
          hint={t('ai.contextPanel.characterCount', {
            count: formatNumber(codePointLength(draft.text)),
            max: formatNumber(AI_CONTEXT_CHARACTERS),
          })}
        >
          {(p) => (
            <Textarea
              {...p}
              className="field-sizing-fixed h-[min(45dvh,28rem)] resize-y overflow-y-auto text-base leading-6 md:text-sm"
              value={draft.text}
              maxLength={AI_CONTEXT_CHARACTERS}
              placeholder={t('ai.contextPanel.textPlaceholder')}
              onChange={(e) => setDraft((old) => ({ ...old, text: e.target.value }))}
            />
          )}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
      </form>
    </ResponsiveDialog>
  );
}

/** A file item: read-only preview of its text and the Internal switch. */
function FileItemDialog({
  title,
  name,
  text,
  initialInternal,
  isNew = false,
  error,
  onClose,
  onSave,
  onDelete,
}: Readonly<{
  title: string;
  name: string;
  text: string;
  initialInternal: boolean;
  isNew?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (internal: boolean) => void;
  onDelete?: () => void;
}>) {
  const { t } = useTranslation('admin');
  const [internal, setInternal] = useState(initialInternal);
  return (
    <ResponsiveDialog
      open
      size="wide"
      onOpenChange={(o) => !o && onClose()}
      title={<span className="break-words">{title}</span>}
      description={isNew ? undefined : t('ai.contextPanel.fileReadOnly')}
      footer={
        <>
          {onDelete && (
            <Button
              variant="outline"
              size="touch"
              className="text-danger md:min-h-9 sm:mr-auto"
              onClick={onDelete}
            >
              {t('ai.contextPanel.delete')}
            </Button>
          )}
          <Button
            size="touch"
            className="md:min-h-9"
            disabled={!isNew && internal === initialInternal}
            onClick={() => onSave(internal)}
          >
            {isNew ? t('ai.contextPanel.add') : t('ai.contextPanel.save')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-4 pb-1">
        {isNew && (
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">{t('mockAgents.context.fileName')}</span>
            <span className="truncate" title={name}>
              {name}
            </span>
          </p>
        )}
        <InternalSwitch checked={internal} onCheckedChange={setInternal} />
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-medium">{t('ai.contextPanel.preview')}</p>
          <pre className="max-h-[40dvh] overflow-y-auto rounded-md bg-muted p-3 font-sans text-sm break-words whitespace-pre-wrap">
            {text}
          </pre>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

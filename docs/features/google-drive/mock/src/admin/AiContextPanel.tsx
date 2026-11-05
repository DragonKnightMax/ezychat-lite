import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, FileText, NotebookText, Plus, Search, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  AI_CONTEXT_CHARACTERS,
  AI_CONTEXT_ITEMS,
  AI_CONTEXT_NAME_CHARACTERS,
  AiContextTextBody,
  codePointLength,
  type AiDocument,
} from '@ezychat/shared';
import { BatchDeleteError, useAiDocument, useAiMemberAction } from '../api/ai';
import { errorMessage } from '../api/client';
import { Banner, ResponsiveDialog } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
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
import { ConfirmDialog, Field, Pending } from './adminUi';

const UPLOAD_ACCEPT = '.txt,.md,.pdf,.docx';
const UPLOAD_BYTES = 10 * 1024 * 1024;
const CONFIRM_NAMES = 5;

type Open = { kind: 'item'; id: number } | { kind: 'addText' } | null;

/**
 * Business context as a list of items (uploaded files and text content), like a project
 * knowledge panel: search, multi-select delete, and Add ▾ (upload or text). Items belong to the
 * AI member, so `ensureMember` saves a draft member first when there is none yet.
 */
export function AiContextPanel({
  documents,
  ensureMember,
  disabled = false,
}: {
  documents: AiDocument[];
  ensureMember: () => Promise<boolean>;
  disabled?: boolean;
}) {
  const { t } = useTranslation('admin');
  const titleId = useId();
  const action = useAiMemberAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [open, setOpen] = useState<Open>(null);
  const [confirm, setConfirm] = useState<AiDocument[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [failedNames, setFailedNames] = useState<string | null>(null);

  // Forget selections of items that no longer exist.
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(documents.map((doc) => doc.id));
      const kept = [...current].filter((id) => ids.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [documents]);

  const busy = disabled || action.isPending;
  const full = documents.length >= AI_CONTEXT_ITEMS;
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? documents.filter((doc) => doc.name.toLocaleLowerCase().includes(needle))
    : documents;

  const upload = async (file: File) => {
    if (uploading.current) return;
    uploading.current = true;
    try {
      setLocalError(null);
      if (!/\.(txt|md|pdf|docx)$/i.test(file.name)) {
        setLocalError(t('ai.fileTypeError'));
        return;
      }
      if (file.size > UPLOAD_BYTES) {
        setLocalError(t('ai.fileSizeError'));
        return;
      }
      if (!(await ensureMember())) return;
      await action.mutateAsync({ kind: 'upload', file });
      toast.success(t('ai.contextPanel.fileAdded'));
    } catch {
      /* shown from action.error */
    } finally {
      uploading.current = false;
    }
  };

  const remove = async (items: AiDocument[]) => {
    setFailedNames(null);
    try {
      await action.mutateAsync({ kind: 'removeMany', ids: items.map((doc) => doc.id) });
      toast.success(t('ai.contextPanel.deleted', { count: items.length }));
      setConfirm(null);
      setSelecting(false);
      setSelected(new Set());
    } catch (error) {
      // Keep only the items that still failed, so a retry never re-sends deletes that went through.
      if (error instanceof BatchDeleteError) {
        const failed = items.filter((doc) => error.failedIds.includes(doc.id));
        setConfirm(failed);
        setSelected(new Set(failed.map((doc) => doc.id)));
        setFailedNames(namesOf(failed));
      }
    }
  };
  const namesOf = (items: AiDocument[]) => {
    const names = items
      .slice(0, CONFIRM_NAMES)
      .map((doc) => doc.name)
      .join(', ');
    return items.length > CONFIRM_NAMES
      ? t('ai.contextPanel.namesMore', { names, count: items.length - CONFIRM_NAMES })
      : names;
  };

  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const show = (next: Open) => {
    action.reset();
    setOpen(next);
  };
  const activate = (doc: AiDocument) => {
    if (selecting) toggle(doc.id);
    else show({ kind: 'item', id: doc.id });
  };
  const kindIcon = (doc: AiDocument) => {
    const Icon = doc.kind === 'file' ? FileText : NotebookText;
    const label =
      doc.kind === 'file' ? t('ai.contextPanel.kindFile') : t('ai.contextPanel.kindText');
    return <Icon role="img" aria-label={label} className="size-4 shrink-0 text-muted-foreground" />;
  };
  const added = (doc: AiDocument) =>
    t('ai.contextPanel.added', { when: formatRelative(doc.createdAt) });
  const selectBox = (doc: AiDocument) => (
    <label className="flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11">
      <Checkbox
        checked={selected.has(doc.id)}
        aria-label={t('ai.contextPanel.selectItem', { name: doc.name })}
        onCheckedChange={() => toggle(doc.id)}
      />
    </label>
  );

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="touch" className="md:min-h-9" disabled={busy || full}>
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
          onSelect={() => show({ kind: 'addText' })}
        >
          <NotebookText aria-hidden />
          {t('ai.contextPanel.addText')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle id={titleId}>{t('ai.page.stepContext')}</CardTitle>
        <CardDescription>
          {t('ai.contextPanel.hint')}
          <span className="mt-1 block text-xs">{t('ai.contextPanel.limits')}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <input
          ref={fileInput}
          type="file"
          hidden
          accept={UPLOAD_ACCEPT}
          data-testid="ai-context-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
        {documents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">{t('ai.contextPanel.empty')}</p>
            {addMenu}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {selecting ? (
                <>
                  <Button
                    variant="destructive"
                    size="touch"
                    className="md:min-h-9"
                    disabled={busy || selected.size === 0}
                    onClick={() => setConfirm(documents.filter((doc) => selected.has(doc.id)))}
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
                    disabled={busy}
                    onClick={() => {
                      // Hidden (filtered-out) items must never be selectable for deletion.
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
                {t('ai.contextPanel.noMatches', { query: query.trim() })}
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
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((doc) => (
                        <TableRow
                          key={doc.id}
                          data-state={selected.has(doc.id) ? 'selected' : undefined}
                          className="cursor-pointer"
                          onClick={(e) => {
                            // Controls inside the row handle their own clicks.
                            if ((e.target as HTMLElement).closest('button,label')) return;
                            activate(doc);
                          }}
                        >
                          {selecting && <TableCell>{selectBox(doc)}</TableCell>}
                          <TableCell>{kindIcon(doc)}</TableCell>
                          <TableCell className="min-w-0">
                            <Button
                              variant="link"
                              className="h-auto max-w-full justify-start p-0 font-medium text-foreground pointer-coarse:min-h-11"
                              onClick={() => activate(doc)}
                            >
                              <span className="truncate" title={doc.name}>
                                {doc.name}
                              </span>
                            </Button>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatBytes(doc.size)}
                          </TableCell>
                          <TableCell
                            className="truncate text-muted-foreground"
                            title={formatDateTime(doc.createdAt)}
                          >
                            {added(doc)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <ul aria-labelledby={titleId} className="flex flex-col gap-2 sm:hidden">
                  {shown.map((doc) => (
                    <li
                      key={doc.id}
                      className={cn(
                        'flex min-w-0 items-center gap-1 rounded-lg border bg-card',
                        selected.has(doc.id) && 'border-primary',
                      )}
                    >
                      {selecting && selectBox(doc)}
                      <Button
                        variant="ghost"
                        className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-3 px-3 py-2 text-left font-normal"
                        onClick={() => activate(doc)}
                      >
                        {kindIcon(doc)}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium" title={doc.name}>
                            {doc.name}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {t('ai.contextPanel.meta', {
                              size: formatBytes(doc.size),
                              added: added(doc),
                            })}
                          </span>
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {(localError || (action.error && !confirm && !open)) && (
          <Banner tone="danger">{localError ?? errorMessage(action.error)}</Banner>
        )}
      </CardContent>

      {open?.kind === 'addText' && (
        <TextItemDialog
          title={t('ai.contextPanel.addTextTitle')}
          initial={{ name: '', text: '' }}
          pending={action.isPending}
          error={action.error}
          onClose={() => setOpen(null)}
          onSave={async (body) => {
            if (!(await ensureMember())) return;
            await action.mutateAsync({ kind: 'addText', body });
            toast.success(t('ai.contextPanel.textAdded'));
            setOpen(null);
          }}
        />
      )}
      {open?.kind === 'item' && (
        <ItemDialog
          id={open.id}
          pending={action.isPending}
          error={action.error}
          onClose={() => setOpen(null)}
          onSave={async (body) => {
            await action.mutateAsync({ kind: 'updateText', id: open.id, body });
            toast.success(t('ai.contextPanel.changesSaved'));
            setOpen(null);
          }}
          onDelete={() => {
            const doc = documents.find((item) => item.id === open.id);
            setOpen(null);
            if (doc) setConfirm([doc]);
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
        loading={action.isPending}
        error={
          failedNames
            ? new Error(t('ai.contextPanel.deleteFailed', { names: failedNames }))
            : (action.error ?? undefined)
        }
        onConfirm={() => confirm && void remove(confirm)}
        onClose={() => {
          setConfirm(null);
          setFailedNames(null);
          action.reset();
        }}
      >
        {confirm && confirm.length > 1 && <p className="mb-2 break-words">{namesOf(confirm)}</p>}
        {t('ai.contextPanel.confirmText')}
      </ConfirmDialog>
    </Card>
  );
}

type TextDraft = { name: string; text: string };

/** Opens an item: text items are edited in place; files show a read-only preview. */
function ItemDialog({
  id,
  pending,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  id: number;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (body: TextDraft) => Promise<void>;
  onDelete: () => void;
}) {
  const { t } = useTranslation('admin');
  const view = useAiDocument(id);
  const doc = view.data;
  if (doc?.kind === 'text')
    return (
      <TextItemDialog
        title={doc.name}
        initial={{ name: doc.name, text: doc.text }}
        pending={pending}
        error={error}
        onClose={onClose}
        onSave={onSave}
        onDelete={onDelete}
      />
    );
  return (
    <ResponsiveDialog
      open
      size="wide"
      onOpenChange={(o) => !o && !pending && onClose()}
      title={<span className="break-words">{doc?.name ?? t('ai.contextPanel.loading')}</span>}
      description={doc ? t('ai.contextPanel.fileReadOnly') : undefined}
      footer={
        <>
          <Button variant="outline" size="touch" className="md:min-h-9" onClick={onClose}>
            {t('ai.contextPanel.close')}
          </Button>
          {doc && (
            <Button
              variant="destructive"
              size="touch"
              className="md:min-h-9"
              disabled={pending}
              onClick={onDelete}
            >
              {t('ai.contextPanel.delete')}
            </Button>
          )}
        </>
      }
    >
      {view.isError ? (
        <Banner tone="danger">
          {t('ai.contextPanel.loadError', { error: errorMessage(view.error) })}
        </Banner>
      ) : doc ? (
        <div className="flex min-w-0 flex-col gap-2 pb-1">
          <p className="text-sm font-medium">{t('ai.contextPanel.preview')}</p>
          <pre className="max-h-[50dvh] overflow-y-auto rounded-md bg-muted p-3 font-sans text-sm break-words whitespace-pre-wrap">
            {doc.text}
          </pre>
          {doc.truncated && (
            <p className="text-xs text-muted-foreground">{t('ai.contextPanel.previewTruncated')}</p>
          )}
        </div>
      ) : (
        <p className="pb-1 text-sm text-muted-foreground">{t('ai.contextPanel.loading')}</p>
      )}
    </ResponsiveDialog>
  );
}

/** Name + text editor for adding or editing a text item. */
function TextItemDialog({
  title,
  initial,
  pending,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  title: string;
  initial: TextDraft;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (body: TextDraft) => Promise<void>;
  onDelete?: () => void;
}) {
  const { t } = useTranslation('admin');
  const formId = useId();
  const [draft, setDraft] = useState(initial);
  const valid = AiContextTextBody.safeParse(draft).success;
  const changed = draft.name !== initial.name || draft.text !== initial.text;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = AiContextTextBody.safeParse(draft);
    if (!parsed.success || pending) return;
    try {
      await onSave(parsed.data);
    } catch {
      /* shown below from the mutation error */
    }
  };
  return (
    <ResponsiveDialog
      open
      size="wide"
      onOpenChange={(o) => !o && !pending && onClose()}
      title={<span className="break-words">{title}</span>}
      footer={
        <>
          {onDelete && (
            <Button
              variant="outline"
              size="touch"
              className="text-danger md:min-h-9 sm:mr-auto"
              disabled={pending}
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
            disabled={pending || !valid || !changed}
          >
            <Pending show={pending} />
            {t('ai.contextPanel.save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 pb-1">
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
              // Fixed size: long lines wrap and the box scrolls instead of widening the dialog.
              className="field-sizing-fixed h-[min(55dvh,32rem)] resize-y overflow-y-auto text-base leading-6 md:text-sm"
              value={draft.text}
              // Counts UTF-16 units (≥ code points), so typing can never pass the server limit.
              maxLength={AI_CONTEXT_CHARACTERS}
              placeholder={t('ai.contextPanel.textPlaceholder')}
              onChange={(e) => setDraft((old) => ({ ...old, text: e.target.value }))}
            />
          )}
        </Field>
        {error != null && <Banner tone="danger">{errorMessage(error)}</Banner>}
      </form>
    </ResponsiveDialog>
  );
}

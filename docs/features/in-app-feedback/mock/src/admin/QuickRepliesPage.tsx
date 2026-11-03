import { useState } from 'react';
import type React from 'react';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Trans, useTranslation } from 'react-i18next';
import type { QuickReply } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { useDeleteQuickReply, useQuickReplies, useSaveQuickReply } from '../api/queries';
import { Banner, EmptyState, PageHeader, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SearchField } from '@/components/app/SearchField';
import { ConfirmDialog, ErrorState, Field, ListSkeleton, Pending } from './adminUi';

const SHORTCUT_RE = /^[a-z0-9_-]{1,32}$/;

export function QuickRepliesPage() {
  const replies = useQuickReplies();
  const [editing, setEditing] = useState<QuickReply | 'new' | null>(null);
  const [deleting, setDeleting] = useState<QuickReply | null>(null);
  const del = useDeleteQuickReply();
  const [search, setSearch] = useState('');
  const { t } = useTranslation(['admin', 'common']);

  const all = [...(replies.data ?? [])].sort((a, b) => a.shortcut.localeCompare(b.shortcut));
  const query = search.trim().toLocaleLowerCase();
  const list = all.filter((r) => `${r.shortcut} ${r.body}`.toLocaleLowerCase().includes(query));

  return (
    <div>
      <PageHeader
        title={t('quickReplies.title')}
        description={
          <Trans
            t={t}
            i18nKey="quickReplies.description"
            components={{ kbd: <kbd className="rounded bg-muted px-1 font-mono" /> }}
          />
        }
        actions={
          <Button size="touch" className="md:min-h-9" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('quickReplies.new')}
          </Button>
        }
      />

      <div className="mb-4 space-y-2">
        <SearchField
          value={search}
          onChange={setSearch}
          label={t('quickReplies.searchLabel')}
          placeholder={t('quickReplies.searchPlaceholder')}
        />
        {!replies.isPending && !replies.isError && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('quickReplies.count', { shown: list.length, count: all.length })}
          </p>
        )}
      </div>
      {replies.isPending ? (
        <ListSkeleton />
      ) : replies.isError ? (
        <ErrorState error={replies.error} onRetry={() => void replies.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          title={query ? t('quickReplies.empty.noMatchTitle') : t('quickReplies.empty.noneTitle')}
          description={
            query ? t('quickReplies.empty.noMatchBody') : t('quickReplies.empty.noneBody')
          }
          action={
            query ? (
              <Button variant="outline" size="touch" onClick={() => setSearch('')}>
                {t('quickReplies.empty.clearSearch')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm font-semibold text-primary">/{r.shortcut}</p>
                <p className="mt-1 text-base leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground md:text-sm">
                  {r.body}
                </p>
              </div>
              {/* Same row pattern as Members: Edit, then rarer actions in a "…" menu. */}
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="touch"
                  variant="outline"
                  className="md:pointer-fine:min-h-8"
                  onClick={() => setEditing(r)}
                  aria-label={t('quickReplies.editLabel', { shortcut: r.shortcut })}
                >
                  <Pencil aria-hidden />
                  {t('common:actions.edit')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-touch"
                      variant="ghost"
                      className="md:pointer-fine:size-8"
                      aria-label={t('quickReplies.moreLabel', { shortcut: r.shortcut })}
                    >
                      <MoreHorizontal aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="min-h-11 md:min-h-8"
                      variant="destructive"
                      onSelect={() => setDeleting(r)}
                    >
                      <Trash2 aria-hidden />
                      {t('common:actions.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <QuickReplyDialog
          reply={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open
          title={t('quickReplies.delete.title', { shortcut: deleting.shortcut })}
          confirmLabel={t('common:actions.delete')}
          danger
          loading={del.isPending}
          error={del.error ?? undefined}
          onConfirm={() =>
            del.mutate(deleting.id, {
              onSuccess: () => {
                toast.success(t('quickReplies.delete.done', { shortcut: deleting.shortcut }));
                setDeleting(null);
                del.reset();
              },
            })
          }
          onClose={() => {
            setDeleting(null);
            del.reset();
          }}
        >
          <p>{t('quickReplies.delete.body')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function QuickReplyDialog({ reply, onClose }: { reply: QuickReply | null; onClose: () => void }) {
  const save = useSaveQuickReply();
  const { t } = useTranslation(['admin', 'common']);
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? '');
  const [body, setBody] = useState(reply?.body ?? '');
  const [touched, setTouched] = useState(false);

  const shortcutError =
    touched && !SHORTCUT_RE.test(shortcut) ? t('quickReplies.form.shortcutInvalid') : undefined;
  const bodyError = touched && !body.trim() ? t('quickReplies.form.bodyRequired') : undefined;
  const example = t('quickReplies.form.shortcutExample');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!SHORTCUT_RE.test(shortcut) || !body.trim()) return;
    save.mutate(
      { id: reply?.id, shortcut, body },
      {
        onSuccess: () => {
          toast.success(t('quickReplies.form.saved', { shortcut }));
          onClose();
        },
      },
    );
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title={
        reply
          ? t('quickReplies.form.editTitle', { shortcut: reply.shortcut })
          : t('quickReplies.new')
      }
      footer={
        <>
          <Button
            variant="outline"
            size="touch"
            className="sm:min-h-9"
            onClick={onClose}
            disabled={save.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            form="quick-reply-form"
            size="touch"
            className="sm:min-h-9"
            disabled={save.isPending}
          >
            <Pending show={save.isPending} />
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <form id="quick-reply-form" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        <Field
          label={t('quickReplies.form.shortcut')}
          error={shortcutError}
          hint={t('quickReplies.form.shortcutHint', { example })}
        >
          {(p) => (
            <Input
              {...p}
              className="h-11 font-mono md:h-9"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value.toLowerCase().replace(/^\//, ''))}
              placeholder={example}
              autoCapitalize="none"
              autoCorrect="off"
            />
          )}
        </Field>
        <Field label={t('quickReplies.form.body')} error={bodyError}>
          {(p) => (
            <Textarea
              {...p}
              className="min-h-32"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              maxLength={4096}
            />
          )}
        </Field>
        {save.error && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
      </form>
    </ResponsiveDialog>
  );
}

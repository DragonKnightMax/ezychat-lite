import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, EllipsisVertical, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import type { Message, MessageEdit } from '@ezychat/shared';
import { Banner, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useDeleteMessage, useEditMessage, useMessageEdits } from '../api/message-changes';
import { formatDateTime } from '../lib/format';
import { hasActions, type MessageRights } from './message-changes';
import type { Directory } from './useDirectory';

/**
 * The ⋮ button next to a message (hover or focus on desktop, like Reply; touch screens reach the
 * same actions from the press-and-hold bar). Shown only when the user may do something with the
 * message; Edit stays visible, disabled, once its 15 minutes are over.
 */
export function MessageMoreMenu({
  rights,
  disabledReason,
  onEdit,
  onDelete,
}: {
  rights: MessageRights;
  disabledReason: string | null;
  onEdit(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation('inbox');
  const [open, setOpen] = useState(false);
  if (!hasActions(rights)) return null;
  const canDelete =
    (rights.canDeleteForEveryone && !rights.deleteWindowClosed) || rights.canDeleteForMe;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('message.change.more')}
          title={t('message.change.more')}
          data-testid="message-more"
          className={cn(
            'size-8 shrink-0 rounded-full text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:not-focus-visible:sr-only',
            open && 'opacity-100',
          )}
        >
          <EllipsisVertical aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-2rem)]">
        {rights.canEdit && (
          <DropdownMenuItem
            disabled={rights.editWindowClosed || !!disabledReason}
            onSelect={onEdit}
            className="min-h-11 items-start sm:min-h-9"
          >
            <Pencil aria-hidden="true" className="mt-0.5" />
            <span className="flex flex-col">
              {t('message.change.edit')}
              {rights.editWindowClosed && (
                <span className="text-xs text-muted-foreground">
                  {t('message.change.editWindow')}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        )}
        {(canDelete || rights.canDeleteForEveryone) && (
          <DropdownMenuItem
            variant="destructive"
            disabled={!!disabledReason || !canDelete}
            onSelect={onDelete}
            className="min-h-11 items-start sm:min-h-9"
          >
            <Trash2 aria-hidden="true" className="mt-0.5" />
            <span className="flex flex-col">
              {t('message.change.delete')}
              {!canDelete && (
                <span className="text-xs text-muted-foreground">
                  {t('message.change.deleteWindow')}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        )}
        {disabledReason && (
          <p className="px-2 py-1.5 text-xs text-warning" role="status">
            {disabledReason}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Edit a sent text or caption. WhatsApp shows the customer "Edited". */
export function EditMessageDialog({
  message,
  onClose,
}: {
  /** The message being edited; null closes the dialog. */
  message: Message | null;
  onClose(): void;
}) {
  const { t } = useTranslation(['inbox', 'common']);
  const edit = useEditMessage();
  const current = message?.body ?? '';
  const [text, setText] = useState(current);
  const { reset } = edit;
  useEffect(() => {
    setText(current);
    reset();
  }, [message?.id, current, reset]);
  const trimmed = text.trim();
  const unchanged = !trimmed || trimmed === current.trim();
  const save = () => {
    if (!message || unchanged || edit.isPending) return;
    edit.mutate({ id: message.id, text: trimmed }, { onSuccess: onClose });
  };
  return (
    <ResponsiveDialog
      open={!!message}
      onOpenChange={(o) => !o && !edit.isPending && onClose()}
      title={
        message && message.type !== 'text'
          ? t('message.change.editCaption')
          : t('message.change.editTitle')
      }
      description={t('message.change.editHint')}
      footer={
        <>
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={edit.isPending}
            onClick={onClose}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            className="min-h-11 sm:min-h-9"
            disabled={edit.isPending || unchanged}
            onClick={save}
            data-testid="edit-save"
          >
            {t('message.change.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 pb-1">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
          }}
          rows={4}
          maxLength={65536}
          autoFocus
          aria-label={t('message.change.editTitle')}
          className="max-h-60 text-[15px]"
          data-testid="edit-text"
        />
        <p className="text-xs text-muted-foreground">{t('message.change.editKeys')}</p>
        {edit.error && <Banner tone="danger">{(edit.error as Error).message}</Banner>}
      </div>
    </ResponsiveDialog>
  );
}

/** One confirmation with the delete choices this user has for this message. */
export function DeleteMessageDialog({
  message,
  rights,
  onClose,
}: {
  message: Message | null;
  rights: MessageRights;
  onClose(): void;
}) {
  const { t } = useTranslation(['inbox', 'common']);
  const del = useDeleteMessage();
  const { reset } = del;
  useEffect(() => reset(), [message?.id, reset]);
  const everyone = rights.canDeleteForEveryone && !rights.deleteWindowClosed;
  const run = (scope: 'everyone' | 'me') =>
    message && del.mutate({ id: message.id, scope }, { onSuccess: onClose });
  return (
    <ResponsiveDialog
      open={!!message}
      onOpenChange={(o) => !o && !del.isPending && onClose()}
      title={t('message.change.deleteTitle')}
      footer={
        <>
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={del.isPending}
            onClick={onClose}
          >
            {t('common:actions.cancel')}
          </Button>
          {rights.canDeleteForMe && (
            <Button
              variant={everyone ? 'outline' : 'destructive'}
              className="min-h-11 sm:min-h-9"
              disabled={del.isPending}
              onClick={() => run('me')}
              data-testid="delete-for-me"
            >
              {t('message.change.forMe')}
            </Button>
          )}
          {everyone && (
            <Button
              variant="destructive"
              className="min-h-11 sm:min-h-9"
              disabled={del.isPending}
              onClick={() => run('everyone')}
              data-testid="delete-for-everyone"
            >
              {t('message.change.forEveryone')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-2 pb-1 text-sm text-muted-foreground">
        {everyone && <p>{t('message.change.forEveryoneHint')}</p>}
        {rights.canDeleteForEveryone && rights.deleteWindowClosed && (
          <p className="text-warning">{t('message.change.deleteWindow')}</p>
        )}
        {rights.canDeleteForMe && <p>{t('message.change.forMeHint')}</p>}
        {del.error && <Banner tone="danger">{(del.error as Error).message}</Banner>}
      </div>
    </ResponsiveDialog>
  );
}

/** "Edited" before the time; opens the earlier versions, oldest first. */
export function EditedLabel({
  message,
  directory,
  contactName,
}: {
  message: Message;
  directory?: Directory;
  contactName?: string;
}) {
  const { t } = useTranslation('inbox');
  const [open, setOpen] = useState(false);
  const history = useMessageEdits(message.id, open);
  const who = (e: MessageEdit) =>
    e.by === 'team'
      ? ((e.userId !== null ? directory?.nameOf(e.userId, { youLabel: true }) : null) ??
        t('message.change.byTeam'))
      : e.by === 'phone'
        ? t('message.change.byPhone')
        : (contactName ?? message.senderName ?? t('message.contact'));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-[11px] font-normal text-muted-foreground underline-offset-2"
          data-testid="edited-label"
        >
          {t('message.change.edited')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <p className="mb-2 text-sm font-medium">{t('message.change.historyTitle')}</p>
        {history.data ? (
          <ol className="max-h-72 space-y-2 overflow-y-auto">
            {history.data.edits.map((e, i) => (
              <li key={i} className="rounded-md bg-muted px-2 py-1.5">
                <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                  {e.previousBody}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('message.change.editedBy', { name: who(e), time: formatDateTime(e.at) })}
                </p>
              </li>
            ))}
          </ol>
        ) : history.isError ? (
          <p className="text-sm text-danger">{t('message.change.historyFailed')}</p>
        ) : (
          <div className="space-y-2" role="status" aria-label={t('message.change.historyTitle')}>
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The body of a message deleted for everyone; admins may reveal the original. */
export function DeletedBody({
  message: m,
  isAdmin,
  directory,
  contactName,
}: {
  message: Message;
  isAdmin: boolean;
  directory?: Directory;
  contactName?: string;
}) {
  const { t } = useTranslation('inbox');
  const [show, setShow] = useState(false);
  const original = useMessageEdits(m.id, show);
  const label =
    m.deletedBy === 'team'
      ? t('message.change.deletedBy', {
          name:
            (m.deletedByUserId != null
              ? directory?.nameOf(m.deletedByUserId, { youLabel: true })
              : null) ?? t('message.change.byTeam'),
        })
      : m.deletedBy === 'phone'
        ? t('message.change.deletedFromPhone')
        : m.deletedBy === 'group_admin'
          ? t('message.change.deletedByGroupAdmin')
          : t('message.change.deletedBy', {
              name: contactName ?? m.senderName ?? t('message.contact'),
            });
  return (
    <div data-testid="deleted-body">
      <p className="flex items-center gap-1.5 text-[15px] italic leading-snug text-muted-foreground">
        <Ban className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </p>
      {isAdmin && (
        <>
          {show && (
            <p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-dashed px-2 py-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {original.data
                ? (original.data.original ?? t('message.change.noText'))
                : original.isError
                  ? t('message.change.historyFailed')
                  : '…'}
            </p>
          )}
          <Button
            type="button"
            variant="link"
            onClick={() => setShow((s) => !s)}
            className="h-auto min-h-8 gap-1 p-0 text-xs text-primary"
            data-testid="show-original"
          >
            {show ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {show ? t('message.change.hideOriginal') : t('message.change.showOriginal')}
          </Button>
        </>
      )}
    </div>
  );
}

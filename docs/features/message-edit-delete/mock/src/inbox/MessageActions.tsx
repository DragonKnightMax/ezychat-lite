import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, EllipsisVertical, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import type { Message } from '@ezychat/shared';
import { Banner, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatDateTime } from '../lib/format';
import {
  type MessageChange,
  type MessageRights,
  useDeleteMessage,
  useEditMessage,
} from '../mock/useMessageChanges';

/**
 * Proposed (message-edit-delete): the ⋮ button next to a message (hover/focus on desktop, like
 * Reply; touch screens reach the same actions from the press-and-hold bar). Shown only when the
 * user may do something with the message; Edit stays visible but disabled after 15 minutes.
 */
export function MessageMoreMenu({
  rights,
  disabledReason,
  onEdit,
  onDelete,
}: {
  rights: MessageRights;
  /** WhatsApp is not connected: every action waits. */
  disabledReason: string | null;
  onEdit(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation('inbox');
  const [open, setOpen] = useState(false);
  const canDelete = rights.canDeleteForEveryone || rights.canDeleteForMe;
  if (!rights.canEdit && !canDelete) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('editDelete.more')}
          title={t('editDelete.more')}
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
            disabled={!!rights.editBlocked || !!disabledReason}
            onSelect={onEdit}
            className="min-h-11 items-start sm:min-h-9"
          >
            <Pencil aria-hidden="true" className="mt-0.5" />
            <span className="flex flex-col">
              {t('editDelete.edit')}
              {rights.editBlocked && (
                <span className="text-xs text-muted-foreground">{t('editDelete.editWindow')}</span>
              )}
            </span>
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem
            variant="destructive"
            disabled={!!disabledReason}
            onSelect={onDelete}
            className="min-h-11 sm:min-h-9"
          >
            <Trash2 aria-hidden="true" />
            {t('editDelete.delete')}
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

/** Proposed: edit a sent text or caption. WhatsApp shows the customer "Edited". */
export function EditMessageDialog({
  message,
  current,
  open,
  onOpenChange,
}: {
  message: Message;
  /** Text after earlier edits. */
  current: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation(['inbox', 'common']);
  const edit = useEditMessage();
  const [text, setText] = useState(current);
  useEffect(() => {
    if (open) {
      setText(current);
      edit.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);
  const trimmed = text.trim();
  const save = () => {
    if (!trimmed || trimmed === current.trim()) return;
    edit.mutate({ id: message.id, text: trimmed }, { onSuccess: () => onOpenChange(false) });
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !edit.isPending && onOpenChange(o)}
      title={message.type === 'text' ? t('editDelete.editTitle') : t('editDelete.editCaption')}
      description={t('editDelete.editHint')}
      footer={
        <>
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={edit.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            className="min-h-11 sm:min-h-9"
            disabled={edit.isPending || !trimmed || trimmed === current.trim()}
            onClick={save}
            data-testid="edit-save"
          >
            {t('editDelete.save')}
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
          maxLength={4096}
          autoFocus
          aria-label={t('editDelete.editTitle')}
          className="max-h-60 text-[15px]"
          data-testid="edit-text"
        />
        <p className="text-xs text-muted-foreground">{t('editDelete.editKeys')}</p>
        {edit.error && <Banner tone="danger">{(edit.error as Error).message}</Banner>}
      </div>
    </ResponsiveDialog>
  );
}

/** Proposed: one confirmation with the delete choices this user has for this message. */
export function DeleteMessageDialog({
  message,
  rights,
  open,
  onOpenChange,
}: {
  message: Message;
  rights: MessageRights;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation(['inbox', 'common']);
  const del = useDeleteMessage();
  const run = (scope: 'everyone' | 'me') =>
    del.mutate({ id: message.id, scope }, { onSuccess: () => onOpenChange(false) });
  const everyone = rights.canDeleteForEveryone && !rights.deleteBlocked;
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !del.isPending && onOpenChange(o)}
      title={t('editDelete.deleteTitle')}
      footer={
        <>
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={del.isPending}
            onClick={() => onOpenChange(false)}
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
              {t('editDelete.forMe')}
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
              {t('editDelete.forEveryone')}
            </Button>
          )}
        </>
      }
    >
      <ul className="space-y-2 pb-1 text-sm text-muted-foreground">
        {everyone && <li>{t('editDelete.forEveryoneHint')}</li>}
        {rights.canDeleteForEveryone && rights.deleteBlocked && (
          <li className="text-warning">{t('editDelete.deleteWindow')}</li>
        )}
        {rights.canDeleteForMe && <li>{t('editDelete.forMeHint')}</li>}
      </ul>
    </ResponsiveDialog>
  );
}

/** Proposed: "Edited" before the time; opens the earlier versions, oldest first. */
export function EditedLabel({
  change,
  contactName,
}: {
  change: MessageChange;
  contactName?: string;
}) {
  const { t } = useTranslation('inbox');
  const who = (by: MessageChange['edits'][number]) =>
    by.by === 'team'
      ? (by.name ?? t('editDelete.byTeam'))
      : by.by === 'phone'
        ? t('editDelete.byPhone')
        : (contactName ?? t('message.contact'));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-[11px] font-normal text-muted-foreground underline-offset-2"
          data-testid="edited-label"
        >
          {t('editDelete.edited')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <p className="mb-2 text-sm font-medium">{t('editDelete.historyTitle')}</p>
        <ol className="space-y-2">
          {change.edits.map((e, i) => (
            <li key={i} className="rounded-md bg-muted px-2 py-1.5">
              <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                {e.previous}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('editDelete.editedBy', { name: who(e), time: formatDateTime(e.at) })}
              </p>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}

/** Proposed: the body of a deleted message; admins may reveal the original. */
export function DeletedBody({
  change,
  out,
  contactName,
}: {
  change: MessageChange;
  out: boolean;
  contactName?: string;
}) {
  const { t } = useTranslation('inbox');
  const [show, setShow] = useState(false);
  const label = out
    ? change.deletedBy === 'phone'
      ? t('editDelete.deletedFromPhone')
      : t('editDelete.deletedByTeam', { name: change.deletedByName ?? t('editDelete.byTeam') })
    : t('editDelete.deletedByCustomer', { name: contactName ?? t('message.contact') });
  return (
    <div data-testid="deleted-body">
      <p className="flex items-center gap-1.5 text-[15px] italic leading-snug text-muted-foreground">
        <Ban className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </p>
      {change.original != null && (
        <>
          {show && (
            <p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-dashed px-2 py-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {change.original}
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
            {show ? t('editDelete.hideOriginal') : t('editDelete.showOriginal')}
          </Button>
        </>
      )}
    </div>
  );
}

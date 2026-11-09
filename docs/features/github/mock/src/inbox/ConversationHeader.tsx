import { useTranslation } from 'react-i18next';
import { ArrowLeft, CheckCircle2, NotebookPen, RotateCcw, UserRound } from 'lucide-react';
import type { Chat } from '@ezychat/shared';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatPhone } from '../lib/jid';
import { chatTitle } from './chat-title';
import { ChatAvatar } from './ChatAvatar';
import { GroupIcon } from './ChatListItem';
import type { Directory } from './useDirectory';
import { InboxChip } from './InboxChip';
import { GroupAiBadge } from './GroupAiRow';
import { inboxOfChat, useMockInboxes } from '../mock/inboxes';

export interface ConversationHeaderProps {
  chat: Chat;
  directory: Directory;
  onBack(): void;
  onAssign(userId: number | null): void;
  onToggleStatus(): void;
  notesOpen: boolean;
  notesCount: number;
  onToggleNotes(): void;
  /** Direct chats only: the Customer details button. */
  showCustomer: boolean;
  customerOpen: boolean;
  onToggleCustomer(): void;
  /**
   * Clicking the chat's avatar and name opens its details, like WhatsApp: Group info for a group,
   * Customer details for a direct chat.
   */
  onOpenInfo?(): void;
  /** Group chats: WhatsApp's member count, shown under the name once known. */
  memberCount?: number | null;
  busy?: boolean;
}

const UNASSIGNED = 'none';

export function ConversationHeader({
  chat,
  directory,
  onBack,
  onAssign,
  onToggleStatus,
  notesOpen,
  notesCount,
  onToggleNotes,
  showCustomer,
  customerOpen,
  onToggleCustomer,
  onOpenInfo,
  memberCount = null,
  busy,
}: ConversationHeaderProps) {
  const { t } = useTranslation('inbox');
  const inboxes = useMockInboxes();
  const inbox = inboxes.inboxes.length > 1 ? inboxOfChat(inboxes, chat.jid) : undefined;
  const name = chatTitle(chat, t);
  const subtitle =
    chat.type === 'group'
      ? memberCount != null
        ? t('header.groupMembers', { count: memberCount })
        : t('chatListItem.group')
      : (formatPhone(chat) ?? t('header.phoneHidden'));
  const resolved = chat.status === 'resolved';

  // Options: active team members (from the team directory) + current assignee.
  const options = [...directory.assignable];
  if (chat.assignedTo != null && !options.some((u) => u.id === chat.assignedTo)) {
    const known = directory.byId.get(chat.assignedTo);
    options.push(
      known ?? {
        id: chat.assignedTo,
        displayName:
          directory.nameOf(chat.assignedTo) ?? t('directory.agent', { id: chat.assignedTo }),
        role: 'agent',
        disabled: false,
      },
    );
  }

  return (
    <header className="@container flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b bg-surface px-1.5 py-1.5 sm:px-3">
      <Button
        variant="ghost"
        size="icon-touch"
        onClick={onBack}
        aria-label={t('header.back')}
        className="text-muted-foreground md:hidden"
      >
        <ArrowLeft className="size-5" aria-hidden="true" />
      </Button>
      {/* The name stays the page heading; the visible identity is one button that opens details. */}
      <h2 className="sr-only">{name}</h2>
      <Button
        type="button"
        variant="ghost"
        onClick={onOpenInfo}
        disabled={!onOpenInfo}
        aria-label={
          chat.type === 'group'
            ? t('header.openGroupInfo', { name })
            : t('header.openCustomer', { name })
        }
        className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-lg px-1.5 py-1 text-left font-normal disabled:opacity-100"
      >
        <ChatAvatar name={name} src={chat.avatarUrl} seed={chat.jid} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-base font-semibold text-foreground">
            {chat.type === 'group' && (
              <GroupIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span
              title={name}
              className="line-clamp-2 whitespace-normal [overflow-wrap:anywhere] md:line-clamp-none md:truncate"
            >
              {name}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            {/* Proposed (multi-inbox): the number this chat uses; replies always leave from it. */}
            {inbox && <InboxChip inbox={inbox} className="shrink-0" />}
            <span className="shrink-0 truncate">
              {subtitle}
              {resolved && ` · ${t('header.resolved')}`}
            </span>
            {/* Proposed (ai-groups): the AI answers in this group when mentioned. */}
            {chat.type === 'group' && <GroupAiBadge jid={chat.jid} />}
          </span>
        </span>
      </Button>
      {/* One row from a 672px-wide header (Customer/Notes icon-only below 768px); narrower
          headers put the actions on their own row under the name, with Resolve on the right. */}
      <div className="flex w-full items-center gap-2 px-1 @2xl:w-auto @2xl:px-0">
        <Select
          value={chat.assignedTo == null ? UNASSIGNED : String(chat.assignedTo)}
          disabled={busy}
          onValueChange={(v) => onAssign(v === UNASSIGNED ? null : Number(v))}
        >
          <SelectTrigger
            id={`assign-${chat.jid}`}
            aria-label={t('header.assignedTo')}
            title={directory.nameOf(chat.assignedTo) ?? t('header.unassigned')}
            // The value is a flex box by default, which clips without an ellipsis.
            className="h-11! min-w-0 flex-1 bg-surface text-base *:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate md:w-44 md:flex-none md:text-sm"
          >
            <SelectValue placeholder={t('header.unassigned')} />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={UNASSIGNED} className="min-h-11 md:min-h-8">
              {t('header.unassigned')}
            </SelectItem>
            {options.map((u) => (
              <SelectItem key={u.id} value={String(u.id)} className="min-h-11 md:min-h-8">
                {u.id === directory.me?.id
                  ? t('header.you', { name: u.displayName })
                  : u.kind === 'ai'
                    ? t('header.ai', { name: u.displayName })
                    : u.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showCustomer && (
          <Button
            variant="ghost"
            size="touch"
            onClick={onToggleCustomer}
            aria-pressed={customerOpen}
            aria-label={t('header.customerLabel')}
            title={t('header.customerLabel')}
            className={cn(
              'relative',
              customerOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
            )}
          >
            <UserRound className="size-5" aria-hidden="true" />
            <span className="@max-3xl:sr-only">{t('header.customer')}</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="touch"
          onClick={onToggleNotes}
          aria-pressed={notesOpen}
          aria-label={t('header.notesLabel', { count: notesCount })}
          title={t('header.notesTitle')}
          className={cn(
            'relative',
            notesOpen ? 'bg-note text-note-foreground hover:bg-note' : 'text-muted-foreground',
          )}
        >
          <NotebookPen className="size-5" aria-hidden="true" />
          {/* Icon-only below a 768px header (aria-label keeps the name). */}
          <span className="@max-3xl:sr-only">{t('header.notes')}</span>
          {notesCount > 0 && (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full border border-note-border bg-note px-1 text-xs font-semibold text-note-foreground">
              {notesCount}
            </span>
          )}
        </Button>
        <Button
          variant={resolved ? 'outline' : 'default'}
          size="touch"
          onClick={onToggleStatus}
          disabled={busy}
          className="ml-auto shrink-0"
        >
          {resolved ? <RotateCcw aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          {resolved ? t('header.reopen') : t('header.resolve')}
        </Button>
      </div>
    </header>
  );
}

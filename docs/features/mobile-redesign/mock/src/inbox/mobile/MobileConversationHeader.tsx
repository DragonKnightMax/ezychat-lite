// Proposed (mobile-redesign): the chat header on a phone. One 56 px row (back, photo and name that
// open the details, Resolve, ⋮) and one strip of chips under it: who handles the chat, the
// customer's tags with "+ Tag", and Notes. Replaces the two-row header whose assignee select read
// "Unassig…" and whose Customer and Notes buttons had no visible label.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Info,
  MoreVertical,
  NotebookPen,
  Plus,
  RotateCcw,
  Tag,
  UserRound,
  Users,
} from 'lucide-react';
import type { Chat } from '@ezychat/shared';
import { ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatPhone } from '../../lib/jid';
import { chatTitle } from '../chat-title';
import { ChatAvatar } from '../ChatAvatar';
import { GroupIcon } from '../ChatListItem';
import { InboxChip } from '../InboxChip';
import { GroupAiBadge } from '../GroupAiRow';
import type { Directory } from '../useDirectory';
import { inboxOfChat, useMockInboxes } from '../../mock/inboxes';
import { AssignSheet } from './AssignSheet';
import { ChatTagsSheet } from './TagSheet';
import { useChatTags } from '../../mock/groupTags';

const chip =
  'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring after:absolute after:-inset-y-1 after:inset-x-0 active:bg-muted';

export function MobileConversationHeader({
  chat,
  directory,
  onBack,
  onAssign,
  onToggleStatus,
  notesCount,
  onToggleNotes,
  onOpenInfo,
  memberCount = null,
  busy,
}: Readonly<{
  chat: Chat;
  directory: Directory;
  onBack(): void;
  onAssign(userId: number | null): void;
  onToggleStatus(): void;
  notesCount: number;
  onToggleNotes(): void;
  onOpenInfo?(): void;
  memberCount?: number | null;
  busy?: boolean;
}>) {
  const { t } = useTranslation('inbox');
  const inboxes = useMockInboxes();
  const inbox = inboxes.inboxes.length > 1 ? inboxOfChat(inboxes, chat.jid) : undefined;
  const [sheet, setSheet] = useState<'more' | 'assign' | 'tags' | null>(null);
  const name = chatTitle(chat, t);
  const resolved = chat.status === 'resolved';
  const dm = chat.type === 'dm';
  // Owner 2026-11-07: tags on groups as well as direct chats.
  const tags = useChatTags(chat);
  const subtitle =
    chat.type === 'group'
      ? memberCount != null
        ? t('header.groupMembers', { count: memberCount })
        : t('chatListItem.group')
      : (formatPhone(chat) ?? t('header.phoneHidden'));
  const assignee = directory.nameOf(chat.assignedTo, { youLabel: true });
  const mine = chat.assignedTo != null && chat.assignedTo === directory.me?.id;

  const more = (key: string, Icon: typeof Info, label: string, run: () => void, hidden = false) =>
    hidden ? null : (
      <button
        key={key}
        type="button"
        onClick={run}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
      >
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );

  return (
    <header className="border-b bg-surface" data-testid="mobile-chat-header">
      <h2 className="sr-only">{name}</h2>
      <div className="flex h-14 items-center gap-0.5 px-1">
        <Button
          variant="ghost"
          size="icon-touch"
          onClick={onBack}
          aria-label={t('header.back')}
          className="text-muted-foreground"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Button>
        <button
          type="button"
          onClick={onOpenInfo}
          aria-label={
            chat.type === 'group'
              ? t('header.openGroupInfo', { name })
              : t('header.openCustomer', { name })
          }
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
        >
          <ChatAvatar name={name} src={chat.avatarUrl} seed={chat.jid} size="md" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-[15px] font-semibold leading-tight text-foreground">
              {chat.type === 'group' && (
                <GroupIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{name}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
              {inbox && (
                <InboxChip inbox={inbox} className="max-w-24 shrink-0 px-1.5 py-0 text-[11px]" />
              )}
              <span className="truncate">
                {subtitle}
                {resolved && ` · ${t('header.resolved')}`}
              </span>
            </span>
          </span>
        </button>
        <Button
          variant={resolved ? 'outline' : 'default'}
          size="touch"
          onClick={onToggleStatus}
          disabled={busy}
          className="shrink-0 px-3"
          data-testid="mobile-resolve"
        >
          {resolved ? <RotateCcw aria-hidden /> : <CheckCircle2 aria-hidden />}
          <span className="max-[374px]:sr-only">
            {resolved ? t('header.reopen') : t('header.resolve')}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label={t('mobile.header.more')}
          onClick={() => setSheet('more')}
          className="text-muted-foreground"
          data-testid="mobile-chat-more"
        >
          <MoreVertical className="size-5" aria-hidden />
        </Button>
      </div>
      <div
        className="flex items-center gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="toolbar"
        aria-label={t('mobile.header.chipsLabel')}
        data-testid="chat-chips"
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => setSheet('assign')}
          aria-label={t('mobile.header.assignee', {
            name: assignee ?? t('header.unassigned'),
          })}
          className={cn(
            chip,
            'max-w-48 font-medium',
            mine
              ? 'border-primary/30 bg-primary/10 text-primary'
              : assignee
                ? 'border-border bg-surface text-foreground'
                : 'border-dashed border-border bg-surface text-muted-foreground',
          )}
          data-testid="chip-assignee"
        >
          <UserRound className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{assignee ?? t('header.unassigned')}</span>
          <ChevronDown className="size-4 shrink-0" aria-hidden />
        </button>
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => setSheet('tags')}
            className={cn(
              chip,
              'max-w-36 border-transparent bg-secondary text-secondary-foreground',
            )}
          >
            <Tag className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{tag}</span>
          </button>
        ))}
        {
          <button
            type="button"
            onClick={() => setSheet('tags')}
            className={cn(chip, 'border-dashed border-border text-muted-foreground')}
            data-testid="chip-add-tag"
          >
            <Plus className="size-4" aria-hidden />
            {t('mobile.header.addTag')}
          </button>
        }
        {/* Groups: the AI badge moves from the crowded subtitle into the strip. */}
        {chat.type === 'group' && (
          <span className="flex shrink-0 items-center">
            <GroupAiBadge jid={chat.jid} />
          </span>
        )}
        <button
          type="button"
          onClick={onToggleNotes}
          className={cn(
            chip,
            notesCount > 0
              ? 'border-note-border bg-note text-note-foreground'
              : 'border-border text-muted-foreground',
          )}
          aria-label={t('header.notesLabel', { count: notesCount })}
        >
          <NotebookPen className="size-4" aria-hidden />
          {t('header.notes')}
          {notesCount > 0 && <span className="font-semibold tabular-nums">{notesCount}</span>}
        </button>
      </div>

      <ResponsiveDialog
        open={sheet === 'more'}
        onOpenChange={(o) => setSheet(o ? 'more' : null)}
        title={name}
      >
        <div className="space-y-0.5 pb-3" data-testid="chat-more-sheet">
          {more(
            'info',
            dm ? UserRound : Users,
            dm ? t('mobile.row.customer') : t('mobile.row.groupInfo'),
            () => {
              setSheet(null);
              onOpenInfo?.();
            },
          )}
          {more('assign', UserRound, t('mobile.row.chooseAssignee'), () => setSheet('assign'))}
          {more('tags', Tag, t('mobile.row.tags'), () => setSheet('tags'))}
          {more('notes', NotebookPen, t('header.notesTitle'), () => {
            setSheet(null);
            onToggleNotes();
          })}
          {more(
            'status',
            resolved ? RotateCcw : CheckCircle2,
            resolved ? t('header.reopen') : t('header.resolve'),
            () => {
              setSheet(null);
              onToggleStatus();
            },
          )}
        </div>
      </ResponsiveDialog>
      <AssignSheet
        open={sheet === 'assign'}
        onOpenChange={(o) => setSheet(o ? 'assign' : null)}
        directory={directory}
        value={chat.assignedTo ?? null}
        onAssign={onAssign}
      />
      {
        <ChatTagsSheet
          jid={chat.jid}
          group={!dm}
          open={sheet === 'tags'}
          onOpenChange={(o) => setSheet(o ? 'tags' : null)}
        />
      }
    </header>
  );
}

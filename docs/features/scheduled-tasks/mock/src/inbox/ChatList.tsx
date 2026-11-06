import { memo, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { Chat } from '@ezychat/shared';
import { useChats, type ChatFilters } from '../api/queries';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Banner, EmptyState } from '@/components/app';
import { GettingStartedCard } from './GettingStartedCard';
import { ChatListItem } from './ChatListItem';
import type { Directory } from './useDirectory';
import { useAuth } from '../auth/AuthProvider';
import { accessOf, canOpen, inboxOfChat, useMockInboxes } from '../mock/inboxes';

// Realtime cache updates retain unchanged Chat references. Keep those rows from
// recalculating labels, dates and avatars when another conversation changes.
const MemoChatListItem = memo(ChatListItem);

export interface ChatListProps {
  filters: ChatFilters;
  activeJid: string | null;
  directory: Directory;
  onResetFilters?(): void;
}

const emptyCopy = {
  me: { titleKey: 'chatList.empty.me.title', descriptionKey: 'chatList.empty.me.description' },
  none: {
    titleKey: 'chatList.empty.none.title',
    descriptionKey: 'chatList.empty.none.description',
  },
  any: { titleKey: 'chatList.empty.any.title', descriptionKey: 'chatList.empty.any.description' },
} as const satisfies Record<ChatFilters['assigned'], { titleKey: string; descriptionKey: string }>;

function ChatRowSkeleton() {
  return (
    <div className="flex min-h-16 items-center gap-3 px-3 py-2.5">
      <Skeleton className="size-12 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-3.5 w-3/4" />
      </div>
    </div>
  );
}

export function ChatList({ filters, activeJid, directory, onResetFilters }: ChatListProps) {
  const { t } = useTranslation(['inbox', 'common']);
  const q = useChats(filters);
  // Proposed (multi-inbox): one unified list of every inbox the user may open. The mock filters here;
  // the app filters on the server, so an agent never receives a chat of another inbox.
  const inboxes = useMockInboxes();
  const { user } = useAuth();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  const chats = useMemo(() => {
    const seen = new Set<string>();
    const out: Chat[] = [];
    for (const p of q.data?.pages ?? [])
      for (const c of p.chats) {
        if (seen.has(c.jid)) continue;
        seen.add(c.jid);
        out.push(c);
      }
    const access = accessOf(inboxes, user);
    return out.filter((c) => {
      const inbox = inboxOfChat(inboxes, c.jid);
      if (!canOpen(access, inbox?.id)) return false;
      return inboxes.inboxFilter === 'all' || inbox?.id === inboxes.inboxFilter;
    });
  }, [q.data, inboxes, user]);

  // Infinite scroll: load the next page when the bottom sentinel becomes visible.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage)
          void fetchNextPage({ cancelRefetch: false });
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (q.isPending) {
    return (
      <div
        className="min-h-0 flex-1 overflow-hidden"
        role="status"
        aria-label={t('chatList.loading')}
      >
        {Array.from({ length: 8 }, (_, i) => (
          <ChatRowSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="p-3">
        <Banner
          tone="danger"
          title={t('chatList.loadFailed')}
          action={
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
              {t('common:actions.tryAgain')}
            </Button>
          }
        >
          {q.error instanceof Error ? q.error.message : null}
        </Banner>
      </div>
    );
  }

  if (chats.length === 0) {
    const empty = emptyCopy[filters.assigned];
    const copy = filters.q
      ? {
          title: t('common:status.noResults'),
          description: t('chatList.empty.search', { query: filters.q }),
        }
      : filters.tag
        ? {
            title: t('common:status.noResults'),
            description: t('chatList.empty.tag', { tag: filters.tag }),
          }
        : filters.status === 'resolved'
          ? {
              title: t('chatList.empty.resolvedTitle'),
              description: t('chatList.empty.resolvedDescription'),
            }
          : { title: t(empty.titleKey), description: t(empty.descriptionKey) };
    return (
      <EmptyState
        className="flex-1"
        illustration={
          filters.q || filters.tag
            ? '/illustrations/no-results.png'
            : '/illustrations/empty-inbox.png'
        }
        title={copy.title}
        description={copy.description}
        action={
          onResetFilters &&
          (filters.q ||
            filters.tag ||
            filters.assigned !== 'any' ||
            filters.status === 'resolved') ? (
            <Button variant="outline" size="touch" onClick={onResetFilters}>
              {t('chatList.showAllOpen')}
            </Button>
          ) : (
            // PROPOSED: on phones the chat list is the whole screen, so the checklist shows here.
            <GettingStartedCard className="mt-2 md:hidden" />
          )
        }
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ul className="divide-y divide-border/60">
        {chats.map((c) => (
          <li key={c.jid}>
            <MemoChatListItem
              chat={c}
              active={c.jid === activeJid}
              assigneeName={directory.nameOf(c.assignedTo, { youLabel: true })}
              assignedToMe={c.assignedTo != null && c.assignedTo === directory.me?.id}
            />
          </li>
        ))}
      </ul>
      <div ref={sentinelRef} className="h-px" />
      {isFetchingNextPage && (
        <div className="flex justify-center p-3 text-muted-foreground" role="status">
          <Loader2 className="size-5 animate-spin" aria-label={t('chatList.loadingMore')} />
        </div>
      )}
      {hasNextPage && !isFetchingNextPage && (
        <div className="flex justify-center p-2">
          <Button
            variant="ghost"
            size="touch"
            onClick={() => void fetchNextPage({ cancelRefetch: false })}
          >
            {t('chatList.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

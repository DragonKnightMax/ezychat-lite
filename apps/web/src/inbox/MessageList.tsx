import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '@ezychat/shared';
import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDay } from '../lib/format';
import { EventItem, NoteItem } from './EventItem';
import type { MessageChangeProps } from './message-changes';
import { MessageBubble } from './MessageBubble';
import type { TimelineItem } from './timeline';
import type { Directory } from './useDirectory';

export interface MessageListProps {
  items: TimelineItem[];
  messagesById: Map<string, Message>;
  isGroup: boolean;
  directory: Directory;
  loading: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder(): void;
  onRetry(m: Message): void;
  retryingId: string | null;
  onReply?(m: Message): void;
  /** React as the linked number ('' removes); offered wherever a reply is. */
  onReact?(m: Message, emoji: string): void;
  /** Why reacting is not possible now (WhatsApp not connected); null when it is. */
  reactDisabledReason?: string | null;
  /** Direct chats: the customer's display name, for quotes. */
  contactName?: string;
  /** Edit and delete sent messages (rights per message, handlers). */
  changes?: MessageChangeProps;
  footer?: React.ReactNode;
}

const NEAR_BOTTOM_PX = 150;

function DaySeparator({ date }: { date: number }) {
  useTranslation(); // re-render the localized day label on language change
  return (
    <div className="sticky top-1 z-10 flex justify-center py-2" role="separator">
      <span className="rounded-full border bg-surface/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
        {formatDay(date)}
      </span>
    </div>
  );
}

export function MessageList({
  items,
  messagesById,
  isGroup,
  directory,
  loading,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  retryingId,
  onReply,
  onReact,
  reactDisabledReason,
  contactName,
  changes,
  footer,
}: MessageListProps) {
  const { t } = useTranslation('inbox');
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prev = useRef<{ first?: string; last?: string; height: number; initialized: boolean }>({
    height: 0,
    initialized: false,
  });
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function')
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    nearBottom.current = near;
    setShowJump(!near);
  }, []);

  // Keep scroll position sensible as items change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = items[0]?.key;
    const lastItem = items[items.length - 1];
    const last = lastItem?.key;
    const p = prev.current;
    if (!p.initialized) {
      if (items.length > 0) {
        scrollToBottom();
        p.initialized = true;
      }
    } else if (first !== p.first && last === p.last) {
      // Older page prepended: keep the visible content where it was.
      el.scrollTop += el.scrollHeight - p.height;
    } else if (last !== p.last) {
      const mine =
        lastItem?.kind === 'message' &&
        lastItem.message.fromMe &&
        lastItem.message.sentByUserId === directory.me?.id;
      if (nearBottom.current || mine) scrollToBottom();
    }
    p.first = first;
    p.last = last;
    p.height = el.scrollHeight;
  }, [items, scrollToBottom, directory.me?.id]);

  // Load older messages when the top sentinel is visible.
  useEffect(() => {
    const el = topRef.current;
    const root = scrollRef.current;
    if (!el || !root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((e) => e.isIntersecting) &&
          hasOlder &&
          !loadingOlder &&
          prev.current.initialized
        )
          onLoadOlder();
      },
      { root, rootMargin: '300px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasOlder, loadingOlder, onLoadOlder]);

  const onMediaLoad = useCallback(() => {
    if (nearBottom.current) scrollToBottom();
    if (scrollRef.current) prev.current.height = scrollRef.current.scrollHeight;
  }, [scrollToBottom]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain bg-background py-2"
        aria-label={t('messageList.label')}
        role="log"
      >
        <div ref={topRef} className="h-px" />
        {loadingOlder && (
          <div
            className="flex flex-col gap-2 px-4 py-2"
            role="status"
            aria-label={t('messageList.loadingOlder')}
          >
            <Skeleton className="h-10 w-2/3 rounded-2xl" />
            <Skeleton className="ml-auto h-8 w-1/2 rounded-2xl" />
          </div>
        )}
        {!hasOlder && !loading && items.length > 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">{t('messageList.start')}</p>
        )}
        {loading && items.length === 0 ? (
          <div
            className="flex flex-col gap-3 px-4 py-2"
            role="status"
            aria-label={t('messageList.loading')}
          >
            <Skeleton className="h-12 w-2/3 rounded-2xl" />
            <Skeleton className="h-8 w-1/2 rounded-2xl" />
            <Skeleton className="ml-auto h-10 w-3/5 rounded-2xl" />
            <Skeleton className="h-14 w-2/3 rounded-2xl" />
            <Skeleton className="ml-auto h-8 w-2/5 rounded-2xl" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t('messageList.empty')}</p>
        ) : (
          items.map((it) => {
            switch (it.kind) {
              case 'day':
                return <DaySeparator key={it.key} date={it.date} />;
              case 'event':
                return <EventItem key={it.key} event={it.event} directory={directory} />;
              case 'note':
                return <NoteItem key={it.key} note={it.note} directory={directory} />;
              case 'message': {
                const m = it.message;
                const outboundLabel = m.fromMe
                  ? m.sentByUserId == null
                    ? t('messageList.viaPhone')
                    : directory.nameOf(m.sentByUserId)
                  : null;
                return (
                  <MessageBubble
                    key={it.key}
                    message={m}
                    showSender={isGroup}
                    outboundLabel={outboundLabel}
                    quoted={m.quotedId ? (messagesById.get(m.quotedId) ?? null) : null}
                    onRetry={onRetry}
                    retrying={retryingId === m.id}
                    onMediaLoad={onMediaLoad}
                    directory={directory}
                    onReply={onReply}
                    onReact={onReact}
                    reactDisabledReason={reactDisabledReason}
                    contactName={contactName}
                    changes={changes}
                  />
                );
              }
            }
          })
        )}
        {footer}
      </div>
      {showJump && (
        <Button
          variant="outline"
          size="icon-touch"
          aria-label={t('messageList.jumpToLatest')}
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-3 right-3 rounded-full bg-surface shadow-lg"
        >
          <ArrowDown className="size-5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

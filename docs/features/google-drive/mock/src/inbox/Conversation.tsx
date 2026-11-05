import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { Message } from '@ezychat/shared';
import { ApiError } from '../api/client';
import {
  flattenMessages,
  newClientId,
  qk,
  useChat,
  useGroupMembers,
  useMarkRead,
  useMessages,
  useNotes,
  usePatchChat,
  useQuickReplies,
  useRetryMessage,
  useSendMedia,
  useSendText,
  useWaStatus,
  type MessagesData,
} from '../api/queries';
import { useRealtime } from '../api/socket';
import { i18n } from '@/i18n';
import { toast } from 'sonner';
import { Banner, EmptyState } from '@/components/app';
import { useAuth } from '../auth/AuthProvider';
import { accessOf, canOpen, inboxOfChat, useMockInboxes } from '../mock/inboxes';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMediaQuery } from '@/lib/use-media-query';
import { Composer } from './Composer';
// Proposed (business-api): the 24-hour window of a Business API chat.
import { ReplyWindowNote, WindowClosedPanel, useReplyWindow } from './ReplyWindow';
import { CustomerPanel } from './CustomerPanel';
import { ConversationHeader } from './ConversationHeader';
import { chatTitle } from './chat-title';
import { MessageList } from './MessageList';
import { ReactionSimulator } from '../mock/ReactionSimulator';
import { GroupChatMockControls } from '../mock/GroupsMockControls';
import { quotedAuthor, quotedPreview } from './MessageBubble';
import { NotesPanel } from './NotesPanel';
import { GroupPanel } from './GroupPanel';
import { useNavigationGuardRef } from './navigation-guard';
import { buildTimeline } from './timeline';
import { TypingIndicator } from './TypingIndicator';
import type { Directory } from './useDirectory';
import { waQueuesMessages, waSendingBlocked } from './WaBanner';

export interface ConversationProps {
  jid: string;
  directory: Directory;
  onBack(): void;
}

function toastError(e: unknown) {
  toast.error(e instanceof Error ? e.message : i18n.t('inbox:conversation.updateFailed'));
}

/** Chats where the user already agreed to reply despite another assignee (this session). */
const confirmedChats = new Set<string>();

export function Conversation({ jid, directory, onBack }: ConversationProps) {
  const { t } = useTranslation(['inbox', 'common']);
  // Phones get the short placeholder (one line); the "/" quick-reply hint fits from sm.
  const wideComposer = useMediaQuery('(min-width: 640px)');
  const qc = useQueryClient();
  const chatQ = useChat(jid);
  const messagesQ = useMessages(jid);
  const notesQ = useNotes(jid);
  const quickReplies = useQuickReplies();
  const wa = useWaStatus();
  // Proposed (multi-inbox): inbox access (mock store).
  const mockInboxes = useMockInboxes();
  const windowLeftMs = useReplyWindow(jid);
  const { user: signedIn } = useAuth();
  const sendText = useSendText(jid);
  const sendMedia = useSendMedia(jid);
  // The message a reply will quote; cleared after sending and when another chat opens.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  useEffect(() => setReplyTo(null), [jid]);
  const retry = useRetryMessage();
  const markRead = useMarkRead(jid);
  const patch = usePatchChat(jid);
  const { typing, emitTyping } = useRealtime();
  const [searchParams] = useSearchParams();
  const [notesOpen, setNotesOpen] = useState(false);
  // `?customer=1` (from a group sender's "Open chat") opens the Customer panel.
  const [customerOpen, setCustomerOpen] = useState(() => searchParams.get('customer') === '1');
  const [groupOpen, setGroupOpen] = useState(false);
  // Set by CustomerPanel while editing: switching panels or chats asks before losing changes.
  // It is the inbox page's navigation guard, so chat list links ask too.
  const customerGuard = useNavigationGuardRef();
  const leaveCustomer = (next: () => void) =>
    customerGuard.current ? customerGuard.current(next) : next();
  const [confirm, setConfirm] = useState<{ name: string; resolve(ok: boolean): void } | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const chat = chatQ.data?.chat;
  // Group chats: the member count under the name (same cached list the Group info panel uses).
  const groupMembers = useGroupMembers(jid, chat?.type === 'group');
  // Proposed (group-mentions): typing @ again retries a member list that failed to load.
  const membersFailed = groupMembers.isError;
  const refetchMembers = groupMembers.refetch;
  const refetchMembersOnError = useCallback(() => {
    if (membersFailed) void refetchMembers();
  }, [membersFailed, refetchMembers]);
  const events = chatQ.data?.events;
  const me = directory.me;

  const messages = useMemo(
    () => flattenMessages(messagesQ.data as MessagesData | undefined),
    [messagesQ.data],
  );
  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const notes = notesQ.data;
  const items = useMemo(
    () => buildTimeline(messages, events ?? [], notes ?? []),
    [messages, events, notes],
  );

  // Mark read on open and whenever a new inbound message arrives while viewing.
  const lastInboundId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && !m.fromMe) return m.id;
    }
    return null;
  }, [messages]);
  const lastMarked = useRef<string | null | undefined>(undefined);
  const unread = chat?.unreadCount ?? 0;
  const { mutate: doMarkRead } = markRead;
  useEffect(() => {
    if (!chat) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (lastMarked.current === lastInboundId && unread === 0) return;
    lastMarked.current = lastInboundId;
    doMarkRead();
  }, [chat, lastInboundId, unread, doMarkRead]);

  // Re-mark when the tab becomes visible again.
  useEffect(() => {
    const onVis = () => {
      if (
        document.visibilityState === 'visible' &&
        (qc.getQueryData<{ chat: { unreadCount: number } }>(qk.chat(jid))?.chat.unreadCount ?? 0) >
          0
      )
        doMarkRead();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [qc, jid, doMarkRead]);

  const confirmSend = useCallback((): Promise<boolean> | boolean => {
    if (!chat || chat.assignedTo == null || chat.assignedTo === me?.id) return true;
    if (confirmedChats.has(jid)) return true;
    const name = directory.nameOf(chat.assignedTo) ?? t('conversation.someoneElse');
    return new Promise<boolean>((resolve) => setConfirm({ name, resolve }));
  }, [chat, me?.id, jid, directory, t]);

  function closeConfirm(ok: boolean) {
    if (ok) confirmedChats.add(jid);
    confirm?.resolve(ok);
    setConfirm(null);
  }

  function onRetry(m: Message) {
    setRetryingId(m.id);
    retry.mutate(m.id, {
      onError: (e) => {
        // The optimistic row never reached the server: resend it as a new message.
        if (
          e instanceof ApiError &&
          e.status === 404 &&
          m.id.startsWith('local-') &&
          m.type === 'text' &&
          m.body
        ) {
          qc.setQueryData<MessagesData>(qk.messages(jid), (old) =>
            old
              ? {
                  ...old,
                  pages: old.pages.map((p) => ({
                    ...p,
                    messages: p.messages.filter((x) => x.id !== m.id),
                  })),
                }
              : old,
          );
          sendText.mutate({
            text: m.body,
            quotedId: m.quotedId ?? undefined,
            clientId: newClientId(),
          });
        } else {
          toast.error(e instanceof Error ? e.message : t('conversation.retryFailed'));
        }
      },
      onSettled: () => setRetryingId(null),
    });
  }

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messagesQ;
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (chatQ.isPending) {
    return (
      <div className="flex flex-1 flex-col" role="status" aria-label={t('conversation.loading')}>
        <div className="flex items-center gap-3 border-b bg-surface px-3 py-2">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <Skeleton className="h-12 w-2/3 rounded-2xl" />
          <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
          <Skeleton className="h-8 w-3/5 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (chatQ.isError || !chat) {
    const notFound = chatQ.error instanceof ApiError && chatQ.error.status === 404;
    return (
      <EmptyState
        className="flex-1"
        illustration="/illustrations/no-results.png"
        title={notFound ? t('conversation.notFound') : t('conversation.loadFailed')}
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="touch" onClick={onBack}>
              {t('conversation.back')}
            </Button>
            {!notFound && (
              <Button size="touch" onClick={() => void chatQ.refetch()}>
                {t('common:actions.tryAgain')}
              </Button>
            )}
          </div>
        }
      />
    );
  }

  const chatInbox = inboxOfChat(mockInboxes, chat.jid);
  if (!canOpen(accessOf(mockInboxes, signedIn), chatInbox?.id)) {
    // The app answers 404 for such a chat, so nobody can tell it exists; the mock shows why.
    return (
      <EmptyState
        className="flex-1"
        illustration="/illustrations/no-results.png"
        title={t('mockInbox.noAccessTitle')}
        description={t('mockInbox.noAccessBody')}
        action={
          <Button variant="outline" size="touch" onClick={onBack}>
            {t('conversation.back')}
          </Button>
        }
      />
    );
  }

  const waState = wa.data?.state;
  const blocked = waSendingBlocked(waState);
  const queued = waQueuesMessages(waState);
  // Quotes in a direct chat name the customer like the header does (groups name each sender).
  const contactName = chat.type === 'dm' ? chatTitle(chat, t) : undefined;
  // Proposed (MCP send to a new number): a chat an AI assistant started, where the customer has not
  // written yet. The mock recognises it by the send tool's clientId; the app will use a stored marker.
  const startedByAssistant =
    chat.type === 'dm' &&
    messages.length > 0 &&
    messages.every((m) => m.fromMe) &&
    messages.some((m) => m.clientId?.startsWith('mcp-'));

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-label={t('conversation.label', { name: chatTitle(chat, t) })}
      >
        <ConversationHeader
          chat={chat}
          directory={directory}
          onBack={onBack}
          busy={patch.isPending}
          onAssign={(id) => patch.mutate({ assignedTo: id }, { onError: toastError })}
          onToggleStatus={() =>
            patch.mutate(
              { status: chat.status === 'resolved' ? 'open' : 'resolved' },
              { onError: toastError },
            )
          }
          notesOpen={notesOpen}
          notesCount={notes?.length ?? 0}
          onToggleNotes={() =>
            leaveCustomer(() => {
              setNotesOpen((o) => !o);
              setCustomerOpen(false);
              setGroupOpen(false);
            })
          }
          showCustomer={chat.type === 'dm'}
          customerOpen={customerOpen && chat.type === 'dm'}
          onToggleCustomer={() => {
            if (customerOpen) return leaveCustomer(() => setCustomerOpen(false));
            setCustomerOpen(true);
            setNotesOpen(false);
          }}
          memberCount={groupMembers.data?.group.size ?? null}
          onOpenInfo={() => {
            if (chat.type === 'group') {
              setGroupOpen(true);
              setNotesOpen(false);
              return;
            }
            setCustomerOpen(true);
            setNotesOpen(false);
          }}
        />
        {startedByAssistant && (
          <Banner tone="warning" title={t('mockSend.startedTitle')} className="mx-3 mt-3 md:mx-4">
            <span data-testid="started-by-assistant">{t('mockSend.startedBody')}</span>
          </Banner>
        )}
        {/* Proposed (emoji-reactions): mock-only panel that simulates reactions from WhatsApp. */}
        <ReactionSimulator messages={messages} isGroup={chat.type === 'group'} />
        {/* Proposed (ai-groups): mock-only panel that simulates the AI in this group. */}
        {chat.type === 'group' && <GroupChatMockControls jid={chat.jid} />}
        <MessageList
          items={items}
          messagesById={messagesById}
          isGroup={chat.type === 'group'}
          directory={directory}
          loading={messagesQ.isPending}
          hasOlder={!!hasNextPage}
          loadingOlder={isFetchingNextPage}
          onLoadOlder={loadOlder}
          onRetry={onRetry}
          retryingId={retryingId}
          onReply={setReplyTo}
          contactName={contactName}
        />
        <div className="safe-bottom border-t bg-surface">
          <TypingIndicator entries={typing[jid] ?? []} meId={me?.id ?? null} />
          {(blocked || queued) && (
            <p
              className={
                blocked
                  ? 'px-3 pt-2 text-xs font-medium text-danger'
                  : 'px-3 pt-2 text-xs font-medium text-warning'
              }
              role="status"
            >
              {blocked ? t('conversation.sendingBlocked') : t('conversation.reconnecting')}
            </p>
          )}
          {windowLeftMs !== null && windowLeftMs > 0 && (
            <ReplyWindowNote jid={jid} left={windowLeftMs} />
          )}
          {windowLeftMs === 0 ? (
            <WindowClosedPanel
              jid={jid}
              customerName={chatTitle(chat, t)}
              disabled={blocked}
              onSendTemplate={(text, template) =>
                sendText.mutate({
                  text,
                  clientId: `tpl.${template.name}.${newClientId().slice(0, 12)}`,
                })
              }
            />
          ) : (
            <div className="px-2 py-2 sm:px-3">
              <Composer
                key={jid}
                quickReplies={quickReplies.data ?? []}
                disabled={blocked}
                placeholder={
                  blocked
                    ? t('conversation.placeholderBlocked')
                    : wideComposer
                      ? t('conversation.placeholder')
                      : t('composer.placeholder')
                }
                confirmSend={confirmSend}
                onTyping={() => emitTyping(jid)}
                replyTo={
                  replyTo
                    ? {
                        id: replyTo.id,
                        author: quotedAuthor(replyTo, t, contactName),
                        preview: quotedPreview(replyTo, t),
                      }
                    : null
                }
                onCancelReply={() => setReplyTo(null)}
                // Proposed (ai-reply-suggestions): AI help in direct chats only.
                aiSuggest={
                  chat.type === 'dm'
                    ? {
                        chatJid: chat.jid,
                        lastCustomerMessageId: lastInboundId,
                        isAdmin: me?.role === 'admin',
                      }
                    : null
                }
                // Proposed (group-mentions): `@` tags group members (linked-phone groups).
                mentions={
                  chat.type === 'group'
                    ? {
                        members: groupMembers.data?.members ?? null,
                        error: groupMembers.isError,
                        onOpen: refetchMembersOnError,
                      }
                    : null
                }
                onSend={(text, mentions, shown) => {
                  sendText.mutate({
                    text,
                    clientId: newClientId(),
                    quotedId: replyTo?.id,
                    ...(mentions?.length ? { mentions, shown } : {}),
                  });
                  setReplyTo(null);
                }}
                onAttach={(file, caption) => {
                  sendMedia.mutate({
                    file,
                    caption,
                    clientId: newClientId(),
                    quotedId: replyTo?.id,
                  });
                  setReplyTo(null);
                }}
                onVoiceNote={async (file, clientId) => {
                  await sendMedia.mutateAsync({
                    file,
                    voiceNote: true,
                    clientId,
                    quotedId: replyTo?.id,
                  });
                  setReplyTo(null);
                }}
              />
            </div>
          )}
        </div>
      </section>
      <NotesPanel
        jid={jid}
        open={notesOpen}
        notes={notes ?? []}
        loading={notesQ.isPending}
        directory={directory}
        onClose={() => setNotesOpen(false)}
      />
      {chat.type === 'group' && (
        <GroupPanel jid={jid} open={groupOpen} onClose={() => setGroupOpen(false)} />
      )}
      {chat.type === 'dm' && (
        <CustomerPanel
          jid={jid}
          open={customerOpen}
          directory={directory}
          onClose={() => setCustomerOpen(false)}
          guardRef={customerGuard}
        />
      )}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && closeConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('conversation.confirmTitle', { name: confirm?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                t={t}
                i18nKey="conversation.confirmBody"
                values={{ name: confirm?.name ?? '' }}
                components={{ strong: <strong className="text-foreground" /> }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9" onClick={() => closeConfirm(false)}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction className="min-h-11 sm:min-h-9" onClick={() => closeConfirm(true)}>
              {t('conversation.replyAnyway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

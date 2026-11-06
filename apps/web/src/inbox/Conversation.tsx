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
  useSendReaction,
  useSendMedia,
  useInboxStatus,
  useInboxes,
  useSendText,
  type MessagesData,
} from '../api/queries';
import { acceptedWords, type ReplyPhraseListItem } from '@ezychat/shared';
import { usePhraseList, useReplySuggestionsStatus } from '../api/reply-suggestions';
import { addTeamWord, teamWordsKey, useFixEnglishStatus, useTeamWords } from '../api/fix-english';
import { useGroupChatAi } from '../api/ai-groups';
import { useRealtime } from '../api/socket';
import { i18n } from '@/i18n';
import { toast } from 'sonner';
import { Banner, EmptyState } from '@/components/app';
import { FileDropZone } from '@/components/app/FileDropZone';
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
import { Composer, type ComposerHandle } from './Composer';
import { CustomerPanel } from './CustomerPanel';
import { ConversationHeader } from './ConversationHeader';
import { chatTitle } from './chat-title';
import { MessageList } from './MessageList';
import { quotedAuthor, quotedPreview } from './MessageBubble';
import { useQuoteJump } from './useQuoteJump';
import { NotesPanel } from './NotesPanel';
import { GroupPanel } from './GroupPanel';
import { useNavigationGuardRef } from './navigation-guard';
import { buildTimeline } from './timeline';
import { assistantStartedChat } from './assistant-started';
import { TypingIndicator } from './TypingIndicator';
import type { Directory } from './useDirectory';
import { useInboxOfChat } from './useVisibleInboxes';
import { waQueuesMessages, waSendingBlocked } from './WaBanner';
import { ReplyWindowNote, WindowClosedPanel } from './ReplyWindow';
import { SafetyChatBar } from './SafetyMessage';
import {
  inboxCapabilities,
  useInboxCanTag,
  useReplyWindowHours,
  useWindowClosed,
} from './reply-window';
import { DeleteMessageDialog, EditMessageDialog } from './MessageActions';
import { NO_RIGHTS, messageRights, type MessageChangeProps } from './message-changes';
import { useChosenChatsOnly } from '../auth/chat-scope';

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

/** One empty list, so the composer's completion effect does not restart on every render. */
const NO_PHRASES: readonly ReplyPhraseListItem[] = [];

export function Conversation({ jid, directory, onBack }: ConversationProps) {
  const { t } = useTranslation(['inbox', 'common']);
  // Ask Ezy reads across chats: not for an agent limited to chosen chats
  const chosenOnly = useChosenChatsOnly();
  // Phones get the short placeholder (one line); the "/" quick-reply hint fits from sm.
  const wideComposer = useMediaQuery('(min-width: 640px)');
  const qc = useQueryClient();
  const chatQ = useChat(jid);
  const messagesQ = useMessages(jid);
  const notesQ = useNotes(jid);
  const quickReplies = useQuickReplies();
  const inboxOf = useInboxOfChat();
  const sendText = useSendText(jid);
  const sendMedia = useSendMedia(jid);
  // The message a reply will quote; cleared after sending and when another chat opens.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  useEffect(() => setReplyTo(null), [jid]);
  const retry = useRetryMessage();
  const { mutate: doReact } = useSendReaction();
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
  // The composer follows the chat's own inbox: another phone offline never blocks this one.
  const waState = useInboxStatus(chat?.inboxId)?.state;
  // WhatsApp Business API: free-form replies only within the inbox's reply window.
  const windowHoursOf = useReplyWindowHours();
  const windowHours = chat ? windowHoursOf(chat.inboxId) : null;
  const windowClosedNow = useWindowClosed(chat?.lastInboundAt, windowHours);
  /** The server refused a send with `window_closed` (until the customer writes again). */
  const [refusedAt, setRefusedAt] = useState<{ jid: string; lastInboundAt: number | null } | null>(
    null,
  );
  const windowClosed =
    windowClosedNow === true ||
    (refusedAt !== null &&
      refusedAt.jid === jid &&
      refusedAt.lastInboundAt === (chat?.lastInboundAt ?? null));
  // Group chats: the member count under the name (same cached list the Group info panel uses).
  const groupMembers = useGroupMembers(jid, chat?.type === 'group');
  const canTag = useInboxCanTag();
  // Typing @ again retries a member list that failed to load.
  const membersFailed = groupMembers.isError;
  const refetchMembers = groupMembers.refetch;
  const retryMembers = useCallback(() => {
    if (membersFailed) void refetchMembers();
  }, [membersFailed, refetchMembers]);
  // Group chats: whether the AI agent answers when tagged or quoted (header badge, Group info).
  const groupAi = useGroupChatAi(chat?.type === 'group' ? jid : null);
  const events = chatQ.data?.events;
  const me = directory.me;
  const replySuggestions = useReplySuggestionsStatus();
  const suggestState = replySuggestions.data?.state ?? 'off';
  // Fix English: spelling and grammar marks in the composer (every chat type).
  const fixEnglish = useFixEnglishStatus();
  const teamWords = useTeamWords(fixEnglish.data?.spelling === 'on');
  const acceptedTeamWords = useMemo(
    () => acceptedWords(teamWords.data?.words ?? [], teamWords.data?.businessWords ?? []),
    [teamWords.data],
  );
  // The team's phrase list for instant grey text (direct chats while suggestions are on).
  const phraseList = usePhraseList(jid, suggestState === 'on' && chat?.type === 'dm');

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
  const composerRef = useRef<ComposerHandle>(null);
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

  /** A send refused because the reply window closed shows the template panel at once. */
  const onSendError = useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError) || e.code !== 'window_closed') return;
      setRefusedAt({ jid, lastInboundAt: chat?.lastInboundAt ?? null });
      void qc.invalidateQueries({ queryKey: qk.chat(jid) });
    },
    [jid, chat?.lastInboundAt, qc],
  );

  // The badge changes when the server answers (and for teammates through message:reactions).
  const onReact = useCallback(
    (m: Message, emoji: string) =>
      doReact(
        { chatJid: jid, messageId: m.id, emoji },
        {
          onError: (e) =>
            toast.error(t('message.reactions.notSent'), {
              description: e instanceof Error ? e.message : undefined,
            }),
        },
      ),
    [doReact, jid, t],
  );

  // Edit and delete sent messages: only on a connection that can (a linked phone).
  const { data: inboxList } = useInboxes();
  const inboxId = chat?.inboxId;
  const caps = useMemo(
    () => inboxCapabilities(inboxList?.inboxes.find((i) => i.id === inboxId) ?? {}),
    [inboxList, inboxId],
  );
  const [editing, setEditing] = useState<Message | null>(null);
  const [deleting, setDeleting] = useState<Message | null>(null);
  useEffect(() => {
    setEditing(null);
    setDeleting(null);
  }, [jid]);
  // The time windows are read when a bubble renders; the server checks them again.
  const rightsOf = useCallback((m: Message) => messageRights(m, me, caps, Date.now()), [me, caps]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messagesQ;
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const { target: jumpTarget, open: jumpToQuote } = useQuoteJump(jid, messagesById, {
    hasNextPage: !!hasNextPage,
    fetchNextPage: () => fetchNextPage(),
  });
  const openQuote = useCallback((id: string) => void jumpToQuote(id), [jumpToQuote]);

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

  const blocked = waSendingBlocked(waState);
  const queued = waQueuesMessages(waState);
  // Quotes in a direct chat name the customer like the header does (groups name each sender).
  const contactName = chat.type === 'dm' ? chatTitle(chat, t) : undefined;
  const startedByAssistant = assistantStartedChat(chat, messages, !!hasNextPage);
  const changes: MessageChangeProps = {
    rightsOf,
    disabledReason: blocked || queued ? t('message.change.notConnected') : null,
    onEdit: setEditing,
    onDelete: setDeleting,
    isAdmin: me?.role === 'admin',
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <FileDropZone
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-label={t('conversation.label', { name: chatTitle(chat, t) })}
        enabled={!blocked && !windowClosed}
        onFiles={(files) => composerRef.current?.addFiles(files)}
      >
        <ConversationHeader
          chat={chat}
          directory={directory}
          inbox={inboxOf(chat.inboxId)}
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
          groupAi={chat.type === 'group' ? groupAi.data : null}
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
        <SafetyChatBar jid={jid} />
        {startedByAssistant && (
          <Banner
            tone="warning"
            title={t('conversation.startedByAssistantTitle')}
            className="mx-3 mt-3 md:mx-4"
          >
            <span data-testid="started-by-assistant">
              {t('conversation.startedByAssistantBody')}
            </span>
          </Banner>
        )}
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
          onReact={onReact}
          reactDisabledReason={blocked || queued ? t('message.reactions.notConnected') : null}
          contactName={contactName}
          changes={changes}
          onOpenQuote={openQuote}
          jumpTo={jumpTarget}
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
          {windowHours !== null && !windowClosed && (
            <ReplyWindowNote lastInboundAt={chat.lastInboundAt ?? null} windowHours={windowHours} />
          )}
          {windowClosed ? (
            <WindowClosedPanel
              jid={jid}
              inboxId={chat.inboxId}
              customerName={chatTitle(chat, t)}
              disabled={blocked}
            />
          ) : (
            <div className="px-2 py-2 sm:px-3">
              <Composer
                key={jid}
                ref={composerRef}
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
                askEzy={chosenOnly ? null : { chatJid: chat.jid, name: chatTitle(chat, t) }}
                aiSuggest={
                  suggestState !== 'off'
                    ? {
                        chatJid: chat.jid,
                        lastCustomerMessageId: lastInboundId,
                        isAdmin: me?.role === 'admin',
                        state: suggestState,
                        phrases: phraseList.data?.phrases ?? NO_PHRASES,
                      }
                    : null
                }
                fixEnglish={{
                  chatJid: chat.jid,
                  chatName: chat.name,
                  status: fixEnglish.data,
                  teamWords: acceptedTeamWords,
                  onAddWord: (word) =>
                    addTeamWord(word).then((data) => qc.setQueryData(teamWordsKey, data)),
                }}
                // @ tags group members when the group's connection can tag.
                mentions={
                  chat.type === 'group' && canTag(chat.inboxId)
                    ? {
                        members: groupMembers.data?.members ?? null,
                        error: groupMembers.isError,
                        onOpen: retryMembers,
                      }
                    : null
                }
                onSend={(text, mentions, shown) => {
                  sendText.mutate(
                    {
                      text,
                      clientId: newClientId(),
                      quotedId: replyTo?.id,
                      ...(mentions?.length ? { mentions, shown } : {}),
                    },
                    { onError: onSendError },
                  );
                  setReplyTo(null);
                }}
                onAttach={async (file, caption, index = 0) => {
                  // Only the first file of a send quotes the message being replied to.
                  const quotedId = index === 0 ? replyTo?.id : undefined;
                  if (index === 0) setReplyTo(null);
                  try {
                    await sendMedia.mutateAsync({
                      file,
                      caption,
                      clientId: newClientId(),
                      quotedId,
                    });
                  } catch (e) {
                    onSendError(e);
                  }
                }}
                onVoiceNote={async (file, clientId) => {
                  try {
                    await sendMedia.mutateAsync({
                      file,
                      voiceNote: true,
                      clientId,
                      quotedId: replyTo?.id,
                    });
                  } catch (e) {
                    onSendError(e);
                    throw e;
                  }
                  setReplyTo(null);
                }}
              />
            </div>
          )}
        </div>
      </FileDropZone>
      <NotesPanel
        jid={jid}
        open={notesOpen}
        notes={notes ?? []}
        loading={notesQ.isPending}
        directory={directory}
        onClose={() => setNotesOpen(false)}
      />
      {chat.type === 'group' && (
        <GroupPanel
          jid={jid}
          open={groupOpen}
          isAdmin={me?.role === 'admin'}
          onClose={() => setGroupOpen(false)}
        />
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
      <EditMessageDialog message={editing} onClose={() => setEditing(null)} />
      <DeleteMessageDialog
        message={deleting}
        rights={deleting ? rightsOf(deleting) : NO_RIGHTS}
        onClose={() => setDeleting(null)}
      />
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

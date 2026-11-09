// Proposed (forward-message): forward one message to up to 5 existing chats or groups the user may open,
// as WhatsApp's "Forwarded". Never a new number (that is New chat). Each copy goes through the normal
// send queue as the signed-in user, from the WhatsApp number of the chat it goes to.
import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Forward,
  Image as ImageIcon,
  Loader2,
  Mic,
  Search,
  Users,
  Video,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Chat, Message } from '@ezychat/shared';
import { Banner, EmptyState, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ApiError, api } from '../api/client';
import { qk, useChats } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { encodeJid } from '../lib/jid';
import { accessOf, canOpen, inboxOfChat, useMockInboxes, windowLeft } from '../mock/inboxes';
import { useMyChats } from '../mock/memberChats';
import {
  forwardKey,
  forwardedMark,
  useForwardState,
  formatSize,
  type ForwardScenario,
  type ForwardState,
} from '../mock/forward';
import { ChatAvatar } from './ChatAvatar';
import { InboxChip } from './InboxChip';
import { chatTitle } from './chat-title';
import { quotedPreview } from './MessageBubble';
import { useVisibleInboxes } from './useVisibleInboxes';

/** Server refusals shown as a banner. */
type Problem =
  | 'wa_disconnected'
  | 'window_closed'
  | 'safety_locked'
  | 'rate_limited'
  | 'media_unavailable'
  | 'message_deleted'
  | 'too_large_as_video'
  | 'too_large_for_whatsapp'
  | 'other';
const KNOWN: ReadonlySet<string> = new Set([
  'wa_disconnected',
  'window_closed',
  'safety_locked',
  'rate_limited',
  'media_unavailable',
  'message_deleted',
  'too_large_as_video',
  'too_large_for_whatsapp',
]);

function TypeIcon({ type, voiceNote }: Readonly<{ type: Message['type']; voiceNote?: boolean }>) {
  const Icon =
    type === 'image' || type === 'sticker'
      ? ImageIcon
      : type === 'video'
        ? Video
        : type === 'audio' || voiceNote
          ? Mic
          : type === 'document'
            ? FileText
            : null;
  return Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null;
}

export function ForwardDialog({
  message,
  open,
  onClose,
}: Readonly<{ message: Message; open: boolean; onClose(): void }>) {
  const { t } = useTranslation('inbox');
  const ids = { search: useId(), scenario: useId() };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const inboxState = useMockInboxes();
  const visibleInboxes = useVisibleInboxes();
  const multiInbox = visibleInboxes.length > 1;
  const mine = useMyChats();
  const state = useForwardState().data;
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Chat[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const [sendAs, setSendAs] = useState<'original' | 'file'>('original');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setPicked([]);
      setProblem(null);
    }
  }, [open]);

  const q = useChats({ assigned: 'any', q: query });
  const mark = forwardedMark(state, message.id);
  // WhatsApp's own rule: a message forwarded many times goes to one chat at a time.
  const max = mark === 'many' ? 1 : (state?.limits.maxChats ?? 5);
  const locked = !!state?.safetyLocked.includes(message.id);
  const offline = state?.scenario === 'offline';
  const sourceInbox = inboxOfChat(inboxState, message.chatJid);

  const chats = useMemo(() => {
    const seen = new Set<string>();
    const out: Chat[] = [];
    const access = accessOf(inboxState, user);
    for (const p of q.data?.pages ?? [])
      for (const c of p.chats) {
        if (seen.has(c.jid)) continue;
        seen.add(c.jid);
        // Same visibility as the chat list: chosen chats for a limited agent, else inbox access.
        if (
          mine.limited
            ? !mine.jids.has(c.jid)
            : !canOpen(access, inboxOfChat(inboxState, c.jid)?.id)
        )
          continue;
        out.push(c);
      }
    return out.slice(0, 50);
  }, [q.data, inboxState, user, mine.limited, mine.jids]);

  const closed = (jid: string) => windowLeft(inboxState, jid) === 0;
  const isPicked = (jid: string) => picked.some((c) => c.jid === jid);
  const full = picked.length >= max;
  const toggle = (c: Chat) => {
    setProblem(null);
    if (isPicked(c.jid)) setPicked((p) => p.filter((x) => x.jid !== c.jid));
    else if (!full && !closed(c.jid) && !tooBig(c.jid)) setPicked((p) => [...p, c]);
  };
  // Large files: what WhatsApp takes depends on the connection of each chat's number.
  const size = state?.sizes[message.id] ?? 0;
  const kindOf = (jid: string) => inboxOfChat(inboxState, jid)?.type ?? 'linked_phone';
  const limitOf = (jid: string) =>
    state?.mediaLimits[kindOf(jid)] ?? { video: Infinity, image: Infinity, document: Infinity };
  const tooBig = (jid: string) => size > limitOf(jid).document;
  const isVideo = message.type === 'video' && size > 0;
  const videoMax = Math.min(...picked.map((c) => limitOf(c.jid).video));
  const videoBlocked = isVideo && picked.length > 0 && size > videoMax;
  const effectiveSendAs = videoBlocked ? 'file' : sendAs;
  const otherInbox = picked.some((c) => inboxOfChat(inboxState, c.jid)?.id !== sourceInbox?.id);

  const send = useMutation({
    mutationFn: () =>
      api<{ sent: number; messageIds: string[] }>('/mock/forward', {
        method: 'POST',
        body: {
          messageId: message.id,
          to: picked.map((c) => c.jid),
          clientRequestId: requestId,
          sendAs: effectiveSendAs,
          closedWindow: picked.filter((c) => closed(c.jid)).map((c) => c.jid),
          kinds: Object.fromEntries(picked.map((c) => [c.jid, kindOf(c.jid)])),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
      for (const c of picked) void qc.invalidateQueries({ queryKey: qk.messages(c.jid) });
      void qc.invalidateQueries({ queryKey: forwardKey });
      const one = picked.length === 1 ? picked[0]! : null;
      toast.success(
        one
          ? t('mockForward.sentOne', { name: chatTitle(one, t) })
          : t('mockForward.sentMany', { count: r.sent }),
        one
          ? {
              action: {
                label: t('mockForward.openChat'),
                onClick: () =>
                  navigate(`/chats/${encodeJid(one.jid)}`, { state: { fromList: true } }),
              },
            }
          : undefined,
      );
      onClose();
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : '';
      setProblem(KNOWN.has(code) ? (code as Problem) : 'other');
    },
  });

  const blocked = locked ? 'safety_locked' : offline ? 'wa_disconnected' : null;
  const shown = blocked ?? problem;
  const banner = shown && (
    <Banner
      tone={shown === 'window_closed' || shown === 'rate_limited' ? 'warning' : 'danger'}
      title={t(`mockForward.problems.${shown}.title`)}
    >
      {t(`mockForward.problems.${shown}.body`, { inbox: sourceInbox?.name ?? '' })}
    </Banner>
  );

  const footer = (
    <>
      <Button type="button" variant="outline" onClick={onClose} disabled={send.isPending}>
        {t('mockForward.cancel')}
      </Button>
      <Button
        type="button"
        disabled={!picked.length || !!blocked || send.isPending}
        onClick={() => send.mutate()}
        data-testid="forward-send"
      >
        {send.isPending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <Forward aria-hidden />
        )}
        {send.isPending
          ? t('mockForward.sending')
          : picked.length
            ? t('mockForward.sendCount', { count: picked.length })
            : t('mockForward.send')}
      </Button>
    </>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && !send.isPending && onClose()}
      title={t('mockForward.title')}
      description={t('mockForward.description', { max: state?.limits.maxChats ?? 5 })}
      footer={footer}
    >
      <div className="flex min-w-0 flex-col gap-3 pb-1" data-testid="forward-dialog">
        {/* What is being forwarded */}
        <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <TypeIcon type={message.type} voiceNote={message.voiceNote} />
          <p className="min-w-0 flex-1 truncate text-sm" data-testid="forward-preview">
            {quotedPreview(message, t)}
          </p>
          {size > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground" data-testid="forward-size">
              {formatSize(size)}
            </span>
          )}
        </div>
        {size >= 20 * 1024 * 1024 && !blocked && (
          <p className="text-sm text-muted-foreground">
            {t('mockForward.largeNote', { size: formatSize(size) })}
          </p>
        )}
        {isVideo && !blocked && (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="forward-send-as">
            <span className="text-sm font-medium" id={`${ids.scenario}-as`}>
              {t('mockForward.sendAs')}
            </span>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-labelledby={`${ids.scenario}-as`}
            >
              <Button
                type="button"
                size="sm"
                variant={effectiveSendAs === 'original' ? 'default' : 'outline'}
                aria-pressed={effectiveSendAs === 'original'}
                disabled={videoBlocked}
                className="pointer-coarse:min-h-11"
                onClick={() => setSendAs('original')}
              >
                {t('mockForward.asVideo')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={effectiveSendAs === 'file' ? 'default' : 'outline'}
                aria-pressed={effectiveSendAs === 'file'}
                className="pointer-coarse:min-h-11"
                onClick={() => setSendAs('file')}
              >
                {t('mockForward.asFile')}
              </Button>
            </div>
            <p
              className={cn('text-sm', videoBlocked ? 'text-warning' : 'text-muted-foreground')}
              data-testid="forward-send-as-note"
            >
              {videoBlocked
                ? t('mockForward.videoTooBig', {
                    size: formatSize(size),
                    max: formatSize(videoMax),
                  })
                : t('mockForward.sendAsHint')}
            </p>
          </div>
        )}
        {mark === 'many' && (
          <p className="text-sm text-muted-foreground">{t('mockForward.manyTimesNote')}</p>
        )}

        {banner}

        {!blocked && (
          <>
            {/* Chosen chats */}
            <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-live="polite">
              <span
                className={cn(
                  'text-xs font-medium',
                  full ? 'text-warning' : 'text-muted-foreground',
                )}
                data-testid="forward-count"
              >
                {t('mockForward.count', { count: picked.length, max })}
              </span>
              {picked.map((c) => (
                <span
                  key={c.jid}
                  className="inline-flex max-w-[12rem] items-center gap-1 rounded-full border bg-background py-0.5 pr-0.5 pl-2 text-xs"
                >
                  <span className="truncate">{chatTitle(c, t)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 rounded-full pointer-coarse:size-8"
                    aria-label={t('mockForward.remove', { name: chatTitle(c, t) })}
                    onClick={() => toggle(c)}
                  >
                    <X aria-hidden />
                  </Button>
                </span>
              ))}
            </div>
            {full && max > 1 && (
              <p className="text-sm text-warning" role="status" data-testid="forward-full">
                {t('mockForward.full', { max })}
              </p>
            )}

            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id={ids.search}
                type="search"
                autoComplete="off"
                aria-label={t('mockForward.search')}
                placeholder={t('mockForward.search')}
                className="h-11 pl-9 text-base md:h-9 md:text-sm"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="forward-search"
              />
            </div>

            <ul
              className="-mx-1 max-h-[45dvh] min-h-0 overflow-y-auto sm:max-h-80"
              aria-label={t('mockForward.listLabel')}
              data-testid="forward-list"
            >
              {q.isPending ? (
                <li className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t('mockForward.loading')}
                </li>
              ) : chats.length === 0 ? (
                <li>
                  <EmptyState
                    title={t('mockForward.emptyTitle')}
                    description={query ? t('mockForward.emptyQuery') : t('mockForward.emptyNone')}
                  />
                </li>
              ) : (
                chats.map((c) => {
                  const on = isPicked(c.jid);
                  const windowShut = closed(c.jid);
                  const fileTooBig = tooBig(c.jid);
                  const disabled = !on && (windowShut || fileTooBig || full);
                  const inbox = inboxOfChat(inboxState, c.jid);
                  const name = chatTitle(c, t);
                  const rowId = `fwd-${c.jid}`;
                  return (
                    <li key={c.jid}>
                      <label
                        htmlFor={rowId}
                        className={cn(
                          'flex min-h-14 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5',
                          on && 'bg-accent',
                          disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent/60',
                        )}
                        data-testid="forward-row"
                      >
                        <Checkbox
                          id={rowId}
                          checked={on}
                          disabled={disabled}
                          onCheckedChange={() => toggle(c)}
                          aria-describedby={windowShut || fileTooBig ? `${rowId}-why` : undefined}
                        />
                        <ChatAvatar name={name} src={c.avatarUrl} seed={c.jid} size="sm" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{name}</span>
                            {c.type === 'group' && (
                              <Users
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-label={t('chatListItem.group')}
                              />
                            )}
                          </span>
                          {fileTooBig ? (
                            <span id={`${rowId}-why`} className="text-xs text-warning">
                              {t('mockForward.tooBigRow', {
                                max: formatSize(limitOf(c.jid).document),
                              })}
                            </span>
                          ) : windowShut ? (
                            <span id={`${rowId}-why`} className="text-xs text-warning">
                              {t('mockForward.windowClosedRow')}
                            </span>
                          ) : (
                            c.type === 'group' && (
                              <span className="text-xs text-muted-foreground">
                                {t('chatListItem.group')}
                              </span>
                            )
                          )}
                        </span>
                        {multiInbox && inbox && <InboxChip inbox={inbox} className="shrink-0" />}
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
            {multiInbox && otherInbox && (
              <p className="text-xs text-muted-foreground" data-testid="forward-other-inbox">
                {t('mockForward.otherInbox')}
              </p>
            )}
          </>
        )}
        <MockControls
          scenario={state?.scenario ?? 'normal'}
          locked={locked}
          isVideo={isVideo}
          big={size >= 120 * 1024 * 1024}
          messageId={message.id}
          labelId={ids.scenario}
        />
      </div>
    </ResponsiveDialog>
  );
}

function MockControls({
  scenario,
  locked,
  isVideo,
  big,
  messageId,
  labelId,
}: Readonly<{
  scenario: ForwardScenario;
  locked: boolean;
  isVideo: boolean;
  big: boolean;
  messageId: string;
  labelId: string;
}>) {
  const { t } = useTranslation('inbox');
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (body: object) =>
      api<ForwardState>('/mock/forward/scenario', { method: 'PUT', body }),
    onSuccess: (data) => qc.setQueryData(forwardKey, data),
  });
  const buttons: [
    'normal' | 'offline' | 'safety' | 'slow_upload' | 'upload_fails' | 'size120',
    boolean,
    object,
  ][] = [
    [
      'normal',
      scenario === 'normal' && !locked,
      { scenario: 'normal', safetyLock: { messageId, locked: false } },
    ],
    ['offline', scenario === 'offline', { scenario: 'offline' }],
    ['safety', locked, { safetyLock: { messageId, locked: !locked } }],
    ['slow_upload', scenario === 'slow_upload', { scenario: 'slow_upload' }],
    ['upload_fails', scenario === 'upload_fails', { scenario: 'upload_fails' }],
  ];
  if (isVideo) buttons.push(['size120', big, { size: { messageId, mb: big ? 70 : 120 } }]);
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3"
      data-testid="forward-mock-controls"
    >
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {t('mockForward.mock.title')}
      </span>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelId}>
        {buttons.map(([key, on, body]) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={on ? 'default' : 'outline'}
            aria-pressed={on}
            className="pointer-coarse:min-h-11"
            onClick={() => set.mutate(body)}
          >
            {t(`mockForward.mock.${key}`)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('mockForward.mock.hint')}</p>
    </div>
  );
}

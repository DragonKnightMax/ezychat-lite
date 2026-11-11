// Forward one message to up to 5 existing chats or groups the user may open, as WhatsApp's
// "Forwarded" (docs/features/forward-message/design.md). Never a new number (that is New chat). Each
// copy goes through the normal send queue as the signed-in user, from the WhatsApp number of the
// chat it goes to; the server checks every chat again before anything is sent.
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { FORWARD_MAX_CHATS, type Chat, type Inbox, type Message } from '@ezychat/shared';
import { Banner, EmptyState, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/file-transfer';
import { randomUuid } from '@/lib/random-id';
import { ApiError } from '../api/client';
import { useForwardMessage } from '../api/forward';
import { PRIMARY_INBOX_ID, useChats, useInboxes, useWaStatus } from '../api/queries';
import { encodeJid } from '../lib/jid';
import { ChatAvatar } from './ChatAvatar';
import { InboxChip } from './InboxChip';
import { chatTitle } from './chat-title';
import { LARGE_FILE_BYTES, quotedPreview } from './MessageBubble';
import { forwardLocked } from './message-changes';
import { inboxCapabilities, replyWindowLeft, useNow } from './reply-window';

/** Server refusals shown as a banner. */
export type ForwardProblem =
  | 'wa_disconnected'
  | 'window_closed'
  | 'safety_locked'
  | 'rate_limited'
  | 'media_unavailable'
  | 'message_deleted'
  | 'message_not_sent'
  | 'inbox_removed'
  | 'forward_many_times'
  | 'too_large_as_video'
  | 'too_large_for_whatsapp'
  | 'other';

const KNOWN: ReadonlySet<string> = new Set<ForwardProblem>([
  'wa_disconnected',
  'window_closed',
  'safety_locked',
  'rate_limited',
  'media_unavailable',
  'message_deleted',
  'message_not_sent',
  'inbox_removed',
  'forward_many_times',
  'too_large_as_video',
  'too_large_for_whatsapp',
]);

/** The banner for a refused forward: the server's code, or `other`. */
export function forwardProblemOf(err: unknown): ForwardProblem {
  const code = err instanceof ApiError ? err.code : '';
  if (code === 'inbox_not_connected') return 'wa_disconnected';
  return KNOWN.has(code) ? (code as ForwardProblem) : 'other';
}

/** Rows shown at most (search finds the rest). */
const LIST_MAX = 50;

function TypeIcon({ message: m }: Readonly<{ message: Message }>) {
  const Icon =
    m.type === 'image' || m.type === 'sticker'
      ? ImageIcon
      : m.type === 'video'
        ? Video
        : m.type === 'audio'
          ? Mic
          : m.type === 'document'
            ? FileText
            : null;
  return Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null;
}

export function ForwardDialog({
  message,
  sourceInboxId,
  onClose,
}: Readonly<{
  message: Message;
  /** The inbox of the chat the message is in (for the "own number" note). */
  sourceInboxId: number;
  onClose(): void;
}>) {
  const { t } = useTranslation('inbox');
  const ids = { search: useId(), sendAs: useId() };
  const navigate = useNavigate();
  const now = useNow();
  const send = useForwardMessage();
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query);
  const [picked, setPicked] = useState<Chat[]>([]);
  const [problem, setProblem] = useState<ForwardProblem | null>(null);
  // One per dialog opening: a retry after a lost answer sends nothing twice.
  const [requestId] = useState(randomUuid);
  const [sendAs, setSendAs] = useState<'original' | 'file'>('original');

  const { data: inboxData } = useInboxes();
  const allInboxes = inboxData?.inboxes;
  const wa = useWaStatus();
  const inboxes = useMemo(() => new Map((allInboxes ?? []).map((i) => [i.id, i])), [allInboxes]);
  const visible = useMemo(() => (allInboxes ?? []).filter((i) => !i.removed), [allInboxes]);
  const multiInbox = visible.length > 1;
  /** Not connected to WhatsApp now (unknown counts as connected: the server answers then). */
  const offline = (inboxId: number) => {
    const state =
      (inboxId === PRIMARY_INBOX_ID ? wa.data?.state : undefined) ??
      inboxes.get(inboxId)?.status.state;
    return state !== undefined && state !== 'open';
  };
  const limitsOf = (inboxId: number) => {
    const inbox = inboxes.get(inboxId);
    return inbox ? inboxCapabilities(inbox).mediaLimits : undefined;
  };

  const q = useChats({ assigned: 'any', q: search });
  const chats = useMemo(() => {
    const seen = new Set<string>();
    const out: Chat[] = [];
    for (const p of q.data?.pages ?? [])
      for (const c of p.chats) {
        if (seen.has(c.jid)) continue;
        seen.add(c.jid);
        // A removed inbox's chats are read only: nothing can be sent into them.
        if (inboxes.get(c.inboxId)?.removed) continue;
        out.push(c);
      }
    return out.slice(0, LIST_MAX);
  }, [q.data, inboxes]);

  // WhatsApp's own rule: a message forwarded many times goes to one chat at a time.
  const many = !!message.forwarded?.manyTimes;
  const max = many ? 1 : FORWARD_MAX_CHATS;
  const full = picked.length >= max;
  const size = message.mediaSize ?? 0;
  const isVideo = message.type === 'video';

  const windowClosed = (c: Chat) => {
    const hours = inboxes.get(c.inboxId)?.capabilities?.replyWindowHours;
    return replyWindowLeft(c.lastInboundAt, hours, now) === 0;
  };
  const documentMax = (c: Chat) => limitsOf(c.inboxId)?.document;
  const tooBig = (c: Chat) => {
    const limit = documentMax(c);
    return !!limit && size > limit;
  };
  const isPicked = (jid: string) => picked.some((c) => c.jid === jid);
  const toggle = (c: Chat) => {
    setProblem(null);
    if (isPicked(c.jid)) setPicked((p) => p.filter((x) => x.jid !== c.jid));
    else if (!full && !windowClosed(c) && !tooBig(c)) setPicked((p) => [...p, c]);
  };

  // Large videos: one choice for the whole forward; Video is off when a chosen chat cannot take it.
  const videoLimits = picked.map((c) => limitsOf(c.inboxId)?.video).filter((v): v is number => !!v);
  const videoMax = videoLimits.length ? Math.min(...videoLimits) : Infinity;
  const videoBlocked = isVideo && size > 0 && size > videoMax;
  const effectiveSendAs = videoBlocked ? 'file' : sendAs;
  const otherInbox = picked.some((c) => c.inboxId !== sourceInboxId);

  // Offline: nothing can go while no number the user sees is connected; else the chosen chats'.
  const allOffline = visible.length > 0 && visible.every((i) => offline(i.id));
  const offlinePick = picked.find((c) => offline(c.inboxId));
  const offlineInbox: Inbox | undefined = offlinePick
    ? inboxes.get(offlinePick.inboxId)
    : allOffline
      ? (inboxes.get(sourceInboxId) ?? visible[0])
      : undefined;
  const locked = forwardLocked(message);
  const blocked: ForwardProblem | null = locked
    ? 'safety_locked'
    : allOffline
      ? 'wa_disconnected'
      : null;
  const shown = blocked ?? (offlinePick ? 'wa_disconnected' : problem);
  const inboxName =
    offlineInbox?.name ?? inboxes.get(sourceInboxId)?.name ?? t('forward.thisNumber');

  const submit = () => {
    const one = picked.length === 1 ? picked[0]! : null;
    send.mutate(
      {
        id: message.id,
        body: {
          to: picked.map((c) => c.jid),
          clientRequestId: requestId,
          sendAs: effectiveSendAs,
        },
      },
      {
        onSuccess: (res) => {
          toast.success(
            one
              ? t('forward.sentOne', { name: chatTitle(one, t) })
              : t('forward.sentMany', { count: res.messages.length }),
            one
              ? {
                  action: {
                    label: t('forward.openChat'),
                    onClick: () =>
                      navigate(`/chats/${encodeJid(one.jid)}`, { state: { fromList: true } }),
                  },
                }
              : undefined,
          );
          onClose();
        },
        onError: (err) => setProblem(forwardProblemOf(err)),
      },
    );
  };

  const banner = shown && (
    <Banner
      tone={
        shown === 'window_closed' || shown === 'rate_limited' || shown === 'forward_many_times'
          ? 'warning'
          : 'danger'
      }
      title={t(`forward.problems.${shown}.title`)}
    >
      {t(`forward.problems.${shown}.body`, { inbox: inboxName })}
    </Banner>
  );

  const footer = (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 sm:min-h-9"
        onClick={onClose}
        disabled={send.isPending}
      >
        {t('forward.cancel')}
      </Button>
      <Button
        type="button"
        className="min-h-11 sm:min-h-9"
        disabled={!picked.length || !!blocked || !!offlinePick || send.isPending}
        onClick={submit}
        data-testid="forward-send"
      >
        {send.isPending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <Forward aria-hidden />
        )}
        {send.isPending
          ? t('forward.sending')
          : picked.length
            ? t('forward.sendCount', { count: picked.length })
            : t('forward.send')}
      </Button>
    </>
  );

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => !next && !send.isPending && onClose()}
      title={t('forward.title')}
      description={t('forward.description', { max: FORWARD_MAX_CHATS })}
      footer={footer}
    >
      <div className="flex min-w-0 flex-col gap-3 pb-1" data-testid="forward-dialog">
        {/* What is being forwarded */}
        <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <TypeIcon message={message} />
          <p className="min-w-0 flex-1 truncate text-sm" data-testid="forward-preview">
            {quotedPreview(message, t)}
          </p>
          {size > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground" data-testid="forward-size">
              {formatBytes(size)}
            </span>
          )}
        </div>
        {size >= LARGE_FILE_BYTES && !blocked && (
          <p className="text-sm text-muted-foreground" data-testid="forward-large">
            {t('forward.largeNote', { size: formatBytes(size) })}
          </p>
        )}
        {isVideo && !blocked && (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="forward-send-as">
            <span className="text-sm font-medium" id={ids.sendAs}>
              {t('forward.sendAs')}
            </span>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={ids.sendAs}>
              <Button
                type="button"
                size="sm"
                variant={effectiveSendAs === 'original' ? 'default' : 'outline'}
                aria-pressed={effectiveSendAs === 'original'}
                disabled={videoBlocked}
                className="pointer-coarse:min-h-11"
                onClick={() => setSendAs('original')}
              >
                {t('forward.asVideo')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={effectiveSendAs === 'file' ? 'default' : 'outline'}
                aria-pressed={effectiveSendAs === 'file'}
                className="pointer-coarse:min-h-11"
                onClick={() => setSendAs('file')}
              >
                {t('forward.asFile')}
              </Button>
            </div>
            <p
              className={cn('text-sm', videoBlocked ? 'text-warning' : 'text-muted-foreground')}
              data-testid="forward-send-as-note"
            >
              {videoBlocked
                ? t('forward.videoTooBig', { size: formatBytes(size), max: formatBytes(videoMax) })
                : t('forward.sendAsHint')}
            </p>
          </div>
        )}
        {many && !blocked && (
          <p className="text-sm text-muted-foreground" data-testid="forward-many-note">
            {t('forward.manyTimesNote')}
          </p>
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
                {t('forward.count', { count: picked.length, max })}
              </span>
              {picked.map((c) => (
                <span
                  key={c.jid}
                  className="inline-flex max-w-[12rem] items-center gap-1 rounded-full border bg-background py-0.5 pr-0.5 pl-2 text-xs"
                  data-testid="forward-chip"
                >
                  <span className="truncate">{chatTitle(c, t)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 rounded-full pointer-coarse:size-8"
                    aria-label={t('forward.remove', { name: chatTitle(c, t) })}
                    onClick={() => toggle(c)}
                  >
                    <X aria-hidden />
                  </Button>
                </span>
              ))}
            </div>
            {full && max > 1 && (
              <p className="text-sm text-warning" role="status" data-testid="forward-full">
                {t('forward.full', { max })}
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
                aria-label={t('forward.search')}
                placeholder={t('forward.search')}
                className="h-11 pl-9 text-base md:h-9 md:text-sm"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="forward-search"
              />
            </div>

            <ul
              className="-mx-1 max-h-[45dvh] min-h-0 overflow-y-auto sm:max-h-80"
              aria-label={t('forward.listLabel')}
              data-testid="forward-list"
            >
              {q.isPending ? (
                <li className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t('forward.loading')}
                </li>
              ) : q.isError ? (
                <li>
                  <Banner tone="danger" title={t('forward.loadFailed')} />
                </li>
              ) : chats.length === 0 ? (
                <li>
                  <EmptyState
                    title={t('forward.emptyTitle')}
                    description={search ? t('forward.emptyQuery') : t('forward.emptyNone')}
                  />
                </li>
              ) : (
                chats.map((c) => (
                  <ForwardRow
                    key={c.jid}
                    chat={c}
                    on={isPicked(c.jid)}
                    full={full}
                    windowShut={windowClosed(c)}
                    tooBigMax={tooBig(c) ? documentMax(c)! : null}
                    inbox={multiInbox ? inboxes.get(c.inboxId) : undefined}
                    onToggle={() => toggle(c)}
                  />
                ))
              )}
            </ul>
            {multiInbox && otherInbox && (
              <p className="text-xs text-muted-foreground" data-testid="forward-other-inbox">
                {t('forward.otherInbox')}
              </p>
            )}
          </>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function ForwardRow({
  chat: c,
  on,
  full,
  windowShut,
  tooBigMax,
  inbox,
  onToggle,
}: Readonly<{
  chat: Chat;
  on: boolean;
  full: boolean;
  windowShut: boolean;
  /** The number's file limit when the file is above it, else null. */
  tooBigMax: number | null;
  /** The chat's inbox, shown while the user sees two or more. */
  inbox?: Inbox;
  onToggle(): void;
}>) {
  const { t } = useTranslation('inbox');
  const rowId = useId();
  const disabled = !on && (windowShut || tooBigMax !== null || full);
  const name = chatTitle(c, t);
  const why =
    tooBigMax !== null
      ? t('forward.tooBigRow', { max: formatBytes(tooBigMax) })
      : windowShut
        ? t('forward.windowClosedRow')
        : null;
  return (
    <li>
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
          onCheckedChange={onToggle}
          aria-describedby={why ? `${rowId}-why` : undefined}
        />
        <ChatAvatar name={name} src={c.avatarUrl} seed={c.jid} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{name}</span>
            {c.type === 'group' && (
              <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </span>
          {why ? (
            <span id={`${rowId}-why`} className="text-xs text-warning">
              {why}
            </span>
          ) : (
            c.type === 'group' && (
              <span className="text-xs text-muted-foreground">{t('chatListItem.group')}</span>
            )
          )}
        </span>
        {inbox && <InboxChip inbox={inbox} className="shrink-0" />}
      </label>
    </li>
  );
}

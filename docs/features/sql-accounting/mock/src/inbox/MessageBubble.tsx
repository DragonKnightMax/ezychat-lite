import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Mic,
  Reply,
  RotateCw,
} from 'lucide-react';
import type { Message } from '@ezychat/shared';
import { useCustomerProfile, useWaStatus } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { useSendReaction, useTeamReactions } from '../mock/useSendReaction';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatDateTime, formatTime, truncate } from '../lib/format';
import { formatJid } from '../lib/jid';
import { CustomerDetails } from './CustomerPanel';
import { MediaView } from './MediaView';
import { ReactionBadges } from './ReactionBadges';
import { ReactionPicker } from './ReactionPicker';
import { waQueuesMessages, waSendingBlocked } from './WaBanner';
import { useGuardedLinkClick } from './navigation-guard';
import type { Directory } from './useDirectory';
import { SWIPE_TRIGGER_PX, useSwipeReply } from './useSwipeReply';

export interface MessageBubbleProps {
  message: Message;
  /** Show the sender name above inbound bubbles (group chats). */
  showSender: boolean;
  /** Outbound label: agent display name, or "via phone" when sent from the phone. */
  outboundLabel: string | null;
  quoted: Message | null;
  onRetry?(m: Message): void;
  retrying?: boolean;
  /** Start a reply that quotes this message (hover button, swipe right or long-press on touch). */
  onReply?(m: Message): void;
  onMediaLoad?(): void;
  /** Team directory, for "Updated by" in a group sender's profile popover. */
  directory?: Directory;
  /** Direct chats: the customer's name as the header shows it (used in quotes). */
  contactName?: string;
}

/** Read-only profile of a group sender, from their direct chat, with a link to that chat. */
function SenderProfileCard({ chatJid, directory }: { chatJid: string; directory?: Directory }) {
  const { t } = useTranslation('inbox');
  const query = useCustomerProfile(chatJid);
  const to = `/chats/${encodeURIComponent(chatJid)}?customer=1`;
  const onClick = useGuardedLinkClick(to);
  return (
    <div className="space-y-3">
      {query.data ? (
        <CustomerDetails
          profile={query.data.profile}
          whatsappName={query.data.whatsappName}
          directory={directory}
        />
      ) : query.isPending ? (
        <div className="space-y-2" role="status" aria-label={t('customer.title')}>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-44 max-w-full" />
        </div>
      ) : null}
      <Button asChild variant="outline" size="sm" className="w-full">
        <Link to={to} onClick={onClick}>
          {t('customer.open')}
        </Link>
      </Button>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

/** Split text into plain strings and safe <a> elements. */
function linkify(text: string): React.ReactNode[] {
  const parts = text.split(URL_RE);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={p}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="break-all text-primary underline underline-offset-2"
      >
        {p}
      </a>
    ) : (
      p
    ),
  );
}

/**
 * Who wrote a quoted message. In a direct chat the customer is named like the chat header
 * (`contactName`), not by their WhatsApp profile name; groups name each sender.
 */
export function quotedAuthor(q: Message, t: TFunction<'inbox'>, contactName?: string): string {
  if (q.fromMe) return t('message.you');
  return contactName || q.senderName || t('message.contact');
}

export function quotedPreview(q: Message, t: TFunction<'inbox'>): string {
  if (q.body) return truncate(q.body, 140);
  switch (q.type) {
    case 'image':
      return t('message.quote.image');
    case 'video':
      return t('message.quote.video');
    case 'audio':
      return t('message.quote.audio');
    case 'sticker':
      return t('message.quote.sticker');
    case 'document':
      return t('message.quote.document', { name: q.mediaName ?? '' }).trim();
    default:
      return t('message.quote.message');
  }
}

export function StatusTicks({ status }: { status: Message['status'] }) {
  const { t } = useTranslation('inbox');
  const cls = 'inline-block size-3.5 shrink-0';
  const label = t(`message.status.${status}`);
  switch (status) {
    case 'pending':
      return <Clock className={cls} role="img" aria-label={label} />;
    case 'sent':
      return <Check className={cls} role="img" aria-label={label} />;
    case 'delivered':
      return <CheckCheck className={cls} role="img" aria-label={label} />;
    case 'read':
      return <CheckCheck className={cn(cls, 'text-primary')} role="img" aria-label={label} />;
    case 'failed':
      return <AlertCircle className={cn(cls, 'text-danger')} role="img" aria-label={label} />;
  }
}

/** A voice note's transcript (customer words, shown as text) or why there is none. */
function VoiceTranscript({ message: m }: { message: Message }) {
  const { t } = useTranslation('inbox');
  if (m.transcriptStatus === 'ok' && m.transcript)
    return (
      <p
        className="mb-1 whitespace-pre-wrap break-words text-xs italic text-muted-foreground [overflow-wrap:anywhere]"
        data-testid="voice-transcript"
      >
        <span className="sr-only">{t('message.transcript.label')} </span>
        {m.transcript}
      </p>
    );
  const note =
    m.transcriptStatus === 'pending'
      ? t('message.transcript.pending')
      : m.transcriptStatus === 'failed' ||
          m.transcriptStatus === 'too_long' ||
          m.transcriptStatus === 'unsupported'
        ? t(`message.transcript.${m.transcriptStatus}`)
        : null;
  return note ? <p className="mb-1 text-xs italic text-muted-foreground">{note}</p> : null;
}

export function MessageBubble({
  message: m,
  showSender,
  outboundLabel,
  quoted,
  onRetry,
  retrying,
  onMediaLoad,
  directory,
  onReply,
  contactName,
}: MessageBubbleProps) {
  const { t } = useTranslation(['inbox', 'common']);
  // Pending and failed messages still have a local id that WhatsApp could not match.
  const canReply = !!onReply && m.type !== 'system' && !m.id.startsWith('local-');
  // Proposed (send-reactions): whoever may reply may react, with the linked number's one reaction.
  const canReact = canReply;
  const [pickerOpen, setPickerOpen] = useState(false);
  const swipe = useSwipeReply(
    canReply ? () => onReply!(m) : undefined,
    canReact ? () => setPickerOpen(true) : undefined,
  );
  const { user: me } = useAuth();
  const waState = useWaStatus().data?.state;
  const team = useTeamReactions().data?.[m.id] ?? null;
  const sendReaction = useSendReaction();
  if (m.type === 'system') {
    return (
      <div className="flex justify-center px-3 py-1">
        <span className="max-w-[85%] rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
          {m.body}
        </span>
      </div>
    );
  }

  const out = m.fromMe;
  const hasMedia = m.type !== 'text';
  // Proposed (emoji-reactions): reactions as the server presents them (none on older caches).
  const reactions = m.reactions ?? [];
  // A WhatsApp ID (LID) sender formats to '' (never its digits): fall back to a placeholder.
  const senderName =
    m.senderName ??
    (m.senderJid ? formatJid(m.senderJid) || t('chatListItem.unknownContact') : null);
  // Group messages: the sender's own customer profile (from their direct chat), when set.
  const profile = !out ? (m.senderProfile ?? null) : null;

  // Touch screens reply by swipe or long-press, so the button is visually hidden there but stays a
  // real control for screen readers, switch access and keyboards (it shows when focused).
  const replyButton = canReply && (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={t('message.reply')}
      title={t('message.reply')}
      onClick={() => onReply!(m)}
      className="size-8 shrink-0 rounded-full text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:not-focus-visible:sr-only"
    >
      <Reply aria-hidden="true" />
    </Button>
  );

  // Proposed (send-reactions): the linked number's reaction and who in the team sent it (the
  // stored name applies only while the reaction is the one that teammate sent).
  const mine = reactions.find((r) => r.fromMe) ?? null;
  const sentBy = mine && team && team.at === mine.at ? team : null;
  const reactDisabled =
    waSendingBlocked(waState) || waQueuesMessages(waState)
      ? t('message.reactions.notConnected')
      : null;
  const reactButton = canReact && (
    <ReactionPicker
      out={out}
      current={mine?.emoji ?? ''}
      currentBy={sentBy && sentBy.userId !== me?.id ? sentBy.name : null}
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      onReact={(emoji) => sendReaction.mutate({ messageId: m.id, emoji })}
      disabledReason={reactDisabled}
      onReply={canReply ? () => onReply!(m) : undefined}
    />
  );

  return (
    <div
      className={cn(
        'group relative flex items-center gap-1.5 px-2 py-0.5 sm:px-4',
        out ? 'justify-end' : 'justify-start',
        // Proposed (emoji-reactions): room for the badge that hangs under the bubble
        reactions.length > 0 && 'mb-4',
      )}
    >
      {swipe.offset > 0 && (
        <span
          aria-hidden="true"
          className="absolute left-3 grid size-8 place-items-center rounded-full bg-accent text-accent-foreground"
          style={{ opacity: Math.min(1, swipe.offset / SWIPE_TRIGGER_PX) }}
        >
          <Reply className="size-4" />
        </span>
      )}
      {out && replyButton}
      {out && reactButton}
      <div
        {...swipe.handlers}
        style={swipe.offset ? { transform: `translateX(${swipe.offset}px)` } : undefined}
        className={cn(
          'relative min-w-0 max-w-[85%] touch-pan-y rounded-2xl px-3 py-1.5 text-foreground shadow-sm sm:max-w-[70%]',
          out
            ? 'rounded-br-md border border-primary/15 bg-outbound text-outbound-foreground'
            : 'rounded-bl-md border bg-surface',
          m.status === 'failed' && 'border-danger/50',
        )}
        data-message-id={m.id}
      >
        {!out && showSender && profile ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="link"
                title={senderName ?? undefined}
                className="mb-0.5 block h-auto max-w-full truncate p-0 text-left text-xs font-semibold text-primary"
              >
                {profile.name}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
              <SenderProfileCard chatJid={profile.chatJid} directory={directory} />
            </PopoverContent>
          </Popover>
        ) : (
          !out &&
          showSender &&
          senderName && (
            <p className="mb-0.5 truncate text-xs font-semibold text-primary">{senderName}</p>
          )
        )}
        {out && outboundLabel && (
          <p className="mb-0.5 truncate text-[11px] font-medium text-muted-foreground">
            {outboundLabel}
          </p>
        )}
        {m.quotedId && (
          <div className="mb-1 rounded-md border-l-4 border-primary bg-muted/70 px-2 py-1 text-xs">
            {quoted ? (
              <>
                <p className="font-semibold text-primary">{quotedAuthor(quoted, t, contactName)}</p>
                <p className="line-clamp-2 break-words text-muted-foreground">
                  {quotedPreview(quoted, t)}
                </p>
              </>
            ) : (
              <p className="italic text-muted-foreground">{t('message.quotedMessage')}</p>
            )}
          </div>
        )}
        {hasMedia && (
          <div className="mb-1">
            <MediaView message={m} onLoad={onMediaLoad} />
          </div>
        )}
        {m.type === 'audio' && <VoiceTranscript message={m} />}
        {m.body && (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-snug [overflow-wrap:anywhere]">
            {linkify(m.body)}
          </p>
        )}
        <div
          className={cn(
            'mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground',
            // Screen review: room for the reaction badge, so it never covers the time or the ticks.
            reactions.length > 0 && 'pb-3',
          )}
        >
          {/* Proposed (MCP send): replies the admin's AI assistant sent carry this line. The mock
              recognises them by the send tool's clientId; the app will use a stored marker. */}
          {out && m.clientId?.startsWith('mcp-') && (
            <span className="flex items-center gap-0.5" data-testid="via-assistant">
              <Bot className="size-3" aria-hidden="true" />
              {t('mockSend.viaAssistant')} ·
            </span>
          )}
          {/* Proposed (business-api): a template sent after the 24-hour window closed. The mock
              recognises it by its clientId; the app stores the template name on the message. */}
          {out && m.clientId?.startsWith('tpl.') && (
            <span className="flex items-center gap-0.5" data-testid="via-template">
              <FileText className="size-3" aria-hidden="true" />
              {t('mockWindow.templateLabel', {
                name: m.clientId.split('.')[1],
              })}{' '}
              ·
            </span>
          )}
          {m.voiceNote && (
            <span className="flex items-center gap-0.5">
              <Mic className="size-3" aria-hidden="true" />
              {t('message.voiceNote')} ·
            </span>
          )}
          <time dateTime={new Date(m.timestamp).toISOString()} title={formatDateTime(m.timestamp)}>
            {formatTime(m.timestamp)}
          </time>
          {out && <StatusTicks status={m.status} />}
        </div>
        {out && m.status === 'failed' && (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs text-danger">
            <span className="min-w-0 truncate">{m.error ?? t('message.notSent')}</span>
            {onRetry && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRetry(m)}
                disabled={retrying}
                className="min-h-11 border-danger/40 text-danger hover:bg-danger/10 hover:text-danger sm:min-h-8"
              >
                <RotateCw className={cn(retrying && 'animate-spin')} aria-hidden="true" />
                {retrying ? t('retrying') : t('common:actions.retry')}
              </Button>
            )}
          </div>
        )}
        {/* Proposed (emoji-reactions): reaction badges under the bubble's corner. */}
        <ReactionBadges
          reactions={reactions}
          out={out}
          contactName={contactName}
          teamName={sentBy ? (sentBy.userId === me?.id ? '' : sentBy.name) : null}
          onRemoveMine={
            canReact && mine && !reactDisabled
              ? () => sendReaction.mutate({ messageId: m.id, emoji: '' })
              : undefined
          }
        />
      </div>
      {!out && reactButton}
      {!out && replyButton}
    </div>
  );
}

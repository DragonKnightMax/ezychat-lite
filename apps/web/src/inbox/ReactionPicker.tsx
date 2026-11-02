import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Copy, Pencil, Plus, Reply, SmilePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** The bar's emojis, as on WhatsApp. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** "+" opens these: common reactions in a business chat, no emoji library. */
// prettier-ignore
export const MORE_REACTIONS = [
  '👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🙌',
  '🔥', '🎉', '💯', '✅', '👌', '🤝', '💪', '😊',
  '😍', '🥰', '😁', '🤣', '😅', '😉', '🤔', '😎',
  '😴', '😭', '😡', '😱', '🥲', '🙈', '👀', '💐',
  '🎂', '☕', '🍜', '🚚', '📦', '💰', '⭐', '❌',
] as const;

export interface ReactionPickerProps {
  /** Outbound bubble: the bar opens towards the left. */
  out: boolean;
  /** The linked number's current reaction to this message, '' when there is none. */
  current: string;
  /** The teammate who sent that reaction, when it was not the signed-in user or the phone. */
  currentBy?: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** '' removes the linked number's reaction. */
  onReact(emoji: string): void;
  /** Why the team cannot react now (WhatsApp is not connected), else null. */
  disabledReason: string | null;
  /** Touch screens open the bar by press-and-hold, so it offers Reply as well. */
  onReply?(): void;
  /** …and Copy text, for a message with text. */
  onCopy?(): void;
  /** …and Edit / Delete, when the signed-in user may change the message now. */
  onEdit?(): void;
  onDelete?(): void;
}

/**
 * The 🙂 button next to a message and its emoji bar. WhatsApp keeps one
 * reaction per number, so the whole team shares the linked number's reaction: a new emoji replaces
 * it, the same emoji again removes it.
 */
export function ReactionPicker({
  out,
  current,
  currentBy,
  open,
  onOpenChange,
  onReact,
  disabledReason,
  onReply,
  onCopy,
  onEdit,
  onDelete,
}: ReactionPickerProps) {
  const { t } = useTranslation('inbox');
  const [more, setMore] = useState(false);
  const quick: readonly string[] =
    current && !(QUICK_REACTIONS as readonly string[]).includes(current)
      ? [current, ...QUICK_REACTIONS.slice(0, 5)]
      : QUICK_REACTIONS;
  const choose = (emoji: string) => {
    onReact(emoji === current ? '' : emoji);
    onOpenChange(false);
  };
  // `inBar`: the larger buttons of the quick bar (the grid is denser).
  const emojiButton = (emoji: string, inBar: boolean) => (
    <Button
      key={emoji}
      type="button"
      variant="ghost"
      size="icon"
      disabled={!!disabledReason}
      aria-pressed={emoji === current}
      aria-label={t('message.reactions.reactWith', { emoji })}
      title={emoji === current ? t('message.reactions.removeYours') : undefined}
      onClick={() => choose(emoji)}
      className={cn(
        'rounded-full leading-none',
        inBar ? 'size-10 text-2xl' : 'size-9 text-xl',
        emoji === current && 'bg-accent ring-2 ring-primary/40',
      )}
    >
      {emoji}
    </Button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setMore(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('message.reactions.add')}
          title={t('message.reactions.add')}
          data-testid="reaction-picker-button"
          // Touch screens open the bar by press-and-hold: the button is visually hidden there but
          // stays a real control for screen readers, switch access and keyboards.
          className={cn(
            'size-8 shrink-0 rounded-full text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:not-focus-visible:sr-only',
            open && 'opacity-100',
          )}
        >
          <SmilePlus aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={out ? 'end' : 'start'}
        className="w-auto max-w-[calc(100vw-2rem)] rounded-2xl p-1.5"
        data-testid="reaction-picker"
      >
        {more ? (
          <div>
            <div className="flex items-center gap-1 pb-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('message.reactions.back')}
                onClick={() => setMore(false)}
                className="size-8 rounded-full"
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <p className="text-xs font-medium text-muted-foreground">
                {t('message.reactions.more')}
              </p>
            </div>
            <div
              className="grid max-h-56 grid-cols-6 gap-0.5 overflow-y-auto sm:grid-cols-8"
              role="group"
              aria-label={t('message.reactions.more')}
            >
              {MORE_REACTIONS.map((e) => emojiButton(e, false))}
            </div>
          </div>
        ) : (
          <div
            className="flex items-center gap-0.5"
            role="group"
            aria-label={t('message.reactions.add')}
          >
            {quick.map((e) => emojiButton(e, true))}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={!!disabledReason}
              aria-label={t('message.reactions.more')}
              title={t('message.reactions.more')}
              onClick={() => setMore(true)}
              className="size-10 rounded-full text-muted-foreground"
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
        )}
        {(disabledReason || current) && (
          <p
            className={cn(
              'max-w-72 px-2 pt-1.5 pb-0.5 text-xs',
              disabledReason ? 'text-warning' : 'text-muted-foreground',
            )}
            role={disabledReason ? 'status' : undefined}
          >
            {disabledReason ??
              (currentBy
                ? t('message.reactions.replacesTeammate', { name: currentBy, emoji: current })
                : t('message.reactions.removeHint'))}
          </p>
        )}
        {onReply && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              onReply();
            }}
            className="mt-1 hidden min-h-11 w-full justify-start gap-2 border-t pointer-coarse:flex"
          >
            <Reply aria-hidden="true" />
            {t('message.reply')}
          </Button>
        )}
        {onCopy && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              onCopy();
            }}
            className={cn(
              'hidden min-h-11 w-full justify-start gap-2 pointer-coarse:flex',
              !onReply && 'mt-1 border-t',
            )}
          >
            <Copy aria-hidden="true" />
            {t('message.copy.text')}
          </Button>
        )}
        {onEdit && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              onEdit();
            }}
            className="hidden min-h-11 w-full justify-start gap-2 pointer-coarse:flex"
          >
            <Pencil aria-hidden="true" />
            {t('message.change.edit')}
          </Button>
        )}
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              onDelete();
            }}
            className="hidden min-h-11 w-full justify-start gap-2 text-danger hover:text-danger pointer-coarse:flex"
          >
            <Trash2 aria-hidden="true" />
            {t('message.change.delete')}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

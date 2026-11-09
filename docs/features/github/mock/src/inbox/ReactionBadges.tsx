import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { MessageReaction } from '@ezychat/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatJid } from '../lib/jid';

/** Distinct emojis shown in the badge; the popover lists every reaction. */
export const BADGE_EMOJIS = 3;

export interface ReactionGroup {
  emoji: string;
  reactions: MessageReaction[];
}

/** One group per emoji: the most used first, then the one used first. */
export function groupReactions(reactions: MessageReaction[]): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const r of [...reactions].sort((a, b) => a.at - b.at)) {
    const group = groups.get(r.emoji) ?? { emoji: r.emoji, reactions: [] };
    group.reactions.push(r);
    groups.set(r.emoji, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.reactions.length - a.reactions.length || a.reactions[0]!.at - b.reactions[0]!.at,
  );
}

/**
 * Who reacted, named like the rest of the conversation: the server's name (customer profile,
 * contact, WhatsApp name), else the direct chat's name, else the phone number. Never inferred.
 */
export function reactorName(
  r: MessageReaction,
  t: TFunction<'inbox'>,
  contactName?: string,
  teamName?: string | null,
): string {
  // Proposed (send-reactions): the linked number's reaction names the teammate who sent it from
  // EzyChat ('' = the signed-in user); null = the phone or another linked device.
  if (r.fromMe && teamName === '') return t('message.reactions.fromYou');
  if (r.fromMe && teamName) return t('message.reactions.fromTeammate', { name: teamName });
  if (r.fromMe) return t('message.reactions.fromPhone');
  return (
    r.senderName ||
    contactName ||
    (r.senderJid ? formatJid(r.senderJid) : '') ||
    t('chatListItem.unknownContact')
  );
}

export interface ReactionBadgesProps {
  reactions: MessageReaction[];
  /** Outbound bubble: the badge sits under its right corner, else under the left one. */
  out: boolean;
  /** Direct chats: the customer's name as the header shows it. */
  contactName?: string;
  /** Proposed (send-reactions): who sent the linked number's reaction (see `reactorName`). */
  teamName?: string | null;
  /** Proposed (send-reactions): removes the linked number's reaction from the list. */
  onRemoveMine?(): void;
}

/**
 * Emoji reactions under a bubble's corner, as WhatsApp shows them: the emojis (most used first)
 * and the total when more than one person reacted. Tap or click lists who reacted with what.
 */
export function ReactionBadges({
  reactions,
  out,
  contactName,
  teamName,
  onRemoveMine,
}: ReactionBadgesProps) {
  const { t } = useTranslation('inbox');
  if (!reactions.length) return null;
  const groups = groupReactions(reactions);
  const summary = groups.map((g) => `${g.emoji} ${g.reactions.length}`).join(', ');
  const label = t('message.reactions.label', { list: summary });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={label}
          title={label}
          data-testid="reaction-badges"
          className={cn(
            'absolute -bottom-3.5 h-7 min-w-0 gap-0.5 rounded-full bg-surface px-2 py-0 text-sm leading-none font-normal shadow-sm',
            // 44 px touch target around the small pill on touch screens
            "pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']",
            out ? 'right-2' : 'left-2',
          )}
        >
          <span aria-hidden="true" className="flex items-center">
            {groups.slice(0, BADGE_EMOJIS).map((g) => (
              <span key={g.emoji}>{g.emoji}</span>
            ))}
          </span>
          {reactions.length > 1 && (
            <span aria-hidden="true" className="text-xs text-muted-foreground tabular-nums">
              {reactions.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={out ? 'end' : 'start'} className="w-64 max-w-[calc(100vw-2rem)] p-2">
        <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">
          {t('message.reactions.title')}
        </p>
        <ul className="max-h-64 space-y-0.5 overflow-y-auto" data-testid="reaction-list">
          {groups.flatMap((g) =>
            g.reactions.map((r) => (
              <li
                key={`${g.emoji}-${r.fromMe ? 'me' : r.senderJid}-${r.at}`}
                className="flex min-h-9 items-center gap-2 rounded-md px-2"
              >
                <span className="w-6 shrink-0 text-center text-lg leading-none">{r.emoji}</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {reactorName(r, t, contactName, teamName)}
                </span>
                {r.fromMe && onRemoveMine && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onRemoveMine}
                    className="h-8 shrink-0 px-2 text-xs text-muted-foreground pointer-coarse:min-h-11"
                  >
                    {t('message.reactions.remove')}
                  </Button>
                )}
              </li>
            )),
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

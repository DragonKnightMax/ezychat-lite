import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareText } from 'lucide-react';
import type { QuickReply } from '@ezychat/shared';
import { Command, CommandItem, CommandList } from '@/components/ui/command';
import { truncate } from '../lib/format';

/** Quick replies whose shortcut starts with `query` (case-insensitive), sorted by shortcut. */
export function filterQuickReplies(replies: QuickReply[], query: string): QuickReply[] {
  const q = query.trim().toLowerCase();
  return replies
    .filter((r) => r.shortcut.toLowerCase().startsWith(q))
    .sort((a, b) => a.shortcut.localeCompare(b.shortcut));
}

export interface QuickReplyPickerProps {
  replies: QuickReply[];
  /** Text typed after the leading `/`. */
  query: string;
  /** Index into the filtered list. */
  activeIndex: number;
  onPick(reply: QuickReply): void;
  onHover?(index: number): void;
}

/**
 * `/shortcut` picker built on cmdk. Filtering and keyboard handling (↑/↓/Enter/Tab/Escape) live
 * in the Composer, which keeps focus in the textarea and drives `activeIndex`; cmdk renders the
 * listbox/option semantics and the highlighted row.
 */
export function QuickReplyPicker({
  replies,
  query,
  activeIndex,
  onPick,
  onHover,
}: QuickReplyPickerProps) {
  const { t } = useTranslation('inbox');
  const matches = filterQuickReplies(replies, query);
  const listRef = useRef<HTMLDivElement>(null);
  const active = matches[Math.min(activeIndex, matches.length - 1)];

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <Command
      shouldFilter={false}
      value={active ? String(active.id) : ''}
      onValueChange={(v) => {
        const i = matches.findIndex((r) => String(r.id) === v);
        if (i >= 0) onHover?.(i);
      }}
      className="bg-popover"
    >
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <MessageSquareText className="size-3.5" aria-hidden="true" />
        {t('quickReplies.title')}
      </div>
      {matches.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">
          {t('quickReplies.noMatch', { query })}
        </p>
      ) : (
        <CommandList
          ref={listRef}
          label={t('quickReplies.title')}
          className="max-h-60 overscroll-contain p-1"
        >
          {matches.map((r, i) => (
            <CommandItem
              key={r.id}
              value={String(r.id)}
              data-index={i}
              onSelect={() => onPick(r)}
              // mousedown keeps focus in the textarea
              onMouseDown={(e) => e.preventDefault()}
              className="min-h-11 cursor-pointer flex-col items-start justify-center gap-0 px-3 py-1.5"
            >
              <span className="text-sm font-semibold text-primary">/{r.shortcut}</span>
              <span className="w-full truncate text-sm text-muted-foreground">
                {truncate(r.body.replace(/\s+/g, ' '), 120)}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      )}
    </Command>
  );
}

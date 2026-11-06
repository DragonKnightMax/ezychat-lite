import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AtSign } from 'lucide-react';
import type { GroupMember } from '@ezychat/shared';
import { Command, CommandItem, CommandList } from '@/components/ui/command';
import { formatPhone } from '@/lib/jid';
import { memberLabel } from './mentions';

export interface MentionPickerProps {
  /** Members matching the query (already filtered by the Composer), or null while loading. */
  members: GroupMember[] | null;
  error: boolean;
  /** Text typed after `@`. */
  query: string;
  activeIndex: number;
  onPick(member: GroupMember): void;
  onHover?(index: number): void;
}

/**
 * Proposed (group-mentions): the `@` member picker of a group chat. Like the quick-reply picker,
 * focus stays in the textarea and the Composer drives ↑/↓/Enter/Tab/Escape.
 */
export function MentionPicker({
  members,
  error,
  query,
  activeIndex,
  onPick,
  onHover,
}: MentionPickerProps) {
  const { t } = useTranslation('inbox');
  const listRef = useRef<HTMLDivElement>(null);
  const list = members ?? [];
  const active = list[Math.min(activeIndex, list.length - 1)];

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <Command
      shouldFilter={false}
      value={active?.jid ?? ''}
      onValueChange={(v) => {
        const i = list.findIndex((m) => m.jid === v);
        if (i >= 0) onHover?.(i);
      }}
      className="bg-popover"
      data-testid="mention-picker"
    >
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <AtSign className="size-3.5" aria-hidden="true" />
        {t('mockMention.title')}
      </div>
      {error ? (
        <p className="px-3 py-3 text-sm text-destructive">{t('mockMention.error')}</p>
      ) : members == null ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{t('mockMention.loading')}</p>
      ) : list.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">
          {t('mockMention.noMatch', { query })}
        </p>
      ) : (
        <CommandList
          ref={listRef}
          label={t('mockMention.title')}
          className="max-h-60 overscroll-contain p-1"
        >
          {list.map((m, i) => {
            const label = memberLabel(m);
            const named = !!(m.name || m.username);
            const initials = named
              ? label
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0]?.toUpperCase() ?? '')
                  .join('')
              : '@';
            return (
              <CommandItem
                key={m.jid}
                value={m.jid}
                data-index={i}
                onSelect={() => onPick(m)}
                // mousedown keeps focus in the textarea
                onMouseDown={(e) => e.preventDefault()}
                className="min-h-11 cursor-pointer gap-2.5 px-3 py-1.5"
              >
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
                >
                  {initials}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {named ? label : t('mockMention.noName')}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {(m.phone && formatPhone({ phone: m.phone })) || label}
                  </span>
                </span>
                {m.role !== 'member' && (
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {t('mockMention.admin')}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandList>
      )}
    </Command>
  );
}

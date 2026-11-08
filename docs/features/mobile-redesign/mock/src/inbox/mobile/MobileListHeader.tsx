// Proposed (mobile-redesign): the chat list's top on a phone. One 56 px bar (number switcher as the
// title, search, account) and one row of quick filter chips, instead of four stacked filter rows.
// The desktop list keeps its header and ChatFilters unchanged.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, ChevronDown, Search, Tag, X } from 'lucide-react';
import type { Chat } from '@ezychat/shared';
import { Button } from '@/components/ui/button';
import { SearchField } from '@/components/app/SearchField';
import { cn } from '@/lib/utils';
import { useChats, type ChatFilters as Filters } from '../../api/queries';
import { UserMenu } from '../../auth/UserMenu';
import { useAuth } from '../../auth/AuthProvider';
import { accessOf, canOpen, inboxOfChat, useMockInboxes } from '../../mock/inboxes';
import { useVisibleInboxes } from '../useVisibleInboxes';
import { InboxSwitcherSheet } from './InboxSwitcherSheet';
import { TagFilterSheet } from './TagSheet';
import type { QuickFilter } from './phone';

const SEARCH_DEBOUNCE_MS = 300;

/** Open chats the user may see (every inbox): the counts on the chips and in the number switcher. */
export function useOpenChatsForCounts(): Chat[] {
  const q = useChats({ assigned: 'any', status: 'open' });
  const inboxes = useMockInboxes();
  const { user } = useAuth();
  return useMemo(() => {
    const access = accessOf(inboxes, user);
    const out: Chat[] = [];
    const seen = new Set<string>();
    for (const p of q.data?.pages ?? [])
      for (const c of p.chats)
        if (!seen.has(c.jid) && canOpen(access, inboxOfChat(inboxes, c.jid)?.id)) {
          seen.add(c.jid);
          out.push(c);
        }
    return out;
  }, [q.data, inboxes, user]);
}

/** A filter chip: 36 px pill, 44 px tall hit area (the row adds the padding). */
export function FilterChip({
  selected,
  onClick,
  children,
  count,
  testId,
  label,
}: Readonly<{
  selected: boolean;
  onClick(): void;
  children: React.ReactNode;
  count?: number;
  testId?: string;
  label?: string;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      data-testid={testId}
      className={cn(
        // A real <button> styled as a chip: the shadcn Button has no pill size. Tokens only.
        'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring after:absolute after:-inset-y-1 after:inset-x-0',
        selected
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border bg-surface text-muted-foreground active:bg-muted',
      )}
    >
      {children}
      {count != null && count > 0 && (
        <span
          className={cn(
            'min-w-5 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

export function MobileListHeader({
  value,
  onChange,
  quick,
  onQuick,
}: Readonly<{
  value: Filters;
  onChange(next: Filters): void;
  quick: QuickFilter;
  onQuick(next: QuickFilter): void;
}>) {
  const { t } = useTranslation('inbox');
  const visible = useVisibleInboxes();
  const inboxes = useMockInboxes();
  const counts = useOpenChatsForCounts();
  const [searching, setSearching] = useState(Boolean(value.q));
  const [search, setSearch] = useState(value.q ?? '');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  useEffect(() => {
    const timer = setTimeout(() => {
      const { value: v, onChange: cb } = latest.current;
      const q = search.trim() || undefined;
      if (q !== (v.q || undefined)) cb({ ...v, q });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const many = visible.length > 1;
  const current = visible.find((i) => i.id === inboxes.inboxFilter);
  const scoped = counts.filter((c) => !current || inboxOfChat(inboxes, c.jid)?.id === current.id);
  // Unread messages on the numbers that are not shown now: a dot on the switcher, like account switchers.
  const elsewhere = current
    ? counts.filter((c) => inboxOfChat(inboxes, c.jid)?.id !== current.id && c.unreadCount > 0)
        .length
    : 0;
  const unread = scoped.filter((c) => c.unreadCount > 0).length;
  const resolved = value.status === 'resolved';

  const pick = (next: QuickFilter) => {
    onQuick(next);
    const assigned = next === 'mine' ? 'me' : next === 'unassigned' ? 'none' : 'any';
    onChange({ ...value, assigned });
  };

  const closeSearch = () => {
    setSearch('');
    setSearching(false);
    onChange({ ...value, q: undefined });
  };

  return (
    <div className="border-b bg-surface" data-testid="mobile-list-header">
      {searching ? (
        <div className="flex h-14 items-center gap-1 px-1.5">
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={t('mobile.closeSearch')}
            onClick={closeSearch}
            className="text-muted-foreground"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <SearchField
              value={search}
              onChange={setSearch}
              label={t('filters.searchLabel')}
              placeholder={t('filters.searchPlaceholder')}
            />
          </div>
        </div>
      ) : (
        <div className="flex h-14 items-center gap-1 pl-1.5 pr-1">
          {many ? (
            <button
              type="button"
              onClick={() => setSwitcherOpen(true)}
              data-testid="inbox-switcher"
              aria-haspopup="dialog"
              aria-label={t('mobile.switcher.open', {
                name: current?.name ?? t('mobile.switcher.allNumbers'),
              })}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-xl font-semibold tracking-tight text-foreground">
                  <span className="truncate">
                    {current?.name ?? t('mobile.switcher.allNumbers')}
                  </span>
                  <ChevronDown className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  {elsewhere > 0 && (
                    <span
                      className="size-2.5 shrink-0 rounded-full bg-unread"
                      aria-label={t('mobile.switcher.unreadElsewhere', { count: elsewhere })}
                      role="img"
                    />
                  )}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {current
                    ? current.number
                    : t('mobile.switcher.numbersCount', { count: visible.length })}
                </span>
              </span>
            </button>
          ) : (
            <h1 className="flex-1 px-2 text-xl font-semibold tracking-tight text-foreground">
              {t('page.title')}
            </h1>
          )}
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={t('filters.searchLabel')}
            onClick={() => setSearching(true)}
            data-testid="mobile-search"
            className="text-muted-foreground"
          >
            <Search className="size-5" aria-hidden />
          </Button>
          {/* Admin settings, language, theme, notifications, About (with the version) and sign out. */}
          <UserMenu />
        </div>
      )}
      <div
        className="flex gap-2 overflow-x-auto px-3 pb-2.5 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="toolbar"
        aria-label={t('mobile.chips.label')}
        data-testid="filter-chips"
      >
        <FilterChip selected={quick === 'all'} onClick={() => pick('all')}>
          {t('mobile.chips.all')}
        </FilterChip>
        <FilterChip
          selected={quick === 'unread'}
          onClick={() => pick('unread')}
          count={unread}
          testId="chip-unread"
        >
          {t('mobile.chips.unread')}
        </FilterChip>
        <FilterChip selected={quick === 'mine'} onClick={() => pick('mine')}>
          {t('filters.mine')}
        </FilterChip>
        <FilterChip selected={quick === 'unassigned'} onClick={() => pick('unassigned')}>
          {t('filters.unassigned')}
        </FilterChip>
        <FilterChip selected={quick === 'groups'} onClick={() => pick('groups')}>
          {t('mobile.chips.groups')}
        </FilterChip>
        {value.tag ? (
          <span className="inline-flex shrink-0 items-center rounded-full border border-primary/30 bg-primary/10 text-primary">
            <button
              type="button"
              onClick={() => setTagsOpen(true)}
              data-testid="chip-tag"
              className="inline-flex h-9 items-center gap-1.5 rounded-l-full pl-3.5 pr-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Tag className="size-4" aria-hidden />
              <span className="max-w-28 truncate">{value.tag}</span>
            </button>
            <button
              type="button"
              aria-label={t('filters.tagClear')}
              onClick={() => onChange({ ...value, tag: undefined })}
              className="inline-flex size-9 items-center justify-center rounded-r-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden />
            </button>
          </span>
        ) : (
          <FilterChip selected={false} onClick={() => setTagsOpen(true)} testId="chip-tag">
            <Tag className="size-4" aria-hidden />
            {t('filters.tag')}
            <ChevronDown className="size-4" aria-hidden />
          </FilterChip>
        )}
        <FilterChip
          selected={resolved}
          onClick={() => onChange({ ...value, status: resolved ? 'open' : 'resolved' })}
          testId="chip-resolved"
        >
          {resolved && <Check className="size-4" aria-hidden />}
          {t('filters.resolved')}
        </FilterChip>
      </div>
      <InboxSwitcherSheet open={switcherOpen} onOpenChange={setSwitcherOpen} chats={counts} />
      <TagFilterSheet
        open={tagsOpen}
        onOpenChange={setTagsOpen}
        value={value.tag}
        onPick={(tag) => {
          setTagsOpen(false);
          onChange({ ...value, tag });
        }}
      />
    </div>
  );
}

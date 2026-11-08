// Proposed (mobile-redesign): tags on a phone. Two bottom sheets on the existing customer-tag API:
//  - TagFilterSheet: pick one tag to filter the chat list (the list filter stays single-tag, as today);
//  - ChatTagsSheet: tick or untick a customer's tags, or create one, without opening the profile form.
// Both search as you type; a chat's sheet saves on Done through PUT /chats/:jid/profile (tags only).
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Tag } from 'lucide-react';
import { toast } from 'sonner';
import { CUSTOMER_TAG_MAX_CHARS, customerTagKey, normalizeTag } from '@ezychat/shared';
import { ResponsiveDialog } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCustomerProfile, useCustomerTags, useSaveCustomerProfile } from '../../api/queries';
import { useGroupTags, useSaveGroupTags } from '../../mock/groupTags';

/** At most 10 tags per customer (`CustomerProfileBody`). */
export const MAX_CHAT_TAGS = 10;

function TagRow({
  label,
  selected,
  onClick,
  disabled,
  icon,
}: Readonly<{
  label: React.ReactNode;
  selected: boolean;
  onClick(): void;
  disabled?: boolean;
  icon?: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        selected ? 'bg-accent text-accent-foreground' : 'active:bg-muted',
      )}
    >
      {icon ?? <Tag className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Check
        aria-hidden
        className={cn('size-5 shrink-0 text-primary', selected ? 'visible' : 'invisible')}
      />
    </button>
  );
}

export function TagFilterSheet({
  open,
  onOpenChange,
  value,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange(open: boolean): void;
  value?: string;
  onPick(tag: string | undefined): void;
}>) {
  const { t } = useTranslation('inbox');
  const [search, setSearch] = useState('');
  const tags = useCustomerTags(search.trim());
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('filters.tagLabel')}
      description={t('mobile.tags.filterHint')}
    >
      <div className="space-y-2 pb-3" data-testid="tag-filter-sheet">
        <SearchField
          value={search}
          onChange={setSearch}
          label={t('filters.tagSearch')}
          placeholder={t('filters.tagSearch')}
        />
        <div className="space-y-0.5">
          {value && (
            <TagRow
              label={t('mobile.tags.anyTag')}
              selected={false}
              onClick={() => onPick(undefined)}
            />
          )}
          {tags.data?.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t('filters.tagEmpty')}</p>
          )}
          {tags.data?.map((tag) => (
            <TagRow
              key={tag}
              label={tag}
              selected={value != null && customerTagKey(value) === customerTagKey(tag)}
              onClick={() => onPick(tag)}
            />
          ))}
        </div>
      </div>
    </ResponsiveDialog>
  );
}

/**
 * The one tag editor for a chat, direct or group (owner 2026-11-07: any teammate who can open the chat
 * may add, remove and create tags, on direct chats and groups alike). Opened from the chat header's
 * + Tag chip, a list row's press-and-hold sheet, Customer details and Group info.
 */
export function ChatTagsSheet({
  jid,
  group = false,
  open,
  onOpenChange,
}: Readonly<{ jid: string; group?: boolean; open: boolean; onOpenChange(open: boolean): void }>) {
  const { t } = useTranslation(['inbox', 'common']);
  const profile = useCustomerProfile(open && !group ? jid : null);
  const save = useSaveCustomerProfile(jid);
  const groupTags = useGroupTags();
  const saveGroup = useSaveGroupTags(jid);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const known = useCustomerTags(search.trim());
  const saved = group
    ? groupTags.data
      ? (groupTags.data[jid] ?? [])
      : undefined
    : profile.data?.profile.tags;
  const ready = group ? !!groupTags.data : !!profile.data;
  const pending = group ? saveGroup.isPending : save.isPending;

  useEffect(() => {
    if (open && saved) setChosen(saved);
    if (!open) setSearch('');
  }, [open, saved]);

  const typed = normalizeTag(search);
  const chosenKeys = useMemo(() => new Set(chosen.map(customerTagKey)), [chosen]);
  // Chosen tags first, then the team's other tags that match the search.
  const list = useMemo(() => {
    const out = [...chosen];
    for (const tag of known.data ?? []) if (!chosenKeys.has(customerTagKey(tag))) out.push(tag);
    return typed ? out.filter((x) => customerTagKey(x).includes(customerTagKey(typed))) : out;
  }, [chosen, chosenKeys, known.data, typed]);
  const canCreate =
    typed.length > 0 &&
    typed.length <= CUSTOMER_TAG_MAX_CHARS &&
    !list.some((x) => customerTagKey(x) === customerTagKey(typed));
  const full = chosen.length >= MAX_CHAT_TAGS;

  const toggle = (tag: string) =>
    setChosen((prev) =>
      prev.some((x) => customerTagKey(x) === customerTagKey(tag))
        ? prev.filter((x) => customerTagKey(x) !== customerTagKey(tag))
        : prev.length >= MAX_CHAT_TAGS
          ? prev
          : [...prev, tag],
    );

  const done = () => {
    const finish = {
      onSuccess: () => {
        toast.success(t('mobile.tags.saved'));
        onOpenChange(false);
      },
      onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
    };
    if (group) {
      saveGroup.mutate(chosen, finish);
      return;
    }
    const p = profile.data?.profile;
    if (!p) return;
    save.mutate(
      {
        name: p.name ?? '',
        company: p.company ?? '',
        email: p.email ?? '',
        otherPhone: p.otherPhone ?? '',
        address: p.address ?? '',
        tags: chosen,
      },
      {
        onSuccess: () => {
          toast.success(t('mobile.tags.saved'));
          onOpenChange(false);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('mobile.tags.chatTitle')}
      description={t('mobile.tags.chatHint', { count: chosen.length, max: MAX_CHAT_TAGS })}
      footer={
        <Button
          size="touch"
          onClick={done}
          disabled={!ready || pending}
          data-testid="chat-tags-done"
        >
          {t('common:actions.done')}
        </Button>
      }
    >
      <div className="space-y-2 pb-2" data-testid="chat-tags-sheet">
        <SearchField
          value={search}
          onChange={setSearch}
          label={t('mobile.tags.searchOrCreate')}
          placeholder={t('mobile.tags.searchOrCreate')}
        />
        <div className="space-y-0.5">
          {canCreate && (
            <TagRow
              label={t('mobile.tags.create', { tag: typed })}
              selected={false}
              disabled={full}
              icon={<Plus className="size-4 shrink-0 text-primary" aria-hidden />}
              onClick={() => {
                toggle(typed);
                setSearch('');
              }}
            />
          )}
          {list.map((tag) => {
            const on = chosenKeys.has(customerTagKey(tag));
            return (
              <TagRow
                key={tag}
                label={tag}
                selected={on}
                disabled={!on && full}
                onClick={() => toggle(tag)}
              />
            );
          })}
          {list.length === 0 && !canCreate && (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t('mobile.tags.none')}</p>
          )}
        </div>
        {full && <p className="px-2 text-sm text-muted-foreground">{t('mobile.tags.full')}</p>}
      </div>
    </ResponsiveDialog>
  );
}

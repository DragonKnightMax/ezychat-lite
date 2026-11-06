import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Banner } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useChats } from '../api/queries';
import { ChatAvatar } from '../inbox/ChatAvatar';
import { GroupIcon } from '../inbox/ChatListItem';
import { MemberChatScope, type MemberChat } from '@ezychat/shared';

const SUGGEST = 8;
const SCOPES = MemberChatScope.options;

/**
 * "Chats this member can see" in Edit member, for agents only (design docs/features/partner-role):
 * All chats (default, as today) or Only chosen chats, with the chosen list and a search to add more.
 * The dialog saves it with `PUT /api/users/:id/chats`.
 */
export function MemberChatsField({
  scope,
  chats,
  onChange,
}: {
  scope: 'all' | 'chosen';
  chats: MemberChat[];
  onChange(scope: 'all' | 'chosen', chats: MemberChat[]): void;
}) {
  const { t } = useTranslation('admin');
  const open = useChats({ assigned: 'any', status: 'open' });
  const done = useChats({ assigned: 'any', status: 'resolved' });
  const [query, setQuery] = useState('');
  const chosen = new Set(chats.map((c) => c.jid));
  const all = useMemo(
    () =>
      [...(open.data?.pages ?? []), ...(done.data?.pages ?? [])]
        .flatMap((p) => p.chats)
        .map((c): MemberChat => ({ jid: c.jid, name: c.name || c.jid, type: c.type })),
    [open.data, done.data],
  );
  const q = query.trim().toLocaleLowerCase();
  const suggestions = all
    .filter((c) => !chosen.has(c.jid) && (!q || c.name.toLocaleLowerCase().includes(q)))
    .slice(0, SUGGEST);

  return (
    <fieldset className="flex min-w-0 flex-col gap-3" data-testid="member-chats">
      <legend className="mb-2 text-sm font-medium">{t('limitedChats.label')}</legend>
      <RadioGroup
        value={scope}
        onValueChange={(v) => onChange(v as 'all' | 'chosen', chats)}
        className="gap-2"
      >
        {SCOPES.map((v) => (
          <Label
            key={v}
            htmlFor={`member-chats-${v}`}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem id={`member-chats-${v}`} value={v} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block font-medium">{t(`limitedChats.${v}.title`)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`limitedChats.${v}.hint`)}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>

      {scope === 'chosen' && (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {t('limitedChats.count', { count: chats.length })}
          </p>
          {chats.length === 0 ? (
            <Banner tone="warning">{t('limitedChats.none')}</Banner>
          ) : (
            <ul
              className="max-h-56 divide-y overflow-y-auto rounded-lg border"
              aria-label={t('limitedChats.chosenLabel')}
              data-testid="chosen-chats"
            >
              {chats.map((c) => (
                <li key={c.jid} className="flex items-center gap-3 py-1 pr-1 pl-3">
                  <ChatAvatar name={c.name} seed={c.jid} size="sm" />
                  <span className="flex min-w-0 flex-1 items-center gap-1 text-sm">
                    {c.type === 'group' && (
                      <GroupIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="[overflow-wrap:anywhere] md:truncate">{c.name}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t('limitedChats.remove', { name: c.name })}
                    onClick={() =>
                      onChange(
                        'chosen',
                        chats.filter((x) => x.jid !== c.jid),
                      )
                    }
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <SearchField
            value={query}
            onChange={setQuery}
            label={t('limitedChats.addLabel')}
            placeholder={t('limitedChats.addPlaceholder')}
          />
          <ul className="divide-y rounded-lg border" aria-label={t('limitedChats.addLabel')}>
            {suggestions.length === 0 && (
              <li className="px-3 py-3 text-sm text-muted-foreground">
                {t('limitedChats.noMatch')}
              </li>
            )}
            {suggestions.map((c) => (
              <li key={c.jid}>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onChange('chosen', [...chats, c])}
                  aria-label={t('limitedChats.add', { name: c.name })}
                  className="h-auto min-h-11 w-full justify-start gap-3 rounded-none px-3 py-1.5 text-left font-normal"
                >
                  <ChatAvatar name={c.name} seed={c.jid} size="sm" />
                  <span className="flex min-w-0 flex-1 items-center gap-1">
                    {c.type === 'group' && (
                      <GroupIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{c.name}</span>
                  </span>
                  <Plus aria-hidden className="text-primary" />
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </fieldset>
  );
}

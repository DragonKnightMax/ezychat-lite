import type React from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import {
  CUSTOMER_TAG_LIMIT,
  CUSTOMER_TAG_MAX_CHARS,
  customerTagKey,
  normalizeTag,
} from '@ezychat/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface TagInputProps {
  value: string[];
  onChange(tags: string[]): void;
  /** Existing tags to offer; filtered by prefix and minus the chosen ones. */
  suggestions?: readonly string[];
  /** Called with the text being typed, e.g. to fetch suggestions for it. */
  onQueryChange?(q: string): void;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** Free-text tags: Enter or comma adds, Backspace on an empty input removes the last one. */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  onQueryChange,
  id,
  ...aria
}: TagInputProps) {
  const { t } = useTranslation(['inbox', 'common']);
  const listId = useId();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const full = value.length >= CUSTOMER_TAG_LIMIT;

  const chosen = new Set(value.map((tag) => customerTagKey(tag)));
  const prefix = customerTagKey(text);
  const options = suggestions
    .filter((s) => !chosen.has(customerTagKey(s)) && customerTagKey(s).startsWith(prefix))
    .slice(0, 8);
  const showOptions = focused && !full && options.length > 0;

  function setQuery(next: string) {
    setText(next);
    onQueryChange?.(normalizeTag(next));
  }

  function add(raw: string) {
    const tag = normalizeTag(raw);
    setQuery('');
    if (!tag || full || chosen.has(customerTagKey(tag))) return;
    onChange([...value, tag]);
  }

  function remove(tag: string) {
    onChange(value.filter((x) => x !== tag));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Enter also confirms an input-method candidate (Chinese, Japanese…): never add half-typed text.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <li key={tag} className="min-w-0 max-w-full">
              {/* overflow-visible: Badge clips by default, which would clip the × hit area too. */}
              <Badge
                variant="secondary"
                className="max-w-full gap-0.5 overflow-visible py-0 pr-0.5"
              >
                <span className="truncate">{tag}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  // 24px visible, ~44px hit area on touch screens.
                  className="relative size-6 rounded-full before:absolute before:-inset-2.5 before:content-['']"
                  aria-label={t('customer.removeTag', { tag })}
                  onClick={() => remove(tag)}
                >
                  <X aria-hidden="true" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          role="combobox"
          aria-expanded={showOptions}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          enterKeyHint="enter"
          maxLength={CUSTOMER_TAG_MAX_CHARS}
          value={text}
          disabled={full}
          placeholder={full ? t('customer.tagLimit') : t('customer.tagPlaceholder')}
          onChange={(e) => {
            const next = e.target.value;
            if (next.includes(',')) {
              const parts = next.split(',');
              const rest = parts.pop() ?? '';
              let tags = value;
              const keys = new Set(tags.map((tag) => customerTagKey(tag)));
              for (const part of parts) {
                const tag = normalizeTag(part);
                if (!tag || keys.has(customerTagKey(tag)) || tags.length >= CUSTOMER_TAG_LIMIT)
                  continue;
                keys.add(customerTagKey(tag));
                tags = [...tags, tag];
              }
              if (tags !== value) onChange(tags);
              // A full list disables the input: never leave text there that Save would add.
              setQuery(tags.length >= CUSTOMER_TAG_LIMIT ? '' : rest);
            } else {
              setQuery(next);
            }
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="h-11 min-w-0 flex-1 text-base md:h-9 md:text-sm"
          {...aria}
        />
        {/* Phone keyboards may not show an Enter key that adds: an explicit Add button. */}
        <Button
          type="button"
          variant="outline"
          aria-label={t('customer.addTag')}
          disabled={full || !normalizeTag(text)}
          // Keep focus in the input so the next tag can be typed straight away.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => add(text)}
          className="min-h-11 shrink-0 md:min-h-9"
        >
          <Plus aria-hidden="true" />
          {t('common:actions.add')}
        </Button>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t('customer.tags')}
        hidden={!showOptions}
        className="flex flex-wrap gap-1"
      >
        {showOptions &&
          options.map((s) => (
            <Button
              key={s}
              type="button"
              role="option"
              aria-selected={false}
              variant="ghost"
              size="sm"
              className="min-h-11 max-w-full justify-start truncate md:min-h-8"
              // Keep focus in the input so the list stays open for the next tag.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(s)}
            >
              {s}
            </Button>
          ))}
      </div>
    </div>
  );
}

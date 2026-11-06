import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Labelled search with an explicit, keyboard-accessible reset. */
export function SearchField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder: string;
}) {
  const { t, i18n } = useTranslation('app');
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 bg-surface pl-9 pr-12 text-base [&::-webkit-search-cancel-button]:appearance-none md:text-sm"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label={t('search.clear', { label: label.toLocaleLowerCase(i18n.language) })}
          className="absolute right-0 top-0"
          onClick={() => onChange('')}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

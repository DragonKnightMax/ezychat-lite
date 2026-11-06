import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isLocale, SUPPORTED_LOCALES } from '@ezychat/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useChangeLocale } from './use-change-locale';

/** Compact language picker for screens without the account menu (sign-in, setup). */
export function LanguageSelect({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { locale, changeLocale } = useChangeLocale();
  return (
    <Select value={locale} onValueChange={(v) => isLocale(v) && changeLocale(v)}>
      <SelectTrigger
        size="sm"
        aria-label={t('language.label')}
        className={cn('w-auto gap-2', className)}
      >
        <Languages aria-hidden="true" className="size-4" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SUPPORTED_LOCALES.map((l) => (
          <SelectItem key={l.code} value={l.code} lang={l.code}>
            {l.nativeName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

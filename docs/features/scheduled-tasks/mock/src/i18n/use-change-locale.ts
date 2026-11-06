import { useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { Locale } from '@ezychat/shared';
import { useSetMyLocale } from '@/api/queries';
import { useAuth } from '@/auth/AuthProvider';
import { localeStore, useLocale } from './locale-store';

/**
 * Current language plus a setter that applies it here and, once it has loaded, saves it to the
 * account when signed in.
 */
export function useChangeLocale() {
  const locale = useLocale();
  const { user } = useAuth();
  const { t } = useTranslation();
  const { mutate } = useSetMyLocale();
  const signedIn = !!user;
  const changeLocale = useCallback(
    (next: Locale) => {
      localeStore.setLocale(next).then(
        () => {
          if (signedIn) mutate(next, { onError: () => toast.error(t('language.saveFailed')) });
        },
        () => toast.error(t('language.loadFailed')),
      );
    },
    [signedIn, mutate, t],
  );
  return { locale, changeLocale };
}

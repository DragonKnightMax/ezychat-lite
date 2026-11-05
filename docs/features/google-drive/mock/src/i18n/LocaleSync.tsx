import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthProvider';
import { localeStore } from './locale-store';

/** Applies the signed-in user's saved language (it follows them across browsers and devices). */
export function LocaleSync() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const saved = user?.locale ?? null;
  useEffect(() => {
    if (saved && saved !== localeStore.getSnapshot())
      localeStore.setLocale(saved).catch(() => toast.error(t('language.loadFailed')));
  }, [saved, t]);
  return null;
}

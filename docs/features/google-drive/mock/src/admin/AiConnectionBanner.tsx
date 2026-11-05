import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { AiMemberStatus } from '@ezychat/shared';
import { Banner } from '@/components/app';

/** The one banner for a ChatGPT connection that expired or stopped working. */
export function AiConnectionBanner({
  status,
  action,
}: {
  status: AiMemberStatus;
  action?: React.ReactNode;
}) {
  const { t } = useTranslation('admin');
  const { state, error } = status.connection;
  if (status.settings.mode !== 'chatgpt' || (state !== 'error' && state !== 'expired')) return null;
  return (
    <Banner
      tone="danger"
      title={state === 'expired' ? t('ai.bannerExpiredTitle') : t('ai.bannerErrorTitle')}
      action={action}
    >
      <p>{error ?? (state === 'expired' ? t('ai.bannerExpiredText') : t('ai.bannerFallback'))}</p>
      <p>{t('ai.bannerChatsReleased')}</p>
    </Banner>
  );
}

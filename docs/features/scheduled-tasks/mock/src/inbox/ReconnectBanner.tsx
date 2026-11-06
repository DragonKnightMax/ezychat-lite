import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useRealtime } from '../api/socket';
import { Banner } from '@/components/app';

/**
 * Shown while the realtime (Socket.IO) link to the server is down after having been up once,
 * so agents know the inbox may be stale. Pure on `connected` (exported for tests).
 */
export function ReconnectBannerView({ connected }: { connected: boolean }) {
  const { t } = useTranslation('inbox');
  const everConnected = useRef(false);
  if (connected) everConnected.current = true;
  if (connected || !everConnected.current) return null;
  return (
    <div className="border-b bg-surface px-3 py-2">
      <Banner tone="warning" title={t('reconnect.title')}>
        {t('reconnect.body')}
      </Banner>
    </div>
  );
}

export function ReconnectBanner() {
  const { connected } = useRealtime();
  return <ReconnectBannerView connected={connected} />;
}

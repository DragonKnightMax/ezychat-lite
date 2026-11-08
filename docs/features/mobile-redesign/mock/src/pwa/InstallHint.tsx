import { Share } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Banner } from '@/components/app';
import { needsInstallForPush } from './push';

/**
 * iOS Safari only delivers notifications to Home Screen web apps.
 * Renders nothing elsewhere (or when `force` is false and already installed).
 */
export function InstallHint({ className, force = false }: { className?: string; force?: boolean }) {
  const { t } = useTranslation('inbox');
  if (!force && !needsInstallForPush()) return null;
  return (
    <Banner tone="info" title={t('installHint.title')} className={className}>
      <Trans
        t={t}
        i18nKey="installHint.body"
        components={{
          share: (
            <Share
              className="inline size-4 align-text-bottom text-foreground"
              aria-label={t('installHint.share')}
              role="img"
            />
          ),
          strong: <strong className="text-foreground" />,
        }}
      />
    </Banner>
  );
}

export default InstallHint;

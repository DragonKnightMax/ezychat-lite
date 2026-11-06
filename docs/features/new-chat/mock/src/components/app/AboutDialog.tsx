import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { GITHUB_REPO_URL } from '@/lib/links';
import { ResponsiveDialog } from './index';
import { AppCredits } from './AppCredits';
import { DesktopUpdatePanel } from './DesktopUpdates';
// Proposed (upgrade-enterprise)
import { UpgradeButton, useUpgradeUrl } from './UpgradeEnterprise';

/** "About EzyChat Lite": icon, name, description, version, repo link and credits. */
export function AboutDialog({
  open,
  onOpenChange,
  version,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version?: string;
}) {
  const { t } = useTranslation(['app', 'common']);
  const upgradeUrl = useUpgradeUrl();
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('about.title')}
      description={t('about.description')}
    >
      <div className="flex flex-col items-center gap-4 pb-4 text-center">
        <img
          src="/icon-192.png"
          alt=""
          aria-hidden="true"
          className="size-16 select-none rounded-2xl"
        />
        <div>
          <p className="text-base font-semibold">{t('common:appName')}</p>
          <p className="text-sm text-muted-foreground">
            {version ? t('about.version', { version }) : t('about.versionUnknown')}
          </p>
        </div>
        <DesktopUpdatePanel />
        <Button asChild variant="outline" size="touch">
          <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
            {t('about.github')}
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
        {/* Proposed (upgrade-enterprise): Lite only. */}
        {upgradeUrl && (
          <div className="flex flex-col items-center gap-2" data-testid="about-upgrade">
            <p className="max-w-xs text-sm text-muted-foreground">{t('common:upgrade.about')}</p>
            <UpgradeButton />
          </div>
        )}
        <AppCredits />
      </div>
    </ResponsiveDialog>
  );
}

export default AboutDialog;

// Proposed (upgrade-enterprise): "Upgrade to Enterprise" links, Lite only. The production app reads the
// address from `useAppLinks().upgrade` (Lite: https://ezychat.ai/#enterprise; Enterprise passes `null`, which
// hides every link). The mock decides with the mock-only edition switch.
import { ExternalLink, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useMockEdition } from '@/mock/edition';
import { cn } from '@/lib/utils';

export const UPGRADE_URL = 'https://ezychat.ai/#enterprise';

/** The upgrade address, or `null` when the edition hides it (Enterprise). */
export function useUpgradeUrl(): string | null {
  return useMockEdition() === 'lite' ? UPGRADE_URL : null;
}

/** An outline button that opens the Enterprise page in the browser. */
export function UpgradeButton({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  const url = useUpgradeUrl();
  if (!url) return null;
  return (
    <Button asChild variant="outline" size="touch" className={className}>
      <a href={url} target="_blank" rel="noopener noreferrer" data-testid="upgrade-enterprise">
        <Sparkles aria-hidden="true" />
        {t('upgrade.cta')}
        <ExternalLink aria-hidden="true" />
      </a>
    </Button>
  );
}

/** A quiet row under a limit: why Enterprise helps, and the upgrade button. */
export function UpgradeNote({
  reason,
  className,
}: {
  reason: 'agents' | 'numbers';
  className?: string;
}) {
  const { t } = useTranslation('common');
  const url = useUpgradeUrl();
  if (!url) return null;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
      data-testid="upgrade-note"
    >
      <p className="min-w-0 text-sm text-muted-foreground">{t(`upgrade.${reason}`)}</p>
      <UpgradeButton className="shrink-0 self-start sm:self-auto" />
    </div>
  );
}

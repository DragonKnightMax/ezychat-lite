import { useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  PlugZap,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DesktopUpgradeBridge, DesktopUpgradeState } from '@ezychat/shared';
import { Banner, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useAppLinks } from '@/lib/app-links';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { upgradeBridge, useDesktopUpgrade } from '../../lite-import/bridge';
import { IconBubble, IconLine, Tiles } from '../../lite-import/ui';

/**
 * The "Upgrade to Enterprise" address, or null when the product hides it: Lite links
 * ezychat.ai/#enterprise (with a campaign tag), another product passes `createInboxApp({ links: { upgrade: null } })`.
 */
export function useUpgradeUrl(): string | null {
  return useAppLinks().upgrade;
}

/**
 * Lite's Upgrade dialog in the desktop window on the host PC: downloads the EzyChat Enterprise installer,
 * checks it and starts it (the desktop does all of that; the page only asks and shows progress).
 */
export function UpgradeDialog({
  open,
  onOpenChange,
  bridge,
  state,
  onState,
  learnMoreUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: DesktopUpgradeBridge;
  state: DesktopUpgradeState;
  onState: (state: DesktopUpgradeState) => void;
  learnMoreUrl: string;
}) {
  const { t } = useTranslation('common');
  const [failed, setFailed] = useState(false);
  const run = async (call: () => Promise<DesktopUpgradeState>) => {
    setFailed(false);
    try {
      onState(await call());
    } catch {
      setFailed(true);
    }
  };
  const busy = state.status === 'checking' || state.status === 'downloading';
  const pct =
    state.totalBytes && state.totalBytes > 0
      ? Math.min(100, (state.downloadedBytes / state.totalBytes) * 100)
      : 0;
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={t('upgrade.dialog.title')}>
      <div
        className="flex min-w-0 flex-col gap-4 pb-4"
        data-testid="upgrade-dialog"
        data-status={state.status}
      >
        <Tiles
          items={[
            {
              icon: Smartphone,
              value: t('upgrade.dialog.numbersValue'),
              label: t('upgrade.dialog.numbers'),
            },
            {
              icon: Bot,
              value: t('upgrade.dialog.agentsValue'),
              label: t('upgrade.dialog.agents'),
            },
            { icon: PlugZap, value: t('upgrade.dialog.apiValue'), label: t('upgrade.dialog.api') },
          ]}
        />
        <ul className="flex flex-col gap-1">
          <IconLine icon={ShieldCheck} tone="text-success">
            {t('upgrade.dialog.keeps')}
          </IconLine>
          <IconLine icon={Clock} tone="text-success">
            {t('upgrade.dialog.trial')}
          </IconLine>
        </ul>
        {(state.status === 'error' || failed) && (
          <Banner tone="danger">{t('upgrade.dialog.error')}</Banner>
        )}
        {state.status === 'downloading' && (
          <div className="flex flex-col gap-2">
            <Progress value={pct} aria-label={t('upgrade.dialog.downloading')} />
            <p className="text-sm text-muted-foreground">
              {state.totalBytes
                ? t('upgrade.dialog.progress', {
                    done: formatBytes(state.downloadedBytes),
                    total: formatBytes(state.totalBytes),
                  })
                : t('upgrade.dialog.downloading')}
            </p>
          </div>
        )}
        {state.status === 'started' ? (
          <div
            className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
            data-testid="upgrade-started"
          >
            <IconBubble icon={CheckCircle2} tone="success" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{t('upgrade.dialog.startedTitle')}</span>
              <span className="text-sm text-muted-foreground">
                {t('upgrade.dialog.startedBody')}
              </span>
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {state.status === 'downloading' ? (
              <Button
                variant="outline"
                size="touch"
                onClick={() => void run(() => bridge.cancel())}
              >
                {t('upgrade.dialog.cancel')}
              </Button>
            ) : (
              <Button size="touch" disabled={busy} onClick={() => void run(() => bridge.install())}>
                <Download aria-hidden />
                {state.status === 'error' || failed
                  ? t('upgrade.dialog.retry')
                  : t('upgrade.dialog.install')}
              </Button>
            )}
            <Button asChild variant="outline" size="touch">
              <a href={learnMoreUrl} target="_blank" rel="noopener noreferrer">
                {t('upgrade.dialog.learnMore')}
              </a>
            </Button>
          </div>
        )}
      </div>
    </ResponsiveDialog>
  );
}

/**
 * The upgrade button: in the desktop window on the host PC it opens the Upgrade dialog (install
 * EzyChat Enterprise); anywhere else it opens the Enterprise page in the browser. Nothing when hidden.
 */
export function UpgradeButton({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  const url = useUpgradeUrl();
  const bridge = upgradeBridge();
  const [state, setState] = useDesktopUpgrade(bridge);
  const [open, setOpen] = useState(false);
  if (!url) return null;
  if (bridge && state?.available)
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className={className}
          data-testid="upgrade-enterprise"
          onClick={() => setOpen(true)}
        >
          <Sparkles aria-hidden="true" />
          {t('upgrade.cta')}
        </Button>
        <UpgradeDialog
          open={open}
          onOpenChange={setOpen}
          bridge={bridge}
          state={state}
          onState={setState}
          learnMoreUrl={url}
        />
      </>
    );
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

/** A quiet row under a Lite limit: why Enterprise helps, and the upgrade button. */
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
      <p className="min-w-0 text-sm text-muted-foreground">
        {reason === 'agents' ? t('upgrade.agents') : t('upgrade.numbers')}
      </p>
      <UpgradeButton className="shrink-0 self-start sm:self-auto" />
    </div>
  );
}

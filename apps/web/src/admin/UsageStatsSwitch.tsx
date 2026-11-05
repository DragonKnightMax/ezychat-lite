import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client';
import { usePatchSettings, useSettings } from '../api/queries';
import { Banner } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/**
 * "Share anonymous usage stats" (design: docs/superpowers/specs/2026-11-04-usage-stats-design.md): on by default, saved
 * at once (admins only). The "?" lists exactly what is sent and what never is.
 */
export function UsageStatsSwitch() {
  const { t } = useTranslation('admin');
  const settings = useSettings();
  const patch = usePatchSettings();
  const id = useId();
  const hintId = `${id}-hint`;
  const checked = patch.isPending
    ? (patch.variables?.usageStats ?? settings.data?.usageStats ?? true)
    : (settings.data?.usageStats ?? true);
  return (
    <div className="flex flex-col gap-2" data-testid="usage-stats">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={id} className="leading-normal">
              {t('settings.usageStats.label')}
            </Label>
            <InfoTip topic="usageStats" />
          </div>
          <p id={hintId} className="mt-0.5 text-sm text-muted-foreground">
            {t('settings.usageStats.hint')}
          </p>
        </div>
        <Label
          htmlFor={id}
          className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
        >
          <Switch
            id={id}
            aria-describedby={hintId}
            checked={checked}
            disabled={settings.isPending || patch.isPending}
            onCheckedChange={(usageStats) => patch.mutate({ usageStats })}
          />
        </Label>
      </div>
      {(patch.error || settings.error) && (
        <Banner tone="danger">{errorMessage(patch.error || settings.error)}</Banner>
      )}
    </div>
  );
}

/** Settings → General: the switch in its own card. */
export function UsageStatsCard() {
  const { t } = useTranslation('admin');
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('settings.usageStats.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <UsageStatsSwitch />
      </CardContent>
    </Card>
  );
}

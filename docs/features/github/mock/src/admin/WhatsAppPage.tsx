import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { WaState } from '@ezychat/shared';
import { useWaAction, useWaStatus, type WaAction } from '../api/queries';
import { PhoneLink } from '../wa/PhoneLink';
import { Banner, EmptyState, PageHeader, StatusDot, stateTone } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ConfirmDialog, ErrorState } from './adminUi';
// Proposed (upgrade-enterprise)
import { UpgradeNote } from '@/components/app/UpgradeEnterprise';

/** WhatsApp connection state → translation key in the `admin` namespace. */
export const WA_STATE_LABEL_KEY = {
  open: 'whatsapp.state.open',
  connecting: 'whatsapp.state.connecting',
  qr: 'whatsapp.state.qr',
  disconnected: 'whatsapp.state.disconnected',
  logged_out: 'whatsapp.state.loggedOut',
  replaced: 'whatsapp.state.replaced',
  blocked: 'whatsapp.state.blocked',
} as const satisfies Record<WaState, string>;

const ACTIONS = {
  logout: { danger: true },
  relink: { danger: true },
  takeover: { danger: false },
} as const satisfies Record<WaAction, { danger: boolean }>;

/** Least to most disruptive: Log out (the loudest consequence) always comes last. */
const ACTION_ORDER = ['takeover', 'relink', 'logout'] as const satisfies readonly WaAction[];

const LINK_ILLUSTRATION = '/illustrations/link-whatsapp.png';

function formatPhone(jid: string): string {
  const num = jid.split('@')[0]?.split(':')[0] ?? jid;
  return /^\d+$/.test(num) ? `+${num}` : num;
}

export function WhatsAppPage() {
  const wa = useWaStatus();
  const action = useWaAction();
  const [pending, setPending] = useState<WaAction | null>(null);
  const { t } = useTranslation('admin');

  if (wa.isPending)
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={t('ui.loading')}>
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (wa.isError) return <ErrorState error={wa.error} onRetry={() => void wa.refetch()} />;

  const s = wa.data;
  // Guard against a state added on the server before the web catalog knows it.
  const labelKey: (typeof WA_STATE_LABEL_KEY)[WaState] | undefined = WA_STATE_LABEL_KEY[s.state];
  const label = labelKey ? t(labelKey) : s.state;
  const unlinked = s.state === 'logged_out' || s.state === 'blocked';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('nav.whatsapp')} description={t('whatsapp.description')} />

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{t('whatsapp.connection')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid max-w-xl grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('whatsapp.status')}</dt>
            <dd>
              <StatusDot
                tone={stateTone(s.state)}
                pulse={s.state === 'connecting'}
                label={
                  <span className="font-medium" data-testid="wa-state">
                    {label}
                  </span>
                }
              />
            </dd>
            {s.me && (
              <>
                <dt className="text-muted-foreground">{t('whatsapp.linkedNumber')}</dt>
                <dd className="font-medium break-words">{formatPhone(s.me.jid)}</dd>
                {s.me.name && (
                  <>
                    <dt className="text-muted-foreground">{t('whatsapp.name')}</dt>
                    <dd className="font-medium break-words">{s.me.name}</dd>
                  </>
                )}
              </>
            )}
          </dl>
          {s.lastError && s.state !== 'open' && <Banner tone="warning">{s.lastError}</Banner>}
          {s.state === 'replaced' && (
            <Banner tone="danger" title={t('whatsapp.replacedTitle')}>
              {t('whatsapp.replacedBody')}
            </Banner>
          )}
          {unlinked && <Banner tone="danger">{t('whatsapp.unlinkedBody')}</Banner>}
          {/* Proposed (upgrade-enterprise): Lite links one number. */}
          <UpgradeNote reason="numbers" />
        </CardContent>
      </Card>

      {s.state === 'qr' && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>{t('whatsapp.scanTitle')}</CardTitle>
            <CardDescription>{t('whatsapp.scanHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            {s.qr ? (
              <div className="flex justify-center">
                {/* QR codes need a light quiet zone to scan reliably, even in dark mode. */}
                <div className="rounded-lg border bg-card p-3 dark:bg-foreground">
                  <QRCodeSVG
                    value={s.qr}
                    size={256}
                    bgColor="transparent"
                    fgColor="currentColor"
                    className="h-auto w-full max-w-64 text-foreground dark:text-background"
                    aria-label={t('whatsapp.qrLabel')}
                  />
                </div>
              </div>
            ) : (
              <EmptyState
                illustration={LINK_ILLUSTRATION}
                title={t('whatsapp.waitingQrTitle')}
                description={t('whatsapp.waitingQrBody')}
              />
            )}
          </CardContent>
        </Card>
      )}

      {(s.state === 'qr' || s.state === 'connecting') && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>{t('whatsapp.phoneTitle')}</CardTitle>
            <CardDescription>{t('whatsapp.phoneHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <PhoneLink />
          </CardContent>
        </Card>
      )}

      {unlinked && (
        <Card>
          <EmptyState
            illustration={LINK_ILLUSTRATION}
            title={t('whatsapp.linkTitle')}
            description={t('whatsapp.linkBody')}
            action={
              <Button
                size="touch"
                className="md:min-h-9"
                onClick={() => {
                  action.reset();
                  setPending('relink');
                }}
              >
                {t('whatsapp.actions.relink.label')}
              </Button>
            }
          />
        </Card>
      )}

      <Card className="gap-4">
        <CardHeader>
          <CardTitle id="wa-actions-title">{t('whatsapp.actionsTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul aria-labelledby="wa-actions-title" className="flex flex-col divide-y">
            {/* Take over only helps when another session replaced this one. */}
            {ACTION_ORDER.filter((a) => a !== 'takeover' || s.state === 'replaced').map((a) => (
              <li
                key={a}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
              >
                <p className="min-w-0 text-sm text-muted-foreground">
                  {t(`whatsapp.actions.${a}.hint`)}
                </p>
                <Button
                  size="touch"
                  className={cn(
                    'shrink-0 md:min-h-9',
                    a === 'logout' && 'border-danger/40 text-danger hover:text-danger',
                  )}
                  variant={a === 'takeover' ? 'default' : 'outline'}
                  onClick={() => {
                    action.reset();
                    setPending(a);
                  }}
                >
                  {t(`whatsapp.actions.${a}.label`)}
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {pending && (
        <ConfirmDialog
          open
          title={t(`whatsapp.actions.${pending}.title`)}
          confirmLabel={t(`whatsapp.actions.${pending}.label`)}
          danger={ACTIONS[pending].danger}
          loading={action.isPending}
          error={action.error ?? undefined}
          onConfirm={() =>
            action.mutate(pending, {
              onSuccess: () => {
                toast.success(t(`whatsapp.actions.${pending}.done`));
                setPending(null);
              },
            })
          }
          onClose={() => setPending(null)}
        >
          <p>{t(`whatsapp.actions.${pending}.body`)}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

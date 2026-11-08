import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Check, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '../api/client';
import { Banner, ResponsiveDialog, SegmentedControl, StatusDot } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  googleCalendarUrl,
  useGoogleCalendar,
  useGoogleCalendarAction,
} from '@/mock/googleCalendar';
import { ConfirmDialog, ListSkeleton } from './adminUi';
import { GoogleCalendarLink } from './ConnectorsGalleryPage';

const DEMO_ACCOUNT = 'kopiapong.penang@gmail.com';

/**
 * Proposed (google-calendar): Settings → Integrations → Google Calendar. One Google account per
 * install; "Connect Google Calendar" opens Google's sign-in (in the mock: a stand-in consent dialog),
 * nothing to paste. Which calendar each AI agent uses and its booking hours live on the agent page.
 */
export function GoogleCalendarSection({
  onOpenSettings,
}: Readonly<{ onOpenSettings?: () => void }>) {
  const { t } = useTranslation('admin');
  const query = useGoogleCalendar();
  const action = useGoogleCalendarAction();
  const mockId = useId();
  const [consent, setConsent] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const data = query.data;
  const state = data?.state ?? 'disconnected';
  const connect = () =>
    action.mutate(
      { kind: 'connect', account: DEMO_ACCOUNT },
      {
        onSuccess: () => {
          setConsent(false);
          toast.success(t('mockCalendar.connected', { account: DEMO_ACCOUNT }));
        },
      },
    );
  const tone = state === 'connected' ? 'success' : state === 'disconnected' ? 'muted' : 'warning';
  return (
    <Card data-testid="google-calendar-settings">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockConnectors.gc.accountTitle')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockConnectors.gc.accountDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending && <ListSkeleton rows={2} />}
        {data && state === 'disconnected' && (
          <>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {(['what1', 'what2', 'what3'] as const).map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {t(`mockCalendar.${key}`)}
                </li>
              ))}
            </ul>
            <Button size="touch" className="self-start" onClick={() => setConsent(true)}>
              <CalendarDays aria-hidden />
              {t('mockCalendar.connect')}
            </Button>
            <p className="text-sm text-muted-foreground">{t('mockCalendar.connectHint')}</p>
          </>
        )}
        {data && state !== 'disconnected' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-muted-foreground">{t('mockCalendar.account')}</span>
                <span className="font-medium break-all">{data.account}</span>
              </div>
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={tone} />
                {t(`mockCalendar.state.${state}`)}
              </span>
            </div>
            {state === 'expired' && (
              <Banner tone="warning" title={t('mockCalendar.expiredTitle')}>
                <span className="flex flex-col items-start gap-2">
                  {t('mockCalendar.expiredBody')}
                  <Button size="touch" variant="outline" onClick={() => setConsent(true)}>
                    {t('mockCalendar.signInAgain')}
                  </Button>
                </span>
              </Banner>
            )}
            {state === 'unavailable' && (
              <Banner tone="warning" title={t('mockCalendar.unavailableTitle')}>
                {t('mockCalendar.unavailableBody')}
              </Banner>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t('mockCalendar.calendars')}</span>
              <ul className="flex flex-col gap-1 text-sm">
                {data.calendars.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <span className="break-all">{c.name}</span>
                    {c.readOnly && <Badge variant="secondary">{t('mockCalendar.readOnly')}</Badge>}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('mockCalendar.perAgent')}{' '}
              {onOpenSettings && (
                <Button
                  variant="link"
                  className="h-auto p-0 align-baseline"
                  onClick={onOpenSettings}
                >
                  {t('mockConnectors.gc.openSettings')}
                </Button>
              )}
            </p>
            {/* Baseline addition (PR #192): Open Google Calendar beside Disconnect. */}
            <div className="flex flex-wrap items-center gap-2">
              {data.account && (
                <GoogleCalendarLink
                  href={googleCalendarUrl(data.account)}
                  label={t('mockConnectors.bookings.openCalendar')}
                />
              )}
              <Button
                size="touch"
                variant="outline"
                className="self-start"
                onClick={() => setConfirmDisconnect(true)}
              >
                {t('mockCalendar.disconnect')}
              </Button>
            </div>
          </>
        )}
        {action.error && <Banner tone="danger">{errorMessage(action.error)}</Banner>}
        {data && state !== 'disconnected' && (
          <div
            className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
            data-testid="mock-calendar-controls"
          >
            <Badge variant="outline" className="self-start">
              {t('mockSuggest.mockControls')}
            </Badge>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span id={mockId} className="text-sm font-medium">
                {t('mockCalendar.mockGoogle')}
              </span>
              <SegmentedControl<'connected' | 'expired' | 'unavailable'>
                size="sm"
                aria-labelledby={mockId}
                value={state}
                onValueChange={(next) => action.mutate({ kind: 'state', state: next })}
                options={[
                  { value: 'connected', label: t('mockCalendar.mockOk') },
                  { value: 'expired', label: t('mockCalendar.mockExpired') },
                  { value: 'unavailable', label: t('mockCalendar.mockDown') },
                ]}
              />
            </div>
          </div>
        )}
      </CardContent>
      <ResponsiveDialog
        open={consent}
        onOpenChange={setConsent}
        title={t('mockCalendar.consentTitle')}
        description={t('mockCalendar.consentMock')}
        footer={
          <>
            <Button size="touch" variant="outline" onClick={() => setConsent(false)}>
              {t('mockCalendar.consentCancel')}
            </Button>
            <Button size="touch" disabled={action.isPending} onClick={connect}>
              {t('mockCalendar.consentAllow')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pb-2 text-sm" data-testid="google-consent">
          <p>
            {t('mockCalendar.consentAccount')}{' '}
            <span className="font-medium break-all">{DEMO_ACCOUNT}</span>
          </p>
          <p className="font-medium">{t('mockCalendar.consentWants')}</p>
          <ul className="flex flex-col gap-1.5">
            {(['scope1', 'scope2'] as const).map((key) => (
              <li key={key} className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                {t(`mockCalendar.${key}`)}
              </li>
            ))}
          </ul>
        </div>
      </ResponsiveDialog>
      <ConfirmDialog
        open={confirmDisconnect}
        title={t('mockCalendar.disconnectTitle')}
        confirmLabel={t('mockCalendar.disconnect')}
        danger
        loading={action.isPending}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          action.mutate(
            { kind: 'disconnect' },
            {
              onSuccess: () => {
                setConfirmDisconnect(false);
                toast.success(t('mockCalendar.disconnected'));
              },
            },
          )
        }
      >
        {t('mockCalendar.disconnectBody')}
      </ConfirmDialog>
    </Card>
  );
}

import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { googleCalendarUrl } from '@ezychat/shared';
import {
  googleCalendarKey,
  useGoogleCalendar,
  useGoogleCalendarConnect,
  useGoogleCalendarDisconnect,
  useGoogleCalendarProgress,
} from '../../api/connectors';
import { Badge } from '@/components/ui/badge';
import { GoogleCalendarLink } from './connector-ui';
import { GoogleAccountCard, useGoogleConnectFlow } from './google-connect';

/**
 * The Google account EzyChat uses (one per install): connect, its state, its calendars and
 * Disconnect. Which calendar each AI agent uses lives on the Settings tab.
 */
export function GoogleCalendarAccountCard({
  onOpenSettings,
}: Readonly<{ onOpenSettings?: () => void }>) {
  const { t } = useTranslation('admin');
  const query = useGoogleCalendar();
  const flow = useGoogleConnectFlow({
    useStart: useGoogleCalendarConnect,
    useProgress: useGoogleCalendarProgress,
    statusKey: googleCalendarKey,
    connectedToast: t('connectors.gc.connectedToast'),
  });
  const data = query.data;
  const state = data?.state;
  return (
    <GoogleAccountCard
      testId="google-calendar-account"
      icon={CalendarDays}
      query={query}
      flow={flow}
      disconnect={useGoogleCalendarDisconnect()}
      onOpenSettings={onOpenSettings}
      texts={{
        description: t('connectors.gc.accountDescription'),
        what: [t('connectors.gc.what1'), t('connectors.gc.what2'), t('connectors.gc.what3')],
        connect: t('connectors.gc.connect'),
        connectHint: t('connectors.gc.connectHint'),
        expiredBody: t('connectors.gc.expiredBody'),
        unavailableTitle: t('connectors.gc.unavailableTitle'),
        unavailableBody: t('connectors.gc.unavailableBody'),
        perAgent: t('connectors.gc.perAgent'),
        disconnectTitle: t('connectors.gc.disconnectTitle'),
        disconnectBody: t('connectors.gc.disconnectBody'),
        disconnected: t('connectors.gc.disconnected'),
      }}
      actions={
        data?.account && (
          <GoogleCalendarLink
            href={googleCalendarUrl(data.account)}
            label={t('connectors.bookings.openCalendar')}
          />
        )
      }
    >
      {/* While the sign-in does not work the list is unknown: no "No calendars found". */}
      {data && (state === 'connected' || data.calendars.length > 0) && (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('connectors.gc.calendars')}</span>
          {data.calendars.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('connectors.gc.noCalendars')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {data.calendars.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className="break-all">{c.name}</span>
                  {c.readOnly && <Badge variant="secondary">{t('connectors.gc.readOnly')}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </GoogleAccountCard>
  );
}

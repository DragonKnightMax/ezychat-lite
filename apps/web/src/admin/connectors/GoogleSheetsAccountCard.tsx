import { useTranslation } from 'react-i18next';
import { Table2 } from 'lucide-react';
import {
  googleSheetsKey,
  useGoogleSheets,
  useGoogleSheetsConnect,
  useGoogleSheetsDisconnect,
  useGoogleSheetsProgress,
} from '../../api/connectors';
import { GoogleAccountCard, useGoogleConnectFlow } from './google-connect';

/**
 * The Google account Google Sheets uses (one per install, its own sign-in): connect, its state and
 * Disconnect. Which spreadsheet each AI agent uses lives on the Settings tab.
 */
export function GoogleSheetsAccountCard({
  onOpenSettings,
}: Readonly<{ onOpenSettings?: () => void }>) {
  const { t } = useTranslation('admin');
  const flow = useGoogleConnectFlow({
    useStart: useGoogleSheetsConnect,
    useProgress: useGoogleSheetsProgress,
    statusKey: googleSheetsKey,
    connectedToast: t('connectors.gs.connectedToast'),
  });
  return (
    <GoogleAccountCard
      testId="google-sheets-account"
      icon={Table2}
      query={useGoogleSheets()}
      flow={flow}
      disconnect={useGoogleSheetsDisconnect()}
      onOpenSettings={onOpenSettings}
      texts={{
        description: t('connectors.gs.accountDescription'),
        what: [t('connectors.gs.what1'), t('connectors.gs.what2'), t('connectors.gs.what3')],
        connect: t('connectors.gs.connect'),
        connectHint: t('connectors.gs.connectHint'),
        expiredBody: t('connectors.gs.expiredBody'),
        unavailableTitle: t('connectors.gs.unavailableTitle'),
        unavailableBody: t('connectors.gs.unavailableBody'),
        perAgent: t('connectors.gs.perAgent'),
        disconnectTitle: t('connectors.gs.disconnectTitle'),
        disconnectBody: t('connectors.gs.disconnectBody'),
        disconnected: t('connectors.gs.disconnected'),
      }}
    />
  );
}

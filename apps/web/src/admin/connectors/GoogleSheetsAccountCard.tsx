import { useTranslation } from 'react-i18next';
import { Table2 } from 'lucide-react';
import {
  googleSheetsKey,
  useGoogleSheets,
  useGoogleSheetsConnect,
  useGoogleSheetsDisconnect,
  useGoogleSheetsProgress,
} from '../../api/connectors';
import { GoogleAccountCard, googleAccountTexts, useGoogleConnectFlow } from './google-connect';

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
      texts={googleAccountTexts(t as unknown as (key: string) => string, 'gs')}
    />
  );
}

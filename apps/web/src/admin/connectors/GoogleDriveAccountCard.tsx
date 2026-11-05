import { useTranslation } from 'react-i18next';
import { HardDrive } from 'lucide-react';
import {
  googleDriveKey,
  useGoogleDrive,
  useGoogleDriveConnect,
  useGoogleDriveDisconnect,
  useGoogleDriveProgress,
} from '../../api/connectors';
import { GoogleAccountCard, googleAccountTexts, useGoogleConnectFlow } from './google-connect';

/**
 * The Google account Google Drive uses (one per install, its own sign-in): connect, its state and
 * Disconnect. Each AI agent's folder and files live on the Settings tab.
 */
export function GoogleDriveAccountCard({
  onOpenSettings,
}: Readonly<{ onOpenSettings?: () => void }>) {
  const { t } = useTranslation('admin');
  const flow = useGoogleConnectFlow({
    useStart: useGoogleDriveConnect,
    useProgress: useGoogleDriveProgress,
    statusKey: googleDriveKey,
    connectedToast: t('connectors.gd.connectedToast'),
  });
  return (
    <GoogleAccountCard
      testId="google-drive-account"
      icon={HardDrive}
      query={useGoogleDrive()}
      flow={flow}
      disconnect={useGoogleDriveDisconnect()}
      onOpenSettings={onOpenSettings}
      texts={googleAccountTexts(t as unknown as (key: string) => string, 'gd')}
    />
  );
}

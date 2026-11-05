import { ExternalLink, Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { feedbackUrl } from '@/lib/links';
import { useAppVersion } from '@/lib/version';

/**
 * Opens the feedback form on ezychat.ai in the app's language, with the app version filled in.
 * No GitHub account needed; nothing is sent until the user submits the form.
 */
export function FeatureRequestAction({ placement = 'button' }: { placement?: 'button' | 'menu' }) {
  const { t, i18n } = useTranslation('app');
  const version = useAppVersion();
  const link = (
    <a href={feedbackUrl(i18n.language, version)} target="_blank" rel="noopener noreferrer">
      <Lightbulb aria-hidden="true" />
      {t('featureRequest.label')}
      <ExternalLink aria-hidden="true" className="ml-auto size-3.5" />
      <span className="sr-only"> {t('featureRequest.opensWebsite')}</span>
    </a>
  );

  return placement === 'menu' ? (
    <DropdownMenuItem asChild className="min-h-11">
      {link}
    </DropdownMenuItem>
  ) : (
    <Button asChild variant="ghost" className="min-h-11 text-muted-foreground">
      {link}
    </Button>
  );
}

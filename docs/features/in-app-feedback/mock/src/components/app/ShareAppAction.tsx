import { useId, useState } from 'react';
import { Copy, Download, ExternalLink, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  copyShareText,
  downloadShareCard,
  SHARE_APP_URL,
  shareApp,
  shareAppMessage,
  SOCIAL_SHARE_LINKS,
} from '@/lib/share-app';
import { ResponsiveDialog } from './index';

// Platform names are brands and stay untranslated.
const SOCIAL_PLATFORMS = [
  { id: 'linkedin', name: 'LinkedIn' },
  { id: 'facebook', name: 'Facebook' },
] as const;
const INSTAGRAM = 'Instagram';

type Feedback =
  | 'messageCopied'
  | 'linkCopied'
  | 'copyUnavailable'
  | 'shareUnavailable'
  | 'imageStarted'
  | 'imageFailed';

/** Personal recommendation tools, with user-controlled posting on each platform. */
export function ShareAppAction({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['app', 'common']);
  const id = useId();
  // The suggested caption follows the UI language until the user edits it.
  const [edited, setEdited] = useState<string | null>(null);
  const caption = edited ?? t('share.caption');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);

  async function copy(text: string, success: Feedback) {
    try {
      await copyShareText(text);
      setFeedback(success);
    } catch {
      setFeedback('copyUnavailable');
    }
  }

  async function nativeShare() {
    setFeedback(null);
    setBusy(true);
    try {
      const result = await shareApp(caption);
      if (result === 'copied') setFeedback('messageCopied');
    } catch {
      setFeedback('shareUnavailable');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setFeedback(null);
    setBusy(true);
    try {
      await downloadShareCard();
      setFeedback('imageStarted');
    } catch {
      setFeedback('imageFailed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('share.title')}
      description={t('share.description')}
      footer={
        <Button variant="outline" size="touch" onClick={() => onOpenChange(false)}>
          {t('common:actions.done')}
        </Button>
      }
    >
      <div className="min-w-0 space-y-4 pb-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-caption`}>{t('share.message')}</Label>
          <Textarea
            id={`${id}-caption`}
            value={caption}
            onChange={(event) => setEdited(event.target.value)}
            className="max-h-48 min-h-32 resize-y [overflow-wrap:anywhere]"
            maxLength={2000}
          />
          <Button
            variant="outline"
            size="touch"
            className="w-full"
            onClick={() => void copy(shareAppMessage(caption), 'messageCopied')}
          >
            <Copy aria-hidden="true" /> {t('share.copyMessage')}
          </Button>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-url`}>{t('share.publicLink')}</Label>
          <Input
            id={`${id}-url`}
            readOnly
            value={SHARE_APP_URL}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="text-sm text-muted-foreground">{t('share.privacy')}</p>
          <Button
            variant="ghost"
            size="touch"
            onClick={() => void copy(SHARE_APP_URL, 'linkCopied')}
          >
            <Copy aria-hidden="true" /> {t('share.copyLink')}
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('share.socialTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('share.socialHint')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SOCIAL_PLATFORMS.map((platform) => (
              <Button key={platform.id} asChild variant="outline" size="touch">
                <a href={SOCIAL_SHARE_LINKS[platform.id]} target="_blank" rel="noopener noreferrer">
                  {platform.name} <ExternalLink aria-hidden="true" />
                  <span className="sr-only"> {t('share.opensNewWindow')}</span>
                </a>
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm font-medium">{INSTAGRAM}</p>
          <p className="text-sm text-muted-foreground">{t('share.instagramHint')}</p>
          <img
            src="/share-app.svg"
            alt={t('share.imageAlt')}
            className="mx-auto aspect-square w-40 max-w-full rounded-lg border"
          />
          <Button
            variant="outline"
            size="touch"
            className="w-full"
            disabled={busy}
            onClick={() => void download()}
          >
            <Download aria-hidden="true" /> {t('share.downloadImage')}
          </Button>
        </div>
        {typeof navigator.share === 'function' && (
          <Button
            size="touch"
            className="w-full"
            disabled={busy}
            onClick={() => void nativeShare()}
          >
            <Share2 aria-hidden="true" /> {t('share.more')}
          </Button>
        )}
        <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
          {feedback && t(`share.feedback.${feedback}`)}
        </p>
      </div>
    </ResponsiveDialog>
  );
}

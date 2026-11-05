import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { WaStatus } from '@ezychat/shared';
import { useWaStatus } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';

type WaStateName = WaStatus['state'];
type BannerTone = 'info' | 'warning' | 'danger';

/** States where outgoing messages are queued and will go out once reconnected. */
export function waQueuesMessages(state: WaStateName | undefined): boolean {
  return state === 'disconnected' || state === 'connecting';
}

/** States where sending is pointless until an admin acts (composer disabled). */
export function waSendingBlocked(state: WaStateName | undefined): boolean {
  return state === 'qr' || state === 'logged_out' || state === 'replaced' || state === 'blocked';
}

const copy = {
  connecting: {
    tone: 'info',
    titleKey: 'waBanner.connecting.title',
    bodyKey: 'waBanner.connecting.body',
  },
  disconnected: {
    tone: 'warning',
    titleKey: 'waBanner.disconnected.title',
    bodyKey: 'waBanner.disconnected.body',
  },
  qr: { tone: 'warning', titleKey: 'waBanner.qr.title', bodyKey: 'waBanner.qr.body' },
  logged_out: {
    tone: 'danger',
    titleKey: 'waBanner.loggedOut.title',
    bodyKey: 'waBanner.loggedOut.body',
  },
  replaced: {
    tone: 'danger',
    titleKey: 'waBanner.replaced.title',
    bodyKey: 'waBanner.replaced.body',
  },
  blocked: { tone: 'danger', titleKey: 'waBanner.blocked.title', bodyKey: 'waBanner.blocked.body' },
} as const satisfies Record<
  Exclude<WaStateName, 'open'>,
  { tone: BannerTone; titleKey: string; bodyKey: string }
>;

/** Top-of-inbox banner shown whenever the WhatsApp connection isn't open. */
export function WaBanner() {
  const { t } = useTranslation('inbox');
  const { isAdmin } = useAuth();
  const wa = useWaStatus();
  const state = wa.data?.state;
  if (!state || state === 'open') return null;
  const c = copy[state];
  return (
    <div className="border-b bg-surface px-3 py-2">
      <Banner
        tone={c.tone}
        title={t(c.titleKey)}
        action={
          isAdmin ? (
            <Button asChild variant="outline" size="touch" className="sm:h-8 sm:min-h-8">
              <Link to="/admin/whatsapp" aria-label={t('waBanner.openSettings')}>
                <span className="sm:hidden">{t('waBanner.settingsShort')}</span>
                <span className="hidden sm:inline">{t('waBanner.openSettings')}</span>
              </Link>
            </Button>
          ) : undefined
        }
      >
        {t(c.bodyKey)}
      </Banner>
    </div>
  );
}

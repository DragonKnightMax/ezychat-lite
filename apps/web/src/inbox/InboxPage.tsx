import { ExtensionBannerSlot } from '@/access/BannerSlot';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAppVersion } from '../lib/version';
import { useInboxes, type ChatFilters as Filters } from '../api/queries';
import { UserMenu } from '../auth/UserMenu';
import { AskEzyButton } from '../askezy/AskEzyButton';
import { EmptyState } from '@/components/app';
import { cn } from '@/lib/utils';
import { decodeJid } from '../lib/jid';
import { ChatFilters } from './ChatFilters';
import { ChatList } from './ChatList';
import { Conversation } from './Conversation';
import { GettingStartedCard } from './GettingStartedCard';
import { useDirectory } from './useDirectory';
import { ReconnectBanner } from './ReconnectBanner';
import { WaBanner } from './WaBanner';
import { useVisibleInboxes } from './useVisibleInboxes';
import { NewChatButton } from './NewChatDialog';
import { useCanonicalChatRedirect } from './useCanonicalChatRedirect';
import { NavigationGuardProvider } from './navigation-guard';

const FILTERS_KEY = 'wati.inbox.filters';
const DEFAULT_FILTERS: Filters = { assigned: 'any', status: 'open' };

function loadFilters(): Filters {
  try {
    const raw = sessionStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const v = JSON.parse(raw) as Partial<Filters>;
    const assigned = v.assigned === 'me' || v.assigned === 'none' ? v.assigned : 'any';
    const status = v.status === 'resolved' ? 'resolved' : 'open';
    const tag =
      typeof v.tag === 'string' && v.tag.trim() && v.tag.length <= 30 ? v.tag.trim() : undefined;
    const inbox =
      typeof v.inbox === 'number' && Number.isInteger(v.inbox) && v.inbox > 0 ? v.inbox : undefined;
    return { assigned, status, q: typeof v.q === 'string' && v.q ? v.q : undefined, tag, inbox };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function InboxPage() {
  const { t } = useTranslation(['inbox', 'common']);
  const params = useParams<{ jid?: string }>();
  const jid = params.jid ? decodeJid(params.jid) : null;
  const navigate = useNavigate();
  const location = useLocation();
  const directory = useDirectory();
  const version = useAppVersion();
  useCanonicalChatRedirect(jid);

  // Mobile back: when the conversation was opened from the list, pop history so the hardware /
  // swipe back gesture doesn't bounce into the chat again; deep links replace instead.
  const fromList = (location.state as { fromList?: boolean } | null)?.fromList === true;
  const onBack = useCallback(() => {
    if (fromList) navigate(-1);
    else navigate('/', { replace: true });
  }, [fromList, navigate]);
  const [filters, setFilters] = useState<Filters>(loadFilters);

  useEffect(() => {
    try {
      sessionStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    } catch {
      /* storage unavailable */
    }
  }, [filters]);
  // A remembered inbox the user can no longer pick (access removed, inbox removed) lists every inbox.
  const inboxesLoaded = useInboxes().data != null;
  const visibleInboxes = useVisibleInboxes();
  const listFilters = useMemo(() => {
    if (filters.inbox == null || !inboxesLoaded) return filters;
    return visibleInboxes.length > 1 && visibleInboxes.some((i) => i.id === filters.inbox)
      ? filters
      : { ...filters, inbox: undefined };
  }, [filters, inboxesLoaded, visibleInboxes]);

  return (
    <NavigationGuardProvider>
      <div className="safe-x flex h-dvh flex-col overflow-hidden bg-background">
        <div className="safe-top bg-surface" />
        <ExtensionBannerSlot />
        <WaBanner />
        <ReconnectBanner />
        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              'min-h-0 w-full flex-col bg-surface md:w-[360px] md:shrink-0 md:border-r',
              jid ? 'hidden md:flex' : 'flex',
            )}
            aria-label={t('page.chats')}
          >
            <header className="flex items-center gap-1 px-3 py-1">
              <h1 className="flex-1 py-2 text-xl font-semibold tracking-tight text-foreground">
                {t('page.title')}
              </h1>
              {/* New chat (docs/features/new-chat/design.md): admins, and team members when allowed. */}
              <NewChatButton />
              <AskEzyButton />
              {directory.isAdmin && (
                <Button asChild variant="ghost" size="touch">
                  <Link to="/admin" aria-label={t('page.admin')}>
                    <Settings aria-hidden="true" />
                    {/* Icon only on phones, to leave room for Ask Ezy. */}
                    <span className="max-sm:hidden">{t('page.admin')}</span>
                  </Link>
                </Button>
              )}
              <UserMenu />
            </header>
            <ChatFilters value={filters} onChange={setFilters} inboxes={visibleInboxes} />
            <ChatList
              filters={listFilters}
              activeJid={jid}
              directory={directory}
              onResetFilters={() => setFilters(DEFAULT_FILTERS)}
            />
            {version && (
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                {t('page.version', { appName: t('common:appName'), version })}
              </p>
            )}
            <div className="safe-bottom" />
          </aside>
          <main
            className={cn(
              'min-h-0 min-w-0 flex-1 flex-col bg-background',
              jid ? 'flex' : 'hidden md:flex',
            )}
          >
            {jid ? (
              <Conversation key={jid} jid={jid} directory={directory} onBack={onBack} />
            ) : (
              <EmptyState
                className="flex-1"
                illustration="/illustrations/empty-inbox.png"
                title={t('page.selectTitle')}
                description={t('page.selectDescription')}
                action={<GettingStartedCard className="mt-2" />}
              />
            )}
          </main>
        </div>
      </div>
    </NavigationGuardProvider>
  );
}

export default InboxPage;

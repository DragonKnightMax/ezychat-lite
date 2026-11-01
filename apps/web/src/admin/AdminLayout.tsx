import { ExtensionBannerSlot } from '@/access/BannerSlot';
import { useEffect, useState } from 'react';
import {
  BarChart3,
  ChevronLeft,
  Inbox,
  Loader2,
  LogOut,
  Menu,
  MessageSquareText,
  Plug,
  Puzzle,
  ScrollText,
  Settings,
  ShieldAlert,
  Smartphone,
  Globe,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
  useParams,
} from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client';
import { useAiAgents } from '../api/ai';
import { useInboxes } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { PushToggle } from '../pwa/PushToggle';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { AskEzyButton } from '../askezy/AskEzyButton';
import { useAppVersion } from '@/lib/version';
import { reportClientError } from '@/lib/error-reporter';
import { AppCredits } from '@/components/app';
import { ErrorBoundary } from '@/components/app/ErrorBoundary';
import {
  extensionPath,
  extensionRoutes,
  useExtensionTranslation,
  useWebExtensions,
  type WebExtension,
  type WebExtensionAdminSection,
  type WebExtensionNavItem,
} from '../extensions';
import { AiMemberPage } from './AiMemberPage';
import { AuditPage } from './AuditPage';
import { ConnectorDetailPage } from './connectors/ConnectorDetailPage';
import { ConnectorsGalleryPage } from './connectors/ConnectorsGalleryPage';
import { ReportsPage } from './ReportsPage';
import { SafetyPage } from './SafetyPage';
import { ListSkeleton } from './adminUi';
import { InboxesPage } from './InboxesPage';
import { MembersPage } from './MembersPage';
import { QuickRepliesPage } from './QuickRepliesPage';
import { SettingsPage } from './SettingsPage';
import { TunnelPage } from './TunnelPage';
import { WhatsAppPage } from './WhatsAppPage';
import { LiteImportPage } from '../lite-import/LiteImportPage';

/**
 * Every core admin section. `labelKey` is a translation key in the `admin` namespace. WhatsApp and
 * Inboxes never show together: see `visibleAdminNav`.
 */
export const ADMIN_NAV = [
  // First: the page an owner opens most (design: docs/features/reports/design.md).
  { to: 'reports', labelKey: 'nav.reports', icon: BarChart3 },
  // WhatsApp Safety: next to Reports, the page an owner opens after an alert.
  { to: 'safety', labelKey: 'nav.safety', icon: ShieldAlert },
  { to: 'members', labelKey: 'nav.members', icon: Users },
  { to: 'quick-replies', labelKey: 'nav.quickReplies', icon: MessageSquareText },
  { to: 'connectors', labelKey: 'nav.connectors', icon: Plug },
  { to: 'whatsapp', labelKey: 'nav.whatsapp', icon: Smartphone },
  { to: 'inboxes', labelKey: 'inboxes.title', icon: Inbox },
  { to: 'tunnel', labelKey: 'nav.tunnel', icon: Globe },
  { to: 'settings', labelKey: 'nav.settings', icon: Settings },
  { to: 'audit', labelKey: 'nav.audit', icon: ScrollText },
] as const satisfies readonly { to: string; labelKey: string; icon: LucideIcon }[];

export type AdminNavItem = (typeof ADMIN_NAV)[number];

/**
 * The sections in the nav: **Inboxes** replaces **WhatsApp** only in an edition that allows more than
 * one WhatsApp number (Lite allows one, so it keeps WhatsApp).
 */
export function visibleAdminNav(multiInbox: boolean): AdminNavItem[] {
  return ADMIN_NAV.filter((n) => n.to !== (multiInbox ? 'whatsapp' : 'inboxes'));
}

/** True when the edition allows several WhatsApp numbers; false (Lite) until the server says so. */
function useMultiInbox(): { multiInbox: boolean; isPending: boolean } {
  const inboxes = useInboxes();
  return { multiInbox: (inboxes.data?.maxInboxes ?? 1) > 1, isPending: inboxes.isPending };
}

/** `/admin/whatsapp`: the WhatsApp page, or Inboxes when the edition has several numbers. */
function WhatsAppRoute() {
  const { multiInbox } = useMultiInbox();
  return multiInbox ? <Navigate to="/admin/inboxes" replace /> : <WhatsAppPage />;
}

/** `/admin/inboxes`: only with several numbers; Lite goes back to its WhatsApp page. */
function InboxesRoute() {
  const { multiInbox, isPending } = useMultiInbox();
  if (isPending) return <ListSkeleton rows={2} />;
  return multiInbox ? <InboxesPage /> : <Navigate to="/admin/whatsapp" replace />;
}

/**
 * `/admin/members/ai`: Lite opens its one agent (or a new one); an edition with several agents lists
 * them on Members.
 */
function AiAgentIndexRoute() {
  const agents = useAiAgents();
  if (agents.isPending) return <ListSkeleton rows={2} />;
  const data = agents.data;
  if (!data || data.maxAgents > 1) return <Navigate to="/admin/members" replace />;
  const first = data.agents[0];
  return (
    <Navigate to={first ? `/admin/members/ai/${first.id}` : '/admin/members/ai/new'} replace />
  );
}

/** `/admin/members/ai/:agentId`: a positive id only; anything else goes back to Members. */
function AiAgentRoute() {
  const { agentId = '' } = useParams();
  return /^[1-9]\d{0,9}$/.test(agentId) ? (
    <AiMemberPage />
  ) : (
    <Navigate to="/admin/members" replace />
  );
}

interface ExtensionNavLink {
  key: string;
  href: string;
  /** Translation key in the `common` namespace (extension catalogs live there). */
  labelKey: string;
  icon: NonNullable<WebExtensionNavItem['icon']>;
  useBadge?: WebExtensionNavItem['useBadge'];
}

/** Admin nav links contributed by extensions, always absolute `/admin/ext/<name>/...` paths. */
function extensionNavLinks(extensions: readonly WebExtension[]): ExtensionNavLink[] {
  return extensions.flatMap((ext) =>
    (ext.adminNav ?? []).map((item) => ({
      key: `${ext.name}:${item.path}`,
      href: extensionPath(ext.name, item.path, true),
      labelKey: item.labelKey,
      icon: item.icon ?? Puzzle,
      useBadge: item.useBadge,
    })),
  );
}

/** The core section an extension admin route declares for this path (e.g. `members`). */
export function extensionSectionOf(
  extensions: readonly WebExtension[],
  pathname: string,
): WebExtensionAdminSection | undefined {
  for (const ext of extensions)
    for (const route of ext.routes ?? [])
      if (
        route.admin &&
        route.section &&
        matchPath({ path: extensionPath(ext.name, route.path, true), end: true }, pathname)
      )
        return route.section;
  return undefined;
}

function NavBadgeContent({ useBadge }: { useBadge: NonNullable<ExtensionNavLink['useBadge']> }) {
  const tExt = useExtensionTranslation();
  const badge = useBadge();
  if (!badge) return null;
  const count = typeof badge.count === 'number' && badge.count > 0 ? badge.count : 0;
  if (!count && !badge.attention) return null;
  const label = badge.labelKey ? tExt(badge.labelKey, badge.labelValues) : undefined;
  return (
    <span className="ml-auto flex shrink-0 items-center" data-testid="nav-badge">
      {count ? (
        <span
          aria-hidden={label ? true : undefined}
          data-tone={badge.attention ? 'attention' : 'count'}
          className={cn(
            'min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-semibold',
            // Something to fix uses the warning tone (like the extensions' problem badges);
            // a plain count keeps the brand colour.
            badge.attention
              ? 'border border-warning/40 bg-warning/15 text-foreground'
              : 'bg-primary text-primary-foreground',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : (
        <span aria-hidden className="size-2 rounded-full bg-destructive" />
      )}
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

/** An extension's nav badge; a crash in its hook hides the badge, never the nav. */
function NavBadge({ useBadge }: { useBadge?: ExtensionNavLink['useBadge'] }) {
  if (!useBadge) return null;
  return (
    <ErrorBoundary fallback={null}>
      <NavBadgeContent useBadge={useBadge} />
    </ErrorBoundary>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors md:min-h-9',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
    isActive
      ? 'bg-primary/10 text-primary'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  );

function UnknownAdminRoute() {
  const { pathname } = useLocation();
  useEffect(() => {
    reportClientError({ kind: 'error', message: 'Unmatched admin route', route: pathname });
  }, [pathname]);
  return <Navigate to="/admin/members" replace />;
}

function AdminNav({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
  const { t } = useTranslation('admin');
  const tExt = useExtensionTranslation();
  const extensions = useWebExtensions();
  const extensionLinks = extensionNavLinks(extensions);
  const { multiInbox } = useMultiInbox();
  // An extension page under a core section (e.g. an agent's sub-page) keeps that item active.
  const section = extensionSectionOf(extensions, useLocation().pathname);
  return (
    <nav aria-label={t('nav.label')} className={className}>
      <ul className="flex flex-col gap-1">
        {visibleAdminNav(multiInbox).map((n) => (
          <li key={n.to}>
            <NavLink
              to={`/admin/${n.to}`}
              onClick={onNavigate}
              className={({ isActive }) => navLinkClass({ isActive: isActive || section === n.to })}
            >
              <n.icon className="size-4 shrink-0" aria-hidden />
              {t(n.labelKey)}
            </NavLink>
          </li>
        ))}
        {extensionLinks.map((n) => (
          <li key={n.key}>
            <NavLink to={n.href} onClick={onNavigate} className={navLinkClass}>
              <n.icon className="size-4 shrink-0" aria-hidden />
              {tExt(n.labelKey)}
              <NavBadge useBadge={n.useBadge} />
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function AdminFooter({ version, onNavigate }: { version?: string; onNavigate?: () => void }) {
  const { logout } = useAuth();
  const { t } = useTranslation('admin');
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      onNavigate?.();
    } catch (error) {
      toast.error(t('layout.logOutFailed', { error: errorMessage(error) }));
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <footer
      aria-label={t('layout.footer')}
      className="safe-bottom flex shrink-0 flex-col gap-1 border-t p-3"
    >
      <PushToggle compact className="px-2" />
      <Button
        variant="ghost"
        size="touch"
        className="justify-start px-2 text-muted-foreground"
        disabled={loggingOut}
        aria-busy={loggingOut}
        onClick={() => void handleLogout()}
      >
        {loggingOut ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut aria-hidden />}
        {loggingOut ? t('layout.loggingOut') : t('layout.logOut')}
      </Button>
      <Separator className="my-1" />
      <AppCredits version={version} variant="sidebar" />
    </footer>
  );
}

function AdminMenu({ version, onNavigate }: { version?: string; onNavigate?: () => void }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* The way out comes first, right under "Admin", not buried below the footer tools. */}
      <div className="border-b p-2">
        <Button
          asChild
          variant="ghost"
          size="touch"
          className="w-full justify-start px-3 text-primary"
        >
          <Link to="/" onClick={onNavigate}>
            <ChevronLeft aria-hidden />
            {t('layout.backToInbox')}
          </Link>
        </Button>
      </div>
      <AdminNav className="flex-1 p-2" onNavigate={onNavigate} />
      <AdminFooter version={version} onNavigate={onNavigate} />
    </div>
  );
}

/**
 * Admin shell. Side nav on >= md; on phones a top bar with a Sheet menu.
 * Mounted by App.tsx at `/admin/*`; non-admins are redirected to `/`.
 */
export function AdminLayout() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const version = useAppVersion();
  const { t } = useTranslation(['admin', 'common']);
  const extensions = useWebExtensions();
  const tExt = useExtensionTranslation();
  const { multiInbox } = useMultiInbox();

  if (isLoading)
    return (
      <div
        role="status"
        className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground"
      >
        <Loader2 className="size-6 animate-spin" aria-hidden />
        <span className="sr-only">{t('layout.loading')}</span>
      </div>
    );
  if (!user || user.role !== 'admin') return <Navigate to="/" replace />;

  const section = extensionSectionOf(extensions, location.pathname);
  const coreCurrent = visibleAdminNav(multiInbox).find(
    (n) => location.pathname.includes(`/admin/${n.to}`) || section === n.to,
  );
  const extensionCurrent = coreCurrent
    ? undefined
    : extensionNavLinks(extensions).find(
        (n) => location.pathname === n.href || location.pathname.startsWith(`${n.href}/`),
      );
  const currentLabel = coreCurrent
    ? t(coreCurrent.labelKey)
    : extensionCurrent
      ? tExt(extensionCurrent.labelKey)
      : undefined;

  return (
    <div className="safe-x flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
      {/* Phone: top bar with section menu */}
      <header className="safe-top sticky top-0 z-20 border-b bg-card md:hidden">
        <div className="flex items-center gap-1 px-1">
          <Button asChild variant="ghost" size="touch" className="px-2 text-primary">
            <Link to="/">
              <ChevronLeft aria-hidden />
              {t('layout.inbox')}
            </Link>
          </Button>
          <p className="min-w-0 flex-1 truncate text-center text-base font-semibold">
            {currentLabel ? t('titleWithSection', { section: currentLabel }) : t('title')}
          </p>
          <AskEzyButton compact />
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-touch" aria-label={t('layout.menu')}>
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0">
              <SheetHeader className="border-b">
                <SheetTitle>{t('title')}</SheetTitle>
                <SheetDescription>{t('common:appName')}</SheetDescription>
              </SheetHeader>
              <AdminMenu version={version ?? undefined} onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
      </header>

      {/* Desktop: side nav */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div className="sticky top-0 flex h-dvh flex-col">
          <div className="border-b px-4 py-4">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('common:appName')}
            </p>
            <p className="text-lg font-semibold">{t('title')}</p>
            {/* An action, not a page: apart from the page list. */}
            <AskEzyButton variant="outline" className="mt-3 w-full" />
          </div>
          <AdminMenu version={version ?? undefined} />
        </div>
      </aside>

      <main className="safe-bottom min-w-0 flex-1">
        <ExtensionBannerSlot />
        <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:py-6">
          <Routes>
            <Route index element={<Navigate to="/admin/members" replace />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="safety" element={<SafetyPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="members/ai" element={<AiAgentIndexRoute />} />
            <Route path="members/ai/new" element={<AiMemberPage />} />
            <Route path="members/ai/:agentId" element={<AiAgentRoute />} />
            <Route path="quick-replies" element={<QuickRepliesPage />} />
            <Route path="connectors" element={<ConnectorsGalleryPage />} />
            <Route path="connectors/:id" element={<ConnectorDetailPage />} />
            <Route path="whatsapp" element={<WhatsAppRoute />} />
            <Route path="inboxes" element={<InboxesRoute />} />
            <Route
              path="inboxes/lite"
              element={
                <ErrorBoundary>
                  <LiteImportPage />
                </ErrorBoundary>
              }
            />
            <Route path="tunnel" element={<TunnelPage />} />
            <Route path="settings/*" element={<SettingsPage />} />
            <Route path="audit" element={<AuditPage />} />
            {extensionRoutes(extensions, true)}
            <Route path="*" element={<UnknownAdminRoute />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default AdminLayout;

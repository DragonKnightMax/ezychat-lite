import { useEffect, useState } from 'react';
import {
  BarChart3,
  ChevronLeft,
  Loader2,
  LogOut,
  Menu,
  MessageSquareText,
  ScrollText,
  Settings,
  Globe,
  Inbox,
  Smartphone,
  Plug,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client';
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
import { useAppVersion } from '@/lib/version';
import { reportClientError } from '@/lib/error-reporter';
import { AppCredits } from '@/components/app';
// Proposed (custom-agents): one page per AI agent replaces the single AI Sales Agent page.
import { AgentPage, AgentRedirect } from './AgentPage';
import { useMockEdition } from '../mock/edition';
import { AuditPage } from './AuditPage';
import { MembersPage } from './MembersPage';
import { QuickRepliesPage } from './QuickRepliesPage';
import { SettingsPage } from './SettingsPage';
import { TunnelPage } from './TunnelPage';
import { WhatsAppPage } from './WhatsAppPage';
import { InboxesPage } from './InboxesPage';
import { ConnectorsGalleryPage } from './ConnectorsGalleryPage';
import { ConnectorDetailPage } from './ConnectorDetailPage';
// Baseline addition (reports, confirmed): Admin → Reports (busy days, busy times, reply times).
import { ReportsPage } from './ReportsPage';

/** `labelKey` is a translation key in the `admin` namespace. */
export const ADMIN_NAV = [
  // Baseline addition (reports): first, the page an owner opens most.
  { to: 'reports', labelKey: 'mockReports.nav', icon: BarChart3 },
  { to: 'members', labelKey: 'nav.members', icon: Users },
  { to: 'quick-replies', labelKey: 'nav.quickReplies', icon: MessageSquareText },
  // Proposed (google-calendar): a gallery of ready connectors, one page each.
  { to: 'connectors', labelKey: 'mockConnectors.title', icon: Plug },
  // Proposed (multi-inbox): one inbox per WhatsApp number replaces the single WhatsApp page.
  { to: 'inboxes', labelKey: 'mockInbox.title', icon: Inbox },
  { to: 'tunnel', labelKey: 'nav.tunnel', icon: Globe },
  { to: 'settings', labelKey: 'nav.settings', icon: Settings },
  { to: 'audit', labelKey: 'nav.audit', icon: ScrollText },
] as const satisfies readonly { to: string; labelKey: string; icon: LucideIcon }[];

/** Proposed (custom-agents): the mock Lite view keeps Lite's single WhatsApp page instead of Inboxes. */
const LITE_NAV = ADMIN_NAV.map((n) =>
  n.to === 'inboxes'
    ? ({ to: 'whatsapp', labelKey: 'nav.whatsapp', icon: Smartphone } as const)
    : n,
);
function useAdminNav() {
  return useMockEdition() === 'lite' ? LITE_NAV : ADMIN_NAV;
}

function UnknownAdminRoute() {
  const { pathname } = useLocation();
  useEffect(() => {
    reportClientError({ kind: 'error', message: 'Unmatched admin route', route: pathname });
  }, [pathname]);
  return <Navigate to="/admin/members" replace />;
}

function AdminNav({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
  const { t } = useTranslation('admin');
  const nav = useAdminNav();
  return (
    <nav aria-label={t('nav.label')} className={className}>
      <ul className="flex flex-col gap-1">
        {nav.map((n) => (
          <li key={n.to}>
            <NavLink
              to={`/admin/${n.to}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors md:min-h-9',
                  'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              <n.icon className="size-4 shrink-0" aria-hidden />
              {t(n.labelKey)}
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
  const nav = useAdminNav();

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

  const current = nav.find((n) => location.pathname.includes(`/admin/${n.to}`));

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
            {current ? t('titleWithSection', { section: t(current.labelKey) }) : t('title')}
          </p>
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
          </div>
          <AdminMenu version={version ?? undefined} />
        </div>
      </aside>

      <main className="safe-bottom min-w-0 flex-1">
        <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:py-6">
          <Routes>
            <Route index element={<Navigate to="/admin/members" replace />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="members/ai" element={<AgentRedirect />} />
            <Route path="members/ai/:agentId" element={<AgentPage />} />
            <Route path="quick-replies" element={<QuickRepliesPage />} />
            <Route path="whatsapp" element={<WhatsAppPage />} />
            <Route path="inboxes" element={<InboxesPage />} />
            <Route path="tunnel" element={<TunnelPage />} />
            <Route path="settings/*" element={<SettingsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="connectors" element={<ConnectorsGalleryPage />} />
            <Route path="connectors/:id" element={<ConnectorDetailPage />} />
            <Route path="*" element={<UnknownAdminRoute />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default AdminLayout;

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  CalendarCheck,
  CalendarSearch,
  ChevronRight,
  MessageSquare,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Banner, EmptyState } from '@/components/app';
import { UpgradeButton } from '@/components/app/UpgradeEnterprise';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';
import { encodeJid } from '@/lib/jid';
import { connectorStatus, CONNECTORS, type CatalogConnector } from '@/mock/connectorCatalog';
import { useConnectorList } from '@/mock/connectorList';
import { useMockEdition } from '@/mock/edition';
import {
  useCalendarBookings,
  useGoogleCalendar,
  type CalendarBooking,
} from '@/mock/googleCalendar';
import { useShownAgents } from '@/mock/useAgents';
import { ListSkeleton } from './adminUi';
import { AgentBookingsCard } from './AgentBookingsCard';
import {
  ConnectorIcon,
  ConnectorStatusBadge,
  GoogleCalendarLink,
  VoteButton,
} from './ConnectorsGalleryPage';
import { GoogleCalendarSection } from './GoogleCalendarSection';
import { ComingSoonEntryPage, PartnerConnectorPage } from './PartnerConnectorPage';

/** As `formatTimeRange` in the app's lib/format.ts (PR #192): "Fri, 30 Oct, 7:30–9:00 pm". */
function formatTimeRange(startIso: string, endIso: string, language: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat(language, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(start);
  const time = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time.format(start)}–${time.format(end)}`;
}

// Baseline addition (PR #192): the Bookings tab.
const TABS = ['overview', 'settings', 'activity', 'bookings'] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/connectors/:id`, one page per connector. Google Calendar (built in) has Overview, Settings
 * (per AI agent), Activity and Bookings; the custom connector is an app feature. Proposed
 * (connector-list): every other page is built from the connector's entry in the connector list
 * (partner MCP connectors, coming soon), or from the copy kept with a connection that is no longer
 * listed.
 */
export function ConnectorDetailPage() {
  const { t } = useTranslation('admin');
  const { id } = useParams();
  const list = useConnectorList();
  const app = CONNECTORS.find(
    (x) => x.id === id && (x.id === 'google-calendar' || x.id === 'custom-mcp'),
  );
  if (app) return <AppConnectorPage c={app} />;
  if (list.isPending) return <ListSkeleton rows={4} />;
  const entry = list.data?.list.entries.find((e) => e.id === id && e.schemaVersion === 1);
  const kept = list.data?.connections[id ?? ''];
  if (entry?.kind === 'coming_soon') return <ComingSoonEntryPage entry={entry} />;
  if (entry?.kind === 'mcp' || kept?.state === 'connected')
    return (
      <PartnerConnectorPage
        entry={entry?.kind === 'mcp' ? entry : kept!.entry}
        listed={entry?.kind === 'mcp'}
      />
    );
  return (
    <EmptyState
      illustration="/illustrations/no-results.png"
      title={t('mockConnectors.notFound')}
      action={
        <Button asChild size="touch">
          <Link to="/admin/connectors">{t('mockConnectors.backToGallery')}</Link>
        </Button>
      }
    />
  );
}

/** Breadcrumb back to the gallery, shared by every connector page. */
export function ConnectorBreadcrumb({ name }: { name: string }) {
  const { t } = useTranslation('admin');
  return (
    <nav aria-label={t('mockConnectors.breadcrumb')} className="flex items-center gap-1 text-sm">
      <Link
        to="/admin/connectors"
        className="text-muted-foreground underline-offset-4 hover:underline"
      >
        {t('mockConnectors.title')}
      </Link>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </nav>
  );
}

/** Google Calendar (built in) and the custom connector: the app's own pages. */
function AppConnectorPage({ c }: { c: CatalogConnector }) {
  const { t } = useTranslation('admin');
  // Mock: catalog keys built from the connector id (the app types them per connector).
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const [params, setParams] = useSearchParams();
  const edition = useMockEdition();
  const google = useGoogleCalendar();
  const status = connectorStatus(c, edition, google.data?.state);
  const full = c.id === 'google-calendar';
  const tabParam = params.get('tab');
  const tab: Tab = full && TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'overview';
  const setTab = (next: string) =>
    setParams(
      (p) => {
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );

  return (
    <div className="flex flex-col gap-4" data-testid={`connector-page-${c.id}`}>
      <ConnectorBreadcrumb name={tc(`mockConnectors.items.${c.id}.name`)} />
      <div className="flex items-start gap-4">
        <ConnectorIcon c={c} size="lg" muted={status === 'enterprise'} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words">
              {tc(`mockConnectors.items.${c.id}.name`)}
            </h1>
            <ConnectorStatusBadge status={status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {t(c.edition === 'core' ? 'mockConnectors.byCore' : 'mockConnectors.byEnterprise')} ·{' '}
            {tc(`mockConnectors.category.${c.category}`)}
          </p>
        </div>
      </div>

      {full ? (
        <Tabs value={tab} onValueChange={setTab}>
          <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
            <TabsList variant="line" className="w-max justify-start">
              {TABS.map((id) => (
                <TabsTrigger key={id} value={id} className="min-h-11 flex-none px-3 md:min-h-9">
                  {tc(`mockConnectors.tabs.${id}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="overview" className="flex flex-col gap-4">
            <About c={c} />
            <GoogleCalendarSection onOpenSettings={() => setTab('settings')} />
            <Privacy c={c} />
          </TabsContent>
          <TabsContent value="settings" className="flex flex-col gap-4">
            <AgentSettings />
          </TabsContent>
          <TabsContent value="activity" className="flex flex-col gap-4">
            <Activity />
          </TabsContent>
          <TabsContent value="bookings" className="flex flex-col gap-4">
            <Bookings />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="flex flex-col gap-4">
          {status === 'enterprise' && (
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{t('mockConnectors.enterpriseOnly')}</p>
              <UpgradeButton className="shrink-0 self-start sm:self-auto" />
            </div>
          )}
          {!c.available && (
            <Banner tone="info" title={t('mockConnectors.comingSoonTitle')}>
              <span className="flex flex-col items-start gap-2">
                {t('mockConnectors.comingSoonBody')}
                <VoteButton name={tc(`mockConnectors.items.${c.id}.name`)} />
              </span>
            </Banner>
          )}
          <About c={c} />
          {c.id === 'custom-mcp' && status !== 'enterprise' && (
            <Card className="gap-3">
              <CardHeader>
                <CardTitle>{t('mockConnectors.custom.setUpTitle')}</CardTitle>
                <CardDescription>{t('mockConnectors.custom.setUpBody')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  size="touch"
                  onClick={() => toast.info(t('mockConnectors.custom.mockToast'))}
                >
                  {t('mockConnectors.custom.add')}
                </Button>
              </CardContent>
            </Card>
          )}
          {c.tools.length > 0 && <Privacy c={c} />}
          <Button asChild variant="outline" size="touch" className="self-start">
            <Link to="/admin/connectors">{t('mockConnectors.backToGallery')}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/** What the connector does and what the AI may do with it (look-ups and actions). */
function About({ c }: { c: CatalogConnector }) {
  const { t } = useTranslation('admin');
  // Mock: catalog keys built from the connector id (the app types them per connector).
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('mockConnectors.aboutTitle')}</CardTitle>
        <CardDescription>{tc(`mockConnectors.items.${c.id}.long`)}</CardDescription>
      </CardHeader>
      {c.tools.length > 0 && (
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('mockConnectors.aiCan')}</p>
          <ul className="flex flex-col divide-y rounded-lg border">
            {c.tools.map((tool) => (
              <li key={tool.key} className="flex flex-col gap-1 px-3 py-3">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {tc(`mockConnectors.items.${c.id}.tools.${tool.key}`)}
                  </span>
                  <Badge variant="secondary">
                    {t(tool.access === 'read' ? 'mockConnectors.lookUp' : 'mockConnectors.changes')}
                  </Badge>
                </span>
                <span className="text-sm text-muted-foreground">
                  {tc(`mockConnectors.items.${c.id}.tools.${tool.key}Hint`)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{t('mockConnectors.switchNote')}</p>
        </CardContent>
      )}
    </Card>
  );
}

function Privacy({ c }: { c: CatalogConnector }) {
  const { t } = useTranslation('admin');
  // Mock: catalog keys built from the connector id (the app types them per connector).
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockConnectors.privacyTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {tc(`mockConnectors.items.${c.id}.privacy`)}
        </p>
      </CardContent>
    </Card>
  );
}

/** Settings tab: one AI agent at a time (Lite has one; Enterprise picks). */
export function AgentSettings({
  render,
}: {
  render?: (agent: { id: string; name: string }) => React.ReactNode;
}) {
  const { t } = useTranslation('admin');
  const { shown } = useShownAgents();
  const [picked, setPicked] = useState<string>();
  const agent = shown.find((a) => a.id === picked) ?? shown[0];
  if (!agent)
    return (
      <EmptyState
        title={t('mockConnectors.noAgent')}
        action={
          <Button asChild size="touch">
            <Link to="/admin/members/ai/new">{t('mockConnectors.addAgent')}</Link>
          </Button>
        }
      />
    );
  return (
    <>
      {shown.length > 1 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="connector-agent">{t('mockConnectors.forAgent')}</Label>
          <Select value={agent.id} onValueChange={setPicked}>
            <SelectTrigger
              id="connector-agent"
              className="min-h-11 w-full sm:w-80 *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {shown.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {render ? (
        render(agent)
      ) : (
        <AgentBookingsCard key={agent.id} agentId={agent.id} name={agent.name} />
      )}
    </>
  );
}

/** Activity tab: what the AI checked and booked (who and when, never the chat text). */
function Activity() {
  const { t, i18n } = useTranslation('admin');
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const google = useGoogleCalendar();
  const rows = google.data?.activity ?? [];
  if (rows.length === 0) return <EmptyState title={t('mockConnectors.activityEmpty')} />;
  const when = (start: string, end: string) => {
    const day = new Intl.DateTimeFormat(i18n.language, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(start));
    const time = (iso: string) =>
      new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }).format(
        new Date(iso),
      );
    return `${day}, ${time(start)}–${time(end)}`;
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockConnectors.activityTitle')}</CardTitle>
        <CardDescription>{t('mockConnectors.activityHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {rows.map((r) => {
            const Icon =
              r.kind === 'booked'
                ? CalendarCheck
                : r.kind === 'checked'
                  ? CalendarSearch
                  : UserRound;
            return (
              <li key={`${r.at}-${r.kind}`} className="flex items-start gap-3 py-3 first:pt-0">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">
                    {r.kind === 'booked' && r.start && r.end
                      ? t('mockConnectors.act.booked', {
                          agent: r.agent,
                          customer: r.customer,
                          when: when(r.start, r.end),
                        })
                      : tc(`mockConnectors.act.${r.kind}`, {
                          agent: r.agent,
                          customer: r.customer,
                        })}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatRelative(r.at)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Baseline addition (PR #192 Bookings tab): the events the AI added (EzyChat's own records, no
 * Google call), upcoming first, with links to the chat and to the event in Google Calendar.
 */
function Bookings() {
  const { t, i18n } = useTranslation('admin');
  const query = useCalendarBookings();
  if (query.isPending) return <ListSkeleton rows={3} />;
  if (!query.data) return null;
  const { upcoming, past, calendarUrl } = query.data;
  const open = calendarUrl && (
    <GoogleCalendarLink href={calendarUrl} label={t('mockConnectors.bookings.openCalendar')} />
  );
  if (upcoming.length === 0 && past.length === 0)
    return (
      <EmptyState
        title={t('mockConnectors.bookings.empty')}
        description={t('mockConnectors.bookings.emptyHint')}
        action={open || undefined}
      />
    );
  const list = (rows: CalendarBooking[], testId: string) => (
    <ul className="flex flex-col divide-y rounded-lg border" data-testid={testId}>
      {rows.map((b) => (
        <li key={b.id} className="flex flex-col gap-2 px-3 py-3">
          <span className="flex items-start gap-3">
            <CalendarCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium break-words">
                {formatTimeRange(b.start, b.end, i18n.language)}
              </span>
              <span className="text-sm break-words">
                {b.customer || t('mockConnectors.bookings.unknownCustomer')}
              </span>
              {b.agentName && (
                <span className="text-xs text-muted-foreground">
                  {t('mockConnectors.bookings.by', { agent: b.agentName })}
                </span>
              )}
            </span>
          </span>
          <span className="flex flex-wrap gap-2 pl-7">
            <Button asChild variant="outline" size="sm" className="min-h-9 pointer-coarse:min-h-11">
              <Link to={`/chats/${encodeJid(b.chatJid)}`}>
                <MessageSquare aria-hidden />
                {t('mockConnectors.bookings.openChat')}
              </Link>
            </Button>
            <GoogleCalendarLink href={b.eventUrl} label={t('mockConnectors.bookings.openEvent')} />
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <Card className="gap-4" data-testid="calendar-bookings">
      <CardHeader>
        <CardTitle>{t('mockConnectors.bookings.title')}</CardTitle>
        <CardDescription>{t('mockConnectors.bookings.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {open}
        <section className="flex flex-col gap-2" aria-labelledby="bookings-upcoming">
          <h3 id="bookings-upcoming" className="text-sm font-medium">
            {t('mockConnectors.bookings.upcoming')}
          </h3>
          {upcoming.length > 0 ? (
            list(upcoming, 'bookings-upcoming')
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('mockConnectors.bookings.noneUpcoming')}
            </p>
          )}
        </section>
        {past.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="bookings-past">
            <h3 id="bookings-past" className="text-sm font-medium">
              {t('mockConnectors.bookings.past')}
            </h3>
            {list(past, 'bookings-past')}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

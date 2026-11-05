import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CalendarCheck,
  CalendarSearch,
  FileText,
  ListPlus,
  MessageSquare,
  Save,
  ShieldAlert,
  TableProperties,
  TriangleAlert,
  UserPlus,
  UserRound,
} from 'lucide-react';
import type {
  CalendarActivity,
  CalendarBooking,
  ConnectorEntry,
  DriveActivity,
  GoogleCalendarState,
  GoogleDriveState,
  SheetsActivity,
  SqlAccountState,
} from '@ezychat/shared';
import {
  useCalendarActivity,
  useCalendarBookings,
  useDriveActivity,
  useGoogleCalendar,
  useGoogleDrive,
  useGoogleSheets,
  useSheetsActivity,
} from '../../api/connectors';
import { useSqlAccount } from '../../api/sql-account';
import { encodeJid } from '../../lib/jid';
import { EmptyState } from '@/components/app';
import { UpgradeButton } from '@/components/app/UpgradeEnterprise';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative, formatTimeRange } from '@/lib/format';
import { ErrorState, ListSkeleton } from '../adminUi';
import { AgentPicker } from './AgentPicker';
import { BookingSettingsCard } from './BookingSettingsCard';
import { DriveSettingsCard } from './DriveSettingsCard';
import { connectorStatus, findConnector, type CatalogConnector } from './catalog';
import {
  BetaBadge,
  ConnectorBreadcrumb,
  ConnectorIcon,
  ConnectorNotice,
  ConnectorStatusBadge,
  GoogleCalendarLink,
  useBuiltinEntry,
  useConnectorLinks,
} from './connector-ui';
import { GoogleCalendarAccountCard } from './GoogleCalendarAccountCard';
import { GoogleDriveAccountCard } from './GoogleDriveAccountCard';
import { GoogleSheetsAccountCard } from './GoogleSheetsAccountCard';
import { SheetsSettingsCard } from './SheetsSettingsCard';
import { SqlAccountTabs } from './SqlAccountPage';
import { ListConnectorPage } from './PartnerConnectorPage';

const TABS = ['overview', 'settings', 'activity', 'bookings'] as const;
type Tab = (typeof TABS)[number];
/** Google Sheets and Google Drive have no Bookings tab. */
const SHEETS_TABS = ['overview', 'settings', 'activity'] as const;

type ConnectorState = GoogleCalendarState | GoogleDriveState | SqlAccountState;

/** The built-in connectors' own pages (each with its tabs). */
const BUILTIN_TABS: Partial<
  Record<
    string,
    (props: Readonly<{ c: CatalogConnector; entry: ConnectorEntry | null }>) => React.ReactNode
  >
> = {
  'google-calendar': (props) => <GoogleCalendarTabs {...props} />,
  'google-sheets': (props) => <GoogleSheetsTabs {...props} />,
  'google-drive': (props) => <GoogleDriveTabs {...props} />,
  'sql-account': ({ entry }) => <SqlAccountTabs entry={entry} />,
};
const isTab = (value: string | null, tabs: readonly Tab[] = TABS): value is Tab =>
  (tabs as readonly string[]).includes(value ?? '');

/**
 * `/admin/connectors/:id`: one page per connector. The app's own connectors come first: Google
 * Calendar has Overview (what it does, the Google account, your data), Settings (per AI agent),
 * Activity and Bookings tabs (`?tab=`, `&agent=`); Google Sheets and Google Drive the same without Bookings;
 * SQL Account has Overview, Connection, Settings, Customers and Activity; the custom connector needs Enterprise. Every
 * other page is built from the connector's entry in the connector list. A connector an extension
 * provides opens the extension's page.
 */
export function ConnectorDetailPage() {
  const { id } = useParams();
  const c = findConnector(id);
  if (!c) return <ListConnectorPage id={id ?? ''} />;
  return <AppConnectorPage c={c} />;
}

function AppConnectorPage({ c }: { c: CatalogConnector }) {
  const { t } = useTranslation('admin');
  const links = useConnectorLinks();
  const google = useGoogleCalendar(c.id === 'google-calendar');
  const sheets = useGoogleSheets(c.id === 'google-sheets');
  const sql = useSqlAccount(c.id === 'sql-account');
  const drive = useGoogleDrive(c.id === 'google-drive');
  // The connector list may mark the app's own connector Beta and add a notice (e.g. Google review).
  const entry = useBuiltinEntry(c.id);
  const link = links[c.id];
  if (link) return <Navigate to={link} replace />;
  const states: Partial<Record<string, { state: ConnectorState } | undefined>> = {
    'google-sheets': sheets.data,
    'google-drive': drive.data,
    'sql-account': sql.data,
  };
  const status = connectorStatus(c, (states[c.id] ?? google.data)?.state, undefined);
  const name = t(`connectors.items.${c.id}.name`);

  return (
    <div className="flex flex-col gap-4" data-testid={`connector-page-${c.id}`}>
      <ConnectorBreadcrumb name={name} />
      <div className="flex items-start gap-4">
        <ConnectorIcon c={c} size="lg" muted={status === 'enterprise'} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words">{name}</h1>
            <ConnectorStatusBadge status={status} />
            <BetaBadge show={entry?.stage === 'beta'} />
          </div>
          <p className="text-sm text-muted-foreground">
            {t(c.edition === 'core' ? 'connectors.byCore' : 'connectors.byEnterprise')} ·{' '}
            {t(`connectors.category.${c.category}`)}
          </p>
        </div>
      </div>

      {BUILTIN_TABS[c.id]?.({ c, entry }) ?? (
        <div className="flex flex-col gap-4">
          {status === 'enterprise' && (
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{t('connectors.enterpriseOnly')}</p>
              <UpgradeButton className="shrink-0 self-start sm:self-auto" />
            </div>
          )}
          <About c={c} />
          <Privacy c={c} />
          <Button asChild variant="outline" size="touch" className="self-start">
            <Link to="/admin/connectors">{t('connectors.backToGallery')}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/** The tabs of a built-in connector, or null for any other connector page. */
function GoogleCalendarTabs({
  c,
  entry,
}: Readonly<{ c: CatalogConnector; entry: ConnectorEntry | null }>) {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useTabParam(TABS);
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
        <TabsList variant="line" className="w-max justify-start">
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="min-h-11 flex-none px-3 md:min-h-9">
              {t(`connectors.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="overview" className="flex flex-col gap-4">
        <About c={c} />
        <ConnectorNotice entry={entry} />
        <GoogleCalendarAccountCard onOpenSettings={() => setTab('settings')} />
        <Privacy c={c} />
      </TabsContent>
      <TabsContent value="settings" className="flex flex-col gap-4">
        <AgentSettings onConnect={() => setTab('overview')} />
      </TabsContent>
      <TabsContent value="activity" className="flex flex-col gap-4">
        <Activity />
      </TabsContent>
      <TabsContent value="bookings" className="flex flex-col gap-4">
        <Bookings />
      </TabsContent>
    </Tabs>
  );
}

function useTabParam(tabs: readonly Tab[]) {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam, tabs) ? tabParam : 'overview';
  const setTab = (next: string) =>
    setParams(
      (p) => {
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  return [tab, setTab] as const;
}

/**
 * A Google connector with its own sign-in (Sheets, Drive): Overview (what it does, the Google
 * account, your data), Settings (per AI agent) and Activity.
 */
function GoogleConnectorTabs({
  c,
  entry,
  AccountCard,
  privacy,
  Settings,
  activity,
}: Readonly<{
  c: CatalogConnector;
  entry: ConnectorEntry | null;
  AccountCard: React.ComponentType<{ onOpenSettings?: () => void }>;
  privacy: React.ReactNode;
  Settings: React.ComponentType<{ onConnect: () => void }>;
  activity: React.ReactNode;
}>) {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useTabParam(SHEETS_TABS);
  const [overview, settingsTab] = SHEETS_TABS;
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
        <TabsList variant="line" className="w-max justify-start">
          {SHEETS_TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="min-h-11 flex-none px-3 md:min-h-9">
              {t(`connectors.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="overview" className="flex flex-col gap-4">
        <About c={c} />
        <ConnectorNotice entry={entry} />
        <AccountCard onOpenSettings={() => setTab(settingsTab)} />
        {privacy}
      </TabsContent>
      <TabsContent value="settings" className="flex flex-col gap-4">
        <Settings onConnect={() => setTab(overview)} />
      </TabsContent>
      <TabsContent value="activity" className="flex flex-col gap-4">
        {activity}
      </TabsContent>
    </Tabs>
  );
}

/** Google Sheets: the shared Google connector tabs with its account card, settings and activity. */
function GoogleSheetsTabs({
  c,
  entry,
}: Readonly<{ c: CatalogConnector; entry: ConnectorEntry | null }>) {
  return (
    <GoogleConnectorTabs
      c={c}
      entry={entry}
      AccountCard={GoogleSheetsAccountCard}
      privacy={<Privacy c={c} />}
      Settings={SheetsAgentSettings}
      activity={<SheetsActivityList />}
    />
  );
}

/** Google Drive: the shared Google connector tabs; its privacy card has three lines. */
function GoogleDriveTabs({
  c,
  entry,
}: Readonly<{ c: CatalogConnector; entry: ConnectorEntry | null }>) {
  const { t } = useTranslation('admin');
  return (
    <GoogleConnectorTabs
      c={c}
      entry={entry}
      AccountCard={GoogleDriveAccountCard}
      privacy={
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>{t('connectors.privacyTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>{t('connectors.items.google-drive.privacy')}</p>
            <p>{t('connectors.items.google-drive.privacy2')}</p>
            <p>{t('connectors.items.google-drive.privacy3')}</p>
          </CardContent>
        </Card>
      }
      Settings={DriveAgentSettings}
      activity={<DriveActivityList />}
    />
  );
}

/** What the connector does and what the AI may do with it (look-ups and actions). */
function About({ c }: { c: CatalogConnector }) {
  const { t } = useTranslation('admin');
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('connectors.aboutTitle')}</CardTitle>
        <CardDescription>{t(`connectors.items.${c.id}.long`)}</CardDescription>
      </CardHeader>
      {c.tools.length > 0 && (
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('connectors.aiCan')}</p>
          <ul className="flex flex-col divide-y rounded-lg border">
            {c.tools.map((tool) => (
              <li key={tool.key} className="flex flex-col gap-1 px-3 py-3">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t(`connectors.tools.${tool.key}`)}</span>
                  <Badge variant="secondary">
                    {t(tool.access === 'read' ? 'connectors.lookUp' : 'connectors.changes')}
                  </Badge>
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`connectors.tools.${tool.key}Hint`)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{t('connectors.switchNote')}</p>
        </CardContent>
      )}
    </Card>
  );
}

function Privacy({ c }: { c: CatalogConnector }) {
  const { t } = useTranslation('admin');
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('connectors.privacyTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t(`connectors.items.${c.id}.privacy`)}</p>
      </CardContent>
    </Card>
  );
}

/** Settings tab: one AI agent at a time (`&agent=<id>` picks it; a picker with 2+ agents). */
function AgentSettings({ onConnect }: Readonly<{ onConnect: () => void }>) {
  const google = useGoogleCalendar();
  if (google.isPending) return <ListSkeleton rows={3} />;
  if (google.error)
    return <ErrorState error={google.error} onRetry={() => void google.refetch()} />;
  return (
    <AgentPicker
      render={(agent) => (
        <BookingSettingsCard
          key={agent.id}
          agentId={agent.id}
          name={agent.displayName}
          status={google.data}
          onConnect={onConnect}
        />
      )}
    />
  );
}

/** Google Sheets Settings tab: one AI agent at a time, like Google Calendar's. */
function SheetsAgentSettings({ onConnect }: Readonly<{ onConnect: () => void }>) {
  const sheets = useGoogleSheets();
  if (sheets.isPending) return <ListSkeleton rows={3} />;
  if (sheets.error)
    return <ErrorState error={sheets.error} onRetry={() => void sheets.refetch()} />;
  return (
    <AgentPicker
      render={(agent) => (
        <SheetsSettingsCard
          key={agent.id}
          agentId={agent.id}
          name={agent.displayName}
          status={sheets.data}
          onConnect={onConnect}
        />
      )}
    />
  );
}

/** Google Drive Settings tab: connect first, then one AI agent at a time. */
function DriveAgentSettings({ onConnect }: Readonly<{ onConnect: () => void }>) {
  const { t } = useTranslation('admin');
  const drive = useGoogleDrive();
  if (drive.isPending) return <ListSkeleton rows={3} />;
  if (drive.error) return <ErrorState error={drive.error} onRetry={() => void drive.refetch()} />;
  const state = drive.data.state;
  if (state === 'disconnected' || state === 'not_configured')
    return (
      <EmptyState
        title={t('connectors.drive.notConnected')}
        description={
          state === 'not_configured'
            ? t('connectors.gc.notConfiguredBody')
            : t('connectors.drive.notConnectedHint')
        }
        action={
          state === 'disconnected' ? (
            <Button size="touch" onClick={onConnect}>
              {t('connectors.gd.connect')}
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <AgentPicker
      render={(agent) => (
        <DriveSettingsCard
          key={agent.id}
          agentId={agent.id}
          name={agent.displayName}
          status={drive.data}
          onConnect={onConnect}
        />
      )}
    />
  );
}

const DRIVE_ICON = {
  saved: Save,
  read: FileText,
  skipped: ShieldAlert,
  failed: TriangleAlert,
} as const;

/** Google Drive Activity tab: who saved or read a file, and when (never file names or contents). */
function DriveActivityList() {
  const { t } = useTranslation('admin');
  const query = useDriveActivity();
  if (query.isPending) return <ListSkeleton rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const rows = query.data.activity;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('connectors.activityEmpty')}
        description={t('connectors.driveAct.emptyHint')}
      />
    );
  const line = (r: DriveActivity) => {
    const names = { agent: r.agentName, customer: r.customer, group: r.group ?? '' };
    const text =
      r.kind === 'skipped'
        ? t(`connectors.driveAct.skipped.${r.reason ?? 'unavailable'}`, names)
        : t(`connectors.driveAct.${r.kind}`, names);
    return r.group ? t('connectors.driveAct.inGroup', { line: text, group: r.group }) : text;
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('connectors.activityTitle')}</CardTitle>
        <CardDescription>{t('connectors.driveAct.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y" data-testid="drive-activity">
          {rows.map((r) => {
            const Icon = DRIVE_ICON[r.kind];
            return (
              <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">{line(r)}</span>
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

const SHEETS_ICON = {
  looked_up: TableProperties,
  lead_added: UserPlus,
  row_added: ListPlus,
  failed: TriangleAlert,
} as const;

/** Google Sheets Activity tab: what the AI looked up and added (who and when, never values). */
function SheetsActivityList() {
  const { t } = useTranslation('admin');
  const query = useSheetsActivity();
  if (query.isPending) return <ListSkeleton rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const rows = query.data.activity;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('connectors.activityEmpty')}
        description={t('connectors.sheetsAct.hint')}
      />
    );
  const line = (r: SheetsActivity) => {
    const names = {
      agent: r.agentName,
      customer: r.customer,
      tab: r.tab ?? '',
      group: r.group ?? '',
    };
    if (r.kind === 'row_added' && r.group) return t('connectors.sheetsAct.row_addedGroup', names);
    if (r.kind === 'looked_up' && r.tab) return t('connectors.sheetsAct.looked_upTab', names);
    return t(`connectors.sheetsAct.${r.kind}`, names);
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('connectors.activityTitle')}</CardTitle>
        <CardDescription>{t('connectors.sheetsAct.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y" data-testid="sheets-activity">
          {rows.map((r) => {
            const Icon = SHEETS_ICON[r.kind];
            return (
              <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">{line(r)}</span>
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

const ACTIVITY_ICON = {
  booked: CalendarCheck,
  checked: CalendarSearch,
  handed_over: UserRound,
  failed: TriangleAlert,
} as const;

/** Activity tab: what the AI checked and booked (who and when, never the chat text). */
function Activity() {
  const { t } = useTranslation('admin');
  const query = useCalendarActivity();
  if (query.isPending) return <ListSkeleton rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const rows = query.data.activity;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('connectors.activityEmpty')}
        description={t('connectors.activityHint')}
      />
    );
  const line = (r: CalendarActivity) => {
    const when = r.start && r.end ? formatTimeRange(r.start, r.end) : '';
    if (r.kind === 'booked' && when)
      return t('connectors.act.booked', { agent: r.agentName, customer: r.customer, when });
    if (r.kind === 'booked')
      return t('connectors.act.bookedNoTime', { agent: r.agentName, customer: r.customer });
    return t(`connectors.act.${r.kind}`, { agent: r.agentName, customer: r.customer });
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('connectors.activityTitle')}</CardTitle>
        <CardDescription>{t('connectors.activityHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y" data-testid="calendar-activity">
          {rows.map((r) => {
            const Icon = ACTIVITY_ICON[r.kind];
            return (
              <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">{line(r)}</span>
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

/** Test ids of the two lists. */
const BOOKING_LISTS = { upcoming: 'bookings-upcoming', past: 'bookings-past' } as const;

/**
 * Bookings tab: the events the AI added (EzyChat's own records, no Google call), upcoming first,
 * with links to the chat and to the event in Google Calendar.
 */
function Bookings() {
  const { t } = useTranslation('admin');
  const query = useCalendarBookings();
  if (query.isPending) return <ListSkeleton rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { upcoming, past, calendarUrl } = query.data;
  const open = calendarUrl && (
    <GoogleCalendarLink href={calendarUrl} label={t('connectors.bookings.openCalendar')} />
  );
  if (upcoming.length === 0 && past.length === 0)
    return (
      <EmptyState
        title={t('connectors.bookings.empty')}
        description={t('connectors.bookings.emptyHint')}
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
                {formatTimeRange(b.start, b.end)}
              </span>
              <span className="text-sm break-words">
                {b.customer || t('connectors.bookings.unknownCustomer')}
              </span>
              {b.agentName && (
                <span className="text-xs text-muted-foreground">
                  {t('connectors.bookings.by', { agent: b.agentName })}
                </span>
              )}
            </span>
          </span>
          <span className="flex flex-wrap gap-2 pl-7">
            <Button asChild variant="outline" size="sm" className="min-h-9 pointer-coarse:min-h-11">
              <Link to={`/chats/${encodeJid(b.chatJid)}`}>
                <MessageSquare aria-hidden />
                {t('connectors.bookings.openChat')}
              </Link>
            </Button>
            <GoogleCalendarLink href={b.eventUrl} label={t('connectors.bookings.openEvent')} />
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('connectors.bookings.title')}</CardTitle>
        <CardDescription>{t('connectors.bookings.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {open}
        <section className="flex flex-col gap-2" aria-labelledby="bookings-upcoming">
          <h3 id="bookings-upcoming" className="text-sm font-medium">
            {t('connectors.bookings.upcoming')}
          </h3>
          {upcoming.length > 0 ? (
            list(upcoming, BOOKING_LISTS.upcoming)
          ) : (
            <p className="text-sm text-muted-foreground">{t('connectors.bookings.noneUpcoming')}</p>
          )}
        </section>
        {past.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="bookings-past">
            <h3 id="bookings-past" className="text-sm font-medium">
              {t('connectors.bookings.past')}
            </h3>
            {list(past, BOOKING_LISTS.past)}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

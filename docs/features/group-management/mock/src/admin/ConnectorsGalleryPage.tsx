import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageCircle,
  RefreshCw,
  ThumbsUp,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '../api/client';
import { Banner, EmptyState, PageHeader, SegmentedControl } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  CONNECTORS,
  CONNECTOR_CATEGORIES,
  voteUrl,
  connectorStatus,
  type ConnectorCategory,
  type ConnectorStatus,
} from '@/mock/connectorCatalog';
import {
  entryFit,
  entryIcon,
  pick,
  useConnectorList,
  useConnectorListAction,
  type ConnectorListView,
  type ListState,
} from '@/mock/connectorList';
import { useMockEdition, type MockEdition } from '@/mock/edition';
import { useGoogleCalendar, type GoogleState } from '@/mock/googleCalendar';
import { InfoTip } from '@/components/app/InfoTip';

/**
 * Proposed (connector-list): two more card states. `needsUpdate`: the entry asks for a newer
 * EzyChat (greyed); `delisted`: connected, but no longer in the connector list (keeps working).
 */
export type CardStatus = ConnectorStatus | 'needsUpdate' | 'delisted';

/** Status badge used on gallery cards and the detail page header. */
export function ConnectorStatusBadge({ status }: { status: CardStatus }) {
  const { t } = useTranslation('admin');
  // Mock: catalog keys built from the connector id (the app types them per connector).
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const variant =
    status === 'connected'
      ? 'default'
      : status === 'comingSoon' || status === 'enterprise' || status === 'needsUpdate'
        ? 'secondary'
        : 'outline';
  return (
    <Badge
      variant={variant}
      className={
        status === 'attention' || status === 'delisted' ? 'border-warning text-warning' : undefined
      }
      data-testid={`connector-status-${status}`}
    >
      {status === 'needsUpdate' || status === 'delisted'
        ? tc(`mockConnectorList.status.${status}`)
        : tc(`mockConnectors.status.${status}`)}
    </Badge>
  );
}

/**
 * "Vote for this connector": opens WhatsApp with a ready message to the EzyChat team. Nothing is
 * counted in the app (Lite sends no usage data); the team counts the requests it receives.
 */
export function VoteButton({ name, size = 'touch' }: { name: string; size?: 'sm' | 'touch' }) {
  const { t } = useTranslation('admin');
  return (
    <Button
      asChild
      variant="outline"
      size={size}
      className={cn('self-start', size === 'sm' && 'min-h-9 pointer-coarse:min-h-11')}
    >
      <a
        href={voteUrl(t('mockConnectors.voteMessage', { name }))}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="vote-connector"
      >
        <ThumbsUp aria-hidden />
        {t('mockConnectors.vote')}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

/**
 * Baseline addition (PR #192 `connector-ui.tsx`): "Open Google Calendar" / "Open in Google Calendar"
 * opens Google in the browser (outside the app).
 */
export function GoogleCalendarLink({
  href,
  label,
  variant = 'outline',
}: {
  href: string;
  label: string;
  variant?: 'outline' | 'ghost';
}) {
  return (
    <Button
      asChild
      variant={variant}
      size="sm"
      className="min-h-9 self-start pointer-coarse:min-h-11"
    >
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

/** The connector's icon in a calm tile (brand logos are not used in the mock). */
export function ConnectorIcon({
  c,
  size = 'md',
  muted = false,
}: {
  c: { icon: LucideIcon };
  size?: 'md' | 'lg';
  muted?: boolean;
}) {
  const Icon = c.icon;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg border bg-muted',
        muted ? 'text-muted-foreground opacity-60' : 'text-foreground',
        size === 'lg' ? 'size-14' : 'size-11',
      )}
      aria-hidden
    >
      <Icon className={size === 'lg' ? 'size-7' : 'size-5'} />
    </span>
  );
}

/** One gallery card: from the connector list, or an app feature (the custom connector). */
export interface GalleryRow {
  id: string;
  name: string;
  short: string;
  category: string;
  icon: LucideIcon;
  status: CardStatus;
  publisher?: string;
  /** Coming soon: Vote for this connector. */
  vote: boolean;
}

/**
 * Proposed (connector-list): the cards come from the connector list the app keeps (format 1). An
 * entry with a schema this app cannot read is never shown; one that needs a newer EzyChat is greyed;
 * a connector removed from the list stays under Your connectors while it is connected.
 */
export function galleryRows(
  view: ConnectorListView | undefined,
  edition: MockEdition,
  google: GoogleState | undefined,
  tc: (key: string) => string,
  language: string,
): GalleryRow[] {
  const rows: GalleryRow[] = [];
  const gc = CONNECTORS.find((c) => c.id === 'google-calendar')!;
  for (const e of view?.list.entries ?? []) {
    const fit = entryFit(e, view!, edition);
    if (fit === 'hidden') continue;
    if (e.kind === 'builtin' && e.builtinId === 'google-calendar') {
      rows.push({
        id: gc.id,
        name: tc('mockConnectors.items.google-calendar.name'),
        short: tc('mockConnectors.items.google-calendar.short'),
        category: gc.category,
        icon: gc.icon,
        status: connectorStatus(gc, edition, google),
        vote: false,
      });
      continue;
    }
    const connection = view!.connections[e.id];
    const status: CardStatus =
      fit === 'needsUpdate'
        ? 'needsUpdate'
        : fit === 'enterprise'
          ? 'enterprise'
          : e.kind === 'coming_soon'
            ? 'comingSoon'
            : connection?.state === 'connected'
              ? 'connected'
              : 'notConnected';
    rows.push({
      id: e.id,
      name: e.name,
      short: pick(e.summary, language),
      category: e.category,
      icon: entryIcon(e),
      status,
      publisher: e.kind === 'mcp' ? e.publisher : undefined,
      vote: e.kind === 'coming_soon',
    });
  }
  // Connected, but no longer in the list: kept from the copy saved with the connection.
  for (const [id, c] of Object.entries(view?.connections ?? {}))
    if (c.state === 'connected' && !rows.some((r) => r.id === id))
      rows.push({
        id,
        name: c.entry.name,
        short: pick(c.entry.summary, language),
        category: c.entry.category,
        icon: entryIcon(c.entry),
        status: 'delisted',
        publisher: c.entry.publisher,
        vote: false,
      });
  // App feature, not in the list: the custom connector (Enterprise only).
  const custom = CONNECTORS.find((c) => c.id === 'custom-mcp')!;
  rows.push({
    id: custom.id,
    name: tc('mockConnectors.items.custom-mcp.name'),
    short: tc('mockConnectors.items.custom-mcp.short'),
    category: custom.category,
    icon: custom.icon,
    status: connectorStatus(custom, edition, google),
    vote: false,
  });
  return rows;
}

/**
 * Admin → Connectors, a gallery of connectors. Each card opens the connector's own page (details,
 * settings, activity). Connected ones come first; search and a category filter narrow the list.
 * Enterprise-only connectors show in Lite with an Enterprise badge.
 */
export function ConnectorsGalleryPage() {
  const { t, i18n } = useTranslation('admin');
  // Mock: catalog keys built from the connector id (the app types them per connector).
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const edition = useMockEdition();
  const google = useGoogleCalendar();
  const list = useConnectorList();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'all'>('all');
  const q = query.trim().toLowerCase();
  const all = galleryRows(list.data, edition, google.data?.state, tc, i18n.language);
  const rows = all.filter(
    (r) =>
      (category === 'all' || r.category === category) &&
      (!q ||
        r.name.toLowerCase().includes(q) ||
        r.short.toLowerCase().includes(q) ||
        (r.publisher ?? '').toLowerCase().includes(q)),
  );
  const mine = rows.filter(
    (r) => r.status === 'connected' || r.status === 'attention' || r.status === 'delisted',
  );
  const others = rows.filter((r) => !mine.includes(r));
  const categories = CONNECTOR_CATEGORIES.filter((cat) => all.some((r) => r.category === cat));

  const grid = (items: typeof rows) => (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((r) => {
        const greyed = r.status === 'enterprise' || r.status === 'needsUpdate';
        return (
          <li
            key={r.id}
            className={cn(
              'flex h-full flex-col rounded-xl border',
              // Lite: Enterprise-only connectors are greyed out; so are entries for a newer EzyChat.
              greyed ? 'border-dashed bg-muted/40 text-muted-foreground' : 'bg-card',
            )}
            data-testid={`connector-card-${r.id}`}
          >
            <Link
              to={`/admin/connectors/${r.id}`}
              className="flex min-h-11 flex-1 items-start gap-3 rounded-xl p-4 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ConnectorIcon c={r} muted={greyed} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{r.name}</span>
                  <ConnectorStatusBadge status={r.status} />
                </span>
                <span className="text-sm text-muted-foreground">{r.short}</span>
                {r.status === 'needsUpdate' && (
                  <span className="text-sm text-foreground">
                    {t('mockConnectorList.needsUpdateShort')}
                  </span>
                )}
                <span className="text-xs break-words text-muted-foreground">
                  {r.publisher
                    ? t('mockConnectorList.byPublisher', {
                        publisher: r.publisher,
                        category: tc(`mockConnectors.category.${r.category}`),
                      })
                    : tc(`mockConnectors.category.${r.category}`)}
                </span>
              </span>
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
            {r.vote && (
              <div className="px-4 pb-4">
                <VoteButton name={r.name} size="sm" />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="connectors-gallery">
      <div className="flex flex-col gap-1">
        <PageHeader
          className="pb-0"
          title={
            <span className="inline-flex items-center gap-1.5">
              {t('mockConnectors.title')}
              <InfoTip topic="connectors" />
            </span>
          }
          description={t('mockConnectors.description')}
        />
        {list.data && <ListStatusLine view={list.data} />}
      </div>
      {list.data && <ListBanner view={list.data} />}
      <SearchField
        value={query}
        onChange={setQuery}
        label={t('mockConnectors.searchLabel')}
        placeholder={t('mockConnectors.searchPlaceholder')}
      />
      <div
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
        role="group"
        aria-label={t('mockConnectors.categoryLabel')}
      >
        {(['all', ...categories] as const).map((id) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={category === id ? 'default' : 'outline'}
            aria-pressed={category === id}
            className="min-h-9 shrink-0 rounded-full pointer-coarse:min-h-11"
            onClick={() => setCategory(id)}
          >
            {tc(`mockConnectors.category.${id}`)}
          </Button>
        ))}
      </div>
      {rows.length === 0 && (
        <EmptyState
          illustration="/illustrations/no-results.png"
          title={t('mockConnectors.noMatch')}
          description={t('mockConnectors.noMatchHint')}
        />
      )}
      {mine.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="connectors-mine">
          <h2 id="connectors-mine" className="text-sm font-medium text-muted-foreground">
            {t('mockConnectors.yours')}
          </h2>
          {grid(mine)}
        </section>
      )}
      {others.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="connectors-all">
          <h2 id="connectors-all" className="text-sm font-medium text-muted-foreground">
            {t('mockConnectors.more')}
          </h2>
          {grid(others)}
        </section>
      )}
      <div className="flex flex-col items-start gap-2 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">{t('mockConnectors.missing')}</p>
        <Button asChild variant="outline" size="touch" className="shrink-0">
          <a
            href={voteUrl(t('mockConnectors.requestMessage'))}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="request-connector"
          >
            <MessageCircle aria-hidden />
            {t('mockConnectors.request')}
            <ExternalLink aria-hidden />
          </a>
        </Button>
      </div>
      {list.data && <ListMockControls view={list.data} edition={edition} />}
    </div>
  );
}

/** "Connector list updated 2 hours ago · Check for new connectors". */
function ListStatusLine({ view }: { view: ConnectorListView }) {
  const { t } = useTranslation('admin');
  const action = useConnectorListAction();
  const check = () =>
    action.mutate(
      { kind: 'check' },
      {
        onSuccess: (data) => {
          if (data.result === 'upToDate') toast.success(t('mockConnectorList.checkedUpToDate'));
          else if (data.result === 'offline') toast.error(t('mockConnectorList.checkedOffline'));
          else toast.warning(t('mockConnectorList.checkedRejected'));
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  const when = formatRelative(view.status.lastGoodAt);
  return (
    <p
      className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground"
      data-testid="connector-list-status"
    >
      <span>
        {view.status.state === 'loaded'
          ? t('mockConnectorList.updated', { when })
          : t('mockConnectorList.copyFrom', { when })}
      </span>
      <span aria-hidden>·</span>
      <Button
        variant="link"
        className="h-auto min-h-11 p-0 align-baseline md:min-h-0"
        disabled={action.isPending}
        onClick={check}
        data-testid="check-connector-list"
      >
        {action.isPending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <RefreshCw aria-hidden />
        )}
        {action.isPending ? t('mockConnectorList.checking') : t('mockConnectorList.check')}
      </Button>
    </p>
  );
}

/** Offline: the last copy is used; rejected (bad signature): a warning for admins. */
function ListBanner({ view }: { view: ConnectorListView }) {
  const { t } = useTranslation('admin');
  const when = formatRelative(view.status.lastGoodAt);
  if (view.status.state === 'offline')
    return (
      <Banner tone="info" title={t('mockConnectorList.offlineTitle')}>
        {t('mockConnectorList.offlineBody', { when })}
      </Banner>
    );
  if (view.status.state === 'rejected')
    return (
      <Banner tone="warning" title={t('mockConnectorList.rejectedTitle')}>
        {t('mockConnectorList.rejectedBody', { when })}
      </Banner>
    );
  return null;
}

/** Mock only: the list states, the Google Calendar (MCP) entry and a connector removed from the list. */
function ListMockControls({ view, edition }: { view: ConnectorListView; edition: MockEdition }) {
  const { t } = useTranslation('admin');
  const action = useConnectorListAction();
  const ids = { list: useId(), gc: useId(), lejar: useId() };
  const hidden = view.list.entries.filter((e) => entryFit(e, view, edition) === 'hidden');
  const set = (body: Parameters<typeof action.mutate>[0]) => action.mutate(body);
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
      data-testid="mock-list-controls"
    >
      <Badge variant="outline" className="self-start">
        {t('mockSuggest.mockControls')}
      </Badge>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={ids.list} className="text-sm font-medium">
          {t('mockConnectorList.mock.list')}
        </span>
        <SegmentedControl<ListState>
          size="sm"
          aria-labelledby={ids.list}
          value={view.status.state}
          onValueChange={(listState) => set({ kind: 'scenario', body: { listState } })}
          options={[
            { value: 'loaded', label: t('mockConnectorList.mock.loaded') },
            { value: 'offline', label: t('mockConnectorList.mock.offline') },
            { value: 'rejected', label: t('mockConnectorList.mock.rejected') },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={ids.gc} className="text-sm font-medium">
          {t('mockConnectorList.mock.googleMcp')}
        </span>
        <SegmentedControl<'off' | 'on'>
          size="sm"
          aria-labelledby={ids.gc}
          value={view.mock.showGoogleMcp ? 'on' : 'off'}
          onValueChange={(v) => set({ kind: 'scenario', body: { showGoogleMcp: v === 'on' } })}
          options={[
            { value: 'off', label: t('mockConnectorList.mock.hidden') },
            { value: 'on', label: t('mockConnectorList.mock.shown') },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={ids.lejar} className="text-sm font-medium">
          {t('mockConnectorList.mock.lejar')}
        </span>
        <SegmentedControl<'listed' | 'removed'>
          size="sm"
          aria-labelledby={ids.lejar}
          value={view.mock.delisted.includes('lejar-accounting') ? 'removed' : 'listed'}
          onValueChange={(v) => set({ kind: 'scenario', body: { lejarListed: v === 'listed' } })}
          options={[
            { value: 'listed', label: t('mockConnectorList.mock.listed') },
            { value: 'removed', label: t('mockConnectorList.mock.removed') },
          ]}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {t('mockConnectorList.mock.hiddenNote', {
          count: hidden.length,
          names: hidden.map((e) => e.name).join(', '),
        })}
      </p>
    </div>
  );
}

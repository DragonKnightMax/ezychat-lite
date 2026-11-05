import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageCircle,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ConnectorGallery,
  ConnectorListStatus,
  GoogleCalendarState,
  SqlAccountState,
} from '@ezychat/shared';
import { connectorText } from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import { useConnectorGallery, useRefreshConnectorList } from '../../api/connector-list';
import { useGoogleCalendar, useGoogleDrive, useGoogleSheets } from '../../api/connectors';
import { useSqlAccount } from '../../api/sql-account';
import { Banner, EmptyState, PageHeader } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { Button } from '@/components/ui/button';
import { useAppLinks } from '@/lib/app-links';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ErrorState } from '../adminUi';
import {
  CONNECTOR_CATEGORIES,
  CONNECTORS,
  LIST_CATEGORY,
  connectorStatus,
  type ConnectorCategory,
  type ConnectorStatus,
} from './catalog';
import {
  BetaBadge,
  ConnectorIcon,
  ConnectorStatusBadge,
  VoteButton,
  useConnectorLinks,
} from './connector-ui';
import { entryIcon, isLinked, listStatus } from './list';
import { InfoTip } from '@/components/app/InfoTip';

const ALL = 'all' as const;

/** One gallery card: from the connector list, or one of the app's own connectors. */
interface GalleryRow {
  id: string;
  href: string;
  name: string;
  short: string;
  category: ConnectorCategory;
  icon: { icon: LucideIcon; image?: string };
  status: ConnectorStatus;
  publisher?: string;
  /** The connector list marks it Beta. */
  beta: boolean;
}

/**
 * Admin → Connectors: a gallery of connectors from the connector list the server keeps (refreshed
 * when the page opens), plus the app's own built-in connectors (Google Calendar, Google Sheets, SQL
 * Account) and the custom MCP connector.
 * Each card opens the connector's own page (details, settings, activity), or the page an extension
 * provides. Connected ones come first; search and a category filter narrow the list.
 */
export function ConnectorsGalleryPage() {
  const { t, i18n } = useTranslation('admin');
  const google = useGoogleCalendar();
  const sheets = useGoogleSheets();
  const sql = useSqlAccount();
  const drive = useGoogleDrive();
  const list = useConnectorGallery();
  const refresh = useRefreshConnectorList();
  const links = useConnectorLinks();
  const request = useAppLinks().connectorRequest;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'all'>('all');
  const refreshed = useRef(false);

  // The server downloads the list when an admin opens the gallery (owner: no timer).
  const { mutate: refreshNow } = refresh;
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    refreshNow();
  }, [refreshNow]);

  const builtinStates: Partial<Record<string, GoogleCalendarState | SqlAccountState | undefined>> =
    {
      'google-sheets': sheets.data?.state,
      'google-drive': drive.data?.state,
      'sql-account': sql.data?.state,
    };
  const app = (id: (typeof CONNECTORS)[number]['id']): GalleryRow => {
    const c = CONNECTORS.find((x) => x.id === id)!;
    return {
      id: c.id,
      href: links[c.id] ?? `/admin/connectors/${c.id}`,
      name: t(`connectors.items.${c.id}.name`),
      short: t(`connectors.items.${c.id}.short`),
      category: c.category,
      icon: c,
      status: connectorStatus(c, builtinStates[c.id] ?? google.data?.state, links[c.id]),
      beta:
        list.data?.connectors.some(
          (g) =>
            g.entry.kind === 'builtin' && g.entry.builtinId === c.id && g.entry.stage === 'beta',
        ) ?? false,
    };
  };
  const all: GalleryRow[] = [
    app('google-calendar'),
    app('google-sheets'),
    app('google-drive'),
    app('sql-account'),
  ];
  for (const g of list.data?.connectors ?? []) {
    // Built-in connectors are the app's own (Google Calendar, Sheets, Drive and SQL Account show once, with
    // their live state and pages); a built-in this app does not know is skipped.
    if (g.entry.kind === 'builtin') continue;
    if (g.delisted && !isLinked(g.connection)) continue;
    if (all.some((r) => r.id === g.entry.id)) continue;
    all.push({
      id: g.entry.id,
      href: `/admin/connectors/${g.entry.id}`,
      name: g.entry.name,
      short: connectorText(g.entry.summary, i18n.language),
      category: LIST_CATEGORY[g.entry.category],
      icon: entryIcon(g.entry),
      status: listStatus(g),
      publisher: g.entry.kind === 'mcp' ? g.entry.publisher : undefined,
      beta: g.entry.stage === 'beta',
    });
  }
  all.push(app('custom-mcp'));

  const q = query.trim().toLocaleLowerCase();
  const rows = all.filter(
    (r) =>
      (category === 'all' || r.category === category) &&
      (!q ||
        r.name.toLocaleLowerCase().includes(q) ||
        r.short.toLocaleLowerCase().includes(q) ||
        (r.publisher ?? '').toLocaleLowerCase().includes(q) ||
        r.id.includes(q)),
  );
  const mine = rows.filter(
    (r) => r.status === 'connected' || r.status === 'attention' || r.status === 'delisted',
  );
  const others = rows.filter((r) => !mine.includes(r));
  const filters = [ALL, ...CONNECTOR_CATEGORIES.filter((id) => all.some((r) => r.category === id))];

  const grid = (items: GalleryRow[]) => (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((r) => {
        const greyed = r.status === 'enterprise' || r.status === 'needsUpdate';
        return (
          <li
            key={r.id}
            className={cn(
              'flex h-full flex-col rounded-xl border',
              greyed ? 'border-dashed bg-muted/40 text-muted-foreground' : 'bg-card',
            )}
            data-testid={`connector-card-${r.id}`}
          >
            <Link
              to={r.href}
              className="flex min-h-11 flex-1 items-start gap-3 rounded-xl p-4 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ConnectorIcon c={r.icon} muted={greyed} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{r.name}</span>
                  <ConnectorStatusBadge status={r.status} />
                  <BetaBadge show={r.beta} />
                </span>
                <span className="text-sm break-words text-muted-foreground">{r.short}</span>
                {r.status === 'needsUpdate' && (
                  <span className="text-sm text-foreground">
                    {t('connectors.list.needsUpdateShort')}
                  </span>
                )}
                <span className="text-xs break-words text-muted-foreground">
                  {r.publisher
                    ? t('connectors.list.byPublisher', {
                        publisher: r.publisher,
                        category: t(`connectors.category.${r.category}`),
                      })
                    : t(`connectors.category.${r.category}`)}
                </span>
              </span>
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
            {r.status === 'comingSoon' && request && (
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
          title={t('connectors.title')}
          titleTip={<InfoTip topic="connectors" />}
          description={t('connectors.description')}
        />
        {list.data && <ListStatusLine gallery={list.data} refresh={refresh} />}
      </div>
      {list.data && <ListBanner status={list.data.status} />}
      {list.error && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      <SearchField
        value={query}
        onChange={setQuery}
        label={t('connectors.searchLabel')}
        placeholder={t('connectors.searchPlaceholder')}
      />
      <div
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
        role="group"
        aria-label={t('connectors.categoryLabel')}
      >
        {filters.map((id) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={category === id ? 'default' : 'outline'}
            aria-pressed={category === id}
            className="min-h-9 shrink-0 rounded-full pointer-coarse:min-h-11"
            onClick={() => setCategory(id)}
          >
            {t(`connectors.category.${id}`)}
          </Button>
        ))}
      </div>
      {rows.length === 0 && (
        <EmptyState
          illustration="/illustrations/no-results.png"
          title={t('connectors.noMatch')}
          description={t('connectors.noMatchHint')}
        />
      )}
      {mine.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="connectors-mine">
          <h2 id="connectors-mine" className="text-sm font-medium text-muted-foreground">
            {t('connectors.yours')}
          </h2>
          {grid(mine)}
        </section>
      )}
      {others.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="connectors-all">
          <h2 id="connectors-all" className="text-sm font-medium text-muted-foreground">
            {t('connectors.more')}
          </h2>
          {grid(others)}
        </section>
      )}
      {request && (
        <div className="flex flex-col items-start gap-2 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{t('connectors.missing')}</p>
          <Button asChild variant="outline" size="touch" className="shrink-0">
            <a
              href={request(t('connectors.requestMessage'))}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="request-connector"
            >
              <MessageCircle aria-hidden />
              {t('connectors.request')}
              <ExternalLink aria-hidden />
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Connector list updated 2 hours ago · Check for new connectors". */
function ListStatusLine({
  gallery,
  refresh,
}: {
  gallery: ConnectorGallery;
  refresh: ReturnType<typeof useRefreshConnectorList>;
}) {
  const { t } = useTranslation('admin');
  const { status } = gallery;
  const check = () =>
    refresh.mutate(undefined, {
      onSuccess: (next) => {
        if (next.status.state === 'loaded')
          toast.success(
            next.status.sequence !== status.sequence
              ? t('connectors.list.checkedNew')
              : t('connectors.list.checkedUpToDate'),
          );
        else if (next.status.state === 'rejected')
          toast.warning(t('connectors.list.checkedRejected'));
        else toast.error(t('connectors.list.checkedOffline'));
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  const published = status.generatedAt ? Date.parse(status.generatedAt) : Number.NaN;
  const text =
    status.state === 'builtin'
      ? t('connectors.list.builtin')
      : status.state === 'loaded' && status.checkedAt !== null
        ? t('connectors.list.updated', { when: formatRelative(status.checkedAt) })
        : Number.isFinite(published)
          ? t('connectors.list.copyFrom', { when: formatRelative(published) })
          : t('connectors.list.saved');
  return (
    <p
      className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground"
      data-testid="connector-list-status"
    >
      <span>{text}</span>
      <span aria-hidden>·</span>
      <Button
        variant="link"
        className="h-auto min-h-11 p-0 align-baseline md:min-h-0"
        disabled={refresh.isPending}
        onClick={check}
        data-testid="check-connector-list"
      >
        {refresh.isPending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <RefreshCw aria-hidden />
        )}
        {refresh.isPending ? t('connectors.list.checking') : t('connectors.list.check')}
      </Button>
    </p>
  );
}

/** Offline: the last copy is used; rejected (failed its checks): a warning for admins. */
function ListBanner({ status }: { status: ConnectorListStatus }) {
  const { t } = useTranslation('admin');
  if (status.state === 'offline')
    return (
      <Banner tone="info" title={t('connectors.list.offlineTitle')}>
        <span data-testid="connector-list-offline">{t('connectors.list.offlineBody')}</span>
      </Banner>
    );
  if (status.state === 'rejected')
    return (
      <Banner tone="warning" title={t('connectors.list.rejectedTitle')}>
        <span data-testid="connector-list-rejected">{t('connectors.list.rejectedBody')}</span>
      </Banner>
    );
  return null;
}

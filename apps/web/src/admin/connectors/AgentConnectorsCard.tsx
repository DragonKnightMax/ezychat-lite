import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight, Plug } from 'lucide-react';
import { SQL_OBJECTS, sqlAccessOf } from '@ezychat/shared';
import type { DriveAgentSettings, GitHubAgentView, SheetsAgentSettings } from '@ezychat/shared';
import { useConnectorGallery, useConnectorsAgentSettings } from '../../api/connector-list';
import {
  useBookingSettings,
  useDriveSettings,
  useGitHub,
  useGitHubAgent,
  useGoogleCalendar,
  useGoogleDrive,
  useGoogleSheets,
  useSheetsSettings,
} from '../../api/connectors';
import { useSqlAccount, useSqlAgentSettings } from '../../api/sql-account';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useEdition } from '@/lib/version';
import { findConnector } from './catalog';
import { ConnectorIcon, ConnectorStatusBadge } from './connector-ui';
import { entryIcon, isLinked, withToolDefaults } from './list';

const ROW =
  'flex min-h-11 items-center gap-3 rounded-lg border px-3 py-3 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Signed in (also while it needs attention): the connector's row shows. */
const linkedState = (state: string | undefined) =>
  state === 'connected' || state === 'expired' || state === 'unavailable';

/** Google Calendar: Off, Checks free times, or Checks and books. */
function calendarLine(t: Translate, booking: { checkFree: boolean; book: boolean }): string {
  if (!booking.checkFree) return t('connectors.agentCard.off');
  return t(booking.book ? 'connectors.agentCard.checkAndBook' : 'connectors.agentCard.checkOnly');
}

/** Google Sheets: the tabs it reads and adds rows to, or Off. */
function sheetsLine(t: Translate, settings: SheetsAgentSettings): string {
  const tabs = (access: 'read' | 'add') =>
    settings.spreadsheetId
      ? settings.tabs.filter((x) => x.access === access).map((x) => x.title)
      : [];
  const reads = tabs('read');
  const adds = tabs('add');
  if (reads.length + adds.length === 0) return t('connectors.agentCard.off');
  const parts: string[] = [];
  if (reads.length) parts.push(t('connectors.agentCard.sheetsReads', { tabs: reads.join(', ') }));
  if (adds.length) parts.push(t('connectors.agentCard.sheetsAdds', { tabs: adds.join(', ') }));
  return parts.join(' · ');
}

/** Google Drive: no folder, saves, reads N files, both, or Off. */
function driveLine(t: Translate, settings: DriveAgentSettings): string {
  if (!settings.folder) return t('connectors.agentCard.driveNoFolder');
  const count = settings.read ? settings.files.length : 0;
  if (settings.save && count) return t('connectors.agentCard.driveSavesAndReads', { count });
  if (settings.save) return t('connectors.agentCard.driveSaves');
  if (count) return t('connectors.agentCard.driveReads', { count });
  return t('connectors.agentCard.off');
}

/** GitHub: what it looks up in how many repositories GitHub still shares, or Off. */
function githubLine(t: Translate, view: GitHubAgentView): string {
  const { repos, issues, pulls } = view.settings;
  if (repos.length === 0) return t('connectors.github.agentCard.noRepos');
  const count = repos.filter((r) => !view.unavailableRepoIds.includes(r.id)).length;
  if (issues && pulls) return t('connectors.github.agentCard.both', { count });
  if (issues) return t('connectors.github.agentCard.issues', { count });
  if (pulls) return t('connectors.github.agentCard.pulls', { count });
  return t('connectors.agentCard.off');
}

/**
 * Agent page → Connectors: one summary row per connected connector (what this agent may do there)
 * that opens the connector's Settings tab for this agent. Settings live on the connector's page.
 */
export function AgentConnectorsCard({
  agentId,
  name,
}: Readonly<{ agentId: number; name: string }>) {
  const { t: typed } = useTranslation('admin');
  const t = typed as unknown as Translate;
  const google = useGoogleCalendar();
  const state = google.data?.state;
  const connected = linkedState(state);
  const booking = useBookingSettings(agentId, connected);
  const sheets = useGoogleSheets();
  const sheetsState = sheets.data?.state;
  const sheetsLinked = linkedState(sheetsState);
  const sheetSettings = useSheetsSettings(agentId, sheetsLinked).data;
  const gs = findConnector('google-sheets')!;
  const sheetsSummary = sheetSettings ? sheetsLine(t, sheetSettings) : null;
  const drive = useGoogleDrive();
  const driveState = drive.data?.state;
  const driveLinked = linkedState(driveState);
  const driveSettings = useDriveSettings(agentId, driveLinked).data;
  const gd = findConnector('google-drive')!;
  const driveSummary = driveSettings ? driveLine(t, driveSettings) : null;
  // GitHub is offered in Lite only for now (owner 2026-11-10).
  const lite = useEdition() === 'lite';
  const github = useGitHub(lite);
  const githubState = github.data?.state;
  const githubLinked = lite && (linkedState(githubState) || githubState === 'expiring');
  const githubView = useGitHubAgent(agentId, githubLinked).data;
  const ghc = findConnector('github')!;
  const sql = useSqlAccount();
  const sqlState = sql.data?.state;
  const sqlLinked = sqlState !== undefined && sqlState !== 'disconnected';
  const sqlSettings = useSqlAgentSettings(agentId, sqlLinked).data;
  const sqlOn = sqlSettings
    ? SQL_OBJECTS.filter((o) => sqlAccessOf(sqlSettings, o.id) !== 'off').length
    : null;
  const sqlConnector = findConnector('sql-account')!;
  const gallery = useConnectorGallery();
  const partners = (gallery.data?.connectors ?? []).filter(
    (c) => c.entry.kind === 'mcp' && isLinked(c.connection),
  );
  const partnerSettings = useConnectorsAgentSettings(
    partners.map((c) => c.entry.id),
    agentId,
  );
  const gc = findConnector('google-calendar')!;
  const summary = booking.data ? calendarLine(t, booking.data) : null;
  return (
    <Card className="gap-4" data-testid="agent-connectors">
      <CardHeader>
        <CardTitle>{t('connectors.title')}</CardTitle>
        <CardDescription>{t('connectors.agentCard.description', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {connected && (
          <Link
            to={`/admin/connectors/google-calendar?tab=settings&agent=${agentId}`}
            className={ROW}
            data-testid="agent-connector-google-calendar"
          >
            <ConnectorIcon c={gc} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {t('connectors.items.google-calendar.name')}
                {state !== 'connected' && <ConnectorStatusBadge status="attention" />}
              </span>
              {summary && <span className="text-sm text-muted-foreground">{summary}</span>}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}
        {sheetsLinked && (
          <Link
            to={`/admin/connectors/google-sheets?tab=settings&agent=${agentId}`}
            className={ROW}
            data-testid="agent-connector-google-sheets"
          >
            <ConnectorIcon c={gs} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {t('connectors.items.google-sheets.name')}
                {sheetsState !== 'connected' && <ConnectorStatusBadge status="attention" />}
              </span>
              {sheetsSummary && (
                <span className="text-sm text-muted-foreground">{sheetsSummary}</span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}
        {driveLinked && (
          <Link
            to={`/admin/connectors/google-drive?tab=settings&agent=${agentId}`}
            className={ROW}
            data-testid="agent-connector-google-drive"
          >
            <ConnectorIcon c={gd} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {t('connectors.items.google-drive.name')}
                {driveState !== 'connected' && <ConnectorStatusBadge status="attention" />}
              </span>
              {driveSummary && (
                <span className="text-sm text-muted-foreground">{driveSummary}</span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}
        {githubLinked && (
          <Link
            to={`/admin/connectors/github?tab=settings&agent=${agentId}`}
            className={ROW}
            data-testid="agent-connector-github"
          >
            <ConnectorIcon c={ghc} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {t('connectors.items.github.name')}
                {(githubState === 'expired' || githubState === 'unavailable') && (
                  <ConnectorStatusBadge status="attention" />
                )}
              </span>
              {githubView && (
                <span className="text-sm text-muted-foreground">{githubLine(t, githubView)}</span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}
        {sqlLinked && (
          <Link
            to={`/admin/connectors/sql-account?tab=settings&agent=${agentId}`}
            className={ROW}
            data-testid="agent-connector-sql-account"
          >
            <ConnectorIcon c={sqlConnector} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {t('connectors.items.sql-account.name')}
                {sqlState !== 'connected' && <ConnectorStatusBadge status="attention" />}
              </span>
              {sqlOn !== null && (
                <span className="text-sm text-muted-foreground">
                  {sqlOn === 0
                    ? t('connectors.agentCard.off')
                    : t('connectors.sql.agentCard', { on: sqlOn, total: SQL_OBJECTS.length })}
                </span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}
        {partners.map((c, i) => {
          const tools = c.entry.tools ?? [];
          const saved = partnerSettings[i]?.data;
          const on = saved
            ? Object.values(withToolDefaults(tools, saved.tools)).filter(Boolean).length
            : null;
          return (
            <Link
              key={c.entry.id}
              to={`/admin/connectors/${c.entry.id}?tab=settings&agent=${agentId}`}
              className={ROW}
              data-testid={`agent-connector-${c.entry.id}`}
            >
              <ConnectorIcon c={entryIcon(c.entry)} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-center gap-2 font-medium break-words">
                  {c.entry.name}
                  {c.connection?.state !== 'connected' && (
                    <ConnectorStatusBadge status="attention" />
                  )}
                  {c.delisted && <ConnectorStatusBadge status="delisted" />}
                </span>
                {on !== null && (
                  <span className="text-sm text-muted-foreground">
                    {t('connectors.partner.agentCardTools', { count: on, total: tools.length })}
                  </span>
                )}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          );
        })}
        {!connected &&
          !sheetsLinked &&
          !driveLinked &&
          !githubLinked &&
          !sqlLinked &&
          partners.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('connectors.agentCard.none')}</p>
          )}
        <Button asChild variant="outline" size="touch" className="self-start">
          <Link to="/admin/connectors">
            <Plug aria-hidden />
            {t('connectors.agentCard.browse')}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

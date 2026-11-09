import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight, Plug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CONNECTORS } from '@/mock/connectorCatalog';
import { choiceFor, entryIcon, useConnectorList } from '@/mock/connectorList';
import { bookingFor, useGoogleCalendar } from '@/mock/googleCalendar';
import { driveSettingsFor, useGoogleDrive } from '@/mock/googleDrive';
import { githubSettingsFor, usableRepos, useGitHub } from '@/mock/github';
import { ConnectorIcon } from './ConnectorsGalleryPage';

/**
 * Proposed (google-calendar): agent page → Connectors, one summary row per connected connector
 * (what this agent may do there) that opens the connector's Settings tab. Settings live on the
 * connector's own page; this card only shows and links.
 */
export function AgentConnectorsCard({
  agentId,
  name,
}: Readonly<{ agentId: string; name: string }>) {
  const { t } = useTranslation('admin');
  const google = useGoogleCalendar();
  // Proposed (connector-list): connected partner (MCP) connectors get a row too.
  const partners = Object.entries(useConnectorList().data?.connections ?? {}).filter(
    ([, c]) => c.state === 'connected',
  );
  const gc = CONNECTORS.find((c) => c.id === 'google-calendar')!;
  // Proposed (google-drive): one row when Google Drive is connected.
  const drive = useGoogleDrive();
  const gd = CONNECTORS.find((c) => c.id === 'google-drive')!;
  const driveOn = drive.state !== 'disconnected';
  const ds = driveSettingsFor(drive, agentId);
  const driveSummary = !ds.folder
    ? t('mockDrive.agentCard.noFolder')
    : ds.save && ds.read
      ? t('mockDrive.agentCard.saveAndRead', { count: ds.files.length })
      : ds.save
        ? t('mockDrive.agentCard.saveOnly')
        : ds.read
          ? t('mockDrive.agentCard.readOnly', { count: ds.files.length })
          : t('mockConnectors.agentCard.off');
  // Proposed (github): one row when GitHub is signed in.
  const gh = useGitHub();
  const ghc = CONNECTORS.find((c) => c.id === 'github')!;
  const ghOn = gh.state !== 'disconnected' && gh.state !== 'noInstall';
  const gs = githubSettingsFor(gh, agentId);
  const ghRepos = usableRepos(gh, gs).length;
  const ghSummary =
    gs.repos.length === 0
      ? t('mockGitHub.agentCard.noRepos')
      : gs.issues && gs.pulls
        ? t('mockGitHub.agentCard.both', { count: ghRepos })
        : gs.issues
          ? t('mockGitHub.agentCard.issues', { count: ghRepos })
          : gs.pulls
            ? t('mockGitHub.agentCard.pulls', { count: ghRepos })
            : t('mockConnectors.agentCard.off');
  const connected = google.data && google.data.state !== 'disconnected';
  const booking = bookingFor(google.data, agentId);
  const summary = !booking.checkFree
    ? t('mockConnectors.agentCard.off')
    : booking.book
      ? t('mockConnectors.agentCard.checkAndBook')
      : t('mockConnectors.agentCard.checkOnly');
  return (
    <Card className="gap-4" data-testid="agent-connectors">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockConnectors.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockConnectors.agentCard.description', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {partners.map(([id, c]) => {
          const tools = c.entry.tools ?? [];
          const choice = choiceFor(c, agentId);
          const on = tools.filter((tool) => choice.tools[tool.name]).length;
          return (
            <Link
              key={id}
              to={`/admin/connectors/${id}?tab=settings`}
              className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-3 hover:bg-muted/50"
            >
              <ConnectorIcon c={{ icon: entryIcon(c.entry) }} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium break-words">{c.entry.name}</span>
                <span className="text-sm text-muted-foreground">
                  {t('mockConnectorList.agentCardTools', { count: on, total: tools.length })}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          );
        })}
        {driveOn && (
          <Link
            to="/admin/connectors/google-drive?tab=settings"
            className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-3 hover:bg-muted/50"
          >
            <ConnectorIcon c={gd} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{t('mockDrive.name')}</span>
              <span className="text-sm text-muted-foreground">{driveSummary}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}
        {ghOn && (
          <Link
            to="/admin/connectors/github?tab=settings"
            className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-3 hover:bg-muted/50"
          >
            <ConnectorIcon c={ghc} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{t('mockGitHub.name')}</span>
              <span className="text-sm text-muted-foreground">{ghSummary}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}
        {connected ? (
          <Link
            to="/admin/connectors/google-calendar?tab=settings"
            className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-3 hover:bg-muted/50"
          >
            <ConnectorIcon c={gc} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{t('mockConnectors.items.google-calendar.name')}</span>
              <span className="text-sm text-muted-foreground">{summary}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        ) : (
          partners.length === 0 &&
          !driveOn &&
          !ghOn && (
            <p className="text-sm text-muted-foreground">{t('mockConnectors.agentCard.none')}</p>
          )
        )}
        <Button asChild variant="outline" size="touch" className="self-start">
          <Link to="/admin/connectors">
            <Plug aria-hidden />
            {t('mockConnectors.agentCard.browse')}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

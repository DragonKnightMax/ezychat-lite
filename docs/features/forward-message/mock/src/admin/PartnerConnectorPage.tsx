import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  Search,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '../api/client';
import {
  Banner,
  EmptyState,
  ResponsiveDialog,
  SegmentedControl,
  StatusDot,
} from '@/components/app';
import { UpgradeButton } from '@/components/app/UpgradeEnterprise';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';
import {
  choiceFor,
  entryFit,
  entryIcon,
  pick,
  useApiKeyAction,
  useConnectorList,
  useConnectorListAction,
  type AgentChoice,
  type KeyResult,
  type ListEntry,
  type ListSetting,
  type ListTool,
  type PartnerActivity,
  type PartnerConnection,
} from '@/mock/connectorList';
import { useMockEdition } from '@/mock/edition';
import { ConfirmDialog, Field, SaveBar } from './adminUi';
import { AgentSettings, ConnectorBreadcrumb } from './ConnectorDetailPage';
import { ConnectorIcon, ConnectorStatusBadge, VoteButton } from './ConnectorsGalleryPage';

const TABS = ['overview', 'settings', 'activity'] as const;
type Tab = (typeof TABS)[number];
// Monday first, as Malaysian calendars show it.
const DAYS = [1, 2, 3, 4, 5, 6, 0];

/** The header of a page built from a list entry: icon, name, status, publisher and website. */
function EntryHeader({
  entry,
  status,
}: {
  entry: ListEntry;
  status: Parameters<typeof ConnectorStatusBadge>[0]['status'];
}) {
  const { t } = useTranslation('admin');
  // Mock: catalog keys built from the entry's category.
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const greyed = status === 'enterprise' || status === 'needsUpdate';
  return (
    <div className="flex items-start gap-4">
      <ConnectorIcon c={{ icon: entryIcon(entry) }} size="lg" muted={greyed} />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight break-words">{entry.name}</h1>
          <ConnectorStatusBadge status={status} />
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <p className="text-sm break-words text-muted-foreground">
          {entry.publisher
            ? t('mockConnectorList.byPublisher', {
                publisher: entry.publisher,
                category: tc(`mockConnectors.category.${entry.category}`),
              })
            : tc(`mockConnectors.category.${entry.category}`)}
        </p>
        {entry.homepage && (
          <a
            href={entry.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-primary underline-offset-4 hover:underline md:min-h-0"
            data-testid="publisher-homepage"
          >
            {t('mockConnectorList.website', { publisher: entry.publisher ?? entry.name })}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </div>
    </div>
  );
}

/** What it does and what the AI can do: the entry's texts in the UI language. */
export function EntryAbout({ entry }: { entry: ListEntry }) {
  const { t, i18n } = useTranslation('admin');
  const tools = entry.tools ?? [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('mockConnectors.aboutTitle')}</CardTitle>
        <CardDescription>{pick(entry.description, i18n.language)}</CardDescription>
      </CardHeader>
      {tools.length > 0 && (
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('mockConnectors.aiCan')}</p>
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="entry-tools">
            {tools.map((tool) => (
              <li key={tool.name} className="flex flex-col gap-1 px-3 py-3">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{pick(tool.title, i18n.language)}</span>
                  <Badge variant="secondary">
                    {t(tool.access === 'read' ? 'mockConnectors.lookUp' : 'mockConnectors.changes')}
                  </Badge>
                </span>
                <span className="text-sm text-muted-foreground">
                  {pick(tool.description, i18n.language)}
                </span>
              </li>
            ))}
          </ul>
          {tools.some((tool) => tool.access === 'write') && (
            <p className="text-sm text-muted-foreground">{t('mockConnectors.switchNote')}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/** Your data: the entry's privacy line, plus the technical details behind a button. */
function EntryPrivacy({ entry }: { entry: ListEntry }) {
  const { t, i18n } = useTranslation('admin');
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  if (!entry.privacy) return null;
  const auth = entry.auth?.type ?? 'none';
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockConnectors.privacyTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{pick(entry.privacy, i18n.language)}</p>
        {entry.mcp && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-9 self-start px-2 pointer-coarse:min-h-11"
              aria-expanded={details}
              aria-controls={detailsId}
              onClick={() => setDetails((v) => !v)}
            >
              {details ? t('mockConnectorList.hideDetails') : t('mockConnectorList.showDetails')}
            </Button>
            {details && (
              <dl
                id={detailsId}
                className="grid gap-x-4 gap-y-2 rounded-lg border px-3 py-3 text-sm sm:grid-cols-[auto_1fr]"
              >
                <dt className="text-muted-foreground">{t('mockConnectorList.detail.server')}</dt>
                <dd className="font-mono text-xs break-all">{entry.mcp.url}</dd>
                <dt className="text-muted-foreground">{t('mockConnectorList.detail.signIn')}</dt>
                <dd>
                  {auth === 'oauth'
                    ? t('mockConnectorList.detail.oauth')
                    : auth === 'api_key'
                      ? t('mockConnectorList.detail.apiKey')
                      : t('mockConnectorList.detail.none')}
                </dd>
                <dt className="text-muted-foreground">{t('mockConnectorList.detail.entry')}</dt>
                <dd className="break-all">
                  {t('mockConnectorList.detail.entryValue', {
                    id: entry.id,
                    schema: entry.schemaVersion,
                  })}
                </dd>
              </dl>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A coming-soon entry of the list: its texts and Vote for this connector. */
export function ComingSoonEntryPage({ entry }: { entry: ListEntry }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-4" data-testid={`connector-page-${entry.id}`}>
      <ConnectorBreadcrumb name={entry.name} />
      <EntryHeader entry={entry} status="comingSoon" />
      <Banner tone="info" title={t('mockConnectors.comingSoonTitle')}>
        <span className="flex flex-col items-start gap-2">
          {t('mockConnectors.comingSoonBody')}
          <VoteButton name={entry.name} />
        </span>
      </Banner>
      <EntryAbout entry={entry} />
      <EntryPrivacy entry={entry} />
      <Button asChild variant="outline" size="touch" className="self-start">
        <Link to="/admin/connectors">{t('mockConnectors.backToGallery')}</Link>
      </Button>
    </div>
  );
}

/**
 * Proposed (connector-list): the page of a partner (MCP) connector, built from its list entry.
 * EzyChat connects from this computer straight to the partner's MCP server: Overview (what it does,
 * the connection, your data), Settings per AI agent (the entry's form, one switch per tool, the
 * rules the AI always follows) and Activity. `listed` false: connected, no longer in the list.
 */
export function PartnerConnectorPage({ entry, listed }: { entry: ListEntry; listed: boolean }) {
  const { t } = useTranslation('admin');
  const edition = useMockEdition();
  const list = useConnectorList();
  const [params, setParams] = useSearchParams();
  const view = list.data;
  if (!view) return null;
  const connection = view.connections[entry.id];
  const connected = connection?.state === 'connected';
  const fit = entryFit(entry, view, edition);
  const status = !listed
    ? 'delisted'
    : fit === 'needsUpdate'
      ? 'needsUpdate'
      : fit === 'enterprise'
        ? 'enterprise'
        : connected
          ? 'connected'
          : 'notConnected';
  const tabParam = params.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'overview';
  const setTab = (next: string) =>
    setParams(
      (p) => {
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );

  if (status === 'enterprise' || status === 'needsUpdate')
    return (
      <div className="flex flex-col gap-4" data-testid={`connector-page-${entry.id}`}>
        <ConnectorBreadcrumb name={entry.name} />
        <EntryHeader entry={entry} status={status} />
        {status === 'enterprise' ? (
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{t('mockConnectors.enterpriseOnly')}</p>
            <UpgradeButton className="shrink-0 self-start sm:self-auto" />
          </div>
        ) : (
          <Banner tone="info" title={t('mockConnectorList.needsUpdateTitle')}>
            <span className="flex flex-col items-start gap-2" data-testid="needs-update">
              {t('mockConnectorList.needsUpdateBody', {
                need: entry.minAppVersion,
                have: view.appVersion,
              })}
              <Button
                size="touch"
                variant="outline"
                onClick={() => toast.info(t('mockConnectorList.updateToast'))}
              >
                {t('mockConnectorList.checkUpdates')}
              </Button>
            </span>
          </Banner>
        )}
        <EntryAbout entry={entry} />
        <EntryPrivacy entry={entry} />
        <Button asChild variant="outline" size="touch" className="self-start">
          <Link to="/admin/connectors">{t('mockConnectors.backToGallery')}</Link>
        </Button>
      </div>
    );

  return (
    <div className="flex flex-col gap-4" data-testid={`connector-page-${entry.id}`}>
      <ConnectorBreadcrumb name={entry.name} />
      <EntryHeader entry={entry} status={status} />
      {!listed && (
        <Banner tone="warning" title={t('mockConnectorList.delistedTitle')}>
          <span data-testid="delisted-note">{t('mockConnectorList.delistedBody')}</span>
        </Banner>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
          <TabsList variant="line" className="w-max justify-start">
            {TABS.map((id) => (
              <TabsTrigger key={id} value={id} className="min-h-11 flex-none px-3 md:min-h-9">
                {t(`mockConnectors.tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="flex flex-col gap-4">
          <EntryAbout entry={entry} />
          <ConnectionCard
            entry={entry}
            connection={connection}
            reachable={view.mock.partnerReachable}
            listed={listed}
            onOpenSettings={() => setTab('settings')}
          />
          <EntryPrivacy entry={entry} />
        </TabsContent>
        <TabsContent value="settings" className="flex flex-col gap-4">
          {connected ? (
            <AgentSettings
              render={(agent) => (
                <PartnerAgentCard
                  key={`${entry.id}-${agent.id}`}
                  entry={entry}
                  connection={connection}
                  agentId={agent.id}
                  agentName={agent.name}
                />
              )}
            />
          ) : (
            <EmptyState
              title={t('mockConnectorList.connectFirst', { name: entry.name })}
              description={t('mockConnectorList.connectFirstHint')}
              action={
                <Button size="touch" onClick={() => setTab('overview')}>
                  {t('mockConnectorList.goToOverview')}
                </Button>
              }
            />
          )}
        </TabsContent>
        <TabsContent value="activity" className="flex flex-col gap-4">
          <PartnerActivityList entry={entry} rows={connection?.activity ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The connection: Connect (sign-in page or API key), waiting, connected, failed. */
function ConnectionCard({
  entry,
  connection,
  reachable,
  listed,
  onOpenSettings,
}: {
  entry: ListEntry;
  connection: PartnerConnection | undefined;
  reachable: boolean;
  listed: boolean;
  onOpenSettings: () => void;
}) {
  const { t, i18n } = useTranslation('admin');
  const action = useConnectorListAction();
  const mockId = useId();
  const [keyDialog, setKeyDialog] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const oauth = entry.auth?.type === 'oauth';
  const state = connection?.state;
  const name = entry.name;
  const publisher = entry.publisher ?? entry.name;
  const connect = () => {
    if (!oauth) return setKeyDialog(true);
    action.mutate(
      { kind: 'connect', id: entry.id },
      {
        onSuccess: (data) => {
          const url = data.connections[entry.id]?.signInUrl;
          // The app opens the partner's page in the browser; the mock opens a new tab.
          if (url) window.open(url, '_blank', 'noopener');
        },
      },
    );
  };
  return (
    <Card data-testid="partner-connection">
      <CardHeader>
        <CardTitle>{t('mockConnectorList.connectionTitle')}</CardTitle>
        <CardDescription>
          {oauth
            ? t('mockConnectorList.connectionOauth', { publisher })
            : t('mockConnectorList.connectionKey', { name })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state === 'failed' && connection?.error === 'cancelled' && (
          <Banner tone="warning" title={t('mockConnectorList.cancelledTitle')}>
            {t('mockConnectorList.cancelledBody')}
          </Banner>
        )}
        {state === 'failed' && connection?.error === 'unreachable' && (
          <Banner tone="warning" title={t('mockConnectorList.unreachableTitle', { name })}>
            {t('mockConnectorList.unreachableBody', { publisher })}
          </Banner>
        )}
        {state === 'waiting' && (
          <div
            className="flex flex-col gap-3 rounded-lg border px-3 py-3"
            data-testid="partner-waiting"
            aria-live="polite"
          >
            <span className="flex items-center gap-2 font-medium">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              {t('mockConnectorList.waitingTitle')}
            </span>
            <p className="text-sm text-muted-foreground">
              {t('mockConnectorList.waitingBody', { name })}
            </p>
            <div className="flex flex-wrap gap-2">
              {connection?.signInUrl && (
                <Button asChild size="touch" variant="outline">
                  <a href={connection.signInUrl} target="_blank" rel="noopener noreferrer">
                    {t('mockConnectorList.openSignInAgain')}
                    <ExternalLink aria-hidden />
                  </a>
                </Button>
              )}
              <Button
                size="touch"
                variant="ghost"
                onClick={() => action.mutate({ kind: 'cancel', id: entry.id })}
              >
                {t('mockConnectorList.cancel')}
              </Button>
            </div>
          </div>
        )}
        {state === 'connected' && connection && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-muted-foreground">
                  {connection.keyEnd ? t('mockConnectorList.key') : t('mockConnectorList.account')}
                </span>
                <span className="font-medium break-all">
                  {connection.keyEnd
                    ? t('mockConnectorList.keyEnding', { end: connection.keyEnd })
                    : connection.account}
                </span>
              </div>
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone="success" />
                {t('mockConnectors.status.connected')}
              </span>
            </div>
            {connection.connectedAt && (
              <p className="text-sm text-muted-foreground">
                {t('mockConnectorList.connectedSince', {
                  when: formatRelative(connection.connectedAt),
                })}{' '}
                <Button
                  variant="link"
                  className="h-auto p-0 align-baseline"
                  onClick={onOpenSettings}
                >
                  {t('mockConnectors.gc.openSettings')}
                </Button>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {!oauth && listed && (
                <Button size="touch" variant="outline" onClick={() => setKeyDialog(true)}>
                  <KeyRound aria-hidden />
                  {t('mockConnectorList.replaceKey')}
                </Button>
              )}
              <Button size="touch" variant="outline" onClick={() => setConfirmDisconnect(true)}>
                {t('mockCalendar.disconnect')}
              </Button>
            </div>
          </>
        )}
        {state !== 'connected' && state !== 'waiting' && (
          <>
            <p className="flex items-start gap-2 text-sm" data-testid="privacy-before-connect">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{pick(entry.privacy, i18n.language)}</span>
            </p>
            <Button
              size="touch"
              className="self-start"
              disabled={action.isPending}
              onClick={connect}
              data-testid="partner-connect"
            >
              {action.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : oauth ? (
                <LogIn aria-hidden />
              ) : (
                <KeyRound aria-hidden />
              )}
              {state === 'failed'
                ? t('mockConnectorList.tryAgain')
                : oauth
                  ? t('mockConnectorList.connectOauth', { name })
                  : t('mockConnectorList.connectKey')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {oauth
                ? t('mockConnectorList.oauthHint', { publisher })
                : t('mockConnectorList.keyHint', { name })}
            </p>
          </>
        )}
        {action.error && <Banner tone="danger">{errorMessage(action.error)}</Banner>}
        <div
          className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
          data-testid="mock-partner-controls"
        >
          <Badge variant="outline" className="self-start">
            {t('mockSuggest.mockControls')}
          </Badge>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span id={mockId} className="text-sm font-medium">
              {t('mockConnectorList.mock.server', { publisher })}
            </span>
            <SegmentedControl<'up' | 'down'>
              size="sm"
              aria-labelledby={mockId}
              value={reachable ? 'up' : 'down'}
              onValueChange={(v) =>
                action.mutate({ kind: 'scenario', body: { partnerReachable: v === 'up' } })
              }
              options={[
                { value: 'up', label: t('mockConnectorList.mock.reachable') },
                { value: 'down', label: t('mockConnectorList.mock.unreachable') },
              ]}
            />
          </div>
          {!oauth && (
            <p className="text-sm text-muted-foreground">{t('mockConnectorList.mock.keyRule')}</p>
          )}
        </div>
      </CardContent>
      {!oauth && (
        <ApiKeyDialog
          entry={entry}
          open={keyDialog}
          onOpenChange={setKeyDialog}
          replacing={state === 'connected'}
        />
      )}
      <ConfirmDialog
        open={confirmDisconnect}
        title={t('mockConnectorList.disconnectTitle', { name })}
        confirmLabel={t('mockCalendar.disconnect')}
        danger
        loading={action.isPending}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          action.mutate(
            { kind: 'disconnect', id: entry.id },
            {
              onSuccess: () => {
                setConfirmDisconnect(false);
                toast.success(t('mockConnectorList.disconnected', { name }));
              },
            },
          )
        }
      >
        {t('mockConnectorList.disconnectBody', { name })}
      </ConfirmDialog>
    </Card>
  );
}

/** The API key dialog: label, where to find it, paste, Test, Save. */
function ApiKeyDialog({
  entry,
  open,
  onOpenChange,
  replacing,
}: {
  entry: ListEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replacing: boolean;
}) {
  const { t, i18n } = useTranslation('admin');
  const keyAction = useApiKeyAction();
  const [key, setKey] = useState('');
  const [result, setResult] = useState<{ value: KeyResult; tested: string } | null>(null);
  const auth = entry.auth?.type === 'api_key' ? entry.auth : null;
  const close = (next: boolean) => {
    if (!next) {
      setKey('');
      setResult(null);
      keyAction.reset();
    }
    onOpenChange(next);
  };
  const run = (save: boolean) =>
    keyAction.mutate(
      { id: entry.id, key, save },
      {
        onSuccess: (data) => {
          setResult({ value: data.result, tested: key });
          if (save && data.result === 'ok') {
            close(false);
            toast.success(t('mockConnectorList.connectedToast', { name: entry.name }));
          }
        },
      },
    );
  const shown = result && result.tested === key ? result.value : null;
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={close}
      title={
        replacing
          ? t('mockConnectorList.replaceKeyTitle', { name: entry.name })
          : t('mockConnectorList.keyDialogTitle', { name: entry.name })
      }
      description={t('mockConnectorList.keyDialogBody', { name: entry.name })}
      footer={
        <>
          <Button size="touch" variant="outline" onClick={() => close(false)}>
            {t('mockConnectorList.cancel')}
          </Button>
          <Button
            size="touch"
            variant="outline"
            disabled={!key.trim() || keyAction.isPending}
            onClick={() => run(false)}
            data-testid="key-test"
          >
            {t('mockConnectorList.testKey')}
          </Button>
          <Button
            size="touch"
            disabled={!key.trim() || keyAction.isPending}
            onClick={() => run(true)}
            data-testid="key-save"
          >
            {keyAction.isPending && <Loader2 className="animate-spin" aria-hidden />}
            {t('mockConnectorList.saveKey')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2" data-testid="api-key-dialog">
        <Field
          label={pick(auth?.label, i18n.language) || t('mockConnectorList.key')}
          error={
            shown === 'refused'
              ? t('mockConnectorList.keyRefused', { name: entry.name })
              : undefined
          }
          hint={t('mockConnectorList.keyStored')}
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              maxLength={512}
              className="min-h-11 font-mono"
              onChange={(e) => setKey(e.target.value)}
              data-testid="api-key-input"
            />
          )}
        </Field>
        {auth?.help && (
          <a
            href={auth.help}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-primary underline-offset-4 hover:underline md:min-h-0"
          >
            {t('mockConnectorList.whereKey', { name: entry.name })}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
        {shown === 'ok' && (
          <p className="flex items-center gap-2 text-sm text-success" role="status">
            <CheckCircle2 className="size-4" aria-hidden />
            {t('mockConnectorList.keyWorks')}
          </p>
        )}
        {shown === 'unreachable' && (
          <Banner
            tone="warning"
            title={t('mockConnectorList.unreachableTitle', { name: entry.name })}
          >
            {t('mockConnectorList.keyUnreachable', { name: entry.name })}
          </Banner>
        )}
        {keyAction.error && <Banner tone="danger">{errorMessage(keyAction.error)}</Banner>}
      </div>
    </ResponsiveDialog>
  );
}

/** Settings for one AI agent: the entry's form, one switch per tool, the rules. */
function PartnerAgentCard({
  entry,
  connection,
  agentId,
  agentName,
}: {
  entry: ListEntry;
  connection: PartnerConnection;
  agentId: string;
  agentName: string;
}) {
  const { t, i18n } = useTranslation('admin');
  const action = useConnectorListAction();
  const saved = choiceFor(connection, agentId);
  const [draft, setDraft] = useState<AgentChoice>();
  const value = draft ?? saved;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
  const setSetting = (id: string, v: unknown) =>
    setDraft({ ...value, settings: { ...value.settings, [id]: v } });
  const setTool = (name: string, on: boolean) =>
    setDraft({ ...value, tools: { ...value.tools, [name]: on } });
  const save = () =>
    action.mutate(
      { kind: 'agent', id: entry.id, agentId, choice: value },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast.success(t('mockConnectorList.saved'));
        },
      },
    );
  const settings = entry.settings ?? [];
  return (
    <Card className="gap-4" data-testid="partner-agent-settings">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>
            {t('mockConnectorList.agentTitle', { name: entry.name, agent: agentName })}
          </CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockConnectorList.agentHint', { agent: agentName })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {settings.length > 0 && (
          <div className="flex flex-col gap-4" data-testid="entry-settings">
            {settings.map((s) => (
              <SettingField
                key={s.id}
                setting={s}
                value={value.settings[s.id]}
                choices={connection.choices[s.id] ?? []}
                onChange={(v) => setSetting(s.id, v)}
              />
            ))}
          </div>
        )}

        <section className="flex flex-col gap-2" aria-labelledby={`tools-${entry.id}`}>
          <h3 id={`tools-${entry.id}`} className="text-sm font-medium">
            {t('mockConnectorList.toolsTitle', { agent: agentName })}
          </h3>
          <div className="flex flex-col divide-y rounded-lg border" data-testid="tool-switches">
            {(entry.tools ?? []).map((tool) => (
              <ToolSwitch
                key={tool.name}
                tool={tool}
                on={Boolean(value.tools[tool.name])}
                onChange={(on) => setTool(tool.name, on)}
              />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{t('mockConnectorList.toolsNote')}</p>
        </section>

        <GuardRules entry={entry} settings={settings} language={i18n.language} />

        {action.error && <Banner tone="danger">{errorMessage(action.error)}</Banner>}
        <SaveBar dirty={dirty}>
          <Button size="touch" disabled={!dirty || action.isPending} onClick={save}>
            {t('mockConnectorList.save')}
          </Button>
        </SaveBar>
      </CardContent>
    </Card>
  );
}

function ToolSwitch({
  tool,
  on,
  onChange,
}: {
  tool: ListTool;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t, i18n } = useTranslation('admin');
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-3">
      <div className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id}>{pick(tool.title, i18n.language)}</Label>
          <Badge variant="secondary">
            {t(tool.access === 'read' ? 'mockConnectors.lookUp' : 'mockConnectors.changes')}
          </Badge>
        </span>
        <p className="mt-1 text-sm text-muted-foreground">
          {pick(tool.description, i18n.language)}
        </p>
      </div>
      <Label htmlFor={id} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
        <Switch id={id} checked={on} onCheckedChange={onChange} />
      </Label>
    </div>
  );
}

/** One field of the entry's settings form (text, select, toggle, days, time range, calendar). */
function SettingField({
  setting,
  value,
  choices,
  onChange,
}: {
  setting: ListSetting;
  value: unknown;
  choices: Array<{ value: string; label: string }>;
  onChange: (value: unknown) => void;
}) {
  const { t, i18n } = useTranslation('admin');
  const ids = { toggle: useId(), from: useId(), to: useId() };
  const label = pick(setting.label, i18n.language);
  const hint = setting.hint ? pick(setting.hint, i18n.language) : undefined;
  if (setting.type === 'toggle')
    return (
      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-3">
        <div className="min-w-0">
          <Label htmlFor={ids.toggle}>{label}</Label>
          {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
        </div>
        <Label
          htmlFor={ids.toggle}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
        >
          <Switch id={ids.toggle} checked={Boolean(value)} onCheckedChange={onChange} />
        </Label>
      </div>
    );
  if (setting.type === 'days') {
    const days = Array.isArray(value) ? (value as number[]) : [];
    const dayName = (day: number) =>
      new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(
        new Date(2026, 0, 4 + day), // 4 Jan 2026 is a Sunday
      );
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{label}</legend>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((day) => {
            const id = `${setting.id}-day-${day}`;
            return (
              <Label
                key={day}
                htmlFor={id}
                className="flex min-h-11 items-center gap-2 rounded-md border px-3"
              >
                <Checkbox
                  id={id}
                  checked={days.includes(day)}
                  onCheckedChange={(on) =>
                    onChange(on ? [...days, day] : days.filter((d) => d !== day))
                  }
                />
                {dayName(day)}
              </Label>
            );
          })}
        </div>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </fieldset>
    );
  }
  if (setting.type === 'timeRange') {
    const [from, to] = Array.isArray(value) ? (value as string[]) : ['', ''];
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{label}</legend>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.from}>{t('mockCalendar.from')}</Label>
            <Input
              id={ids.from}
              type="time"
              value={from}
              className="min-h-11 w-36"
              onChange={(e) => onChange([e.target.value, to])}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.to}>{t('mockCalendar.to')}</Label>
            <Input
              id={ids.to}
              type="time"
              value={to}
              className="min-h-11 w-36"
              onChange={(e) => onChange([from, e.target.value])}
            />
          </div>
        </div>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </fieldset>
    );
  }
  if (setting.type === 'select' || setting.type === 'calendarPicker') {
    const options =
      setting.type === 'calendarPicker'
        ? choices
        : (setting.options ?? []).map((o) => ({
            value: o.value,
            label: pick(o.label, i18n.language),
          }));
    return (
      <Field label={label} hint={hint}>
        {(p) => (
          <Select value={String(value ?? '')} onValueChange={onChange}>
            <SelectTrigger
              {...p}
              className="min-h-11 w-full sm:w-80 *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate"
            >
              <SelectValue placeholder={t('mockConnectorList.choose')} />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    );
  }
  return (
    <Field label={label} hint={hint}>
      {(p) => (
        <Input
          {...p}
          value={String(value ?? '')}
          maxLength={120}
          className="min-h-11"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** "Rules the AI always follows": the core rules and each tool's declared guards in plain words. */
function GuardRules({
  entry,
  settings,
  language,
}: {
  entry: ListEntry;
  settings: ListSetting[];
  language: string;
}) {
  const { t, i18n } = useTranslation('admin');
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const tools = entry.tools ?? [];
  const title = (name: string) => {
    const tool = tools.find((x) => x.name === name);
    return tool ? pick(tool.title, language) : name;
  };
  const publisher = entry.publisher ?? entry.name;
  const writes = tools.filter((tool) => tool.access === 'write');
  const field = (path: string) => {
    const last = path.split('.').pop() ?? path;
    return ['name', 'email', 'phone'].includes(last) ? tc(`mockConnectorList.field.${last}`) : last;
  };
  const settingLabel = (ref: string) => {
    const id = ref.replace(/^settings\./, '');
    const s = settings.find((x) => x.id === id);
    return s ? pick(s.label, language) : id;
  };
  return (
    <div
      className="rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground"
      data-testid="guard-rules"
    >
      <p className="mb-1 flex items-center gap-2 font-medium text-foreground">
        <ShieldCheck className="size-4" aria-hidden />
        {t('mockConnectorList.rulesTitle')}
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>{t('mockConnectorList.rule.asDescribed', { publisher })}</li>
        <li>{t('mockConnectorList.rule.noUndo')}</li>
        {writes.length > 0 && <li>{t('mockConnectorList.rule.writeOff')}</li>}
      </ul>
      {writes
        .filter((tool) => tool.guards)
        .map((tool) => {
          const g = tool.guards!;
          const lines: string[] = [];
          if (g.confirmFirst) lines.push(t('mockConnectorList.rule.confirmFirst'));
          for (const from of Object.values(g.valueFrom ?? {}))
            lines.push(t('mockConnectorList.rule.valueFrom', { lookUp: title(from) }));
          if (g.fromCustomer?.length)
            lines.push(
              t('mockConnectorList.rule.fromCustomer', {
                // "name and email", "name, email, and phone": the list format of the UI language.
                fields: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format([
                  ...new Set(g.fromCustomer.map(field)),
                ]),
              }),
            );
          if (g.within)
            lines.push(
              t('mockConnectorList.rule.within', {
                settings: [...new Set(Object.values(g.within).map(settingLabel))].join(', '),
              }),
            );
          if (g.limits)
            lines.push(
              t('mockConnectorList.rule.limits', {
                perChat: g.limits.perChat ?? '–',
                perDay: g.limits.perDay ?? '–',
              }),
            );
          return (
            <div key={tool.name} className="mt-3">
              <p className="font-medium text-foreground">
                {t('mockConnectorList.rulesFor', { tool: pick(tool.title, language) })}
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          );
        })}
    </div>
  );
}

const ACTIVITY_ICON = {
  checked: Search,
  done: CheckCircle2,
  refused: ShieldAlert,
  failed: TriangleAlert,
} as const;

/** Activity: tool calls (checked, done, refused with the reason, failed), never chat text. */
function PartnerActivityList({ entry, rows }: { entry: ListEntry; rows: PartnerActivity[] }) {
  const { t, i18n } = useTranslation('admin');
  const tc = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('mockConnectors.activityEmpty')}
        description={t('mockConnectorList.activityHint', { name: entry.name })}
      />
    );
  const toolTitle = (name: string) => {
    const tool = entry.tools?.find((x) => x.name === name);
    return tool ? pick(tool.title, i18n.language) : name;
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockConnectors.activityTitle')}</CardTitle>
        <CardDescription>
          {t('mockConnectorList.activityHint', { name: entry.name })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y" data-testid="partner-activity">
          {rows.map((r) => {
            const Icon = ACTIVITY_ICON[r.kind];
            return (
              <li key={`${r.at}-${r.kind}`} className="flex items-start gap-3 py-3 first:pt-0">
                <Icon
                  className={
                    r.kind === 'failed'
                      ? 'mt-0.5 size-4 shrink-0 text-danger'
                      : r.kind === 'refused'
                        ? 'mt-0.5 size-4 shrink-0 text-warning'
                        : 'mt-0.5 size-4 shrink-0 text-muted-foreground'
                  }
                  aria-hidden
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium break-words">
                      {t('mockConnectorList.actLine', {
                        tool: toolTitle(r.tool),
                        customer: r.customer,
                      })}
                    </span>
                    <Badge
                      variant={r.kind === 'done' ? 'default' : 'outline'}
                      className={
                        r.kind === 'refused'
                          ? 'border-warning text-warning'
                          : r.kind === 'failed'
                            ? 'border-danger text-danger'
                            : undefined
                      }
                    >
                      {tc(`mockConnectorList.act.${r.kind}`)}
                    </Badge>
                  </span>
                  {r.reason && (
                    <span className="text-sm break-words text-muted-foreground">
                      {tc(`mockConnectorList.reason.${r.reason}`, {
                        publisher: entry.publisher ?? entry.name,
                      })}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {t('mockConnectorList.actBy', {
                      agent: r.agent,
                      when: formatRelative(r.at),
                    })}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

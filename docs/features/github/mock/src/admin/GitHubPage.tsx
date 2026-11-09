import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Banner, EmptyState, ResponsiveDialog, StatusDot } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { SearchField } from '@/components/app/SearchField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';
import { CONNECTORS } from '@/mock/connectorCatalog';
import {
  ACCESSIBLE_REPOS,
  APP_SLUG,
  DEVICE_CODE,
  MAX_REPOS,
  checkToken,
  githubActions,
  githubSettingsFor,
  githubStatus,
  manageOnGitHubUrl,
  repoName,
  usableRepos,
  useGitHub,
  type GitHubAgentSettings,
  type GitHubRepo,
} from '@/mock/github';
import { AgentSettings, ConnectorBreadcrumb } from './ConnectorDetailPage';
import { ConnectorIcon, ConnectorStatusBadge } from './ConnectorsGalleryPage';
import { ConfirmDialog } from './adminUi';

const TABS = ['overview', 'settings', 'activity'] as const;
type Tab = (typeof TABS)[number];

/**
 * Proposed (github): `/admin/connectors/github`, built like the Google Drive page: Overview (what it
 * does, GitHub sign-in with the App or a token, your data), Settings (per AI agent: repositories,
 * Issues, Pull requests) and Activity (who and when, never titles or text).
 */
export function GitHubPage() {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();
  const gh = useGitHub();
  const c = CONNECTORS.find((x) => x.id === 'github')!;
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
  const ready = gh.state !== 'disconnected' && gh.state !== 'noInstall';
  return (
    <div className="flex flex-col gap-4" data-testid="connector-page-github">
      <ConnectorBreadcrumb name={t('mockGitHub.name')} />
      <div className="flex items-start gap-4">
        <ConnectorIcon c={c} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words">
              {t('mockGitHub.name')}
            </h1>
            <ConnectorStatusBadge status={githubStatus(gh.state)} />
            <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('mockConnectors.byCore')} · {t('mockConnectors.category.other')}
          </p>
        </div>
      </div>
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
          <About />
          <AccountCard onOpenSettings={() => setTab('settings')} />
          <Card className="gap-3">
            <CardHeader>
              <CardTitle>{t('mockConnectors.privacyTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>{t('mockGitHub.privacy1')}</p>
              <p>{t('mockGitHub.privacy2')}</p>
              <p>{t('mockGitHub.privacy3')}</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="settings" className="flex flex-col gap-4">
          {ready ? (
            <AgentSettings
              render={(agent) => (
                <GitHubSettingsCard key={agent.id} agentId={agent.id} name={agent.name} />
              )}
            />
          ) : (
            <EmptyState
              title={t('mockGitHub.settings.notConnected')}
              description={t('mockGitHub.settings.notConnectedHint')}
              action={
                <Button size="touch" onClick={() => setTab('overview')}>
                  {t('mockGitHub.signIn')}
                </Button>
              }
            />
          )}
        </TabsContent>
        <TabsContent value="activity" className="flex flex-col gap-4">
          <Activity />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function About() {
  const { t } = useTranslation('admin');
  const tools = ['searchIssues', 'listIssues', 'readIssue', 'searchPulls'] as const;
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('mockConnectors.aboutTitle')}</CardTitle>
        <CardDescription>{t('mockGitHub.long')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t('mockConnectors.aiCan')}</p>
        <ul className="flex flex-col divide-y rounded-lg border">
          {tools.map((key) => (
            <li key={key} className="flex flex-col gap-1 px-3 py-3">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`mockGitHub.tools.${key}`)}</span>
                <Badge variant="secondary">{t('mockConnectors.lookUp')}</Badge>
              </span>
              <span className="text-sm text-muted-foreground">
                {t(`mockGitHub.tools.${key}Hint`)}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{t('mockGitHub.neverChanges')}</p>
      </CardContent>
    </Card>
  );
}

type DeviceStep = 'waiting' | 'denied' | 'expired';

/** The GitHub account card: two ways to sign in, the App install step, states and disconnect. */
function AccountCard({ onOpenSettings }: Readonly<{ onOpenSettings: () => void }>) {
  const { t } = useTranslation('admin');
  const gh = useGitHub();
  const mockId = useId();
  const tokenId = useId();
  const [device, setDevice] = useState<DeviceStep | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<null | 'classic' | 'invalid' | 'noRepos'>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const state = gh.state;
  const tone =
    state === 'connected'
      ? 'success'
      : state === 'disconnected'
        ? 'muted'
        : state === 'expiring' || state === 'noInstall'
          ? 'info'
          : 'warning';
  const approve = (installed: boolean) => {
    githubActions.signedInWithApp(installed);
    setDevice(null);
    toast.success(t('mockGitHub.signedIn', { login: 'kopiapong-dev' }));
  };
  const saveToken = () => {
    const result = checkToken(token);
    if (result !== 'ok') return setTokenError(result);
    githubActions.savedToken();
    setTokenOpen(false);
    setToken('');
    setTokenError(null);
    toast.success(t('mockGitHub.signedIn', { login: 'kopiapong-dev' }));
  };
  const openToken = () => {
    setToken('');
    setTokenError(null);
    setTokenOpen(true);
  };
  const expiresOn = gh.tokenExpiresAt
    ? new Date(gh.tokenExpiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : '';
  return (
    <Card data-testid="github-account">
      <CardHeader>
        <CardTitle>{t('mockGitHub.accountTitle')}</CardTitle>
        <CardDescription>{t('mockGitHub.accountDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state === 'disconnected' ? (
          <>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {(['what1', 'what2', 'what3'] as const).map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {t(`mockGitHub.${key}`)}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button size="touch" onClick={() => setDevice('waiting')}>
                <GitPullRequest aria-hidden />
                {t('mockGitHub.signIn')}
              </Button>
              <Button variant="link" className="h-auto min-h-11 p-0" onClick={openToken}>
                {t('mockGitHub.useToken')}
              </Button>
            </div>
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              {t('mockGitHub.signInHint')}
              <InfoTip topic="githubApp" />
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-muted-foreground">
                  {t(gh.method === 'token' ? 'mockGitHub.viaToken' : 'mockGitHub.viaApp')}
                </span>
                <span className="font-medium break-all">{gh.login}</span>
                {gh.method === 'token' && expiresOn && (
                  <span className="text-xs text-muted-foreground">
                    {t(
                      state === 'expired' ? 'mockGitHub.tokenExpired' : 'mockGitHub.tokenExpires',
                      { date: expiresOn },
                    )}
                  </span>
                )}
              </div>
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={tone} />
                {t(`mockGitHub.state.${state}`)}
              </span>
            </div>
            {state === 'noInstall' && (
              <Banner tone="info" title={t('mockGitHub.install.title')}>
                <span className="flex flex-col items-start gap-2">
                  {t('mockGitHub.install.body')}
                  <span className="flex flex-wrap gap-2">
                    <Button asChild size="touch">
                      <a
                        href={`https://github.com/apps/${APP_SLUG}/installations/new`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink aria-hidden />
                        {t('mockGitHub.install.button')}
                      </a>
                    </Button>
                    <Button size="touch" variant="outline" onClick={githubActions.installed}>
                      <RefreshCw aria-hidden />
                      {t('mockGitHub.install.check')}
                    </Button>
                  </span>
                  <span className="text-xs">{t('mockGitHub.install.orgNote')}</span>
                </span>
              </Banner>
            )}
            {state === 'expiring' && (
              <Banner tone="info" title={t('mockGitHub.expiringTitle', { date: expiresOn })}>
                <span className="flex flex-col items-start gap-2">
                  {t('mockGitHub.expiringBody')}
                  <Button size="touch" variant="outline" onClick={openToken}>
                    <KeyRound aria-hidden />
                    {t('mockGitHub.newToken')}
                  </Button>
                </span>
              </Banner>
            )}
            {state === 'expired' && (
              <Banner
                tone="warning"
                title={t(
                  gh.method === 'token'
                    ? 'mockGitHub.expiredTokenTitle'
                    : 'mockGitHub.expiredTitle',
                )}
              >
                <span className="flex flex-col items-start gap-2">
                  {t('mockGitHub.expiredBody')}
                  <Button
                    size="touch"
                    variant="outline"
                    onClick={() => (gh.method === 'token' ? openToken() : setDevice('waiting'))}
                  >
                    {t(gh.method === 'token' ? 'mockGitHub.newToken' : 'mockGitHub.signInAgain')}
                  </Button>
                </span>
              </Banner>
            )}
            {state === 'unavailable' && (
              <Banner tone="warning" title={t('mockGitHub.unavailableTitle')}>
                {t('mockGitHub.unavailableBody')}
              </Banner>
            )}
            {state !== 'noInstall' && (
              <p className="text-sm text-muted-foreground">
                {t('mockGitHub.reposShared', { count: ACCESSIBLE_REPOS.length })}{' '}
                <a
                  href={manageOnGitHubUrl(gh.method)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {t('mockGitHub.changeOnGitHub')}
                </a>
                {'. '}
                {t('mockGitHub.perAgent')}{' '}
                <Button
                  variant="link"
                  className="h-auto p-0 align-baseline"
                  onClick={onOpenSettings}
                >
                  {t('mockConnectors.gc.openSettings')}
                </Button>
              </p>
            )}
            <Button
              size="touch"
              variant="outline"
              className="self-start"
              onClick={() => setConfirmDisconnect(true)}
            >
              {t('mockCalendar.disconnect')}
            </Button>
            <div
              className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
              data-testid="mock-github-controls"
            >
              <Badge variant="outline" className="self-start">
                {t('mockSuggest.mockControls')}
              </Badge>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span id={mockId} className="text-sm font-medium">
                  {t('mockGitHub.mockGitHub')}
                </span>
                <span role="group" aria-labelledby={mockId} className="flex flex-wrap gap-2">
                  {(
                    [
                      ['connected', 'mockCalendar.mockOk'],
                      ...(gh.method === 'token'
                        ? ([['expiring', 'mockGitHub.mockExpiring']] as const)
                        : []),
                      ['expired', 'mockCalendar.mockExpired'],
                      ['unavailable', 'mockGitHub.mockDown'],
                    ] as const
                  ).map(([value, key]) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={state === value ? 'default' : 'outline'}
                      aria-pressed={state === value}
                      className="min-h-9 pointer-coarse:min-h-11"
                      onClick={() => githubActions.setState(value)}
                    >
                      {t(key)}
                    </Button>
                  ))}
                </span>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <ResponsiveDialog
        open={device !== null}
        onOpenChange={(open) => !open && setDevice(null)}
        title={t('mockGitHub.device.title')}
        description={t('mockGitHub.device.description')}
        footer={
          <Button size="touch" variant="outline" onClick={() => setDevice(null)}>
            {t('mockCalendar.consentCancel')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4 pb-2" data-testid="github-device">
          {device === 'waiting' ? (
            <>
              <ol className="flex flex-col gap-3 text-sm">
                <li className="flex flex-col gap-2">
                  <span>{t('mockGitHub.device.step1')}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <code
                      className="rounded-lg border bg-muted px-4 py-2 font-mono text-2xl font-semibold tracking-widest"
                      data-testid="github-device-code"
                    >
                      {DEVICE_CODE}
                    </code>
                    <Button
                      size="touch"
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard?.writeText(DEVICE_CODE).catch(() => {});
                        toast.success(t('mockGitHub.device.copied'));
                      }}
                    >
                      <Copy aria-hidden />
                      {t('mockGitHub.device.copy')}
                    </Button>
                  </span>
                </li>
                <li className="flex flex-col items-start gap-2">
                  <span>{t('mockGitHub.device.step2')}</span>
                  <Button asChild size="touch">
                    <a href="https://github.com/login/device" target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden />
                      {t('mockGitHub.device.open')}
                    </a>
                  </Button>
                </li>
              </ol>
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <RefreshCw
                  className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                {t('mockGitHub.device.waiting')}
              </p>
            </>
          ) : (
            <Banner
              tone="warning"
              title={t(
                device === 'denied'
                  ? 'mockGitHub.device.deniedTitle'
                  : 'mockGitHub.device.expiredTitle',
              )}
            >
              <span className="flex flex-col items-start gap-2">
                {t(
                  device === 'denied'
                    ? 'mockGitHub.device.deniedBody'
                    : 'mockGitHub.device.expiredBody',
                )}
                <Button size="touch" variant="outline" onClick={() => setDevice('waiting')}>
                  {t('mockGitHub.device.again')}
                </Button>
              </span>
            </Banner>
          )}
          <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-2">
            <Badge variant="outline" className="self-start">
              {t('mockSuggest.mockControls')}
            </Badge>
            <span className="flex flex-wrap gap-2">
              {(
                [
                  ['approve', () => approve(true)],
                  ['approveNoInstall', () => approve(false)],
                  ['deny', () => setDevice('denied')],
                  ['expire', () => setDevice('expired')],
                ] as const
              ).map(([key, run]) => (
                <Button
                  key={key}
                  size="sm"
                  variant="outline"
                  className="min-h-9 pointer-coarse:min-h-11"
                  onClick={run}
                >
                  {t(`mockGitHub.device.mock.${key}`)}
                </Button>
              ))}
            </span>
          </div>
        </div>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={tokenOpen}
        onOpenChange={setTokenOpen}
        title={t('mockGitHub.token.title')}
        description={t('mockGitHub.token.description')}
        footer={
          <>
            <Button size="touch" variant="outline" onClick={() => setTokenOpen(false)}>
              {t('mockCalendar.consentCancel')}
            </Button>
            <Button size="touch" disabled={!token.trim()} onClick={saveToken}>
              {t('mockGitHub.token.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 pb-2" data-testid="github-token">
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
            <li>
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('mockGitHub.token.step1')}
              </a>
            </li>
            <li>{t('mockGitHub.token.step2')}</li>
            <li>{t('mockGitHub.token.step3')}</li>
            <li>{t('mockGitHub.token.step4')}</li>
          </ol>
          <div className="flex flex-col gap-2">
            <Label htmlFor={tokenId} className="flex items-center gap-1">
              {t('mockGitHub.token.label')}
              <InfoTip topic="githubToken" />
            </Label>
            <Input
              id={tokenId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_…"
              value={token}
              aria-invalid={tokenError !== null}
              onChange={(e) => {
                setToken(e.target.value);
                setTokenError(null);
              }}
              className="h-11 font-mono text-base md:text-sm"
            />
            {tokenError && (
              <p className="text-sm text-danger" role="alert">
                {t(`mockGitHub.token.error.${tokenError}`)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('mockGitHub.token.readOnly')}</p>
          </div>
          <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="mr-2">
              {t('mockSuggest.mockControls')}
            </Badge>
            {t('mockGitHub.token.mockHint')}
          </p>
        </div>
      </ResponsiveDialog>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title={t('mockGitHub.disconnectTitle')}
        confirmLabel={t('mockCalendar.disconnect')}
        danger
        onConfirm={() => {
          githubActions.disconnect();
          setConfirmDisconnect(false);
        }}
      >
        <p className="text-sm text-muted-foreground">
          {t(gh.method === 'token' ? 'mockGitHub.disconnectToken' : 'mockGitHub.disconnectApp')}
        </p>
      </ConfirmDialog>
    </Card>
  );
}

/** Settings tab, one AI agent: its repositories, Issues and Pull requests, with a Save bar. */
function GitHubSettingsCard({ agentId, name }: Readonly<{ agentId: string; name: string }>) {
  const { t } = useTranslation('admin');
  const gh = useGitHub();
  const saved = githubSettingsFor(gh, agentId);
  const [draft, setDraft] = useState<GitHubAgentSettings>(saved);
  const [picker, setPicker] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [query, setQuery] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const paused = gh.state === 'expired' || gh.state === 'unavailable';
  const update = (next: Partial<GitHubAgentSettings>) => setDraft((d) => ({ ...d, ...next }));
  const hasRepos = draft.repos.length > 0;
  const q = query.trim().toLowerCase();
  const choosable = ACCESSIBLE_REPOS.filter(
    (r) => !draft.repos.some((x) => x.id === r.id) && (!q || repoName(r).toLowerCase().includes(q)),
  );
  const owners = [...new Set(choosable.map((r) => r.owner))];
  const room = MAX_REPOS - draft.repos.length;
  return (
    <div className="flex flex-col gap-4" data-testid="github-settings">
      {paused && (
        <Banner tone="warning" title={t('mockGitHub.pausedTitle')}>
          {t(gh.state === 'expired' ? 'mockGitHub.pausedExpired' : 'mockGitHub.pausedDown', {
            name,
          })}
        </Banner>
      )}
      <Card className="gap-4" data-testid="github-repos">
        <CardHeader>
          <CardTitle>{t('mockGitHub.repos.title')}</CardTitle>
          <CardDescription>{t('mockGitHub.repos.description', { name })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {hasRepos ? (
            <ul className="flex flex-col divide-y rounded-lg border" data-testid="github-repo-list">
              {draft.repos.map((r) => {
                const gone = gh.revoked.includes(r.id);
                return (
                  <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                    {gone ? (
                      <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
                    ) : r.private ? (
                      <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <CircleDot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium break-all">{repoName(r)}</span>
                      <span className="text-xs text-muted-foreground">
                        {gone
                          ? t('mockGitHub.repos.gone', { name })
                          : t(r.private ? 'mockGitHub.repos.private' : 'mockGitHub.repos.public')}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 md:size-9"
                      aria-label={t('mockGitHub.repos.remove', { repo: repoName(r) })}
                      onClick={() => update({ repos: draft.repos.filter((x) => x.id !== r.id) })}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('mockGitHub.repos.none', { name })}</p>
          )}
          <Button
            variant={hasRepos ? 'outline' : 'default'}
            size="touch"
            className="self-start"
            disabled={room <= 0}
            onClick={() => {
              setPicked([]);
              setQuery('');
              setPicker(true);
            }}
          >
            <GitPullRequest aria-hidden />
            {t('mockGitHub.repos.choose')}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t('mockGitHub.repos.hint', { max: MAX_REPOS })}
          </p>
          {hasRepos && (
            <Banner tone="info" title={t('mockGitHub.repos.whoTitle')}>
              {t('mockGitHub.repos.whoBody', { name })}
            </Banner>
          )}
        </CardContent>
      </Card>

      <Card className="gap-4" data-testid="github-access">
        <CardHeader>
          <CardTitle>{t('mockGitHub.access.title', { name })}</CardTitle>
          <CardDescription>{t('mockGitHub.access.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col divide-y rounded-lg border">
            {(['issues', 'pulls'] as const).map((key) => (
              <div key={key} className="flex items-start justify-between gap-4 px-3 py-3">
                <span className="flex flex-col gap-0.5">
                  <Label htmlFor={`${key}-${agentId}`} className="font-medium">
                    {t(`mockGitHub.access.${key}`)}
                  </Label>
                  <span className="text-sm text-muted-foreground">
                    {t(`mockGitHub.access.${key}Hint`)}
                  </span>
                </span>
                <Switch
                  id={`${key}-${agentId}`}
                  checked={draft[key]}
                  disabled={!hasRepos}
                  onCheckedChange={(on) => update({ [key]: on })}
                />
              </div>
            ))}
          </div>
          {!hasRepos && <p className="text-sm text-muted-foreground">{t('mockGitHub.needRepo')}</p>}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground" data-testid="github-instructions-note">
        {t('mockGitHub.when.note', { name })}{' '}
        <Link
          to={`/admin/members/ai/${agentId}`}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('mockGitHub.when.open', { name })}
        </Link>
      </p>

      {saved.repos.length > 0 && <MockSimulator agentName={name} settings={saved} />}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
        {dirty && (
          <span className="mr-auto text-sm text-muted-foreground">{t('mockDrive.unsaved')}</span>
        )}
        <Button size="touch" variant="outline" disabled={!dirty} onClick={() => setDraft(saved)}>
          {t('mockDrive.discard')}
        </Button>
        <Button
          size="touch"
          disabled={!dirty}
          onClick={() => {
            githubActions.saveAgent(agentId, draft);
            toast.success(t('mockDrive.saved'));
          }}
        >
          {t('mockDrive.saveButton')}
        </Button>
      </div>

      <ResponsiveDialog
        open={picker}
        onOpenChange={setPicker}
        title={t('mockGitHub.picker.title')}
        description={t('mockGitHub.picker.description', { name })}
        footer={
          <>
            <Button size="touch" variant="outline" onClick={() => setPicker(false)}>
              {t('mockCalendar.consentCancel')}
            </Button>
            <Button
              size="touch"
              disabled={picked.length === 0}
              onClick={() => {
                update({
                  repos: [
                    ...draft.repos,
                    ...ACCESSIBLE_REPOS.filter((r) => picked.includes(r.id)),
                  ].slice(0, MAX_REPOS),
                });
                setPicker(false);
              }}
            >
              {t('mockGitHub.picker.add', { count: picked.length })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pb-2" data-testid="github-picker">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchField
                value={query}
                onChange={setQuery}
                label={t('mockGitHub.picker.search')}
                placeholder={t('mockGitHub.picker.search')}
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              className="size-11 shrink-0"
              aria-label={t('mockGitHub.picker.refresh')}
              onClick={() => toast.success(t('mockGitHub.picker.refreshed'))}
            >
              <RefreshCw aria-hidden />
            </Button>
          </div>
          {choosable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(q ? 'mockGitHub.picker.noMatch' : 'mockGitHub.picker.allAdded')}
            </p>
          ) : (
            owners.map((owner) => (
              <div key={owner} className="flex flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">{owner}</p>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {choosable
                    .filter((r) => r.owner === owner)
                    .map((r: GitHubRepo) => {
                      const on = picked.includes(r.id);
                      return (
                        <li key={r.id}>
                          <Label className="flex min-h-11 items-center gap-3 px-3 py-2 font-normal">
                            <Checkbox
                              checked={on}
                              disabled={!on && picked.length >= room}
                              onCheckedChange={(next) =>
                                setPicked((p) =>
                                  next === true ? [...p, r.id] : p.filter((x) => x !== r.id),
                                )
                              }
                            />
                            <span className="min-w-0 flex-1 break-all">{r.name}</span>
                            <Badge variant="secondary">
                              {t(
                                r.private ? 'mockGitHub.repos.private' : 'mockGitHub.repos.public',
                              )}
                            </Badge>
                          </Label>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))
          )}
          <p className="text-sm text-muted-foreground">
            {t('mockGitHub.picker.missing')}{' '}
            <a
              href={manageOnGitHubUrl(gh.method)}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t(
                gh.method === 'token' ? 'mockGitHub.picker.editToken' : 'mockGitHub.picker.editApp',
              )}
            </a>
          </p>
          {draft.repos.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-2">
              <Badge variant="outline" className="self-start">
                {t('mockSuggest.mockControls')}
              </Badge>
              <span className="flex flex-wrap gap-2">
                {draft.repos.map((r) => (
                  <Button
                    key={r.id}
                    size="sm"
                    variant="outline"
                    className="min-h-9 pointer-coarse:min-h-11"
                    onClick={() => githubActions.toggleRevoked(r.id)}
                  >
                    {t(
                      gh.revoked.includes(r.id)
                        ? 'mockGitHub.picker.mockShare'
                        : 'mockGitHub.picker.mockUnshare',
                      { repo: r.name },
                    )}
                  </Button>
                ))}
              </span>
            </div>
          )}
        </div>
      </ResponsiveDialog>
    </div>
  );
}

/**
 * Mock only: what the agent does in a chat with the saved settings (no AI is called): an issue
 * question, a pull request status, a repo it was not given, an issue whose text gives orders.
 */
function MockSimulator({
  agentName,
  settings,
}: Readonly<{ agentName: string; settings: GitHubAgentSettings }>) {
  const { t: typed } = useTranslation('admin');
  // Mock: keys built from the scenario (the app types each key).
  const t = typed as unknown as (key: string, options?: Record<string, unknown>) => string;
  const gh = useGitHub();
  const [lines, setLines] = useState<Array<{ who: 'customer' | 'ai' | 'event'; text: string }>>([]);
  const paused = gh.state === 'expired' || gh.state === 'unavailable';
  const repos = usableRepos(gh, settings);
  const run = (kind: 'issue' | 'pull' | 'other' | 'inject') => {
    const customer = 'Jay Low';
    const next: typeof lines = [];
    const repo = repos[0] ? repoName(repos[0]) : '';
    const say = (who: 'customer' | 'ai' | 'event', key: string) =>
      next.push({ who, text: t(`mockGitHub.sim.${key}`, { name: agentName, repo }) });
    const log = (kind: 'searched' | 'read' | 'refused' | 'failed') =>
      githubActions.addActivity({ at: Date.now(), kind, agent: agentName, customer });
    say('customer', `${kind}Customer`);
    const off = (kind === 'pull' && !settings.pulls) || (kind !== 'pull' && !settings.issues);
    if (paused) {
      say('ai', 'handover');
      say('event', 'handoverLine');
      log('failed');
    } else if (repos.length === 0) {
      say('ai', 'noRepos');
    } else if (kind === 'other') {
      say('event', 'refusedLine');
      say('ai', 'otherReply');
      log('refused');
    } else if (off) {
      say('ai', kind === 'pull' ? 'pullsOff' : 'issuesOff');
    } else {
      say('event', 'lookedUpLine');
      if (kind === 'inject') say('event', 'injectLine');
      say('ai', `${kind}Reply`);
      log(kind === 'issue' ? 'read' : 'searched');
    }
    setLines(next);
  };
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
      data-testid="github-simulator"
    >
      <Badge variant="outline" className="self-start">
        {t('mockSuggest.mockControls')}
      </Badge>
      <p className="text-sm text-muted-foreground">
        {t('mockGitHub.sim.intro', { name: agentName })}
      </p>
      <div className="flex flex-wrap gap-2">
        {(['issue', 'pull', 'other', 'inject'] as const).map((kind) => (
          <Button
            key={kind}
            variant="outline"
            size="sm"
            className="min-h-9 pointer-coarse:min-h-11"
            onClick={() => run(kind)}
          >
            {t(`mockGitHub.sim.${kind}`)}
          </Button>
        ))}
      </div>
      {lines.length > 0 && (
        <ol className="flex flex-col gap-2" aria-live="polite">
          {lines.map((line, i) =>
            line.who === 'event' ? (
              <li key={i} className="text-center text-xs break-words text-muted-foreground">
                {line.text}
              </li>
            ) : (
              <li
                key={i}
                className={
                  line.who === 'customer'
                    ? 'max-w-[85%] self-start rounded-lg bg-muted px-3 py-2 text-sm break-words'
                    : 'max-w-[85%] self-end rounded-lg bg-primary/10 px-3 py-2 text-sm break-words'
                }
              >
                {line.text}
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

/** Activity tab: who and when only; never repo names, titles or text. */
function Activity() {
  const { t } = useTranslation('admin');
  const gh = useGitHub();
  const rows = gh.activity;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('mockConnectors.activityEmpty')}
        description={t('mockGitHub.activityEmptyHint')}
      />
    );
  const ICON = { searched: Search, read: GitPullRequest, refused: ShieldCheck, failed: UserRound };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockConnectors.activityTitle')}</CardTitle>
        <CardDescription>{t('mockGitHub.activityHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {rows.map((r) => {
            const Icon = ICON[r.kind];
            return (
              <li key={`${r.at}-${r.kind}`} className="flex items-start gap-3 py-3 first:pt-0">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">
                    {t(`mockGitHub.act.${r.kind}`, { agent: r.agent, customer: r.customer })}
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

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CircleDot, GitPullRequest, Lock, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  GITHUB_MAX_REPOS,
  GitHubAgentSettings,
  type GitHubRepo,
  type GitHubStatus,
} from '@ezychat/shared';
import { ApiError, errorMessage } from '../../api/client';
import {
  useGitHub,
  useGitHubAgent,
  useGitHubRepos,
  useRefreshGitHubRepos,
  useSaveGitHubAgent,
} from '../../api/connectors';
import { Banner, EmptyState, ResponsiveDialog } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ErrorState, ListSkeleton, Pending, SaveBar } from '../adminUi';
import { AgentPicker } from './AgentPicker';
import { ToolSwitchRow } from './connector-ui';

/** What decides whether the settings changed. */
const fingerprint = (s: GitHubAgentSettings) =>
  JSON.stringify({ repos: s.repos.map((r) => r.id), issues: s.issues, pulls: s.pulls });

const LOOK_UPS = ['issues', 'pulls'] as const;
const owner = (r: GitHubRepo) => r.fullName.split('/')[0]!;
const repoShortName = (r: GitHubRepo) => r.fullName.split('/')[1]!;

/** GitHub Settings tab: sign in first (and install the App), then one AI agent at a time. */
export function GitHubSettingsTab({ onConnect }: Readonly<{ onConnect: () => void }>) {
  const { t } = useTranslation('admin');
  const github = useGitHub();
  if (github.isPending) return <ListSkeleton rows={3} />;
  if (github.error)
    return <ErrorState error={github.error} onRetry={() => void github.refetch()} />;
  const state = github.data.state;
  if (state === 'not_connected' || state === 'no_installation')
    return (
      <EmptyState
        title={t('connectors.github.notConnected')}
        description={t('connectors.github.notConnectedHint')}
        action={
          <Button size="touch" onClick={onConnect}>
            {t('connectors.github.signIn')}
          </Button>
        }
      />
    );
  return (
    <AgentPicker
      render={(agent) => (
        <GitHubSettingsCard
          key={agent.id}
          agentId={agent.id}
          name={agent.displayName}
          status={github.data}
          onConnect={onConnect}
        />
      )}
    />
  );
}

/**
 * Connectors → GitHub → Settings, for one AI agent: the repositories it may look in (from what
 * GitHub shares, at most GITHUB_MAX_REPOS) and the Issues and Pull requests look-ups. What to look
 * up, and when, is in the agent's instructions (docs/connector-design.md), linked at the end.
 */
function GitHubSettingsCard({
  agentId,
  name,
  status,
  onConnect,
}: Readonly<{
  agentId: number;
  name: string;
  status: GitHubStatus;
  /** Shows the account card (Overview tab). */
  onConnect: () => void;
}>) {
  const { t } = useTranslation('admin');
  const query = useGitHubAgent(agentId);
  const save = useSaveGitHubAgent(agentId);
  const [draft, setDraft] = useState<GitHubAgentSettings>();
  const [picking, setPicking] = useState(false);
  const saved = query.data?.settings;
  const value = draft ?? saved;
  const set = (patch: Partial<GitHubAgentSettings>) => {
    if (value) setDraft({ ...value, ...patch });
  };
  const dirty = !!value && !!saved && fingerprint(value) !== fingerprint(saved);
  const unshared = new Set(query.data?.unavailableRepoIds ?? []);
  const notAccessible = save.error instanceof ApiError && save.error.code === 'repo_not_accessible';

  const submit = () => {
    const parsed = GitHubAgentSettings.safeParse(value);
    if (!parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(undefined);
        toast.success(t('connectors.github.saved'));
      },
    });
  };

  if (query.isPending) return <ListSkeleton rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!value) return null;
  const hasRepos = value.repos.length > 0;
  const paused = status.state === 'expired' || status.state === 'unavailable';

  return (
    <div className="flex flex-col gap-4" data-testid="github-settings">
      {paused && (
        <Banner tone="warning" title={t('connectors.github.pausedTitle')}>
          {t(
            status.state === 'expired'
              ? 'connectors.github.pausedExpired'
              : 'connectors.github.pausedDown',
            { name },
          )}{' '}
          <Button variant="link" className="h-auto p-0 align-baseline" onClick={onConnect}>
            {t('connectors.booking.openAccount')}
          </Button>
        </Banner>
      )}

      <Card className="gap-4" data-testid="github-repos">
        <CardHeader>
          <CardTitle>{t('connectors.github.repos.title')}</CardTitle>
          <CardDescription>{t('connectors.github.repos.description', { name })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {hasRepos ? (
            <ul className="flex flex-col divide-y rounded-lg border" data-testid="github-repo-list">
              {value.repos.map((r) => {
                const gone = unshared.has(r.id);
                const Icon = gone ? TriangleAlert : r.private ? Lock : CircleDot;
                return (
                  <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                    <Icon
                      className={
                        gone
                          ? 'size-4 shrink-0 text-warning'
                          : 'size-4 shrink-0 text-muted-foreground'
                      }
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium break-all">{r.fullName}</span>
                      <span className="text-xs text-muted-foreground">
                        {gone
                          ? t('connectors.github.repos.gone', { name })
                          : t(
                              r.private
                                ? 'connectors.github.repos.private'
                                : 'connectors.github.repos.public',
                            )}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 md:size-9"
                      aria-label={t('connectors.github.repos.remove', { repo: r.fullName })}
                      onClick={() => set({ repos: value.repos.filter((x) => x.id !== r.id) })}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('connectors.github.repos.none', { name })}
            </p>
          )}
          <Button
            variant={hasRepos ? 'outline' : 'default'}
            size="touch"
            className="self-start"
            disabled={value.repos.length >= GITHUB_MAX_REPOS}
            onClick={() => setPicking(true)}
          >
            <GitPullRequest aria-hidden />
            {t('connectors.github.repos.choose')}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t('connectors.github.repos.hint', { max: GITHUB_MAX_REPOS })}
          </p>
          {hasRepos && (
            <Banner tone="info" title={t('connectors.github.repos.whoTitle')}>
              {t('connectors.github.repos.whoBody', { name })}
            </Banner>
          )}
        </CardContent>
      </Card>

      <Card className="gap-4" data-testid="github-access">
        <CardHeader>
          <CardTitle>{t('connectors.github.access.title', { name })}</CardTitle>
          <CardDescription>{t('connectors.github.access.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col divide-y rounded-lg border">
            {LOOK_UPS.map((key) => (
              <ToolSwitchRow
                key={key}
                id={`github-${key}-${agentId}`}
                label={t(`connectors.github.access.${key}`)}
                hint={t(`connectors.github.access.${key}Hint`)}
                checked={hasRepos && value[key]}
                disabled={!hasRepos}
                onCheckedChange={(on) => set({ [key]: on })}
              />
            ))}
          </div>
          {!hasRepos && (
            <p className="text-sm text-muted-foreground">{t('connectors.github.needRepo')}</p>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground" data-testid="github-instructions-note">
        {t('connectors.github.when.note', { name })}{' '}
        <Link
          to={`/admin/members/ai/${agentId}`}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('connectors.github.when.open', { name })}
        </Link>
      </p>

      {save.error && (
        <Banner tone="danger">
          {notAccessible ? t('connectors.github.repos.notAccessible') : errorMessage(save.error)}
        </Banner>
      )}
      <SaveBar dirty={dirty}>
        <Button
          size="touch"
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => setDraft(undefined)}
        >
          {t('connectors.drive.discard')}
        </Button>
        <Button size="touch" disabled={!dirty || save.isPending} onClick={submit}>
          <Pending show={save.isPending} />
          {t('connectors.drive.saveButton')}
        </Button>
      </SaveBar>

      {picking && (
        <RepoPicker
          name={name}
          status={status}
          chosen={value.repos}
          onClose={() => setPicking(false)}
          onAdd={(added) => {
            set({ repos: [...value.repos, ...added].slice(0, GITHUB_MAX_REPOS) });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * "Choose repositories": what GitHub shares with EzyChat, grouped by owner, without the ones
 * already chosen; Refresh reads the list again from GitHub.
 */
function RepoPicker({
  name,
  status,
  chosen,
  onClose,
  onAdd,
}: Readonly<{
  name: string;
  status: GitHubStatus;
  chosen: GitHubRepo[];
  onClose: () => void;
  onAdd: (repos: GitHubRepo[]) => void;
}>) {
  const { t } = useTranslation('admin');
  const repos = useGitHubRepos();
  const refresh = useRefreshGitHubRepos();
  const [picked, setPicked] = useState<number[]>([]);
  const [query, setQuery] = useState('');
  const q = query.trim().toLocaleLowerCase();
  const taken = new Set(chosen.map((r) => r.id));
  const choosable = (repos.data?.repos ?? []).filter(
    (r) => !taken.has(r.id) && (!q || r.fullName.toLocaleLowerCase().includes(q)),
  );
  const owners = [...new Set(choosable.map(owner))];
  const room = GITHUB_MAX_REPOS - chosen.length;
  const list = (
    <>
      {choosable.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(q ? 'connectors.github.picker.noMatch' : 'connectors.github.picker.allAdded')}
        </p>
      ) : (
        owners.map((o) => (
          <div key={o} className="flex flex-col gap-1">
            <p className="text-xs font-medium break-all text-muted-foreground">{o}</p>
            <ul className="flex flex-col divide-y rounded-lg border">
              {choosable
                .filter((r) => owner(r) === o)
                .map((r) => {
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
                        <span className="min-w-0 flex-1 break-all">{repoShortName(r)}</span>
                        <Badge variant="secondary">
                          {t(
                            r.private
                              ? 'connectors.github.repos.private'
                              : 'connectors.github.repos.public',
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
    </>
  );
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('connectors.github.picker.title')}
      description={t('connectors.github.picker.description', { name })}
      footer={
        <>
          <Button size="touch" variant="outline" onClick={onClose}>
            {t('connectors.gc.cancelSignIn')}
          </Button>
          <Button
            size="touch"
            disabled={picked.length === 0}
            onClick={() => onAdd((repos.data?.repos ?? []).filter((r) => picked.includes(r.id)))}
          >
            {t('connectors.github.picker.add', { count: picked.length })}
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
              label={t('connectors.github.picker.search')}
              placeholder={t('connectors.github.picker.search')}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t('connectors.github.picker.refresh')}
            disabled={refresh.isPending}
            onClick={() =>
              refresh.mutate(undefined, {
                onSuccess: () => toast.success(t('connectors.github.picker.refreshed')),
              })
            }
          >
            {refresh.isPending ? <Pending show /> : <RefreshCw aria-hidden />}
          </Button>
        </div>
        {repos.isPending && <ListSkeleton rows={3} />}
        {repos.error && <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />}
        {refresh.error && <Banner tone="danger">{errorMessage(refresh.error)}</Banner>}
        {repos.data && list}
        {status.manageUrl && (
          <p className="text-sm text-muted-foreground">
            {t('connectors.github.picker.missing')}{' '}
            <a
              href={status.manageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t(
                status.method === 'token'
                  ? 'connectors.github.picker.editToken'
                  : 'connectors.github.picker.editApp',
              )}
            </a>
          </p>
        )}
      </div>
    </ResponsiveDialog>
  );
}

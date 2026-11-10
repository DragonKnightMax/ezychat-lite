import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, GitPullRequest, KeyRound, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  GITHUB_APP_INSTALL_URL,
  GITHUB_NEW_TOKEN_URL,
  type GitHubDeviceStart,
  type GitHubState,
} from '@ezychat/shared';
import { ApiError, errorMessage } from '../../api/client';
import {
  cancelGitHubDevice,
  githubKey,
  githubReposKey,
  useGitHub,
  useGitHubCheck,
  useGitHubDeviceProgress,
  useGitHubDeviceStart,
  useGitHubDisconnect,
  useGitHubRepos,
  useGitHubToken,
} from '../../api/connectors';
import { Banner, ResponsiveDialog, StatusDot, type StatusTone } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/lib/format';
import { ConfirmDialog, ErrorState, ListSkeleton, Pending, copyText } from '../adminUi';

const TONE: Record<Exclude<GitHubState, 'not_connected'>, StatusTone> = {
  connected: 'success',
  no_installation: 'info',
  expiring: 'info',
  expired: 'warning',
  unavailable: 'warning',
};

const TOKEN_ERRORS = ['classic', 'invalid', 'no_repos'] as const;
const WHAT = ['what1', 'what2', 'what3'] as const;
/** What a fine-grained token starts with (not translated). */
const TOKEN_PLACEHOLDER = 'github_pat_…';
type TokenError = (typeof TOKEN_ERRORS)[number];

/**
 * The GitHub sign-in (one per install, design docs/features/github/design.md): Sign in with
 * GitHub (Anchor Sprint's GitHub App, through GitHub's device flow) or a fine-grained token; the
 * install step, the token expiry, problems and Disconnect. Repositories per agent are on Settings.
 */
export function GitHubAccountCard({ onOpenSettings }: Readonly<{ onOpenSettings?: () => void }>) {
  const { t } = useTranslation('admin');
  const query = useGitHub();
  const data = query.data;
  const state = data?.state;
  const working = state === 'connected' || state === 'expiring';
  const repos = useGitHubRepos(working);
  const check = useGitHubCheck();
  const disconnect = useGitHubDisconnect();
  const device = useDeviceSignIn();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenKey, setTokenKey] = useState(0);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const viaToken = data?.method === 'token';
  const expiresOn = data?.tokenExpiresAt ? formatDate(data.tokenExpiresAt) : '';
  const openToken = () => {
    setTokenKey((k) => k + 1);
    setTokenOpen(true);
  };

  return (
    <Card data-testid="github-account">
      <CardHeader>
        <CardTitle>{t('connectors.github.accountTitle')}</CardTitle>
        <CardDescription>{t('connectors.github.accountDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending && <ListSkeleton rows={2} />}
        {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {state === 'not_connected' && (
          <>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {WHAT.map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {t(`connectors.github.${key}`)}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button size="touch" disabled={device.starting} onClick={device.start}>
                {device.starting ? <Pending show /> : <GitPullRequest aria-hidden />}
                {t('connectors.github.signIn')}
              </Button>
              <Button variant="link" className="h-auto min-h-11 p-0" onClick={openToken}>
                {t('connectors.github.useToken')}
              </Button>
            </div>
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              {t('connectors.github.signInHint')}
              <InfoTip topic="githubApp" />
            </p>
          </>
        )}
        {data && state && state !== 'not_connected' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-muted-foreground">
                  {t(viaToken ? 'connectors.github.viaToken' : 'connectors.github.viaApp')}
                </span>
                <span className="font-medium break-all">{data.login}</span>
                {viaToken && expiresOn && (
                  <span className="text-xs text-muted-foreground">
                    {t(
                      state === 'expired'
                        ? 'connectors.github.tokenExpired'
                        : 'connectors.github.tokenExpires',
                      { date: expiresOn },
                    )}
                  </span>
                )}
              </div>
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={TONE[state]} />
                {t(`connectors.github.state.${state}`)}
              </span>
            </div>
            {state === 'no_installation' && (
              <Banner tone="info" title={t('connectors.github.install.title')}>
                <span className="flex flex-col items-start gap-2">
                  {t('connectors.github.install.body')}
                  <span className="flex flex-wrap gap-2">
                    <Button asChild size="touch">
                      <a href={GITHUB_APP_INSTALL_URL} target="_blank" rel="noopener noreferrer">
                        <ExternalLink aria-hidden />
                        {t('connectors.github.install.button')}
                      </a>
                    </Button>
                    <Button
                      size="touch"
                      variant="outline"
                      disabled={check.isPending}
                      onClick={() => check.mutate()}
                    >
                      {check.isPending ? <Pending show /> : <RefreshCw aria-hidden />}
                      {t('connectors.github.install.check')}
                    </Button>
                  </span>
                  <span className="text-xs">{t('connectors.github.install.orgNote')}</span>
                </span>
              </Banner>
            )}
            {check.error && <Banner tone="danger">{errorMessage(check.error)}</Banner>}
            {state === 'expiring' && (
              <Banner tone="info" title={t('connectors.github.expiringTitle', { date: expiresOn })}>
                <span className="flex flex-col items-start gap-2">
                  {t('connectors.github.expiringBody')}
                  <Button size="touch" variant="outline" onClick={openToken}>
                    <KeyRound aria-hidden />
                    {t('connectors.github.newToken')}
                  </Button>
                </span>
              </Banner>
            )}
            {state === 'expired' && (
              <Banner
                tone="warning"
                title={t(
                  viaToken
                    ? 'connectors.github.expiredTokenTitle'
                    : 'connectors.github.expiredTitle',
                )}
              >
                <span className="flex flex-col items-start gap-2">
                  {t('connectors.github.expiredBody')}
                  <Button
                    size="touch"
                    variant="outline"
                    disabled={device.starting}
                    onClick={viaToken ? openToken : device.start}
                  >
                    <Pending show={device.starting} />
                    {t(viaToken ? 'connectors.github.newToken' : 'connectors.github.signInAgain')}
                  </Button>
                </span>
              </Banner>
            )}
            {state === 'unavailable' && (
              <Banner tone="warning" title={t('connectors.github.unavailableTitle')}>
                {t('connectors.github.unavailableBody')}
              </Banner>
            )}
            {state !== 'no_installation' && (
              <p className="text-sm text-muted-foreground">
                {repos.data && (
                  <>{t('connectors.github.reposShared', { count: repos.data.repos.length })} </>
                )}
                {data.manageUrl && (
                  <>
                    <a
                      href={data.manageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t('connectors.github.changeOnGitHub')}
                    </a>
                    {'. '}
                  </>
                )}
                {t('connectors.github.perAgent')}{' '}
                {onOpenSettings && (
                  <Button
                    variant="link"
                    className="h-auto p-0 align-baseline"
                    onClick={onOpenSettings}
                  >
                    {t('connectors.gc.openSettings')}
                  </Button>
                )}
              </p>
            )}
            <Button
              size="touch"
              variant="outline"
              className="self-start"
              onClick={() => setConfirmDisconnect(true)}
            >
              {t('connectors.gc.disconnect')}
            </Button>
          </>
        )}
        {!device.current && device.startError && (
          <Banner tone="danger">{errorMessage(device.startError)}</Banner>
        )}
      </CardContent>

      <DeviceDialog device={device} />
      <TokenDialog key={tokenKey} open={tokenOpen} onClose={() => setTokenOpen(false)} />
      <ConfirmDialog
        open={confirmDisconnect}
        title={t('connectors.github.disconnectTitle')}
        confirmLabel={t('connectors.gc.disconnect')}
        danger
        loading={disconnect.isPending}
        error={disconnect.error}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => {
              setConfirmDisconnect(false);
              toast.success(t('connectors.github.disconnected'));
            },
          })
        }
      >
        {t(viaToken ? 'connectors.github.disconnectToken' : 'connectors.github.disconnectApp')}
      </ConfirmDialog>
    </Card>
  );
}

type DeviceSignIn = ReturnType<typeof useDeviceSignIn>;

/**
 * The App sign-in: the server asks GitHub for a code, the page shows it and polls until the admin
 * approved it on GitHub (then the new status is cached), cancelled, or the code expired.
 */
function useDeviceSignIn() {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const startMutation = useGitHubDeviceStart();
  const [current, setCurrent] = useState<GitHubDeviceStart | null>(null);
  const progress = useGitHubDeviceProgress(current?.requestId ?? null);
  const status = progress.data?.status;
  const signedIn = progress.data?.github ?? null;

  useEffect(() => {
    if (!current || status !== 'done') return;
    setCurrent(null);
    if (signedIn) qc.setQueryData(githubKey, signedIn);
    else void qc.invalidateQueries({ queryKey: githubKey });
    void qc.invalidateQueries({ queryKey: githubReposKey });
    toast.success(t('connectors.github.signedIn', { login: signedIn?.login ?? '' }));
  }, [current, status, signedIn, qc, t]);

  return {
    current,
    status,
    progressError: progress.error,
    starting: startMutation.isPending,
    startError: startMutation.error,
    /** Asks for a code (also "Get a new code"). */
    start: () => startMutation.mutate(undefined, { onSuccess: setCurrent }),
    /** Closing the dialog: the server stops waiting for a code that is still open. */
    close: () => {
      if (current && (status === undefined || status === 'pending'))
        void cancelGitHubDevice(current.requestId).catch(() => {});
      setCurrent(null);
    },
  };
}

function DeviceDialog({ device }: Readonly<{ device: DeviceSignIn }>) {
  const { t } = useTranslation('admin');
  const { current, status } = device;
  const ended = status === 'denied' || status === 'expired' || status === 'failed';
  return (
    <ResponsiveDialog
      open={current !== null}
      onOpenChange={(open) => !open && device.close()}
      title={t('connectors.github.device.title')}
      description={t('connectors.github.device.description')}
      footer={
        <Button size="touch" variant="outline" onClick={device.close}>
          {t('connectors.gc.cancelSignIn')}
        </Button>
      }
    >
      {current && (
        <div className="flex flex-col gap-4 pb-2" data-testid="github-device">
          {ended ? (
            <Banner tone="warning" title={t(`connectors.github.device.${status}Title`)}>
              <span className="flex flex-col items-start gap-2">
                {t(`connectors.github.device.${status}Body`)}
                <Button
                  size="touch"
                  variant="outline"
                  disabled={device.starting}
                  onClick={device.start}
                >
                  <Pending show={device.starting} />
                  {t('connectors.github.device.again')}
                </Button>
              </span>
            </Banner>
          ) : (
            <>
              <ol className="flex flex-col gap-3 text-sm">
                <li className="flex flex-col gap-2">
                  <span>{t('connectors.github.device.step1')}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <code
                      className="rounded-lg border bg-muted px-4 py-2 font-mono text-2xl font-semibold tracking-widest"
                      data-testid="github-device-code"
                    >
                      {current.userCode}
                    </code>
                    <Button
                      size="touch"
                      variant="outline"
                      onClick={() =>
                        void copyText(current.userCode).then(
                          (ok) => ok && toast.success(t('connectors.github.device.copied')),
                        )
                      }
                    >
                      <Copy aria-hidden />
                      {t('connectors.github.device.copy')}
                    </Button>
                  </span>
                </li>
                <li className="flex flex-col items-start gap-2">
                  <span>{t('connectors.github.device.step2')}</span>
                  <Button asChild size="touch">
                    <a href={current.verificationUri} target="_blank" rel="noopener noreferrer">
                      <ExternalLink aria-hidden />
                      {t('connectors.github.device.open')}
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
                {t('connectors.github.device.waiting')}
              </p>
            </>
          )}
          {device.startError && <Banner tone="danger">{errorMessage(device.startError)}</Banner>}
          {device.progressError && (
            <Banner tone="danger">{errorMessage(device.progressError)}</Banner>
          )}
        </div>
      )}
    </ResponsiveDialog>
  );
}

/** "Use a token instead": the four steps on GitHub and the token field, checked by the server. */
function TokenDialog({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  const { t } = useTranslation('admin');
  const id = useId();
  const save = useGitHubToken();
  const [token, setToken] = useState('');
  const code = save.error instanceof ApiError ? save.error.code : null;
  const fieldError = TOKEN_ERRORS.find((e): e is TokenError => e === code) ?? null;
  const submit = () => {
    if (!token.trim()) return;
    save.mutate(token.trim(), {
      onSuccess: (next) => {
        toast.success(t('connectors.github.signedIn', { login: next.login ?? '' }));
        onClose();
      },
    });
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('connectors.github.token.title')}
      description={t('connectors.github.token.description')}
      footer={
        <>
          <Button size="touch" variant="outline" onClick={onClose}>
            {t('connectors.gc.cancelSignIn')}
          </Button>
          <Button size="touch" disabled={!token.trim() || save.isPending} onClick={submit}>
            <Pending show={save.isPending} />
            {t('connectors.github.token.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2" data-testid="github-token">
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
          <li>
            <a
              href={GITHUB_NEW_TOKEN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('connectors.github.token.step1')}
            </a>
          </li>
          <li>{t('connectors.github.token.step2')}</li>
          <li>{t('connectors.github.token.step3')}</li>
          <li>{t('connectors.github.token.step4')}</li>
        </ol>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id} className="flex items-center gap-1">
            {t('connectors.github.token.label')}
            <InfoTip topic="githubToken" />
          </Label>
          <Input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={TOKEN_PLACEHOLDER}
            value={token}
            aria-invalid={fieldError !== null}
            onChange={(e) => {
              setToken(e.target.value);
              save.reset();
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="h-11 font-mono text-base md:text-sm"
          />
          {fieldError && (
            <p className="text-sm text-danger" role="alert">
              {t(`connectors.github.token.error.${fieldError}`)}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('connectors.github.token.readOnly')}</p>
        </div>
        {save.error && !fieldError && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
      </div>
    </ResponsiveDialog>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { Check, ExternalLink, Loader2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import type {
  GoogleCalendarConnectProgress,
  GoogleCalendarConnectStart,
  GoogleCalendarState,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import { Banner, StatusDot, type StatusTone } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, ErrorState, ListSkeleton, Pending } from '../adminUi';

interface Signing {
  requestId: string;
  url: string;
  /** The browser blocked the new window: the person opens the link themselves. */
  blocked: boolean;
}

export interface GoogleConnectFlow {
  connect: () => void;
  cancel: () => void;
  signing: Signing | null;
  failed: GoogleCalendarConnectProgress['error'];
  starting: boolean;
  startError: Error | null;
  progressError: Error | null;
}

/**
 * Starts a Google sign-in of a core connector (Google Calendar, Google Sheets): a window opens
 * inside the click (so the browser allows it), then goes to Google's page once the server answers;
 * the page polls until Google sent the person back. The connector's own API hooks are passed in.
 */
export function useGoogleConnectFlow(options: {
  useStart: () => UseMutationResult<GoogleCalendarConnectStart, Error, void>;
  useProgress: (requestId: string | null) => UseQueryResult<GoogleCalendarConnectProgress>;
  statusKey: QueryKey;
  connectedToast: string;
}): GoogleConnectFlow {
  const qc = useQueryClient();
  const start = options.useStart();
  const [signing, setSigning] = useState<Signing | null>(null);
  const [failed, setFailed] = useState<GoogleCalendarConnectProgress['error']>(null);
  const progress = options.useProgress(signing?.requestId ?? null);
  const status = progress.data?.status;
  const error = progress.data?.error ?? null;
  const { statusKey, connectedToast } = options;

  useEffect(() => {
    if (!signing || !status || status === 'pending') return;
    setSigning(null);
    if (status === 'done') {
      setFailed(null);
      toast.success(connectedToast);
      void qc.invalidateQueries({ queryKey: statusKey });
    } else setFailed(error ?? 'error');
  }, [signing, status, error, qc, statusKey, connectedToast]);

  const connect = async () => {
    setFailed(null);
    const tab = window.open('about:blank', '_blank');
    try {
      const next = await start.mutateAsync();
      if (tab) {
        tab.opener = null;
        tab.location.href = next.authorizationUrl;
      }
      setSigning({ requestId: next.requestId, url: next.authorizationUrl, blocked: !tab });
    } catch {
      // The mutation error is shown on the card.
      tab?.close();
    }
  };

  return {
    connect: () => void connect(),
    cancel: () => setSigning(null),
    signing,
    failed,
    starting: start.isPending,
    startError: start.error,
    progressError: progress.error,
  };
}

/** While Google's sign-in is open, and what went wrong after it. */
export function GoogleSigningIn({ flow }: Readonly<{ flow: GoogleConnectFlow }>) {
  const { t } = useTranslation('admin');
  return (
    <>
      {flow.signing && (
        <div
          className="flex flex-col items-start gap-3 rounded-lg border px-3 py-3"
          role="status"
          data-testid="google-signing-in"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('connectors.gc.waiting')}
          </p>
          <p className="text-sm text-muted-foreground">
            {flow.signing.blocked ? t('connectors.gc.blocked') : t('connectors.gc.waitingHint')}
          </p>
          <Button asChild size="touch" variant={flow.signing.blocked ? 'default' : 'outline'}>
            <a href={flow.signing.url} target="_blank" rel="noopener noreferrer">
              {t('connectors.gc.openSignIn')}
              <ExternalLink aria-hidden />
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">{t('connectors.gc.sameComputer')}</p>
          <Button size="touch" variant="ghost" onClick={flow.cancel}>
            {t('connectors.gc.cancelSignIn')}
          </Button>
        </div>
      )}
      {flow.failed && <Banner tone="danger">{t(`connectors.gc.failed.${flow.failed}`)}</Banner>}
      {flow.startError && <Banner tone="danger">{errorMessage(flow.startError)}</Banner>}
      {flow.progressError && <Banner tone="danger">{errorMessage(flow.progressError)}</Banner>}
    </>
  );
}

const TONE: Record<GoogleCalendarState, StatusTone> = {
  connected: 'success',
  expired: 'warning',
  unavailable: 'warning',
  disconnected: 'muted',
  not_configured: 'muted',
};

/** The texts that differ between the Google connectors (already translated). */
export interface GoogleAccountTexts {
  description: string;
  what: readonly string[];
  connect: string;
  connectHint: string;
  expiredBody: string;
  unavailableTitle: string;
  unavailableBody: string;
  perAgent: string;
  disconnectTitle: string;
  disconnectBody: string;
  disconnected: string;
}

/**
 * The Google account one core connector uses (one per install): connect, its state, the problem
 * banners and Disconnect. `children` adds what only that connector shows while signed in (Google
 * Calendar's calendars); `actions` sits next to Disconnect.
 */
export function GoogleAccountCard({
  testId,
  icon: Icon,
  query,
  flow,
  disconnect,
  texts,
  onOpenSettings,
  children,
  actions,
}: Readonly<{
  testId: string;
  icon: LucideIcon;
  query: UseQueryResult<{ state: GoogleCalendarState; account: string | null }>;
  flow: GoogleConnectFlow;
  disconnect: UseMutationResult<unknown, Error, void>;
  texts: GoogleAccountTexts;
  onOpenSettings?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}>) {
  const { t } = useTranslation('admin');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const data = query.data;
  const state = data?.state;

  const connectButton = (label: string, outline = false) => (
    <Button
      size="touch"
      variant={outline ? 'outline' : 'default'}
      className="self-start"
      disabled={flow.starting || flow.signing !== null}
      onClick={flow.connect}
    >
      {outline ? null : <Icon aria-hidden />}
      <Pending show={flow.starting} />
      {label}
    </Button>
  );

  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{t('connectors.gc.accountTitle')}</CardTitle>
        <CardDescription>{texts.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending && <ListSkeleton rows={2} />}
        {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {state === 'not_configured' && (
          <Banner tone="info" title={t('connectors.gc.notConfiguredTitle')}>
            {t('connectors.gc.notConfiguredBody')}
          </Banner>
        )}
        {state === 'disconnected' && (
          <>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {texts.what.map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
            {!flow.signing && connectButton(texts.connect)}
            <p className="text-sm text-muted-foreground">{texts.connectHint}</p>
          </>
        )}
        {data && (state === 'connected' || state === 'expired' || state === 'unavailable') && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-muted-foreground">{t('connectors.gc.account')}</span>
                <span className="font-medium break-all">{data.account}</span>
              </div>
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={TONE[state]} />
                {t(`connectors.gc.state.${state}`)}
              </span>
            </div>
            {state === 'expired' && (
              <Banner tone="warning" title={t('connectors.gc.expiredTitle')}>
                <span className="flex flex-col items-start gap-2">
                  {texts.expiredBody}
                  {!flow.signing && connectButton(t('connectors.gc.signInAgain'), true)}
                </span>
              </Banner>
            )}
            {state === 'unavailable' && (
              <Banner tone="warning" title={texts.unavailableTitle}>
                {texts.unavailableBody}
              </Banner>
            )}
            {children}
            <p className="text-sm text-muted-foreground">
              {texts.perAgent}{' '}
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
            <div className="flex flex-wrap items-center gap-2">
              {actions}
              <Button
                size="touch"
                variant="outline"
                className="self-start"
                onClick={() => setConfirmDisconnect(true)}
              >
                {t('connectors.gc.disconnect')}
              </Button>
            </div>
          </>
        )}
        <GoogleSigningIn flow={flow} />
      </CardContent>
      <ConfirmDialog
        open={confirmDisconnect}
        title={texts.disconnectTitle}
        confirmLabel={t('connectors.gc.disconnect')}
        danger
        loading={disconnect.isPending}
        error={disconnect.error}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => {
              setConfirmDisconnect(false);
              toast.success(texts.disconnected);
            },
          })
        }
      >
        {texts.disconnectBody}
      </ConfirmDialog>
    </Card>
  );
}

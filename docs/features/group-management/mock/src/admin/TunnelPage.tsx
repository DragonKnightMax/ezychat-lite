import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMockInboxes } from '../mock/inboxes';
import { QRCodeSVG } from 'qrcode.react';
import type { TunnelMode, TunnelState, TunnelStartBody } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { useSettings, useStartTunnel, useStopTunnel, useTunnel } from '../api/queries';
import { Banner, PageHeader, StatusDot, stateTone } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { CopyButton, ErrorState, Field, Pending } from './adminUi';
import { CloudflareSetup } from './CloudflareSetup';
import { InfoTip } from '@/components/app/InfoTip';

/** Tunnel state → translation key in the `admin` namespace. */
const STATE_LABEL_KEY = {
  stopped: 'tunnel.state.stopped',
  starting: 'tunnel.state.starting',
  running: 'tunnel.state.running',
  error: 'tunnel.state.error',
} as const satisfies Record<TunnelState, string>;

const MODES = [
  { value: 'off', labelKey: 'tunnel.modes.off', hintKey: 'tunnel.modes.offHint' },
  { value: 'quick', labelKey: 'tunnel.modes.quick', hintKey: 'tunnel.modes.quickHint' },
  { value: 'named', labelKey: 'tunnel.modes.named', hintKey: 'tunnel.modes.namedHint' },
] as const satisfies readonly { value: TunnelMode; labelKey: string; hintKey: string }[];

// Technical examples, identical in every language.
const TOKEN_PLACEHOLDER = 'eyJh…';
const HOSTNAME_PLACEHOLDER = 'inbox.example.com';

export function TunnelPage() {
  const tunnel = useTunnel();
  const settings = useSettings();
  const start = useStartTunnel();
  const stop = useStopTunnel();
  const { t } = useTranslation('admin');
  const apiInboxes = useMockInboxes().inboxes.filter((i) => i.type === 'business_api');

  const [mode, setMode] = useState<TunnelMode>('off');
  const [token, setToken] = useState('');
  const [hostname, setHostname] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    if (initialised.current || !tunnel.data) return;
    initialised.current = true;
    setMode(tunnel.data.mode);
    setHostname(tunnel.data.hostname ?? settings.data?.namedTunnelHostname ?? '');
  }, [tunnel.data, settings.data]);

  const savedHostname = settings.data?.namedTunnelHostname;
  useEffect(() => {
    if (savedHostname) setHostname((h) => h || savedHostname);
  }, [savedHostname]);

  if (tunnel.isPending)
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={t('ui.loading')}>
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (tunnel.isError)
    return <ErrorState error={tunnel.error} onRetry={() => void tunnel.refetch()} />;

  const s = tunnel.data;
  const active = s.state === 'running' || s.state === 'starting';
  const hasToken = settings.data?.hasTunnelToken ?? false;
  const pending = start.isPending || stop.isPending;
  const namedRunning = s.mode === 'named' && s.state === 'running' && s.hostname === savedHostname;
  const namedStarting =
    s.mode === 'named' && s.state === 'starting' && s.hostname === savedHostname;
  const actionLabel = {
    off: t('tunnel.action.disconnect'),
    named: namedStarting ? t('tunnel.action.namedConnecting') : t('tunnel.action.namedConnect'),
    quick: active ? t('tunnel.action.quickRestart') : t('tunnel.action.quickCreate'),
  }[mode];

  const onStart = (manual = false) => {
    setFormError(null);
    if (mode === 'off') {
      stop.mutate();
      return;
    }
    const body: TunnelStartBody = { mode };
    if (mode === 'named') {
      const entered = manual ? token.trim() : '';
      if (entered && entered.length < 10) return setFormError(t('tunnel.tokenTooShort'));
      if (!entered && !hasToken) return setFormError(t('tunnel.tokenRequired'));
      if (entered) body.token = entered;
      const h = manual ? hostname.trim() : savedHostname;
      if (h) body.hostname = h;
    }
    start.mutate(body, { onSuccess: () => setToken('') });
  };

  const mutationError = start.error ?? stop.error;
  // Guard against a state/mode added on the server before the web catalog knows it.
  const stateKey: (typeof STATE_LABEL_KEY)[TunnelState] | undefined = STATE_LABEL_KEY[s.state];
  const stateLabel = stateKey ? t(stateKey) : s.state;
  const currentMode = MODES.find((m) => m.value === s.mode);
  const currentModeLabel = currentMode ? t(currentMode.labelKey) : s.mode;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('tunnel.title')} description={t('tunnel.description')} />
      {/* Proposed (business-api): Business API inboxes receive their messages through this tunnel. */}
      {apiInboxes.length > 0 && (
        <Banner tone="info" title={t('mockApi.tunnelNoteTitle')}>
          {t('mockApi.tunnelNoteBody', { names: apiInboxes.map((i) => i.name).join(', ') })}
        </Banner>
      )}

      <Card className="gap-4">
        <CardHeader className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-1.5">
            <CardTitle>{t('tunnel.connectTitle')}</CardTitle>
            <InfoTip topic="tunnel" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot
              tone={stateTone(s.state)}
              pulse={s.state === 'starting'}
              label={<span className="font-medium">{stateLabel}</span>}
            />
            {s.mode !== 'off' && (
              <span className="text-sm text-muted-foreground">({currentModeLabel})</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {s.url && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 min-w-0 flex-1 items-center gap-1 text-sm font-medium break-all text-primary underline underline-offset-4"
                >
                  <span className="min-w-0 break-all">{s.url}</span>
                  <ExternalLink className="size-4 shrink-0" aria-hidden />
                </a>
                <CopyButton text={s.url} label={t('tunnel.copyUrl')} />
              </div>
              <div className="flex flex-col items-center gap-2">
                <div className="rounded-lg border bg-card p-3 dark:bg-foreground">
                  <QRCodeSVG
                    value={s.url}
                    size={200}
                    bgColor="transparent"
                    fgColor="currentColor"
                    className="h-auto w-full max-w-52 text-foreground dark:text-background"
                    aria-label={t('tunnel.qrLabel')}
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">{t('tunnel.scanHint')}</p>
              </div>
            </div>
          )}

          {s.mode === 'quick' && <Banner tone="info">{t('tunnel.quickNote')}</Banner>}
          {s.lastError && (
            <Banner tone="danger" title={t('tunnel.lastError')}>
              {s.lastError}
            </Banner>
          )}

          <fieldset className="min-w-0">
            <legend className="mb-2 text-sm font-medium">{t('tunnel.remoteAccess')}</legend>
            <RadioGroup
              value={mode}
              onValueChange={(v) => {
                setMode(v as TunnelMode);
                setFormError(null);
              }}
              className="grid gap-2 sm:grid-cols-3"
              aria-label={t('tunnel.remoteAccessMode')}
            >
              {MODES.map((m) => {
                const id = `tunnel-mode-${m.value}`;
                return (
                  <Label
                    key={m.value}
                    htmlFor={id}
                    className={cn(
                      'flex min-h-11 cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 leading-normal transition-colors hover:bg-accent',
                      mode === m.value && 'border-primary bg-primary/5',
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <RadioGroupItem id={id} value={m.value} />
                      {t(m.labelKey)}
                    </span>
                    <span className="font-normal text-muted-foreground">{t(m.hintKey)}</span>
                  </Label>
                );
              })}
            </RadioGroup>
          </fieldset>

          {mode === 'named' && (
            <div className="flex flex-col gap-4">
              <CloudflareSetup tunnel={s} />
              <div className="border-t pt-4">
                <Button
                  variant="ghost"
                  size="touch"
                  aria-expanded={advancedOpen}
                  aria-controls="cloudflare-advanced"
                  onClick={() => setAdvancedOpen((open) => !open)}
                  className="w-full justify-start whitespace-normal text-left"
                >
                  {t('tunnel.advancedToken')}
                </Button>
                <div id="cloudflare-advanced" hidden={!advancedOpen}>
                  <div className="flex flex-col gap-4 pt-3">
                    <p className="text-sm text-muted-foreground">{t('tunnel.advancedTokenBody')}</p>
                    <Field label={t('tunnel.token')} hint={t('tunnel.tokenHint')}>
                      {(p) => (
                        <Input
                          {...p}
                          type="password"
                          className="h-11 font-mono md:h-9"
                          value={token}
                          onChange={(e) => setToken(e.target.value)}
                          autoComplete="off"
                          placeholder={
                            hasToken ? t('tunnel.tokenSavedPlaceholder') : TOKEN_PLACEHOLDER
                          }
                        />
                      )}
                    </Field>
                    <Field label={t('tunnel.hostname')} hint={t('tunnel.hostnameHint')}>
                      {(p) => (
                        <Input
                          {...p}
                          className="h-11 md:h-9"
                          value={hostname}
                          onChange={(e) => setHostname(e.target.value)}
                          placeholder={HOSTNAME_PLACEHOLDER}
                          autoCapitalize="none"
                          autoCorrect="off"
                        />
                      )}
                    </Field>
                    <Button
                      size="touch"
                      variant="outline"
                      onClick={() => onStart(true)}
                      disabled={pending}
                    >
                      <Pending show={start.isPending} />
                      {t('tunnel.connectWithToken')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {(formError || mutationError) && (
            <Banner tone="danger">{formError ?? errorMessage(mutationError)}</Banner>
          )}

          <div className="flex flex-col gap-2 empty:hidden sm:flex-row">
            {/* Off while nothing runs needs no button: the status above already says it. */}
            {(mode === 'off' ? active : mode !== 'named' || (hasToken && !namedRunning)) && (
              <Button
                size="touch"
                className="md:min-h-9"
                onClick={() => onStart()}
                disabled={pending || (mode === 'named' && namedStarting)}
              >
                <Pending show={mode === 'off' ? stop.isPending : start.isPending} />
                {actionLabel}
              </Button>
            )}
            {active && mode !== 'off' && (
              <Button
                size="touch"
                variant="outline"
                className="md:min-h-9"
                onClick={() => stop.mutate()}
                disabled={pending}
              >
                <Pending show={stop.isPending} />
                {t('tunnel.action.disconnect')}
              </Button>
            )}
          </div>
          {active && (
            <p className="text-sm text-muted-foreground">
              {settings.data?.lanEnabled
                ? t('tunnel.disconnectNoteLan')
                : t('tunnel.disconnectNote')}
            </p>
          )}
        </CardContent>
      </Card>

      {s.logTail.length > 0 && (
        <details className="min-w-0 rounded-lg border bg-card p-4">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
            {t('tunnel.diagnostics')}
          </summary>
          <div className="pt-3">
            <ScrollArea
              className={cn('rounded-md border bg-muted', s.logTail.length > 14 && 'h-72')}
            >
              <pre className="p-3 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
                {s.logTail.join('\n')}
              </pre>
            </ScrollArea>
          </div>
        </details>
      )}
    </div>
  );
}

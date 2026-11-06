import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CloudflareCreateBody, type TunnelStatus } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import {
  useCloudflareAccountAction,
  useCloudflareSetupStatus,
  useCreateCloudflareTunnel,
  type CloudflareAccountAction,
} from '../api/queries';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, Field, Pending } from './adminUi';

// Technical defaults and examples, identical in every language.
const DEFAULT_SUBDOMAIN = 'inbox';
const DEFAULT_TUNNEL_NAME = 'wa-team-inbox';

function approvalUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://dash.cloudflare.com' &&
      parsed.pathname === '/argotunnel' &&
      !parsed.username &&
      !parsed.password
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Guided account authorization and explicit publication. Credentials remain on the server. */
export function CloudflareSetup({ tunnel }: { tunnel: TunnelStatus }) {
  const setup = useCloudflareSetupStatus();
  const account = useCloudflareAccountAction();
  const create = useCreateCloudflareTunnel();
  const { t } = useTranslation('admin');
  const [domainId, setDomainId] = useState('');
  const [subdomain, setSubdomain] = useState(DEFAULT_SUBDOMAIN);
  const [tunnelName, setTunnelName] = useState(DEFAULT_TUNNEL_NAME);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const clearFeedback = () => {
    setFormError(null);
    account.reset();
    create.reset();
  };
  const request = (action: CloudflareAccountAction) => {
    clearFeedback();
    account.mutate(action);
  };

  if (setup.isPending)
    return <Skeleton className="h-32 w-full" aria-label={t('cloudflare.loading')} />;
  if (setup.isError) return <ErrorState error={setup.error} onRetry={() => void setup.refetch()} />;

  const status = setup.data;
  const waiting = status.state === 'signing_in' || status.state === 'awaiting_approval';
  const pendingAction = account.isPending ? account.variables : null;
  const busy = status.busy || account.isPending || create.isPending;
  const selectedDomain =
    status.domains.find((domain) => domain.id === domainId) ??
    status.domains.find((domain) => status.managed?.hostname.endsWith(`.${domain.name}`)) ??
    status.domains[0];
  const address = selectedDomain
    ? `https://${subdomain.trim().toLowerCase()}.${selectedDomain.name}`
    : null;
  const loginUrl = approvalUrl(status.loginUrl);
  const invalidApproval = status.loginUrl && !loginUrl ? t('cloudflare.invalidApproval') : null;
  const actionError = account.error ?? create.error;
  const connected = status.state === 'connected';
  const savedHostname = status.managed?.hostname ?? create.data?.hostname;
  const savedName = status.managed?.name ?? create.variables?.tunnelName;
  const unchanged = address === `https://${savedHostname}` && tunnelName.trim() === savedName;

  if (savedHostname && !editing && !waiting) {
    const matches = tunnel.mode === 'named' && tunnel.hostname === savedHostname;
    const running = matches && tunnel.state === 'running';
    const starting = matches && tunnel.state === 'starting';
    return (
      <section className="flex min-w-0 flex-col gap-3" aria-label={t('cloudflare.saved.label')}>
        <Banner
          title={
            running
              ? t('cloudflare.saved.running')
              : starting
                ? t('cloudflare.saved.starting')
                : t('cloudflare.saved.idle')
          }
        >
          <span className="break-all">{`https://${savedHostname}`}</span>
          <p>
            {running
              ? t('cloudflare.saved.runningBody')
              : starting
                ? t('cloudflare.saved.startingBody')
                : t('cloudflare.saved.idleBody')}
          </p>
        </Banner>
        <Button
          size="touch"
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={() => {
            const domain = status.domains.find((d) => savedHostname.endsWith(`.${d.name}`));
            if (domain) {
              setDomainId(domain.id);
              setSubdomain(savedHostname.slice(0, -(domain.name.length + 1)));
            }
            setTunnelName(savedName ?? DEFAULT_TUNNEL_NAME);
            setFormError(null);
            account.reset();
            setEditing(true);
          }}
        >
          {t('cloudflare.saved.change')}
        </Button>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-5" aria-label={t('cloudflare.setupLabel')}>
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">{t('cloudflare.step1.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('cloudflare.step1.body')}</p>
        {connected ? (
          <div className="flex flex-col gap-2">
            <p role="status" className="text-sm text-success">
              {t('cloudflare.step1.connected')}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                size="touch"
                variant="outline"
                disabled={busy}
                onClick={() => request('refresh')}
              >
                <Pending show={pendingAction === 'refresh'} />
                {t('cloudflare.step1.refresh')}
              </Button>
              <Button size="touch" variant="ghost" disabled={busy} onClick={() => request('login')}>
                {t('cloudflare.step1.another')}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{t('cloudflare.step1.anotherHint')}</p>
          </div>
        ) : waiting ? (
          <div className="flex flex-col gap-3">
            <p role="status" className="text-sm text-muted-foreground">
              {loginUrl ? t('cloudflare.step1.waitingApproval') : t('cloudflare.step1.preparing')}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {loginUrl && (
                <Button asChild size="touch">
                  <a href={loginUrl} target="_blank" rel="noreferrer">
                    {t('cloudflare.step1.open')}
                    <ExternalLink aria-hidden />
                  </a>
                </Button>
              )}
              <Button
                size="touch"
                variant="outline"
                disabled={pendingAction === 'login/cancel' || create.isPending}
                onClick={() => request('login/cancel')}
              >
                <Pending show={pendingAction === 'login/cancel'} />
                {t('cloudflare.step1.cancel')}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{t('cloudflare.step1.autoUpdate')}</p>
          </div>
        ) : (
          <Button
            size="touch"
            className="self-start"
            disabled={busy}
            onClick={() => request('login')}
          >
            <Pending show={pendingAction === 'login'} />
            {status.state === 'error' ? t('cloudflare.step1.retry') : t('cloudflare.step1.signIn')}
          </Button>
        )}
      </div>

      {(formError || actionError || status.error || invalidApproval) && (
        <Banner tone="danger" title={t('cloudflare.attention')}>
          {formError ??
            (actionError ? errorMessage(actionError) : (status.error ?? invalidApproval))}
        </Banner>
      )}

      {connected && status.domains.length === 0 && (
        <Banner tone="info" title={t('cloudflare.noDomainTitle')}>
          {t('cloudflare.noDomainBody')}
        </Banner>
      )}

      {connected && status.domains.length > 0 && (
        <form
          className="flex min-w-0 flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (unchanged) return;
            clearFeedback();
            const parsed = CloudflareCreateBody.safeParse({
              domainId: selectedDomain?.id,
              subdomain,
              tunnelName,
            });
            if (!parsed.success) {
              setFormError(parsed.error.issues[0]?.message ?? t('cloudflare.formInvalid'));
              return;
            }
            if (!selectedDomain || busy) return;
            create.mutate(parsed.data, { onSuccess: () => setEditing(false) });
          }}
        >
          <h3 className="text-base font-semibold">{t('cloudflare.step2.title')}</h3>
          <Field label={t('cloudflare.step2.domain')}>
            {(props) => (
              <Select value={selectedDomain?.id ?? ''} onValueChange={setDomainId} disabled={busy}>
                <SelectTrigger {...props} className="min-h-11 w-full min-w-0 text-base md:text-sm">
                  <SelectValue placeholder={t('cloudflare.step2.domainPlaceholder')} />
                </SelectTrigger>
                <SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">
                  {status.domains.map((domain) => (
                    <SelectItem
                      key={domain.id}
                      value={domain.id}
                      className="min-h-11 break-all whitespace-normal"
                    >
                      {domain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          {selectedDomain?.accountName && (
            <p className="text-sm break-all text-muted-foreground">
              {t('cloudflare.step2.account', { name: selectedDomain.accountName })}
            </p>
          )}
          <Field label={t('cloudflare.step2.prefix')} hint={t('cloudflare.step2.prefixHint')}>
            {(props) => (
              <Input
                {...props}
                className="h-11"
                value={subdomain}
                maxLength={63}
                onChange={(event) => setSubdomain(event.target.value)}
                disabled={busy}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={DEFAULT_SUBDOMAIN}
              />
            )}
          </Field>
          {address && (
            <div className="rounded-lg border bg-muted p-3">
              <p className="mb-1 text-sm text-muted-foreground">{t('cloudflare.step2.preview')}</p>
              <p
                className="text-base font-medium break-all"
                aria-label={t('cloudflare.step2.previewLabel')}
              >
                {address}
              </p>
            </div>
          )}
          <Field
            label={t('cloudflare.step2.tunnelName')}
            hint={t('cloudflare.step2.tunnelNameHint')}
          >
            {(props) => (
              <Input
                {...props}
                className="h-11"
                value={tunnelName}
                maxLength={64}
                onChange={(event) => setTunnelName(event.target.value)}
                disabled={busy}
                placeholder={DEFAULT_TUNNEL_NAME}
              />
            )}
          </Field>
          <div className="flex flex-col gap-2 border-t pt-4">
            <h3 className="text-base font-semibold">
              {savedHostname ? t('cloudflare.step3.saveTitle') : t('cloudflare.step3.connectTitle')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('cloudflare.step3.body')}</p>
            <Button
              type="submit"
              size="touch"
              disabled={
                busy || unchanged || !selectedDomain || !subdomain.trim() || !tunnelName.trim()
              }
            >
              <Pending show={create.isPending || status.busy} />
              {create.isPending || status.busy
                ? t('cloudflare.step3.connecting')
                : savedHostname
                  ? t('cloudflare.step3.saveSubmit')
                  : t('cloudflare.step3.createSubmit')}
            </Button>
            {unchanged && (
              <p className="text-sm text-muted-foreground">{t('cloudflare.step3.unchanged')}</p>
            )}
            {savedHostname && (
              <Button
                type="button"
                variant="ghost"
                size="touch"
                disabled={busy}
                onClick={() => {
                  setFormError(null);
                  account.reset();
                  setEditing(false);
                }}
              >
                {t('cloudflare.step3.cancel')}
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

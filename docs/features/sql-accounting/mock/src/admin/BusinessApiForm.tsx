// Proposed (business-api): connect a number on the WhatsApp Business API (Meta Cloud API). Enterprise only.
// The admin pastes the IDs, a permanent access token and the App secret from their own Meta app; the
// server checks them with the Graph API (the mock simulates the check). Shared by Admin → Inboxes and the
// setup wizard's WhatsApp step.
import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, Globe, ShieldCheck } from 'lucide-react';
import { Banner, StatusDot } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTunnel } from '../api/queries';
import { Field } from './adminUi';
import type { MockApiConnection } from '../mock/inboxes';

const META_GUIDE_URL = 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started';
export const WEBHOOK_PATH = '/api/ext/wa-cloud/webhook';

export interface CheckedNumber {
  api: MockApiConnection;
  /** Display number Meta reports for the phone number ID. */
  number: string;
}

/** The four details from Meta, a "Where do I find these?" guide and Check and connect. */
export function BusinessApiForm({
  onConnected,
  submitLabel,
  replacing,
  expectNumber,
}: Readonly<{
  onConnected(result: CheckedNumber): void;
  /** Defaults to "Check and connect". */
  submitLabel?: string;
  /** Edit: only a new token and App secret for the same number (the IDs stay). */
  replacing?: MockApiConnection;
  /** Switching a linked-phone inbox: Meta must report this same number, or its chats would mix. */
  expectNumber?: string;
}>) {
  const { t } = useTranslation('admin');
  const [phoneNumberId, setPhoneNumberId] = useState(replacing?.phoneNumberId ?? '');
  const [wabaId, setWabaId] = useState(replacing?.wabaId ?? '');
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const required = (value: string) =>
    submitted && value.trim() === '' ? t('mockApi.required') : undefined;
  const digits = (value: string) =>
    required(value) ??
    (submitted && !/^\d{6,20}$/.test(value.trim()) ? t('mockApi.digitsOnly') : undefined);

  const check = (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSubmitted(true);
    setError(null);
    const ids = [phoneNumberId, wabaId].map((v) => v.trim());
    if (ids.some((v) => !/^\d{6,20}$/.test(v)) || !token.trim() || !secret.trim()) return;
    setChecking(true);
    // Mock: the server would call the Graph API (phone number, WABA, token permissions) here.
    setTimeout(() => {
      setChecking(false);
      if (/bad|invalid|expired/i.test(token)) return setError(t('mockApi.errorToken'));
      if (ids[0] === ids[1] || ids[0]!.startsWith('000')) return setError(t('mockApi.errorNumber'));
      // Mock: a phone number ID starting with 999 is another number than the inbox's.
      if (expectNumber && ids[0]!.startsWith('999'))
        return setError(t('mockApi.errorOtherNumber', { number: expectNumber }));
      onConnected({
        api: {
          phoneNumberId: ids[0]!,
          wabaId: ids[1]!,
          verifiedName: replacing?.verifiedName ?? 'Kopi Apong Sdn Bhd',
          quality: replacing?.quality ?? 'high',
          limit: replacing?.limit ?? '250',
          tokenEnd: token.trim().slice(-4),
        },
        number: expectNumber ?? '+60 3-2785 6000',
      });
    }, 1100);
  };

  return (
    <form
      onSubmit={check}
      noValidate
      className="flex min-w-0 flex-col gap-4"
      data-testid="api-form"
    >
      {!replacing && (
        <>
          <Field
            label={t('mockApi.phoneNumberId')}
            hint={t('mockApi.phoneNumberIdHint')}
            error={digits(phoneNumberId)}
          >
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                autoComplete="off"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('mockApi.wabaId')} hint={t('mockApi.wabaIdHint')} error={digits(wabaId)}>
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                autoComplete="off"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
              />
            )}
          </Field>
        </>
      )}
      <Field label={t('mockApi.token')} hint={t('mockApi.tokenHint')} error={required(token)}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('mockApi.secret')} hint={t('mockApi.secretHint')} error={required(secret)}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        )}
      </Field>

      <div className="rounded-lg border bg-muted/40">
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="w-full justify-between px-3 md:min-h-9"
          aria-expanded={guideOpen}
          onClick={() => setGuideOpen((o) => !o)}
        >
          {t('mockApi.guideTitle')}
          <ChevronDown className={guideOpen ? 'rotate-180 transition' : 'transition'} aria-hidden />
        </Button>
        {guideOpen && (
          <div className="flex flex-col gap-2 px-3 pb-3 text-sm text-muted-foreground">
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t('mockApi.guide1')}</li>
              <li>{t('mockApi.guide2')}</li>
              <li>{t('mockApi.guide3')}</li>
              <li>{t('mockApi.guide4')}</li>
            </ol>
            <Button
              asChild
              variant="link"
              size="touch"
              className="h-auto self-start px-0 text-left whitespace-normal"
            >
              <a href={META_GUIDE_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
                {t('mockApi.guideLink')}
              </a>
            </Button>
          </div>
        )}
      </div>

      {!replacing && !expectNumber && <Banner tone="info">{t('mockApi.phoneAppNote')}</Banner>}
      {error && (
        <Banner tone="danger" title={t('mockApi.errorTitle')}>
          {error}
        </Banner>
      )}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        {t('mockApi.stored')}
      </p>
      <Button
        type="submit"
        size="touch"
        className="self-start md:min-h-9"
        disabled={checking}
        aria-busy={checking || undefined}
      >
        {checking ? t('mockApi.checking') : (submitLabel ?? t('mockApi.check'))}
      </Button>
    </form>
  );
}

/** Verified name, number, quality rating and messaging limit, as Meta reports them. */
export function ApiNumberSummary({
  api,
  number,
}: Readonly<{ api: MockApiConnection; number: string }>) {
  const { t } = useTranslation('admin');
  const tone = api.quality === 'high' ? 'success' : api.quality === 'medium' ? 'warning' : 'danger';
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">{t('mockApi.verifiedName')}</dt>
      <dd className="min-w-0 break-words font-medium">{api.verifiedName}</dd>
      <dt className="text-muted-foreground">{t('mockApi.number')}</dt>
      <dd className="tabular-nums">{number}</dd>
      <dt className="text-muted-foreground">{t('mockApi.quality')}</dt>
      <dd>
        <StatusDot tone={tone} label={t(`mockApi.qualityValue.${api.quality}`)} />
      </dd>
      <dt className="text-muted-foreground">{t('mockApi.limit')}</dt>
      <dd>{t(`mockApi.limitValue.${api.limit}`)}</dd>
    </dl>
  );
}

/**
 * Where Meta delivers this number's messages. Meta needs a public https address, so the webhook rides on
 * Phone access (the Cloudflare tunnel); EzyChat registers the address with Meta itself and again when a
 * Quick Tunnel address changes.
 */
export function WebhookStatus({
  failing = false,
  compact = false,
}: Readonly<{ failing?: boolean; compact?: boolean }>) {
  const { t } = useTranslation('admin');
  const tunnel = useTunnel();
  const running = tunnel.data?.state === 'running' && !!tunnel.data.url;
  if (!running)
    return (
      <Banner tone="warning" title={t('mockApi.webhook.offTitle')}>
        <span className="flex flex-col gap-2">
          <span>{t('mockApi.webhook.offBody')}</span>
          {!compact && (
            <Button asChild variant="outline" size="touch" className="self-start md:min-h-9">
              <Link to="/admin/tunnel">
                <Globe aria-hidden />
                {t('mockApi.webhook.openTunnel')}
              </Link>
            </Button>
          )}
        </span>
      </Banner>
    );
  const url = `${tunnel.data!.url}${WEBHOOK_PATH}`;
  if (failing)
    return (
      <Banner tone="danger" title={t('mockApi.webhook.failTitle')}>
        {t('mockApi.webhook.failBody')}
      </Banner>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm" data-testid="webhook-ok">
      <StatusDot
        tone="success"
        label={<span className="font-medium">{t('mockApi.webhook.okTitle')}</span>}
      />
      <code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-xs">{url}</code>
      <p className="text-muted-foreground">
        {tunnel.data!.mode === 'quick'
          ? t('mockApi.webhook.quickNote')
          : t('mockApi.webhook.namedNote')}
      </p>
    </div>
  );
}

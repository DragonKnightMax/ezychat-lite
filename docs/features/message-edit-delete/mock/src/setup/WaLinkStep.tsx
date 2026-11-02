import type React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowRight, CircleCheck, Loader2, QrCode, Smartphone } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PhoneLink } from '../wa/PhoneLink';
import { errorMessage } from '../api/client';
import { useWaAction, useWaStatus } from '../api/queries';
import { Banner, StatusDot, stateTone } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ButtonSpinner } from '../auth/AuthShell';
import { connectedAsLabel } from './connected-label';

export interface WaLinkStepProps {
  onContinue?: () => void;
  onSkip?: () => void;
}

const KNOWN_STATES = [
  'open',
  'qr',
  'connecting',
  'starting',
  'logged_out',
  'replaced',
  'blocked',
  'disconnected',
] as const;
type KnownState = (typeof KNOWN_STATES)[number];
const isKnownState = (state: string): state is KnownState =>
  (KNOWN_STATES as readonly string[]).includes(state);

/** Shows the pairing QR (from wa status) until the number is linked. */
export function WaLinkStep({ onContinue, onSkip }: WaLinkStepProps) {
  const { t } = useTranslation(['auth', 'common']);
  const wa = useWaStatus();
  const action = useWaAction();
  const s = wa.data;

  let body: React.ReactNode;
  if (wa.isPending) {
    body = <Waiting text={t('setup.wa.checking')} />;
  } else if (wa.error) {
    body = <Banner tone="danger">{errorMessage(wa.error)}</Banner>;
  } else if (s?.state === 'open') {
    body = (
      <div
        role="status"
        className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-sm"
      >
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">{t('setup.wa.linked')}</p>
          <p className="break-words text-muted-foreground">{connectedAsLabel(s.me, t)}</p>
        </div>
      </div>
    );
  } else if (s?.state === 'qr' && s.qr) {
    body = (
      <div className="flex flex-col items-center gap-3">
        <Card className="gap-0 p-3">
          <CardContent className="p-0">
            <QRCodeSVG
              value={s.qr}
              size={240}
              marginSize={1}
              className="h-auto w-[min(240px,70vw)] rounded-md"
              title={t('setup.wa.qrTitle')}
            />
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">{t('setup.wa.qrRefresh')}</p>
      </div>
    );
  } else if (
    s?.state === 'logged_out' ||
    s?.state === 'replaced' ||
    s?.state === 'blocked' ||
    s?.state === 'disconnected'
  ) {
    body = (
      <div className="flex flex-col gap-3">
        <Banner tone="warning" title={t(`setup.wa.stateTitles.${s.state}`)}>
          {s.lastError ?? t('setup.wa.relinkHint')}
        </Banner>
        {action.error && <Banner tone="danger">{errorMessage(action.error)}</Banner>}
        <Button
          variant="secondary"
          size="touch"
          aria-busy={action.isPending || undefined}
          disabled={action.isPending}
          onClick={() => action.mutate('relink')}
        >
          {action.isPending ? <ButtonSpinner /> : <QrCode aria-hidden="true" />}
          {t('setup.wa.showNewQr')}
        </Button>
      </div>
    );
  } else {
    body = <Waiting text={t('setup.wa.waitingQr')} />;
  }

  const linked = s?.state === 'open';
  const linking = !wa.isPending && !wa.error && (s?.state === 'qr' || s?.state === 'connecting');
  if (linking) {
    body = (
      <Tabs defaultValue="qr" className="gap-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="qr" className="min-h-9">
            <QrCode aria-hidden="true" />
            {t('setup.wa.tabQr')}
          </TabsTrigger>
          <TabsTrigger value="phone" className="min-h-9">
            <Smartphone aria-hidden="true" />
            {t('setup.wa.tabPhone')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="qr">{body}</TabsContent>
        <TabsContent value="phone">
          <PhoneLink />
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{t('setup.wa.title')}</h2>
          {s?.state && (
            <StatusDot
              tone={stateTone(s.state)}
              pulse={s.state === 'qr' || s.state === 'connecting'}
              label={
                <span className="text-muted-foreground">
                  {isKnownState(s.state) ? t(`setup.wa.states.${s.state}`) : s.state}
                </span>
              }
            />
          )}
        </div>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t('setup.wa.step1')}</li>
          <li>
            <Trans
              t={t}
              i18nKey="setup.wa.step2"
              components={{ b: <strong className="text-foreground" /> }}
            />
          </li>
          <li>{t('setup.wa.step3')}</li>
        </ol>
      </div>
      {body}
      <p className="text-xs text-muted-foreground">{t('setup.wa.disclaimer')}</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onSkip && !linked && (
          <Button variant="ghost" size="touch" onClick={onSkip}>
            {t('setup.wa.skip')}
          </Button>
        )}
        {onContinue && (
          <Button size="touch" onClick={onContinue} disabled={!linked}>
            {t('common:actions.continue')}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-8">
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export default WaLinkStep;

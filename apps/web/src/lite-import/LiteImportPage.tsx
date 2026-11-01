// Admin → Inboxes → Add a number from EzyChat Lite (`/admin/inboxes/lite`). Desktop window on the host
// PC only: a phone, another PC or the tunnel sees "Only on the EzyChat computer".
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, Loader2, MonitorDown, SearchX, ShieldCheck } from 'lucide-react';
import type { DesktopLiteImportBridge, LiteImportPhase } from '@ezychat/shared';
import { useSettings, useUsers } from '../api/queries';
import { Banner, PageHeader } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { liteImportBridge, useLiteImport } from './bridge';
import { LiteChecklistCard } from './notice';
import {
  ChecksStep,
  DoneStep,
  FailedStep,
  FoundStep,
  ProtectedStep,
  ReviewStep,
  RunningStep,
} from './steps';
import { IconBubble, IconLine } from './ui';

type View = 'found' | 'checks' | 'review' | 'running' | 'done';

function viewOf(phase: LiteImportPhase, local: 'found' | 'checks' | 'review'): View {
  if (phase === 'running') return 'running';
  if (phase === 'done') return 'done';
  if (phase === 'failed') return 'running';
  if (phase === 'blocked' && local === 'review') return 'checks';
  return local;
}

function Stepper({ merge, at, done }: { merge: boolean; at: View; done: boolean }) {
  const { t } = useTranslation('admin');
  const steps: View[] = merge
    ? ['found', 'checks', 'review', 'running', 'done']
    : ['found', 'checks', 'running', 'done'];
  const idx = steps.indexOf(at);
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t('liteImport.progress')}>
      {steps.map((s, i) => (
        <li
          key={s}
          className={cn(
            'flex items-center gap-1.5',
            i === idx ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
          aria-current={i === idx ? 'step' : undefined}
        >
          {i < idx || (done && i === idx) ? (
            <CheckCircle2 className="size-4 text-success" aria-hidden />
          ) : (
            <Circle className={cn('size-4', i === idx && 'text-primary')} aria-hidden />
          )}
          {t(`liteImport.step.${s}`)}
        </li>
      ))}
    </ol>
  );
}

/** What a phone, another PC or the tunnel shows instead of the import. */
export function DesktopOnly() {
  const { t } = useTranslation('admin');
  return (
    <Card data-testid="lite-desktop-only">
      <CardContent className="flex flex-col items-start gap-3 p-6">
        <IconBubble icon={MonitorDown} tone="warning" />
        <p className="font-semibold">{t('liteImport.desktopOnly.title')}</p>
        <ul className="flex flex-col gap-1">
          <IconLine icon={MonitorDown}>{t('liteImport.desktopOnly.pc')}</IconLine>
          <IconLine icon={ShieldCheck}>{t('liteImport.desktopOnly.admin')}</IconLine>
        </ul>
        <Button asChild variant="outline" size="touch">
          <Link to="/admin/inboxes">{t('liteImport.backInboxes')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function NoLite() {
  const { t } = useTranslation('admin');
  return (
    <Card data-testid="lite-none">
      <CardContent className="flex flex-col items-start gap-3 p-6">
        <IconBubble icon={SearchX} />
        <p className="font-semibold">{t('liteImport.none.title')}</p>
        <p className="text-sm text-muted-foreground">{t('liteImport.none.body')}</p>
        <Button asChild variant="outline" size="touch">
          <Link to="/admin/inboxes">{t('liteImport.backInboxes')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Wizard({ bridge }: { bridge: DesktopLiteImportBridge }) {
  const { t } = useTranslation('admin');
  const { state, error, busy, act } = useLiteImport(bridge);
  const users = useUsers();
  const settings = useSettings();
  const [local, setLocal] = useState<'found' | 'checks' | 'review'>('found');

  if (error) return <Banner tone="danger">{t('liteImport.readFailed')}</Banner>;
  if (!state || state.phase === 'idle')
    return (
      <Loader2
        className="size-5 animate-spin text-muted-foreground"
        aria-label={t('liteImport.scanning')}
      />
    );
  const cancel = (
    <Button asChild variant="outline" size="touch">
      <Link to="/admin/inboxes">{t('liteImport.cancel')}</Link>
    </Button>
  );
  const step = { state, bridge, act, busy };
  if (state.phase === 'protected')
    return (
      <div className="flex min-w-0 flex-col gap-5" data-testid="lite-wizard" data-phase="protected">
        <Stepper merge at="found" done={false} />
        {/* Admin → Inboxes runs after setup, so Lite's number comes in as a new inbox. */}
        <ProtectedStep {...step} mode="merge" cancel={cancel} />
      </div>
    );
  if (state.phase === 'none' || !state.lite) return <NoLite />;

  const merge = state.mode === 'merge';
  const view = viewOf(state.phase, local);
  const people = (users.data ?? []).filter((u) => !u.disabled && u.kind !== 'ai');
  const fail = t('liteImport.actionFailed');
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="lite-wizard" data-phase={state.phase}>
      <Stepper merge={merge} at={view} done={state.phase === 'done'} />
      {view === 'found' && (
        <FoundStep state={state} onContinue={() => setLocal('checks')} cancel={cancel} />
      )}
      {view === 'checks' && (
        <ChecksStep
          {...step}
          continueLabel={t('liteImport.check.continue')}
          onContinue={() =>
            merge ? setLocal('review') : void act(() => bridge.start({ team: [] }), fail)
          }
        />
      )}
      {view === 'review' &&
        (users.isPending || settings.isPending ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <ReviewStep
            {...step}
            people={people}
            // Unknown (settings failed to load) reads as "has its own": the old, safe wording.
            ownAddress={
              settings.data
                ? settings.data.hasTunnelToken || Boolean(settings.data.namedTunnelHostname)
                : true
            }
          />
        ))}
      {view === 'running' &&
        (state.phase === 'failed' ? (
          <FailedStep {...step} onRetry={() => setLocal('found')} />
        ) : (
          <RunningStep state={state} />
        ))}
      {view === 'done' && (
        <>
          <DoneStep state={state} />
          <LiteChecklistCard />
        </>
      )}
    </div>
  );
}

export function LiteImportPage() {
  const { t } = useTranslation('admin');
  const bridge = liteImportBridge();
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <nav className="text-sm">
        <Link to="/admin/inboxes" className="text-muted-foreground hover:text-foreground">
          {t('liteImport.backInboxes')}
        </Link>
      </nav>
      <PageHeader title={t('liteImport.pageTitle')} className="pb-0" />
      {bridge ? <Wizard bridge={bridge} /> : <DesktopOnly />}
    </div>
  );
}

export default LiteImportPage;

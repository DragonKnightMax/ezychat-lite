// Setup wizard step 0 (new install, no account yet): when the desktop window on this PC finds EzyChat
// Lite data, the wizard starts with "Bring from EzyChat Lite" (copy: replaces Account, WhatsApp and AI
// assistant) or "Start new" (today's wizard). Without the bridge or without Lite: today's wizard only.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Download,
  KeyRound,
  MessageSquare,
  MonitorDown,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import type { DesktopLiteImportBridge } from '@ezychat/shared';
import { useSetupStatus } from '../api/queries';
import { AuthShell, FullPageLoader } from '../auth/AuthShell';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { liteImportBridge, useLiteImport } from './bridge';
import { ChecksStep, DoneStep, FailedStep, ProtectedStep, RunningStep } from './steps';
import { IconBubble, IconLine, MoveFigure, type Icon } from './ui';

type LiteStep = 'start' | 'bring' | 'ready';
const LITE_STEPS: LiteStep[] = ['start', 'bring', 'ready'];

/** Same look as the setup wizard's step indicator: Start → Bring data → Ready. */
function LiteSteps({ current }: { current: LiteStep }) {
  const { t } = useTranslation('admin');
  const idx = LITE_STEPS.indexOf(current);
  return (
    <ol className="mb-5 flex items-center gap-2 text-xs" aria-label={t('liteImport.progress')}>
      {LITE_STEPS.map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
              i < idx && 'bg-primary text-primary-foreground',
              i === idx && 'border-2 border-primary text-primary',
              i > idx && 'border border-border text-muted-foreground',
            )}
            aria-current={i === idx ? 'step' : undefined}
          >
            {i < idx ? <Check className="size-4" aria-hidden /> : i + 1}
          </span>
          <span
            className={cn(
              'hidden truncate sm:inline',
              i === idx ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {t(`liteImport.setup.steps.${s}`)}
          </span>
          {i < LITE_STEPS.length - 1 && (
            <span
              aria-hidden="true"
              className={cn('h-px min-w-3 flex-1', i < idx ? 'bg-primary' : 'bg-border')}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function BigChoice({
  icon,
  title,
  points,
  primary = false,
  onPick,
  testId,
}: {
  icon: Icon;
  title: string;
  points: Array<[Icon, string]>;
  primary?: boolean;
  onPick: () => void;
  testId: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-lg border p-4',
        primary && 'border-primary',
      )}
      data-testid={testId}
    >
      <div className="flex items-center gap-3">
        <IconBubble icon={icon} />
        <p className="font-semibold">{title}</p>
      </div>
      <ul className="flex flex-1 flex-col gap-1">
        {points.map(([I, text]) => (
          <IconLine key={text} icon={I} tone={primary ? 'text-success' : undefined}>
            {text}
          </IconLine>
        ))}
      </ul>
      <Button
        variant={primary ? 'default' : 'outline'}
        size="touch"
        className="h-auto py-2 whitespace-normal"
        onClick={onPick}
      >
        {title}
      </Button>
    </div>
  );
}

function WithBridge({
  bridge,
  startNew,
}: {
  bridge: DesktopLiteImportBridge;
  startNew: ReactNode;
}) {
  const { t } = useTranslation('admin');
  const status = useSetupStatus();
  const { state, error, busy, act } = useLiteImport(bridge);
  const [path, setPath] = useState<'choose' | 'lite' | 'new'>('choose');

  if (path === 'new' || error) return startNew;
  if (!state || state.phase === 'idle') return <FullPageLoader />;
  if (state.phase === 'none') return startNew;
  // Mid-import (the window was reloaded): stay on the Lite path.
  const underway = state.phase === 'running' || state.phase === 'done' || state.phase === 'failed';
  const lite = state.lite;
  // Lite runs as an OS service: its data is locked, so nothing is known until "Allow" frees it.
  const locked = state.phase === 'protected';
  if (path === 'choose' && !underway) {
    if (status.isPending) return <FullPageLoader />;
    if (!status.data?.needsSetup || (!locked && (state.mode !== 'copy' || !lite))) return startNew;
  }

  const fail = t('liteImport.actionFailed');
  const step = { state, bridge, act, busy };
  const choosing = path === 'choose' && !underway;
  return (
    <AuthShell
      wide
      title={t('liteImport.setup.title')}
      subtitle={choosing ? t('liteImport.setup.subtitle') : undefined}
    >
      <div
        className="flex min-w-0 flex-col gap-4"
        data-testid="lite-setup"
        data-path={choosing ? 'choose' : 'lite'}
      >
        {choosing && (lite || locked) && (
          <>
            <MoveFigure number={lite?.number ?? null} service={locked} mode="copy" />
            <div className="grid gap-3 sm:grid-cols-2">
              <BigChoice
                testId="lite-setup-bring"
                icon={Download}
                title={t('liteImport.setup.bring')}
                primary
                points={
                  lite && !locked
                    ? [
                        [MessageSquare, t('liteImport.setup.bringChats', { chats: lite.chats })],
                        [Users, t('liteImport.setup.bringTeam', { n: lite.users.length })],
                        [Zap, t('liteImport.found.noQr')],
                      ]
                    : [
                        [MessageSquare, t('liteImport.setup.bringAll')],
                        [KeyRound, t('liteImport.protected.ask')],
                        [Zap, t('liteImport.found.noQr')],
                      ]
                }
                onPick={() => setPath('lite')}
              />
              <BigChoice
                testId="lite-setup-new"
                icon={Sparkles}
                title={t('liteImport.setup.new')}
                points={[
                  [UserPlus, t('liteImport.setup.newAccount')],
                  [Smartphone, t('liteImport.setup.newQr')],
                ]}
                onPick={() => setPath('new')}
              />
            </div>
            <ul className="flex flex-col gap-1">
              <IconLine icon={ShieldCheck}>{t('liteImport.found.kept')}</IconLine>
              <IconLine icon={MonitorDown}>{t('liteImport.setup.onlyHere')}</IconLine>
            </ul>
          </>
        )}
        {!choosing && (
          <>
            <LiteSteps current={state.phase === 'done' ? 'ready' : 'bring'} />
            {locked && (
              <ProtectedStep
                {...step}
                mode="copy"
                cancel={
                  <Button variant="outline" size="touch" onClick={() => setPath('new')}>
                    {t('liteImport.setup.new')}
                  </Button>
                }
              />
            )}
            {(state.phase === 'found' || state.phase === 'blocked') && (
              <ChecksStep
                {...step}
                continueLabel={t('liteImport.found.continueCopy')}
                onContinue={() => void act(() => bridge.start({ team: [] }), fail)}
              />
            )}
            {state.phase === 'running' && <RunningStep state={state} />}
            {state.phase === 'failed' && (
              <FailedStep
                {...step}
                extra={
                  <Button variant="ghost" size="touch" onClick={() => setPath('new')}>
                    {t('liteImport.setup.new')}
                  </Button>
                }
              />
            )}
            {state.phase === 'done' && <DoneStep state={state} />}
          </>
        )}
      </div>
    </AuthShell>
  );
}

/** The setup wizard's entry: the Start step when Lite data is on this PC, else `startNew` as is. */
export function LiteSetupStart({ startNew }: { startNew: ReactNode }) {
  const bridge = liteImportBridge();
  if (!bridge) return <>{startNew}</>;
  return <WithBridge bridge={bridge} startNew={startNew} />;
}

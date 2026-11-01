import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  CircleCheck,
  CircleDashed,
  Inbox,
  Smartphone,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ApiError, errorMessage } from '../api/client';
import { useSetupAdmin, useSetupStatus, useWaStatus } from '../api/queries';
import { AuthShell, ButtonSpinner, Field, FullPageLoader } from '../auth/AuthShell';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { WaLinkStep } from './WaLinkStep';
import { AiAssistantStep } from './AiAssistantStep';
import { usernameFrom, usernameFromName } from './username';
import { WhatsAppStepChoice } from './WhatsAppStepChoice';
import { LiteSetupStart } from '../lite-import/LiteSetupStart';

/** Account → WhatsApp → AI assistant (skippable) → Ready. */
type Step = 'account' | 'whatsapp' | 'ai' | 'ready';

const STEPS: Step[] = ['account', 'whatsapp', 'ai', 'ready'];

function StepIndicator({ current }: { current: Step }) {
  const { t } = useTranslation('auth');
  const idx = STEPS.indexOf(current);
  return (
    <ol className="mb-5 flex items-center gap-2 text-xs" aria-label={t('setup.progress')}>
      {STEPS.map((s, i) => (
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
            {i < idx ? <Check className="size-4" aria-label={t('setup.stepDone')} /> : i + 1}
          </span>
          <span
            className={cn(
              'hidden truncate sm:inline',
              i === idx ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {t(`setup.steps.${s}`)}
          </span>
          {i < STEPS.length - 1 && (
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

function CurrentStepLabel({ current }: { current: Step }) {
  const { t } = useTranslation('auth');
  return (
    <p className="-mt-3 mb-5 text-center text-sm font-medium sm:hidden">
      {t('setup.stepOf', {
        n: STEPS.indexOf(current) + 1,
        total: STEPS.length,
        name: t(`setup.steps.${current}`),
      })}
    </p>
  );
}

function AccountStep({
  businessName,
  onBusinessName,
  onDone,
}: {
  businessName: string;
  onBusinessName: (value: string) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('auth');
  const create = useSetupAdmin();
  const [displayName, setDisplayName] = useState('');
  // Filled in from "Your name" until the owner edits it.
  const [typedUsername, setTypedUsername] = useState<string | null>(null);
  const username = typedUsername ?? usernameFrom(displayName);
  const [password, setPassword] = useState('');

  // A cleared field explains itself; the prefilled one is always valid once a name is typed.
  const usernameError =
    (username.length > 0 || typedUsername !== null) && !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)
      ? t('setup.admin.usernameRule')
      : undefined;
  const passwordError =
    password.length > 0 && password.length < 8 ? t('setup.admin.minLength') : undefined;
  const valid =
    businessName.trim().length > 0 &&
    !usernameError &&
    username.length >= 3 &&
    displayName.trim().length > 0 &&
    password.length >= 8;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    create.mutate({ username, displayName: displayName.trim(), password }, { onSuccess: onDone });
  };

  const forbidden = create.error instanceof ApiError && create.error.status === 403;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-muted-foreground">{t('setup.admin.introShort')}</p>
      {create.error && (
        <Banner tone="danger" title={forbidden ? t('setup.admin.forbiddenTitle') : undefined}>
          {forbidden ? t('setup.admin.forbiddenBody') : errorMessage(create.error)}
        </Banner>
      )}
      <Field
        label={t('setup.admin.businessName')}
        autoComplete="organization"
        value={businessName}
        maxLength={80}
        onChange={(e) => onBusinessName(e.target.value)}
        hint={t('setup.admin.businessNameHint')}
      />
      <Field
        label={t('setup.admin.yourName')}
        autoComplete="name"
        value={displayName}
        maxLength={64}
        onChange={(e) => setDisplayName(e.target.value)}
        hint={t('setup.admin.displayNameHint')}
      />
      <Field
        label={t('setup.admin.username')}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={username}
        onChange={(e) => setTypedUsername(e.target.value)}
        error={usernameError}
        hint={
          typedUsername === null &&
          displayName.trim() !== '' &&
          usernameFromName(displayName).length < 3
            ? t('setup.admin.usernamePickedHint')
            : t('setup.admin.usernameAutoHint')
        }
      />
      <Field
        label={t('setup.admin.passLabel')}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={passwordError}
        hint={t('setup.admin.minLength')}
      />
      <Button
        type="submit"
        size="touch"
        className="w-full"
        aria-busy={create.isPending || undefined}
        disabled={create.isPending || !valid}
      >
        {create.isPending && <ButtonSpinner />}
        {t('setup.admin.submitContinue')}
        {!create.isPending && <ArrowRight aria-hidden="true" />}
      </Button>
    </form>
  );
}

function SummaryRow({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {done ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className={cn('min-w-0', !done && 'text-muted-foreground')}>{children}</span>
    </li>
  );
}

function ReadyStep({ aiOn }: { aiOn: boolean }) {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const wa = useWaStatus();
  const linked = wa.data?.state === 'open';
  return (
    <div className="flex flex-col gap-5">
      <div
        role="status"
        className="flex flex-col gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-3"
      >
        <h2 className="text-base font-semibold">{t('setup.ready.title')}</h2>
        <ul className="flex flex-col gap-2">
          <SummaryRow done={linked}>
            {linked ? t('setup.ready.waLinked') : t('setup.ready.waNotLinked')}
          </SummaryRow>
          <SummaryRow done={aiOn}>
            {aiOn ? t('setup.ready.aiOn') : t('setup.ready.aiOff')}
          </SummaryRow>
        </ul>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{t('setup.ready.later')}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild variant="outline" size="touch" className="w-full sm:flex-1">
            <Link to="/admin/members">
              <Users aria-hidden="true" />
              {t('setup.ready.addTeammates')}
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            size="touch"
            className="h-auto w-full py-2 whitespace-normal sm:flex-1"
          >
            <Link to="/admin/tunnel">
              <Smartphone aria-hidden="true" />
              {t('setup.ready.phoneAccess')}
            </Link>
          </Button>
        </div>
      </div>
      <Button size="touch" className="w-full" onClick={() => navigate('/', { replace: true })}>
        <Inbox aria-hidden="true" />
        {t('setup.ready.goInbox')}
      </Button>
    </div>
  );
}

/** First-run wizard: account → link WhatsApp → AI assistant (skippable) → ready. */
function NewSetupWizard() {
  const { t } = useTranslation('auth');
  const status = useSetupStatus();
  const [step, setStep] = useState<Step>('account');
  const [businessName, setBusinessName] = useState('');
  const [aiOn, setAiOn] = useState(false);
  // Once needsSetup=true has been seen this visit we're mid-wizard: creating the admin flips
  // needsSetup to false *before* the step advances, which must not bounce us to the inbox.
  const [wizardStarted, setWizardStarted] = useState(false);
  if (status.data?.needsSetup && !wizardStarted) setWizardStarted(true);

  if (status.isPending) return <FullPageLoader />;
  // Setup already finished (and we're not mid-wizard) → leave.
  if (!wizardStarted && step === 'account' && status.data && !status.data.needsSetup)
    return <Navigate to="/" replace />;

  return (
    <AuthShell
      title={t('setup.title')}
      subtitle={t('setup.subtitle')}
      illustration={step === 'account' ? '/illustrations/welcome.png' : undefined}
      wide
    >
      <StepIndicator current={step} />
      <CurrentStepLabel current={step} />
      {status.error && step === 'account' && (
        <Banner tone="danger" className="mb-4">
          {errorMessage(status.error)}
        </Banner>
      )}
      {step === 'account' && (
        <AccountStep
          businessName={businessName}
          onBusinessName={setBusinessName}
          onDone={() => setStep('whatsapp')}
        />
      )}
      {step === 'whatsapp' && (
        <WhatsAppStepChoice
          phoneStep={<WaLinkStep onContinue={() => setStep('ai')} onSkip={() => setStep('ai')} />}
          onContinue={() => setStep('ai')}
          onSkip={() => setStep('ai')}
        />
      )}
      {step === 'ai' && (
        <AiAssistantStep
          businessName={businessName.trim()}
          onDone={(on) => {
            setAiOn(on);
            setStep('ready');
          }}
        />
      )}
      {step === 'ready' && <ReadyStep aiOn={aiOn} />}
    </AuthShell>
  );
}

/**
 * The setup page. In the desktop app, when EzyChat Lite data is on this PC, a Start step offers to bring
 * it over first (`lite-import/LiteSetupStart.tsx`); otherwise it is the wizard above, unchanged.
 */
export function SetupWizard() {
  return <LiteSetupStart startNew={<NewSetupWizard />} />;
}

export default SetupWizard;

import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client';
import { useLogin, useMe, useSetupStatus } from '../api/queries';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { AuthShell, ButtonSpinner, Field } from './AuthShell';

function safeFrom(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}

export function LoginPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  const setup = useSetupStatus();
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);

  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.data && !login.isPending) {
    return (
      <Navigate
        to={me.data.mustChangePassword ? '/change-password' : safeFrom(location.state)}
        replace
      />
    );
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Sign in stays enabled; an incomplete form explains itself instead of a dead button.
    setSubmitted(true);
    if (!username.trim() || !password) return;
    login.mutate(
      { username: username.trim(), password },
      {
        onSuccess: (user) => {
          if (user?.mustChangePassword) navigate('/change-password', { replace: true });
          else navigate(safeFrom(location.state), { replace: true });
        },
      },
    );
  };

  return (
    <AuthShell title={t('login.title')} subtitle={t('login.subtitle')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {login.error && <Banner tone="danger">{errorMessage(login.error)}</Banner>}
        <Field
          label={t('login.username')}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={submitted && !username.trim() ? t('login.usernameRequired') : undefined}
        />
        <Field
          label={t('login.passLabel')}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={submitted && !password ? t('login.passRequired') : undefined}
        />
        <Button
          type="submit"
          size="touch"
          className="w-full"
          aria-busy={login.isPending || undefined}
          disabled={login.isPending}
        >
          {login.isPending ? <ButtonSpinner /> : <LogIn aria-hidden="true" />}
          {t('login.submit')}
        </Button>
        <p className="text-center text-sm text-muted-foreground">{t('login.forgot')}</p>
      </form>
    </AuthShell>
  );
}

export default LoginPage;

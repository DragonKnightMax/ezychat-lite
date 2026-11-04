import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client';
import { useChangePassword } from '../api/queries';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { useAuth } from './AuthProvider';
import { AuthShell, ButtonSpinner, Field, FullPageLoader } from './AuthShell';

export function ChangePasswordPage() {
  const { t } = useTranslation(['auth', 'common']);
  const navigate = useNavigate();
  const { user, isLoading, logout } = useAuth();
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  if (isLoading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace />;

  const forced = user.mustChangePassword;
  // Errors show while typing once there is something to judge, and for every field on submit.
  const tooShort = (touched || next.length > 0) && next.length < 8;
  const mismatch = (touched || confirm.length > 0) && next !== confirm;
  const sameAsOld = next.length > 0 && next === current;
  const valid = current.length > 0 && next.length >= 8 && next === confirm && !sameAsOld;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      { onSuccess: () => navigate('/', { replace: true }) },
    );
  };

  return (
    <AuthShell
      title={forced ? t('changePassword.titleForced') : t('changePassword.title')}
      subtitle={forced ? t('changePassword.welcome', { name: user.displayName }) : user.displayName}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {change.error && <Banner tone="danger">{errorMessage(change.error)}</Banner>}
        <Field
          label={t('changePassword.current')}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={touched && !current ? t('changePassword.required') : undefined}
        />
        <Field
          label={t('changePassword.new')}
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={t('changePassword.minLength')}
          error={
            tooShort
              ? t('changePassword.minLength')
              : sameAsOld
                ? t('changePassword.sameAsOld')
                : undefined
          }
        />
        <Field
          label={t('changePassword.confirm')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? t('changePassword.mismatch') : undefined}
        />
        <Button
          type="submit"
          size="touch"
          className="w-full"
          aria-busy={change.isPending || undefined}
          disabled={change.isPending}
        >
          {change.isPending ? <ButtonSpinner /> : <KeyRound aria-hidden="true" />}
          {t('changePassword.submit')}
        </Button>
        <div className="flex justify-between gap-2">
          {!forced && (
            <Button type="button" variant="ghost" size="touch" onClick={() => navigate(-1)}>
              <ArrowLeft aria-hidden="true" />
              {t('common:actions.cancel')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="touch"
            className="ml-auto"
            onClick={() => void logout()}
          >
            <LogOut aria-hidden="true" />
            {t('common:account.signOut')}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

export default ChangePasswordPage;

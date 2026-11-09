import type React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client';
import { useSetupStatus } from '../api/queries';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { useAuth } from './AuthProvider';
import { FullPageLoader } from './AuthShell';

export interface RequireAuthProps {
  /** Only admins may pass; agents are sent to `/`. */
  admin?: boolean;
  children?: React.ReactNode;
}

/**
 * Route guard implementing the boot logic:
 * needsSetup → /setup; no user → /login; mustChangePassword → /change-password.
 * Renders `children` or an `<Outlet />`.
 */
export function RequireAuth({ admin = false, children }: RequireAuthProps) {
  const location = useLocation();
  const setup = useSetupStatus();
  const { user, isLoading, error } = useAuth();

  if (setup.isPending || isLoading) return <FullPageLoader />;

  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  if (!user) {
    if (error) return <ServerUnreachable message={errorMessage(error)} />;
    const from = location.pathname + location.search;
    return <Navigate to="/login" replace state={from !== '/' ? { from } : undefined} />;
  }

  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;

  return <>{children ?? <Outlet />}</>;
}

function ServerUnreachable({ message }: { message: string }) {
  const { t } = useTranslation(['auth', 'common']);
  return (
    <div className="safe-x flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-3">
        <Banner tone="danger" title={t('unreachable.title')}>
          {message}
        </Banner>
        <Button size="touch" className="w-full" onClick={() => window.location.reload()}>
          <RefreshCw aria-hidden="true" />
          {t('common:actions.retry')}
        </Button>
      </div>
    </div>
  );
}

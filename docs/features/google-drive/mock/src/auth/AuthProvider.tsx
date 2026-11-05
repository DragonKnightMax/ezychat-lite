import { createContext, useContext, useEffect, useMemo } from 'react';
import type React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@ezychat/shared';
import { UNAUTHORIZED_EVENT } from '../api/client';
import { qk, useLogout, useMe } from '../api/queries';

export interface AuthValue {
  user: User | null;
  isLoading: boolean;
  isAdmin: boolean;
  /** Error loading /api/me other than 401 (e.g. server unreachable). */
  error: Error | null;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const me = useMe();
  const logoutMutation = useLogout();
  const { mutateAsync: doLogout } = logoutMutation;

  // Any 401 from the API means our session is gone: drop the cached user so guards redirect to /login.
  useEffect(() => {
    const onUnauthorized = () => {
      if (qc.getQueryData(qk.me)) qc.setQueryData(qk.me, null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  const user = me.data ?? null;
  const value = useMemo<AuthValue>(
    () => ({
      user,
      isLoading: me.isPending,
      isAdmin: user?.role === 'admin',
      error: me.error ?? null,
      logout: async () => {
        await doLogout();
      },
    }),
    [user, me.isPending, me.error, doLogout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Auth state. Works without an AuthProvider too (falls back to the `me` query directly). */
export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  const me = useMe();
  const { mutateAsync } = useLogout();
  if (ctx) return ctx;
  const user = me.data ?? null;
  return {
    user,
    isLoading: me.isPending,
    isAdmin: user?.role === 'admin',
    error: me.error ?? null,
    logout: async () => {
      await mutateAsync();
    },
  };
}

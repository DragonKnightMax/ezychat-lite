import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Shape of GET /api/health (only the fields the UI needs). */
export interface HealthInfo {
  app: string;
  version: string;
  mode: string;
}

export const healthQueryKey = ['health'] as const;

/** Version baked into the web bundle at build time (root package.json), or null if not defined. */
export const BUILD_VERSION: string | null =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : null;

/**
 * The running app version: the server's version from GET /api/health, falling back to the web
 * build version while loading (or if the request fails).
 */
function useHealth(): HealthInfo | undefined {
  return useQuery({
    queryKey: healthQueryKey,
    queryFn: () => api<HealthInfo>('/health'),
    staleTime: Infinity,
    retry: 1,
  }).data;
}

export function useAppVersion(): string | null {
  const data = useHealth();
  return typeof data?.version === 'string' && data.version ? data.version : BUILD_VERSION;
}

/** The server's run mode from GET /api/health ('dev' for local and test servers), or null while unknown. */
export function useServerMode(): string | null {
  const mode = useHealth()?.mode;
  return typeof mode === 'string' ? mode : null;
}

import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

/** The app's one QueryClient (tests use it too, so they run with the real defaults). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (count, e) =>
          !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

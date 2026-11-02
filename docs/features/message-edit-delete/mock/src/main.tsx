import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from './api/client';
import { RealtimeProvider } from './api/socket';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { installGlobalErrorReporting } from '@/lib/error-reporter';
import { localeStore } from '@/i18n/locale-store';
import { LocaleSync } from '@/i18n/LocaleSync';
import './index.css';

// Uncaught errors / unhandled rejections → server log (structured `mod: "web"` entries).
installGlobalErrorReporting();

const queryClient = new QueryClient({
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

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

const render = () =>
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <LocaleSync />
            <RealtimeProvider>
              <TooltipProvider delayDuration={300}>
                <App />
                <Toaster position="top-center" closeButton richColors={false} />
              </TooltipProvider>
            </RealtimeProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );

// Load the chosen language's catalogs before the first paint so nobody sees an English flash.
// A failed chunk load still renders (English fallback) rather than a blank page.
localeStore
  .ready()
  .catch((e: unknown) => console.warn('Language load failed', e))
  .finally(render);

// PWA service-worker registration lives in src/pwa/registerSW.ts (Task 13). The glob keeps this
// file building whether or not that module exists yet.
const pwaModules = import.meta.glob<{ registerSW?: () => unknown; default?: () => unknown }>(
  './pwa/registerSW.ts',
);
for (const load of Object.values(pwaModules)) {
  void load()
    .then((m) => (m.registerSW ?? m.default)?.())
    .catch((e: unknown) => console.warn('Service worker registration failed', e));
}

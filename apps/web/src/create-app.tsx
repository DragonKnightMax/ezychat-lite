import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { createQueryClient } from './api/query-client';
import {
  browserStorage,
  restorePersistedQueries,
  startQueryPersistence,
} from './api/query-persist';
import { RealtimeProvider } from './api/socket';
import { clearUserCaches } from './auth/user-caches';
import { BUILD_VERSION } from './lib/version';
import { App } from './App';
import { AccessGate } from './access/AccessGate';
import { AuthProvider } from './auth/AuthProvider';
import {
  registerExtensionCatalogs,
  validateWebExtensions,
  WebExtensionsProvider,
  type WebExtension,
} from './extensions';
import { Toaster } from '@/components/ui/sonner';
import { FeedbackHost } from '@/components/app/FeedbackDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { installGlobalErrorReporting } from '@/lib/error-reporter';
import { installFileDropGuard } from '@/lib/file-transfer';
import { AppLinksProvider } from '@/lib/app-links';
import { resolveAppLinks, type AppLinks } from '@/lib/links';
import { setProductName } from '@/i18n';
import { localeStore } from '@/i18n/locale-store';
import { LocaleSync } from '@/i18n/LocaleSync';
import './index.css';

export interface CreateInboxAppOptions {
  /** UI added by another product build. Lite passes `[]`. */
  extensions?: readonly WebExtension[];
  /** Element to render into; defaults to `#root`. */
  root?: HTMLElement;
  /** Product name shown wherever the UI names the app; defaults to "EzyChat Lite". */
  productName?: string;
  /**
   * Outside links (About, Report an issue, release notes, support email). Missing
   * entries keep Lite's links; an explicit `null` hides that link.
   */
  links?: Partial<AppLinks>;
}

/**
 * Renders the inbox app. Extensions are validated first (a bad extension throws before anything
 * renders) and their catalogs are merged on top of the core catalogs.
 */
export async function createInboxApp({
  extensions = [],
  root = document.getElementById('root') ?? undefined,
  productName,
  links,
}: CreateInboxAppOptions = {}): Promise<void> {
  validateWebExtensions(extensions);
  const appLinks = resolveAppLinks(links);
  if (productName !== undefined) setProductName(productName);
  if (!root) throw new Error('#root missing');

  // Uncaught errors / unhandled rejections → server log (structured `mod: "web"` entries).
  installGlobalErrorReporting();
  // Files dropped outside a drop zone never replace the app with the file.
  installFileDropGuard();

  const queryClient = createQueryClient();
  // The last user's first screen (chat list, inboxes, user) shows at once and reloads right away;
  // a different user signing in clears what the earlier one left (photos, files, saved lists).
  const storage = browserStorage();
  const buster = BUILD_VERSION ?? '';
  restorePersistedQueries(queryClient, { storage, buster });
  startQueryPersistence(queryClient, {
    storage,
    buster,
    clearCaches: () => void clearUserCaches(),
  });
  const render = () =>
    createRoot(root).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <WebExtensionsProvider extensions={extensions}>
              <AppLinksProvider links={appLinks}>
                <TooltipProvider delayDuration={300}>
                  {/* While the access gate is closed nothing below it runs: no session, no socket. */}
                  <AccessGate>
                    <AuthProvider>
                      <LocaleSync />
                      <RealtimeProvider>
                        <App />
                        <FeedbackHost />
                      </RealtimeProvider>
                    </AuthProvider>
                  </AccessGate>
                  <Toaster position="top-center" closeButton richColors={false} />
                </TooltipProvider>
              </AppLinksProvider>
            </WebExtensionsProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </StrictMode>,
    );

  // PWA service-worker registration lives in src/pwa/registerSW.ts. The glob keeps this file
  // building whether or not that module exists.
  const pwaModules = import.meta.glob<{ registerSW?: () => unknown; default?: () => unknown }>(
    './pwa/registerSW.ts',
  );
  for (const load of Object.values(pwaModules)) {
    void load()
      .then((m) => (m.registerSW ?? m.default)?.())
      .catch((e: unknown) => console.warn('Service worker registration failed', e));
  }

  // Load the chosen language's catalogs before the first paint so nobody sees an English flash.
  // A failed chunk load still renders (English fallback) rather than a blank page.
  const catalogs =
    extensions.length > 0 ? registerExtensionCatalogs(extensions) : Promise.resolve();
  await catalogs
    .then(() => localeStore.ready())
    .catch((e: unknown) => console.warn('Language load failed', e))
    .finally(render);
}

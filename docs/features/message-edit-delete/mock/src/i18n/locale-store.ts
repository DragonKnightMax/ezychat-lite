import { useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE, isLocale, resolveLocale, type Locale } from '@ezychat/shared';
import { activateLocale } from './index';

export const LOCALE_STORAGE_KEY = 'wati.locale';

function browserLocale(target?: Window): Locale {
  const nav = target?.navigator;
  return resolveLocale(nav ? [...(nav.languages ?? []), nav.language] : []);
}

/**
 * The active UI language. Order: the signed-in user's saved choice (applied by `LocaleSync`),
 * then this browser's last choice (`wati.locale`), then the browser languages, then English.
 * Changes are shared with other tabs through the storage event.
 */
export function createLocaleStore(target?: Window) {
  const listeners = new Set<() => void>();
  let storage: Storage | undefined;
  let saved: string | null = null;
  try {
    storage = target?.localStorage;
    saved = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Storage may be blocked; the choice still applies for this session.
  }
  let locale: Locale = isLocale(saved) ? saved : browserLocale(target);

  const commit = (next: Locale) => {
    if (locale === next) return;
    locale = next;
    listeners.forEach((l) => l());
  };

  let requestSeq = 0;
  /**
   * Switches only once the language's catalogs have loaded, so the picker never shows a language
   * the UI is not in. A failed load (e.g. a stale tab missing a chunk after an update) rejects and
   * leaves the current language in place; an overtaken request is dropped.
   */
  async function apply(next: Locale): Promise<boolean> {
    const seq = ++requestSeq;
    await activateLocale(next);
    if (seq !== requestSeq) return false;
    commit(next);
    return true;
  }

  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key !== LOCALE_STORAGE_KEY && event.key !== null) return;
    apply(isLocale(event.newValue) ? event.newValue : browserLocale(target)).catch((e: unknown) =>
      console.warn('Language switch from another tab failed', e),
    );
  };
  target?.addEventListener('storage', onStorage);

  return {
    getSnapshot: () => locale,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Applies the initial language; on failure the UI (and snapshot) stay English. */
    async ready(): Promise<void> {
      try {
        await apply(locale);
      } catch (e) {
        commit(DEFAULT_LOCALE);
        throw e;
      }
    },
    /** Resolves once the language is active; rejects (keeping the current one) if it can't load. */
    async setLocale(next: Locale): Promise<void> {
      if (!(await apply(next))) return;
      try {
        storage?.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // Continue with the choice when persistence is unavailable.
      }
    },
    dispose() {
      target?.removeEventListener('storage', onStorage);
      listeners.clear();
    },
  };
}

export const localeStore = createLocaleStore(typeof window === 'undefined' ? undefined : window);

export function useLocale(): Locale {
  return useSyncExternalStore(
    localeStore.subscribe,
    localeStore.getSnapshot,
    localeStore.getSnapshot,
  );
}

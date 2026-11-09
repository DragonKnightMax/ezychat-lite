import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'wati.theme';
/** `labelKey` is a translation key (`common:theme.*`). */
export const THEME_OPTIONS = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
] as const;

function preference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Device preference, independent of server settings and shared with other tabs. */
export function createThemeStore(target?: Window) {
  const listeners = new Set<() => void>();
  const media = target?.matchMedia?.('(prefers-color-scheme: dark)');
  let storage: Storage | undefined;
  let saved: string | null = null;
  try {
    storage = target?.localStorage;
    saved = storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    // Private/restricted browsers may deny storage. The preference still works in memory.
  }
  let snapshot = {
    theme: preference(saved),
    resolvedTheme: (media?.matches ? 'dark' : 'light') as ResolvedTheme,
  };

  function apply(next: ThemePreference) {
    const resolvedTheme = next === 'system' ? (media?.matches ? 'dark' : 'light') : next;
    if (target) target.document.documentElement.dataset.theme = resolvedTheme;
    if (snapshot.theme === next && snapshot.resolvedTheme === resolvedTheme) return;
    snapshot = { theme: next, resolvedTheme };
    listeners.forEach((listener) => listener());
  }

  const onSystemChange = () => apply(snapshot.theme);
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key === THEME_STORAGE_KEY || event.key === null) apply(preference(event.newValue));
  };
  media?.addEventListener('change', onSystemChange);
  target?.addEventListener('storage', onStorage);
  apply(snapshot.theme);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTheme(value: string) {
      const next = preference(value);
      try {
        storage?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Continue applying the choice when persistence is unavailable.
      }
      apply(next);
    },
    dispose() {
      media?.removeEventListener('change', onSystemChange);
      target?.removeEventListener('storage', onStorage);
      listeners.clear();
    },
  };
}

// Importing this module applies the saved preference before the app's first render.
const store = createThemeStore(typeof window === 'undefined' ? undefined : window);

export function useTheme() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...snapshot, setTheme: store.setTheme };
}

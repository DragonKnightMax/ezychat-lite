import type React from 'react';
import { createContext, useCallback, useContext, useRef } from 'react';
import { useNavigate, type NavigateOptions } from 'react-router-dom';

/** Runs `next` now, or after the teammate confirms leaving (e.g. discarding unsaved edits). */
export type NavigationGuard = (next: () => void) => void;
type GuardRef = React.RefObject<NavigationGuard | null>;

// BrowserRouter has no useBlocker: in-app links that leave the conversation ask through this.
const NavigationGuardContext = createContext<GuardRef | null>(null);

/** Holds the guard of the open conversation for the whole inbox page. */
export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<NavigationGuard | null>(null);
  return <NavigationGuardContext.Provider value={ref}>{children}</NavigationGuardContext.Provider>;
}

/** The page's guard slot, or a private one outside a provider (tests, standalone use). */
export function useNavigationGuardRef(): GuardRef {
  const own = useRef<NavigationGuard | null>(null);
  return useContext(NavigationGuardContext) ?? own;
}

/**
 * `onClick` for an in-app `<Link>`: a plain click goes through the guard first; modified clicks
 * (new tab / window) are left to the browser.
 */
export function useGuardedLinkClick(to: string, options?: NavigateOptions) {
  const ref = useContext(NavigationGuardContext);
  const navigate = useNavigate();
  return useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      const guard = ref?.current;
      if (!guard || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      guard(() => navigate(to, options));
    },
    [ref, navigate, to, options],
  );
}

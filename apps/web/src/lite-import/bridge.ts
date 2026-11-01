import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type {
  DesktopLiteImportBridge,
  DesktopUpgradeBridge,
  DesktopUpgradeState,
  LiteImportState,
} from '@ezychat/shared';

declare global {
  interface Window {
    /** Lite → Enterprise import: only the desktop inbox window on the host PC has it. */
    watiLiteImport?: DesktopLiteImportBridge;
    /** Lite's "Install EzyChat Enterprise" download: only the desktop window on the host PC. */
    watiUpgrade?: DesktopUpgradeBridge;
  }
}

/** The desktop's import bridge, or null in a browser, on a phone or on another PC. */
export function liteImportBridge(): DesktopLiteImportBridge | null {
  return (typeof window !== 'undefined' && window.watiLiteImport) || null;
}

/** The desktop's Enterprise installer bridge, or null outside the desktop window on the host PC. */
export function upgradeBridge(): DesktopUpgradeBridge | null {
  return (typeof window !== 'undefined' && window.watiUpgrade) || null;
}

/**
 * Follows the import state the desktop main process keeps. Scans once when nothing was scanned yet
 * (`scan: true`). `act` runs one bridge call and keeps its result; a failed call shows a toast.
 */
export function useLiteImport(
  bridge: DesktopLiteImportBridge | null,
  { scan = true }: { scan?: boolean } = {},
) {
  const [state, setState] = useState<LiteImportState | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const off = bridge.onChanged((next) => {
      if (active) setState(next);
    });
    void (async () => {
      try {
        let next = await bridge.getState();
        if (scan && next.phase === 'idle') next = await bridge.scan();
        if (active) setState(next);
      } catch {
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
      off();
    };
  }, [bridge, scan]);

  const act = useCallback(async (call: () => Promise<LiteImportState>, failMessage: string) => {
    setBusy(true);
    try {
      setState(await call());
      return true;
    } catch {
      toast.error(failMessage);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, error, busy, act };
}

/** Follows the Enterprise installer download; null until the desktop answers (or without a bridge). */
export function useDesktopUpgrade(bridge: DesktopUpgradeBridge | null) {
  const [state, setState] = useState<DesktopUpgradeState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let changed = false;
    const off = bridge.onChanged((next) => {
      changed = true;
      if (active) setState(next);
    });
    bridge.getState().then(
      (next) => {
        if (active && !changed) setState(next);
      },
      () => {},
    );
    return () => {
      active = false;
      off();
    };
  }, [bridge]);
  return [state, setState] as const;
}

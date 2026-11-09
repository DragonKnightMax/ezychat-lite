import { useEffect, useState } from 'react';
import type { DesktopUpdatesBridge, DesktopUpdateState } from '@ezychat/shared';

declare global {
  interface Window {
    watiUpdates?: DesktopUpdatesBridge;
  }
}

/** Electron supplies this bridge; browser and phone clients never check GitHub. */
export function useDesktopUpdates() {
  const bridge = window.watiUpdates;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let revision = 0;
    const update = (value: DesktopUpdateState) => {
      if (active) {
        setState(value);
        setError(null);
      }
    };
    const unsubscribe = bridge.onChanged((value) => {
      revision++;
      update(value);
    });
    void bridge
      .getState()
      .then((value) => {
        if (revision === 0) update(value);
      })
      .catch(() => {
        if (active && revision === 0)
          setError('Could not read the update status. Try again from the tray menu.');
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);
  const check = async () => {
    if (!bridge) return;
    setError(null);
    try {
      setState(await bridge.check());
    } catch {
      setError('Could not check for updates. Try again from the tray menu.');
    }
  };
  const open = async (action: 'download' | 'release') => {
    if (!bridge) return;
    setError(null);
    try {
      await (action === 'download' ? bridge.openDownload() : bridge.openRelease());
    } catch {
      setError(
        action === 'download'
          ? 'Could not download the update. Check your connection and try again.'
          : 'Could not open GitHub. Try again.',
      );
    }
  };
  const install = async () => {
    if (!bridge?.installUpdate) return;
    setError(null);
    try {
      await bridge.installUpdate();
    } catch {
      setError('Could not start the update. Your current app is still available. Try again.');
    }
  };
  const cancelDownload = async () => {
    if (!bridge?.cancelDownload) return;
    try {
      await bridge.cancelDownload();
    } catch {
      setError('Could not cancel the download. Try again.');
    }
  };
  return { state, error, check, open, install, cancelDownload };
}

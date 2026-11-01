// Keep the remote inbox bridge separate from the privileged local status window.
// Sandboxed preloads must be CommonJS and cannot import local modules.
import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopLiteImportBridge,
  DesktopUpdatesBridge,
  DesktopUpdateState,
  DesktopUpgradeBridge,
  DesktopUpgradeState,
  LiteImportState,
} from '@ezychat/shared';

const updates: DesktopUpdatesBridge = {
  getState: () => ipcRenderer.invoke('wati:updates-state'),
  check: () => ipcRenderer.invoke('wati:updates-check'),
  openDownload: () => ipcRenderer.invoke('wati:updates-download'),
  openRelease: () => ipcRenderer.invoke('wati:updates-release'),
  installUpdate: () => ipcRenderer.invoke('wati:updates-install'),
  cancelDownload: () => ipcRenderer.invoke('wati:updates-cancel'),
  onChanged: (callback) => {
    const listener = (_event: unknown, state: DesktopUpdateState) => callback(state);
    ipcRenderer.on('wati:updates-changed', listener);
    return () => ipcRenderer.removeListener('wati:updates-changed', listener);
  },
};
contextBridge.exposeInMainWorld('watiUpdates', updates);

contextBridge.exposeInMainWorld('watiNotifications', {
  isSupported: (): Promise<boolean> => ipcRenderer.invoke('wati:notifications-supported'),
  show: (payload: { title: string; body: string; url: string; tag: string }): Promise<boolean> =>
    ipcRenderer.invoke('wati:notifications-show', payload),
  clear: (): Promise<void> => ipcRenderer.invoke('wati:notifications-clear'),
});

// Lite import and the Enterprise installer exist only in the desktop window on the host PC, and only
// for a product that has them: main.ts passes these flags as webPreferences.additionalArguments
// (lite-import/ipc.ts, upgrade/ipc.ts). A browser never has these bridges.
if (process.argv.includes('--wati-lite-import')) {
  const liteImport: DesktopLiteImportBridge = {
    getState: () => ipcRenderer.invoke('wati:lite-import-state'),
    scan: () => ipcRenderer.invoke('wati:lite-import-scan'),
    unlock: () => ipcRenderer.invoke('wati:lite-import-unlock'),
    start: (plan) => ipcRenderer.invoke('wati:lite-import-start', plan),
    reset: () => ipcRenderer.invoke('wati:lite-import-reset'),
    saveSupportFile: () => ipcRenderer.invoke('wati:lite-import-support'),
    onChanged: (callback) => {
      const listener = (_event: unknown, state: LiteImportState) => callback(state);
      ipcRenderer.on('wati:lite-import-changed', listener);
      return () => ipcRenderer.removeListener('wati:lite-import-changed', listener);
    },
  };
  contextBridge.exposeInMainWorld('watiLiteImport', liteImport);
}

if (process.argv.includes('--wati-upgrade')) {
  const upgrade: DesktopUpgradeBridge = {
    getState: () => ipcRenderer.invoke('wati:upgrade-state'),
    install: () => ipcRenderer.invoke('wati:upgrade-install'),
    cancel: () => ipcRenderer.invoke('wati:upgrade-cancel'),
    onChanged: (callback) => {
      const listener = (_event: unknown, state: DesktopUpgradeState) => callback(state);
      ipcRenderer.on('wati:upgrade-changed', listener);
      return () => ipcRenderer.removeListener('wati:upgrade-changed', listener);
    },
  };
  contextBridge.exposeInMainWorld('watiUpgrade', upgrade);
}

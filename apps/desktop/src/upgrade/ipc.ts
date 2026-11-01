// IPC of "Install EzyChat Enterprise" (`window.watiUpgrade`, inbox-preload.cts): host desktop window
// only, and no renderer arguments at all (the feed URL and the installer path never come from it).
import type { DesktopUpgradeState } from '@ezychat/shared';
import { registerInboxIpc, type InboxWindow } from '../inbox-ipc.js';

export const UPGRADE_CHANNELS = {
  state: 'wati:upgrade-state',
  install: 'wati:upgrade-install',
  cancel: 'wati:upgrade-cancel',
  changed: 'wati:upgrade-changed',
} as const;

/** Preload flag (webPreferences.additionalArguments): the product has an upgrade installer feed. */
export const UPGRADE_PRELOAD_ARG = '--wati-upgrade';

export interface UpgradeIpcController {
  getState(): DesktopUpgradeState;
  install(): Promise<DesktopUpgradeState>;
  cancel(): DesktopUpgradeState;
}

export function registerUpgradeIpc(
  controller: UpgradeIpcController,
  windows: InboxWindow,
): { broadcast(state: DesktopUpgradeState): void; dispose(): void } {
  const c = UPGRADE_CHANNELS;
  return registerInboxIpc(
    windows,
    {
      [c.state]: { arity: 0, run: () => controller.getState() },
      [c.install]: { arity: 0, run: () => controller.install() },
      [c.cancel]: { arity: 0, run: () => controller.cancel() },
    },
    c.changed,
  );
}

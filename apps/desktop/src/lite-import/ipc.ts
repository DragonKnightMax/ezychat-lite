// IPC of the Lite import (`window.watiLiteImport`, inbox-preload.cts): host desktop window only.
import type { LiteImportPlan, LiteImportState } from '@ezychat/shared';
import { registerInboxIpc, type InboxWindow } from '../inbox-ipc.js';
import { parseLiteImportPlan } from './parse.js';

export const LITE_IMPORT_CHANNELS = {
  state: 'wati:lite-import-state',
  scan: 'wati:lite-import-scan',
  unlock: 'wati:lite-import-unlock',
  start: 'wati:lite-import-start',
  reset: 'wati:lite-import-reset',
  support: 'wati:lite-import-support',
  changed: 'wati:lite-import-changed',
} as const;

/** Preload flag (webPreferences.additionalArguments): the product adopts another one's data. */
export const LITE_IMPORT_PRELOAD_ARG = '--wati-lite-import';

export interface LiteImportIpcController {
  getState(): LiteImportState;
  scan(): Promise<LiteImportState>;
  unlock(): Promise<LiteImportState>;
  start(plan: LiteImportPlan): Promise<LiteImportState>;
  reset(): Promise<LiteImportState>;
  saveSupportFile(): Promise<boolean>;
}

export function registerLiteImportIpc(
  controller: LiteImportIpcController,
  windows: InboxWindow,
): { broadcast(state: LiteImportState): void; dispose(): void } {
  const c = LITE_IMPORT_CHANNELS;
  return registerInboxIpc(
    windows,
    {
      [c.state]: { arity: 0, run: () => controller.getState() },
      [c.scan]: { arity: 0, run: () => controller.scan() },
      // No arguments: the elevated step is fixed (Lite's own "Remove service"), nothing comes from the page.
      [c.unlock]: { arity: 0, run: () => controller.unlock() },
      [c.start]: {
        arity: 1,
        run: (plan: unknown) => {
          // Validated like zod `LiteImportPlan`; nothing else from the renderer reaches the import.
          const parsed = parseLiteImportPlan(plan);
          if (!parsed) throw new Error('Invalid import plan');
          return controller.start(parsed);
        },
      },
      [c.reset]: { arity: 0, run: () => controller.reset() },
      [c.support]: { arity: 0, run: () => controller.saveSupportFile() },
    },
    c.changed,
  );
}

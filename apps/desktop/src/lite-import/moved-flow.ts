// The moved screen (design §5.6, mock screens "lite-moved" and "lite-moved-confirm"): when Lite's
// server exits 4 (moved.json), the window shows "This WhatsApp number now runs in EzyChat Enterprise."
// and a dialog offers Open EzyChat Enterprise / Use EzyChat Lite again (with a warning). No electron
// import: dialogs, shell and the server are injected by main.ts.
import { join } from 'node:path';
import type { DesktopKey } from '../i18n.js';
import {
  ENTERPRISE_PAGE_URL,
  installedAppCandidates,
  movedChoice,
  movedProductName,
} from './moved.js';

/** Used when moved.json does not name a valid product. */
export const DEFAULT_MOVED_TARGET = 'EzyChat Enterprise';

export interface MovedFlowOptions {
  dataDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  productName: string;
  t(key: DesktopKey, vars?: Record<string, string>): string;
  readText(path: string): string | null;
  exists(path: string): boolean;
  showMessageBox(options: {
    type: 'info' | 'warning';
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink?: boolean;
  }): Promise<{ response: number }>;
  /** shell.openPath: '' on success, else an error message. */
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  /** Shows the moved page in the window (no spinner). */
  showPage(title: string, body: string): void;
  /** `--restore-moved` on our data folder; true when done. */
  restore(): Promise<boolean>;
  /** Starts the server again after a restore. */
  start(): Promise<unknown>;
  /** The desktop's operation gate (busy label, error dialog). */
  runOperation(label: string, errorTitle: string, action: () => Promise<void>): Promise<void>;
  log?(message: string): void;
}

export function createMovedFlow(o: MovedFlowOptions) {
  let target: string | null = null;
  let asking = false;

  const openTarget = async (name: string) => {
    const installed = installedAppCandidates(name, o.platform, o.env).find((p) => o.exists(p));
    if (installed && !(await o.openPath(installed))) return;
    await o.openExternal(ENTERPRISE_PAGE_URL);
  };

  const useLiteAgain = (name: string) =>
    o.runOperation(o.t('moved.restoring'), o.t('moved.restoreFailed'), async () => {
      const { response } = await o.showMessageBox({
        type: 'warning',
        title: o.productName,
        message: o.t('moved.confirmTitle'),
        detail: o.t('moved.confirmDetail', { target: name }),
        buttons: [o.t('moved.useLite'), o.t('common.cancel')],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
      if (!(await o.restore())) throw new Error(o.t('moved.restoreFailed'));
      o.log?.('[desktop] moved.json removed; starting this app on its data again');
      target = null;
      await o.start();
    });

  const ask = async (): Promise<void> => {
    if (asking || !target) return;
    asking = true;
    try {
      const name = target;
      const { response } = await o.showMessageBox({
        type: 'info',
        title: o.productName,
        message: o.t('moved.title', { target: name }),
        detail: o.t('moved.body'),
        buttons: [o.t('moved.open', { target: name }), o.t('moved.useLite'), o.t('common.close')],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      const choice = movedChoice(response);
      if (choice === 'open') await openTarget(name);
      else if (choice === 'use-lite') await useLiteAgain(name);
    } finally {
      asking = false;
    }
  };

  return {
    /** True while the moved screen is up (the tray's Open asks again). */
    active: () => target !== null,
    /** The server exited 4: show the page and ask. */
    show(): Promise<void> {
      target = movedProductName(o.readText(join(o.dataDir, 'moved.json'))) ?? DEFAULT_MOVED_TARGET;
      o.log?.(`[desktop] this WhatsApp number moved to ${target}; showing the moved screen`);
      o.showPage(o.t('moved.title', { target }), o.t('moved.body'));
      return ask();
    },
    ask,
  };
}

// System tray icon + menu.
import { app, Menu, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { Locale } from '@ezychat/shared';
import { appTitle } from './app-title.js';
import { t } from './i18n.js';

export interface TrayActions {
  open(): void;
  openStatus(): void;
  openTunnelAdmin(): void;
  resetAdmin(): void;
  checkUpdates(): void;
  updateLabel(): string | null;
  quit(): void;
  /** label describing the current mode, e.g. "Standalone — running" */
  describe(): string;
}

export function createTray(
  icon: NativeImage,
  actions: TrayActions,
  version: string,
  locale: Locale,
  platform: NodeJS.Platform = process.platform,
): { tray: Tray; refresh(): void } {
  const title = appTitle(version, { devBuild: !app.isPackaged });
  const tray = new Tray(icon);
  tray.setToolTip(title);
  const refresh = () => {
    const updateLabel = actions.updateLabel();
    const items: MenuItemConstructorOptions[] = [
      { label: actions.describe(), enabled: false },
      { type: 'separator' },
      { label: t(locale, 'tray.open'), click: () => actions.open() },
      { label: t(locale, 'tray.status'), click: () => actions.openStatus() },
      ...(updateLabel ? [{ label: updateLabel, click: () => actions.checkUpdates() }] : []),
      { label: t(locale, 'tray.openCloudflare'), click: () => actions.openTunnelAdmin() },
      { type: 'separator' },
      { label: t(locale, 'tray.resetAdmin'), click: () => actions.resetAdmin() },
    ];
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: title, enabled: false },
        ...items,
        { type: 'separator' },
        { label: t(locale, 'tray.quit'), click: () => actions.quit() },
      ]),
    );
    // macOS hides menu bar icons when the bar is full (notch): the Dock menu always reaches these.
    // macOS adds its own Quit there.
    if (platform === 'darwin') app.dock?.setMenu(Menu.buildFromTemplate(items));
  };
  tray.on('click', () => actions.open());
  refresh();
  return { tray, refresh };
}

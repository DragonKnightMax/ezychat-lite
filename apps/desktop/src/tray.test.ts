import { describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';

type Item = { label?: string; type?: string; enabled?: boolean; click?: () => void };
const mock = vi.hoisted(() => ({
  trayMenu: [] as Item[],
  dockMenu: null as Item[] | null,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    dock: {
      setMenu: (menu: { items: Item[] }) => {
        mock.dockMenu = menu.items;
      },
    },
  },
  Menu: { buildFromTemplate: (items: Item[]) => ({ items }) },
  Tray: class {
    setToolTip() {}
    on() {}
    setContextMenu(menu: { items: Item[] }) {
      mock.trayMenu = menu.items;
    }
  },
}));

const { createTray } = await import('./tray.js');

function actions(updateLabel: string | null = null) {
  return {
    open: vi.fn(),
    openStatus: vi.fn(),
    openTunnelAdmin: vi.fn(),
    resetAdmin: vi.fn(),
    checkUpdates: vi.fn(),
    updateLabel: vi.fn(() => updateLabel),
    quit: vi.fn(),
    describe: () => 'Standalone — running',
  };
}
const labels = (items: Item[] | null) => (items ?? []).map((i) => i.label ?? i.type);
const icon = {} as NativeImage;

describe('createTray', () => {
  it('on macOS offers Status & Service and updates in the Dock menu too (a full menu bar hides the icon)', () => {
    mock.dockMenu = null;
    const a = actions('Update to 1.2.3…');
    createTray(icon, a, '1.0.0', 'en', 'darwin');
    expect(labels(mock.dockMenu)).toEqual([
      'Standalone — running',
      'separator',
      'Open',
      'Status & Service…',
      'Update to 1.2.3…',
      'Open admin → Cloudflare',
      'separator',
      'Reset admin password…',
    ]);
    mock.dockMenu?.find((i) => i.label === 'Status & Service…')?.click?.();
    expect(a.openStatus).toHaveBeenCalled();
    // macOS adds its own Quit to the Dock menu
    expect(labels(mock.dockMenu)).not.toContain('Quit');
    expect(labels(mock.trayMenu)).toContain('Quit');
  });

  it('runs the matching action for every Dock item', () => {
    const a = actions('Update to 1.2.3…');
    createTray(icon, a, '1.0.0', 'en', 'darwin');
    const click = (label: string) => mock.dockMenu?.find((i) => i.label === label)?.click?.();
    click('Open');
    click('Update to 1.2.3…');
    click('Open admin → Cloudflare');
    click('Reset admin password…');
    expect(a.open).toHaveBeenCalledOnce();
    expect(a.checkUpdates).toHaveBeenCalledOnce();
    expect(a.openTunnelAdmin).toHaveBeenCalledOnce();
    expect(a.resetAdmin).toHaveBeenCalledOnce();
    mock.trayMenu.find((i) => i.label === 'Quit')?.click?.();
    expect(a.quit).toHaveBeenCalledOnce();
  });

  it('refreshes the Dock menu with the tray menu', () => {
    let label: string | null = null;
    const a = { ...actions(), updateLabel: () => label };
    const handle = createTray(icon, a, '1.0.0', 'en', 'darwin');
    expect(labels(mock.dockMenu)).not.toContain('Restart to update');
    label = 'Restart to update';
    handle.refresh();
    expect(labels(mock.dockMenu)).toContain('Restart to update');
  });

  it('keeps the Dock alone on other systems', () => {
    mock.dockMenu = null;
    createTray(icon, actions(), '1.0.0', 'en', 'win32');
    expect(mock.dockMenu).toBeNull();
    expect(labels(mock.trayMenu)).toContain('Status & Service…');
  });
});

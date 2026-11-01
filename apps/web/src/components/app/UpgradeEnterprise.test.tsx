import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { DesktopUpgradeBridge, DesktopUpgradeState } from '@ezychat/shared';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppLinksProvider } from '@/lib/app-links';
import { ENTERPRISE_UPGRADE_URL, resolveAppLinks } from '@/lib/links';
import { UserMenu } from '@/auth/UserMenu';
import { AboutDialog } from './AboutDialog';
import { UpgradeButton, UpgradeNote } from './UpgradeEnterprise';

const auth = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('@/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      username: 'aisyah',
      displayName: 'Aisyah',
      role: auth.isAdmin ? 'admin' : 'agent',
      locale: null,
    },
    isAdmin: auth.isAdmin,
    logout: vi.fn(),
  }),
}));
vi.mock('@/i18n/use-change-locale', () => ({
  useChangeLocale: () => ({ locale: 'en', changeLocale: vi.fn() }),
}));
vi.mock('@/lib/version', () => ({ useAppVersion: () => '0.1.0' }));
vi.mock('@/pwa/PushToggle', () => ({ PushToggle: () => null }));

afterEach(() => {
  cleanup();
  auth.isAdmin = true;
});

/** Renders with Lite's links, or with the upgrade link hidden like another product does. */
function renderWith(node: ReactNode, upgrade?: null) {
  const links = resolveAppLinks(upgrade === null ? { upgrade: null } : {});
  return render(
    <MemoryRouter>
      <AppLinksProvider links={links}>{node}</AppLinksProvider>
    </MemoryRouter>,
  );
}

it('opens the Enterprise page in a new tab from Lite', () => {
  renderWith(<UpgradeButton />);
  const link = screen.getByRole('link', { name: 'Upgrade to Enterprise' });
  expect(link.getAttribute('href')).toBe(ENTERPRISE_UPGRADE_URL);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

it('explains each Lite limit in its own words', () => {
  renderWith(
    <>
      <UpgradeNote reason="agents" />
      <UpgradeNote reason="numbers" />
    </>,
  );
  const [agents, numbers] = screen.getAllByTestId('upgrade-note');
  expect(agents!.textContent).toContain('one AI agent for each WhatsApp number');
  expect(numbers!.textContent).toContain('links several numbers to one team inbox');
});

it('shows no button and no note when the product hides the upgrade link', () => {
  renderWith(
    <>
      <UpgradeButton />
      <UpgradeNote reason="agents" />
    </>,
    null,
  );
  expect(screen.queryByTestId('upgrade-enterprise')).toBeNull();
  expect(screen.queryByTestId('upgrade-note')).toBeNull();
});

it('About shows the Enterprise text and button in Lite, nothing when hidden', () => {
  const { unmount } = renderWith(<AboutDialog open onOpenChange={() => {}} version="1.0.0" />);
  const about = screen.getByTestId('about-upgrade');
  expect(about.textContent).toContain('with support from Anchor Sprint');
  expect(within(about).getByRole('link', { name: 'Upgrade to Enterprise' })).toBeTruthy();
  unmount();
  renderWith(<AboutDialog open onOpenChange={() => {}} version="1.0.0" />, null);
  expect(screen.queryByTestId('about-upgrade')).toBeNull();
});

async function openMenu() {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Account menu' }));
}

it('the account menu offers the upgrade to admins only', async () => {
  const { unmount } = renderWith(<UserMenu />);
  await openMenu();
  const item = screen.getByRole('menuitem', { name: 'Upgrade to Enterprise' });
  expect(item.getAttribute('href')).toBe(ENTERPRISE_UPGRADE_URL);
  expect(item.getAttribute('target')).toBe('_blank');
  unmount();

  auth.isAdmin = false;
  renderWith(<UserMenu />);
  await openMenu();
  expect(screen.queryByRole('menuitem', { name: 'Upgrade to Enterprise' })).toBeNull();
});

it('the account menu has no upgrade item when the product hides it', async () => {
  renderWith(<UserMenu />, null);
  await openMenu();
  expect(screen.getByRole('menuitem', { name: 'Admin settings' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Upgrade to Enterprise' })).toBeNull();
});

describe('desktop Upgrade dialog (host PC)', () => {
  function fakeUpgrade(initial: Partial<DesktopUpgradeState> = {}) {
    let listener: ((s: DesktopUpgradeState) => void) | null = null;
    const base: DesktopUpgradeState = {
      available: true,
      status: 'idle',
      version: '0.2.0',
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      ...initial,
    };
    const bridge = {
      getState: vi.fn(async () => base),
      install: vi.fn(async () => ({
        ...base,
        status: 'downloading' as const,
        downloadedBytes: 50 * 1024 ** 2,
        totalBytes: 100 * 1024 ** 2,
      })),
      cancel: vi.fn(async () => ({ ...base, status: 'idle' as const })),
      onChanged: vi.fn((cb: (s: DesktopUpgradeState) => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      }),
    } satisfies DesktopUpgradeBridge;
    window.watiUpgrade = bridge;
    return { bridge, base, emit: (s: DesktopUpgradeState) => listener?.(s) };
  }

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
  });
  afterEach(() => {
    delete window.watiUpgrade;
    vi.unstubAllGlobals();
  });

  it('downloads and starts the installer, with progress and cancel', async () => {
    const { bridge, base, emit } = fakeUpgrade();
    renderWith(<UpgradeButton />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Upgrade to Enterprise' }));
    const dialog = await screen.findByTestId('upgrade-dialog');
    expect(dialog.textContent).toContain('Chats, team and WhatsApp come with you');
    expect(within(dialog).getByRole('link', { name: 'Learn more' }).getAttribute('href')).toBe(
      ENTERPRISE_UPGRADE_URL,
    );
    await u.click(within(dialog).getByRole('button', { name: 'Install EzyChat Enterprise' }));
    expect(bridge.install).toHaveBeenCalledOnce();
    expect(dialog.textContent).toContain('50 MB of 100 MB');
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(bridge.cancel).toHaveBeenCalledOnce();
    act(() => emit({ ...base, status: 'started' }));
    expect(screen.getByTestId('upgrade-started').textContent).toContain(
      'Finish it, then EzyChat Enterprise brings your data over.',
    );
  });

  it('a failed download shows the error and Try again', async () => {
    const { bridge } = fakeUpgrade({ status: 'error', error: 'sha_mismatch' });
    bridge.install.mockRejectedValueOnce(new Error('ipc'));
    renderWith(<UpgradeButton />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Upgrade to Enterprise' }));
    const dialog = await screen.findByTestId('upgrade-dialog');
    expect(within(dialog).getByRole('alert').textContent).toContain('did not finish');
    await u.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(bridge.install).toHaveBeenCalledOnce();
    expect(within(dialog).getByRole('alert')).toBeTruthy();
  });

  it('keeps opening the website when the desktop has no installer feed', async () => {
    const { bridge } = fakeUpgrade({ available: false });
    renderWith(<UpgradeButton />);
    await waitFor(() => expect(bridge.getState).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: 'Upgrade to Enterprise' }).getAttribute('href')).toBe(
      ENTERPRISE_UPGRADE_URL,
    );
  });
});

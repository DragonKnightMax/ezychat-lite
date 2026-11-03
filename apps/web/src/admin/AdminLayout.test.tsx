import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AdminLayout, visibleAdminNav } from './AdminLayout';
import { i18n } from '@/i18n';
import { reportClientError } from '@/lib/error-reporter';
import { ANCHOR_SPRINT_URL, CUSTOM_FEATURE_URL } from '@/lib/links';
import { toast } from 'sonner';

const logout = vi.hoisted(() => vi.fn());
/** What `useInboxes()` returns: Lite (`maxInboxes` 1) unless a test changes it. */
const inboxes = vi.hoisted(() => ({
  current: { data: { inboxes: [], maxInboxes: 1, canAdd: false }, isPending: false } as {
    data?: { inboxes: unknown[]; maxInboxes: number; canAdd: boolean };
    isPending: boolean;
  },
}));

/** What `useAiAgents()` returns: Lite with agent 1 unless a test changes it. */
const agents = vi.hoisted(() => ({
  current: {
    data: { agents: [{ id: 1 }], maxAgents: 1 },
    isPending: false,
    isError: false,
  } as {
    data?: { agents: { id: number }[]; maxAgents: number };
    isPending: boolean;
    isError: boolean;
  },
}));

vi.mock('../api/queries', () => ({ useInboxes: () => inboxes.current }));
vi.mock('../api/ai', () => ({ useAiAgents: () => agents.current }));
vi.mock('./InboxesPage', () => ({ InboxesPage: () => <h1>Inboxes</h1> }));

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { role: 'admin' }, isLoading: false, logout }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../pwa/PushToggle', () => ({ PushToggle: () => null }));
vi.mock('@/lib/version', () => ({ useAppVersion: () => '0.1.0' }));
vi.mock('@/lib/error-reporter', () => ({ reportClientError: vi.fn() }));
vi.mock('./AiMemberPage', () => ({ AiMemberPage: () => <h1>AI member page</h1> }));
vi.mock('./MembersPage', () => ({ MembersPage: () => <h1>Members</h1> }));
vi.mock('./QuickRepliesPage', () => ({ QuickRepliesPage: () => <h1>Quick replies</h1> }));
vi.mock('./WhatsAppPage', () => ({ WhatsAppPage: () => <h1>WhatsApp</h1> }));
vi.mock('./TunnelPage', () => ({ TunnelPage: () => <h1>Phone access</h1> }));
vi.mock('./SettingsPage', () => ({ SettingsPage: () => <h1>Settings</h1> }));
vi.mock('./AuditPage', () => ({ AuditPage: () => <h1>Audit</h1> }));
vi.mock('./connectors/ConnectorsGalleryPage', () => ({
  ConnectorsGalleryPage: () => <h1>Connectors</h1>,
}));
vi.mock('./connectors/ConnectorDetailPage', () => ({
  ConnectorDetailPage: () => <h1>Connector page</h1>,
}));
vi.mock('./ReportsPage', () => ({ ReportsPage: () => <h1>Reports</h1> }));
vi.mock('./SafetyPage', () => ({ SafetyPage: () => <h1>Safety</h1> }));

const ADMIN_NAV = visibleAdminNav(false).map((n) => ({
  ...n,
  label: i18n.t(`admin:${n.labelKey}`),
}));

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function setup(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<h1>Inbox</h1>} />
        <Route path="/admin/*" element={<AdminLayout />} />
      </Routes>
      <Location />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const LITE = { data: { inboxes: [], maxInboxes: 1, canAdd: false }, isPending: false };
const MULTI = { data: { inboxes: [], maxInboxes: 3, canAdd: true }, isPending: false };

beforeEach(() => {
  inboxes.current = LITE;
  agents.current = {
    data: { agents: [{ id: 1 }], maxAgents: 1 },
    isPending: false,
    isError: false,
  };
  logout.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe('AdminLayout routing', () => {
  it.each(ADMIN_NAV)('keeps every admin link anchored from $label', async ({ to }) => {
    const user = setup(`/admin/${to}`);
    for (const destination of ADMIN_NAV) {
      const link = screen.getByRole('link', { name: destination.label });
      // Check before clicking so a broken relative fallback cannot enter an endless loop.
      expect(link.getAttribute('href')).toBe(`/admin/${destination.to}`);
      await user.click(link);
      expect(screen.getByRole('heading', { name: destination.label })).toBeTruthy();
      expect(screen.getByTestId('location').textContent).toBe(`/admin/${destination.to}`);
      expect(
        screen.getByRole('link', { name: destination.label }).getAttribute('aria-current'),
      ).toBe('page');
    }
  });

  it.each([
    '/admin',
    '/admin/',
    '/admin/members/quick-replies/members/members',
    '/admin/members/ai/unknown',
    '/admin/members/ai/0',
    '/admin/members/ai/01',
    '/admin/members/ai/2x',
    '/admin/members/ai/1/extra',
    '/admin/unknown',
  ])('recovers %s to the canonical Members page', async (path) => {
    setup(path);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/members'));
    expect(screen.getByRole('heading', { name: 'Members' })).toBeTruthy();
  });

  it('labels the tunnel section Phone access and keeps its /admin/tunnel route', () => {
    setup('/admin/members');
    const link = screen.getByRole('link', { name: 'Phone access' });
    expect(link.getAttribute('href')).toBe('/admin/tunnel');
    expect(screen.queryByRole('link', { name: 'Cloudflare' })).toBeNull();
  });

  it('opens an AI agent page under an active Members section', () => {
    setup('/admin/members/ai/7');
    expect(screen.getByRole('heading', { name: 'AI member page' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Members' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Admin · Members')).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/7');
  });

  it('opens the new-agent page with its preset', () => {
    render(
      <MemoryRouter initialEntries={['/admin/members/ai/new?preset=faq']}>
        <Routes>
          <Route path="/admin/*" element={<AdminLayout />} />
        </Routes>
        <Location />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'AI member page' })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/new');
  });

  it('sends Lite from /admin/members/ai to its one agent', async () => {
    setup('/admin/members/ai');
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/1'),
    );
    expect(screen.getByRole('heading', { name: 'AI member page' })).toBeTruthy();
  });

  it('sends Lite with no agent yet from /admin/members/ai to a new agent', async () => {
    agents.current = { data: { agents: [], maxAgents: 1 }, isPending: false, isError: false };
    setup('/admin/members/ai');
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai/new'),
    );
  });

  it('sends Enterprise from /admin/members/ai to Members, where every agent is listed', async () => {
    agents.current = {
      data: { agents: [{ id: 1 }, { id: 2 }], maxAgents: 3 },
      isPending: false,
      isError: false,
    };
    setup('/admin/members/ai');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/members'));
    expect(screen.getByRole('heading', { name: 'Members' })).toBeTruthy();
  });

  it('waits for the agent list on /admin/members/ai, and falls back to Members on an error', async () => {
    agents.current = { data: undefined, isPending: true, isError: false };
    setup('/admin/members/ai');
    expect(screen.getByLabelText('Loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('location').textContent).toBe('/admin/members/ai');
    cleanup();
    agents.current = { data: undefined, isPending: false, isError: true };
    setup('/admin/members/ai');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/members'));
  });

  it.each(['general', 'ai', 'device', 'maintenance'])(
    'keeps Settings active and mounted on /admin/settings/%s',
    (tab) => {
      setup(`/admin/settings/${tab}`);
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
        'page',
      );
      expect(screen.getByTestId('location').textContent).toBe(`/admin/settings/${tab}`);
      expect(screen.getByText('Admin · Settings')).toBeTruthy();
    },
  );

  it('reports an unmatched route for server-side diagnostics', async () => {
    setup('/admin/members/quick-replies');
    await waitFor(() =>
      expect(reportClientError).toHaveBeenCalledWith({
        kind: 'error',
        message: 'Unmatched admin route',
        route: '/admin/members/quick-replies',
      }),
    );
    expect(screen.getByTestId('location').textContent).toBe('/admin/members');
  });

  it('opens every section from the mobile menu and closes the sheet', async () => {
    const user = setup('/admin/members');
    for (const destination of ADMIN_NAV) {
      await user.click(screen.getByRole('button', { name: 'Admin menu' }));
      const menu = await screen.findByRole('dialog');
      const link = within(menu).getByRole('link', { name: destination.label });
      expect(link.getAttribute('href')).toBe(`/admin/${destination.to}`);
      await user.click(link);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByRole('heading', { name: destination.label })).toBeTruthy();
      expect(screen.getByTestId('location').textContent).toBe(`/admin/${destination.to}`);
    }
  });

  it('keeps version and support destinations available in both footer layouts', async () => {
    const user = setup('/admin/members');
    const checkMenu = async (menu: HTMLElement) => {
      // Back to inbox sits at the top of the menu, above the admin sections.
      const back = within(menu).getByRole('link', { name: 'Back to inbox' });
      expect(back.getAttribute('href')).toBe('/');
      const sections = within(menu).getByRole('navigation', { name: 'Admin sections' });
      expect(
        back.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      const footer = within(menu).getByLabelText('Admin tools and support');
      const tools = within(footer);
      expect(tools.getByText('v0.1.0')).toBeTruthy();
      await user.click(tools.getByRole('button', { name: 'Help & feedback' }));
      for (const [name, href] of [
        ['Anchor Sprint', ANCHOR_SPRINT_URL],
        ['Custom features', CUSTOM_FEATURE_URL],
      ]) {
        const link = tools.getByRole('link', { name });
        expect(link.getAttribute('href')).toBe(href);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      }
      expect(tools.getByRole('button', { name: 'Send feedback' })).toBeTruthy();
    };
    await checkMenu(screen.getByRole('complementary'));
    await user.click(screen.getByRole('button', { name: 'Admin menu' }));
    await checkMenu(await screen.findByRole('dialog'));
  });

  it('returns to the inbox and closes the mobile menu from its footer', async () => {
    const user = setup('/admin/tunnel');
    await user.click(screen.getByRole('button', { name: 'Admin menu' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('link', { name: 'Back to inbox' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it('logs out of the inbox account from the desktop footer', async () => {
    const user = setup('/admin/whatsapp');
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(logout).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('logs out from the mobile footer and closes the drawer after success', async () => {
    const user = setup('/admin/members');
    await user.click(screen.getByRole('button', { name: 'Admin menu' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Log out' }),
    );
    expect(logout).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('prevents repeat logout requests while signing out', async () => {
    let finish!: () => void;
    logout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const user = setup('/admin/members');
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    const pending = screen.getByRole('button', { name: 'Logging out…' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute('aria-busy')).toBe('true');
    await user.click(pending);
    expect(logout).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect((screen.getByRole('button', { name: 'Log out' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('reports a failed logout and allows a retry without closing the mobile drawer', async () => {
    logout.mockRejectedValueOnce(new Error('Server unreachable'));
    const user = setup('/admin/members');
    await user.click(screen.getByRole('button', { name: 'Admin menu' }));
    const menu = await screen.findByRole('dialog');
    await user.click(within(menu).getByRole('button', { name: 'Log out' }));
    expect(toast.error).toHaveBeenCalledWith('Could not log out: Server unreachable');
    expect(screen.getByRole('dialog')).toBe(menu);
    const retry = within(menu).getByRole('button', { name: 'Log out' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    await user.click(retry);
    expect(logout).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('AdminLayout inboxes', () => {
  it('shows WhatsApp, not Inboxes, in Lite (one number)', () => {
    setup('/admin/members');
    expect(screen.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toBe(
      '/admin/whatsapp',
    );
    expect(screen.queryByRole('link', { name: 'Inboxes' })).toBeNull();
    expect(visibleAdminNav(false).map((n) => n.to)).not.toContain('inboxes');
  });

  it('sends Lite from /admin/inboxes back to its WhatsApp page', async () => {
    setup('/admin/inboxes');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/whatsapp'));
    expect(screen.getByRole('heading', { name: 'WhatsApp' })).toBeTruthy();
  });

  it('keeps the WhatsApp page while the inbox list loads, and waits on /admin/inboxes', () => {
    inboxes.current = { data: undefined, isPending: true };
    setup('/admin/whatsapp');
    expect(screen.getByRole('heading', { name: 'WhatsApp' })).toBeTruthy();
    cleanup();
    setup('/admin/inboxes');
    expect(screen.getByLabelText('Loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('location').textContent).toBe('/admin/inboxes');
  });

  it('shows Inboxes instead of WhatsApp when the edition allows several numbers', async () => {
    inboxes.current = MULTI;
    const user = setup('/admin/members');
    expect(screen.queryByRole('link', { name: 'WhatsApp' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Inboxes' });
    expect(link.getAttribute('href')).toBe('/admin/inboxes');
    await user.click(link);
    expect(screen.getByRole('heading', { name: 'Inboxes' })).toBeTruthy();
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Admin · Inboxes')).toBeTruthy();
  });

  it('redirects /admin/whatsapp to /admin/inboxes with several numbers', async () => {
    inboxes.current = MULTI;
    setup('/admin/whatsapp');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/inboxes'));
    expect(screen.getByRole('heading', { name: 'Inboxes' })).toBeTruthy();
  });
});

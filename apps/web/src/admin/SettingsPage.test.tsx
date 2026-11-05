import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SettingsPage } from './SettingsPage';

let settings = { port: 7420, lanEnabled: false, historyDays: 3 };
const patch = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, error: null }));
vi.mock('../api/queries', () => ({
  useSettings: () => ({ isPending: false, isError: false, data: settings }),
  usePatchSettings: () => patch,
}));
vi.mock('../pwa/PushToggle', () => ({ PushToggle: () => null }));
vi.mock('./ResolveAllChatsCard', () => ({ ResolveAllChatsCard: () => <p>Resolve all card</p> }));
vi.mock('./AiConnectionSection', () => ({
  AiConnectionSection: () => <p>Inline AI connection</p>,
}));
vi.mock('./PhraseDictionarySection', () => ({ PhraseDictionarySection: () => null }));
vi.mock('./FixEnglishSection', () => ({ FixEnglishSection: () => <p>Fix English card</p> }));
vi.mock('./ReplySuggestionsSection', () => ({
  ReplySuggestionsSection: () => <p>Reply suggestions card</p>,
}));
vi.mock('./AiVoiceSection', () => ({ AiVoiceSection: () => <p>Voice messages card</p> }));
vi.mock('./CustomerEnrichmentSection', () => ({
  CustomerEnrichmentSection: () => <p>Customer enrichment card</p>,
}));
vi.mock('./IntegrationsSection', () => ({
  IntegrationsSection: () => <p>AI assistant access</p>,
}));
const setTheme = vi.hoisted(() => vi.fn());
const changeLocale = vi.hoisted(() => vi.fn());
vi.mock('@/lib/theme', () => ({
  THEME_OPTIONS: [
    { value: 'light', labelKey: 'theme.light' },
    { value: 'dark', labelKey: 'theme.dark' },
    { value: 'system', labelKey: 'theme.system' },
  ],
  useTheme: () => ({ theme: 'system', setTheme }),
}));
vi.mock('@/i18n/use-change-locale', () => ({
  useChangeLocale: () => ({ locale: 'en', changeLocale }),
}));

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function tree(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/settings/*" element={<SettingsPage />} />
      </Routes>
      <Location />
    </MemoryRouter>
  );
}

function renderAt(path = '/admin/settings/general') {
  return render(tree(path));
}

beforeEach(() => {
  settings = { port: 7420, lanEnabled: false, historyDays: 3 };
  patch.mutate.mockClear();
  setTheme.mockClear();
  changeLocale.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

it('shows the AI connection inline on the AI tab (no popup)', () => {
  renderAt('/admin/settings/ai');
  expect(screen.getByText('Inline AI connection')).toBeTruthy();
  expect(screen.getByText('Reply suggestions card')).toBeTruthy();
  expect(screen.getByText('Voice messages card')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Configure AI connection' })).toBeNull();
  expect(patch.mutate).not.toHaveBeenCalled();
});

it('keeps Voice messages and Customer enrichment under a closed More AI features section', async () => {
  renderAt('/admin/settings/ai');
  const summary = screen.getByText('More AI features');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('Voice messages card');
  expect(details.textContent).toContain('Customer enrichment card');
  expect(details.contains(screen.getByText('Inline AI connection'))).toBe(false);
  await userEvent.setup().click(summary);
  expect(details.open).toBe(true);
});

it('preserves edited fields through a background refresh while updating untouched defaults', async () => {
  const view = renderAt();
  const user = userEvent.setup();
  const port = screen.getByRole('spinbutton', { name: 'Port' }) as HTMLInputElement;
  await user.clear(port);
  await user.type(port, '7550');
  await user.click(screen.getByRole('switch', { name: /local network/ }));
  settings = { port: 7440, lanEnabled: false, historyDays: 10 };
  view.rerender(tree('/admin/settings/general'));
  expect(port.value).toBe('7550');
  expect(screen.getByRole('switch', { name: /local network/ }).getAttribute('aria-checked')).toBe(
    'true',
  );
  expect(
    (
      screen.getByRole('spinbutton', {
        name: 'Days of history to import when linking',
      }) as HTMLInputElement
    ).value,
  ).toBe('10');
  await user.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(patch.mutate).toHaveBeenCalledWith({ port: 7550, lanEnabled: true }, expect.any(Object));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('toggles LAN once from the padded target or switch and saves only when requested', async () => {
  renderAt();
  const user = userEvent.setup();
  const control = screen.getByRole('switch', {
    name: 'Allow access from the local network (LAN)',
  });
  const paddedTarget = control.closest('label');
  expect(paddedTarget).not.toBeNull();
  const save = screen.getByRole('button', { name: 'Save settings' });
  expect(save.hasAttribute('disabled')).toBe(true);

  await user.click(paddedTarget!);
  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(save.hasAttribute('disabled')).toBe(false);
  expect(patch.mutate).not.toHaveBeenCalled();

  await user.click(control);
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(save.hasAttribute('disabled')).toBe(true);

  await user.click(paddedTarget!);
  await user.click(save);
  expect(patch.mutate).toHaveBeenCalledTimes(1);
  expect(patch.mutate).toHaveBeenCalledWith({ lanEnabled: true }, expect.any(Object));
});

it('keeps the switch keyboard accessible without submitting network settings', async () => {
  renderAt();
  const user = userEvent.setup();
  const control = screen.getByRole('switch', {
    name: 'Allow access from the local network (LAN)',
  });
  await user.click(screen.getByRole('spinbutton', { name: 'Port' }));
  // The LAN access "?" tip comes first, then the switch.
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'What is LAN access?' }));
  await user.tab();
  expect(document.activeElement).toBe(control);
  await user.keyboard(' ');
  expect(control.getAttribute('aria-checked')).toBe('true');
  await user.keyboard('{Enter}');
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(patch.mutate).not.toHaveBeenCalled();
});

it.each([
  ['general', 'Port', ['Inline AI connection', 'Resolve all card', 'Appearance']],
  ['ai', 'Inline AI connection', ['Port', 'Resolve all card', 'Appearance', 'AI assistant access']],
  ['integrations', 'AI assistant access', ['Port', 'Inline AI connection', 'Appearance']],
  ['device', 'Appearance', ['Port', 'Inline AI connection', 'Resolve all card']],
  ['maintenance', 'Resolve all card', ['Port', 'Inline AI connection', 'Appearance']],
])('renders only the %s section on its route', (tab, shown, hidden) => {
  renderAt(`/admin/settings/${tab}`);
  expect(screen.getAllByText(shown).length).toBeGreaterThan(0);
  for (const h of hidden) expect(screen.queryByText(h)).toBeNull();
  expect(screen.getByRole('tab', { selected: true }).textContent).toBe(
    {
      general: 'General',
      ai: 'AI',
      integrations: 'Integrations',
      device: 'Preferences',
      maintenance: 'Maintenance',
    }[tab],
  );
});

it.each(['/admin/settings', '/admin/settings/', '/admin/settings/nope', '/admin/settings/ai/x'])(
  'redirects %s to the General tab',
  async (path) => {
    renderAt(path);
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/admin/settings/general'),
    );
    expect(screen.getByRole('spinbutton', { name: 'Port' })).toBeTruthy();
  },
);

it('navigates between tabs with absolute admin paths', async () => {
  renderAt();
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Maintenance' }));
  expect(screen.getByTestId('location').textContent).toBe('/admin/settings/maintenance');
});

it('shows the restart banner only on the General tab', async () => {
  patch.mutate.mockImplementationOnce((_b, o) => o.onSuccess({ restartRequired: true }));
  renderAt();
  const user = userEvent.setup();
  await user.click(screen.getByRole('switch', { name: /local network/ }));
  await user.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(screen.getByText('Restart required')).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'AI' }));
  expect(screen.queryByText('Restart required')).toBeNull();
});

it('shows the reversible end-of-day action without a danger-zone frame', () => {
  renderAt('/admin/settings/maintenance');
  expect(screen.queryByRole('heading', { name: 'Danger zone' })).toBeNull();
  expect(screen.getByText('Resolve all card')).toBeTruthy();
});

it('describes the page and explains when to change the port and history', () => {
  renderAt();
  expect(
    screen.getByText('Team-wide settings for this inbox, plus your own preferences.'),
  ).toBeTruthy();
  expect(screen.getByText(/Only change this if another app already uses this port/)).toBeTruthy();
  expect(screen.getByText(/0–365 days/)).toBeTruthy();
  expect(screen.getByText('days')).toBeTruthy();
});

it('marks unsaved general settings next to Save', async () => {
  renderAt();
  const user = userEvent.setup();
  expect(screen.queryByText('Unsaved')).toBeNull();
  await user.click(screen.getByRole('switch', { name: /local network/ }));
  expect(screen.getByText('Unsaved')).toBeTruthy();
});

it('changes theme and language from compact segmented controls', async () => {
  renderAt('/admin/settings/device');
  const user = userEvent.setup();
  expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeTruthy();
  await user.click(screen.getByText('Dark'));
  expect(setTheme).toHaveBeenCalledWith('dark');
  expect(screen.getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe('true');
  await user.click(screen.getByText('中文'));
  expect(changeLocale).toHaveBeenCalledWith('zh-CN');
  // Language is saved to the account, so it is grouped apart from this-device preferences.
  const account = screen.getByText('Your account').closest('[data-slot="card"]')!;
  expect(account.textContent).toContain('Language');
  expect(account.textContent).toContain('follows you on every device');
  const device = screen.getByText('This device').closest('[data-slot="card"]')!;
  expect(device.textContent).toContain('Appearance');
  expect(device.textContent).not.toContain('Language');
});

it('points Integrations to Admin → Connectors', () => {
  renderAt('/admin/settings/integrations');
  expect(screen.getByText(/are in Admin → Connectors/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Browse connectors' }).getAttribute('href')).toBe(
    '/admin/connectors',
  );
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings, TunnelStatus } from '@ezychat/shared';
import { TunnelPage } from './TunnelPage';

const hooks = vi.hoisted(() => ({
  tunnel: {} as TunnelStatus,
  settings: {} as Settings,
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../api/queries', () => ({
  useTunnel: () => ({ data: hooks.tunnel, isPending: false, isError: false }),
  useSettings: () => ({ data: hooks.settings }),
  useStartTunnel: () => ({ mutate: hooks.start, isPending: false, error: null }),
  useStopTunnel: () => ({ mutate: hooks.stop, isPending: false, error: null }),
}));
vi.mock('./CloudflareSetup', () => ({ CloudflareSetup: () => <div>Guided Cloudflare setup</div> }));

beforeEach(() => {
  hooks.tunnel = {
    mode: 'named',
    state: 'stopped',
    url: null,
    hostname: null,
    lastError: null,
    logTail: [],
  };
  hooks.settings = {
    port: 7420,
    lanEnabled: false,
    historyDays: 3,
    namedTunnelHostname: null,
    hasTunnelToken: false,
    usageStats: true,
  };
  hooks.start.mockReset();
  hooks.stop.mockReset();
});
afterEach(cleanup);

it('hides reconnect while the saved domain runs and explains disconnection', async () => {
  hooks.settings = {
    ...hooks.settings,
    hasTunnelToken: true,
    namedTunnelHostname: 'inbox.example.com',
    lanEnabled: true,
  };
  hooks.tunnel = {
    ...hooks.tunnel,
    state: 'running',
    hostname: 'inbox.example.com',
    url: 'https://inbox.example.com',
  };
  render(<TunnelPage />);
  expect(screen.queryByRole('button', { name: 'Connect saved address' })).toBeNull();
  expect(screen.getByText(/Disconnect Cloudflare stops the public link/).textContent).toContain(
    'and over your enabled local network',
  );
  expect(hooks.stop).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Disconnect Cloudflare' }));
  expect(hooks.stop).toHaveBeenCalledOnce();
});

it('prevents duplicate reconnects while the saved domain starts', () => {
  hooks.settings = {
    ...hooks.settings,
    hasTunnelToken: true,
    namedTunnelHostname: 'inbox.example.com',
  };
  hooks.tunnel = { ...hooks.tunnel, state: 'starting', hostname: 'inbox.example.com' };
  render(<TunnelPage />);
  expect(
    (screen.getByRole('button', { name: 'Connecting saved address…' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(hooks.start).not.toHaveBeenCalled();
});

it('defaults to guided domain setup and keeps manual token fields optional', async () => {
  const user = userEvent.setup();
  render(<TunnelPage />);
  expect(screen.getByText('Guided Cloudflare setup')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Public hostname' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Connect saved address' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Advanced: use a tunnel token' }));
  await user.type(screen.getByLabelText('Tunnel token'), 'a-synthetic-tunnel-token');
  await user.type(screen.getByRole('textbox', { name: 'Public hostname' }), 'inbox.example.com');
  await user.click(screen.getByRole('button', { name: 'Connect with token' }));
  expect(hooks.start).toHaveBeenCalledWith(
    { mode: 'named', token: 'a-synthetic-tunnel-token', hostname: 'inbox.example.com' },
    expect.any(Object),
  );
});

it('reconnects the saved address without using an unfinished advanced draft', async () => {
  hooks.settings = {
    ...hooks.settings,
    namedTunnelHostname: 'saved.example.com',
    hasTunnelToken: true,
  };
  const user = userEvent.setup();
  render(<TunnelPage />);
  const advanced = screen.getByRole('button', { name: 'Advanced: use a tunnel token' });
  await user.click(advanced);
  await user.type(screen.getByLabelText('Tunnel token'), 'unfinished-token-draft');
  await user.clear(screen.getByRole('textbox', { name: 'Public hostname' }));
  await user.type(screen.getByRole('textbox', { name: 'Public hostname' }), 'draft.example.com');
  await user.click(advanced);
  await user.click(screen.getByRole('button', { name: 'Connect saved address' }));
  expect(hooks.start).toHaveBeenCalledWith(
    { mode: 'named', hostname: 'saved.example.com' },
    expect.any(Object),
  );
});

it('shows no status button or disconnect note while remote access is already off', () => {
  hooks.tunnel = { ...hooks.tunnel, mode: 'off' };
  render(<TunnelPage />);
  expect(screen.queryByRole('button', { name: 'Remote access is off' })).toBeNull();
  expect(screen.queryByText(/Disconnect Cloudflare stops the public link/)).toBeNull();
  // The connection state lives in the card header instead of a separate status card.
  const card = screen.getByText('How your team connects').closest('[data-slot="card"]')!;
  expect(card.textContent).toContain('Stopped');
  expect(screen.queryByText('Connection status')).toBeNull();
});

it('offers Disconnect with its note when Off is chosen while connected', async () => {
  hooks.tunnel = { ...hooks.tunnel, mode: 'quick', state: 'running' };
  const user = userEvent.setup();
  render(<TunnelPage />);
  await user.click(screen.getByRole('radio', { name: /^Off/ }));
  expect(screen.getAllByRole('button', { name: 'Disconnect Cloudflare' }).length).toBe(1);
  expect(screen.getByText(/Disconnect Cloudflare stops the public link/)).toBeTruthy();
});

it('retains account-free temporary links and the option to turn off access', async () => {
  hooks.tunnel = { ...hooks.tunnel, mode: 'off' };
  const user = userEvent.setup();
  const view = render(<TunnelPage />);
  expect(screen.queryByText('Guided Cloudflare setup')).toBeNull();
  await user.click(screen.getByRole('radio', { name: /Temporary link/ }));
  await user.click(screen.getByRole('button', { name: 'Create temporary link' }));
  expect(hooks.start).toHaveBeenCalledWith({ mode: 'quick' }, expect.any(Object));
  expect(screen.queryByText('Guided Cloudflare setup')).toBeNull();
  hooks.tunnel = { ...hooks.tunnel, state: 'running', mode: 'quick' };
  view.rerender(<TunnelPage />);
  await user.click(screen.getByRole('button', { name: 'Disconnect Cloudflare' }));
  expect(hooks.stop).toHaveBeenCalledOnce();
});

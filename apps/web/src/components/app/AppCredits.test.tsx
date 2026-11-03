import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppCredits } from './AppCredits';
import { ANCHOR_SPRINT_URL, CUSTOM_FEATURE_URL, LITE_APP_LINKS } from '@/lib/links';
import { AppLinksProvider } from '@/lib/app-links';
import { OPEN_FEEDBACK_EVENT } from './FeedbackDialog';

afterEach(cleanup);

it('preserves the attribution and contact wording outside the admin sidebar', () => {
  render(<AppCredits version="0.1.7" />);
  expect(screen.getByText('v0.1.7')).toBeTruthy();
  expect(screen.getByText(/Need a custom feature/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Contact Anchor Sprint' }).getAttribute('href')).toBe(
    CUSTOM_FEATURE_URL,
  );
});

it('folds sidebar support links into one Help & feedback item without changing destinations', async () => {
  render(<AppCredits variant="sidebar" version="0.1.7" />);
  expect(screen.getByText('v0.1.7')).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Support links' })).toBeNull();
  const toggle = screen.getByRole('button', { name: 'Help & feedback' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await userEvent.setup().click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('navigation', { name: 'Support links' })).toBeTruthy();
  expect(screen.queryByText(/Need a custom feature/)).toBeNull();
  for (const [name, href] of [
    ['Anchor Sprint', ANCHOR_SPRINT_URL],
    ['Custom features', CUSTOM_FEATURE_URL],
  ]) {
    const link = screen.getByRole('link', { name });
    expect(link.getAttribute('href')).toBe(href);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  }
});

it('opens Send feedback from the sidebar panel and from About', async () => {
  const opened = vi.fn();
  window.addEventListener(OPEN_FEEDBACK_EVENT, opened);
  const user = userEvent.setup();
  render(<AppCredits variant="sidebar" version="0.1.7" />);
  await user.click(screen.getByRole('button', { name: 'Help & feedback' }));
  expect(screen.queryByRole('link', { name: 'Report an issue' })).toBeNull();
  await user.click(screen.getByTestId('sidebar-feedback'));
  cleanup();
  render(<AppCredits version="0.1.7" />);
  await user.click(screen.getByRole('button', { name: 'Send feedback' }));
  expect(opened).toHaveBeenCalledTimes(2);
  window.removeEventListener(OPEN_FEEDBACK_EVENT, opened);
});

it('keeps the support email for an edition without a public issue tracker', async () => {
  const links = { ...LITE_APP_LINKS, reportIssue: null, supportEmail: 'help@example.com' };
  render(
    <AppLinksProvider links={links}>
      <AppCredits variant="sidebar" version="0.1.7" />
    </AppLinksProvider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Help & feedback' }));
  expect(screen.getByRole('link', { name: 'Email support' }).getAttribute('href')).toBe(
    'mailto:help@example.com',
  );
  cleanup();
  render(<AppCredits variant="sidebar" version="0.1.7" />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Help & feedback' }));
  expect(screen.queryByRole('link', { name: 'Email support' })).toBeNull();
});

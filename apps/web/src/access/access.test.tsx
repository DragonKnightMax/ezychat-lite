import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiError, UNAUTHORIZED_EVENT } from '@/api/client';
import { AppLinksProvider } from '@/lib/app-links';
import { LITE_APP_LINKS, reportIssueHref, resolveAppLinks, shareAppUrl } from '@/lib/links';
import { AppCredits } from '@/components/app/AppCredits';
import { AboutDialog } from '@/components/app/AboutDialog';
import {
  validateWebExtensions,
  WebExtensionError,
  WebExtensionsProvider,
  type WebExtension,
  type WebExtensionLockScreenProps,
} from '@/extensions';
import { ACCESS_POLL_MS, AccessGate } from './AccessGate';
import { ExtensionBannerSlot, SlimBanner } from './BannerSlot';
import { ACCESS_CLOSED_EVENT, accessGateCode, dispatchAccessClosed } from './events';

vi.mock('@/lib/error-reporter', () => ({ reportClientError: vi.fn() }));
vi.mock('@/lib/version', () => ({ useAppVersion: () => '0.1.0' }));
vi.mock('@/components/app/DesktopUpdates', () => ({ DesktopUpdatePanel: () => null }));

/** Not inside a `hidden` element (jsdom applies no CSS, so `hidden` is what hides a banner). */
function isShown(element: Element): boolean {
  return element.closest('[hidden]') === null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** fetch stub answering GET /api/access from `access`, everything else 200 {}. */
function stubFetch(access: () => unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/access') return json(access());
    return json({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function accessCalls(fn: ReturnType<typeof stubFetch>): number {
  return fn.mock.calls.filter(([url]) => url === '/api/access').length;
}

function Shell({
  extensions = [],
  children,
}: {
  extensions?: readonly WebExtension[];
  children: ReactNode;
}) {
  return (
    <MemoryRouter>
      <WebExtensionsProvider extensions={extensions}>{children}</WebExtensionsProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('accessGateCode', () => {
  it('reads a plain string error from a 403 body only', () => {
    expect(accessGateCode(403, { error: 'license_required' })).toBe('license_required');
    expect(accessGateCode(403, { error: { code: 'forbidden', message: 'x' } })).toBeNull();
    expect(accessGateCode(401, { error: 'license_required' })).toBeNull();
    expect(accessGateCode(403, { error: 'has spaces' })).toBeNull();
    expect(accessGateCode(403, undefined)).toBeNull();
  });
});

describe('api() and the access gate', () => {
  it('turns a 403 with a gate code into an access-closed event, never a sign-in redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'license_required' }, 403)),
    );
    const closed = vi.fn();
    const unauthorized = vi.fn();
    window.addEventListener(ACCESS_CLOSED_EVENT, closed);
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    try {
      const error = await api('/me').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('license_required');
      expect(closed).toHaveBeenCalledTimes(1);
      expect((closed.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        code: 'license_required',
      });
      expect(unauthorized).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(ACCESS_CLOSED_EVENT, closed);
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    }
  });

  it('keeps ordinary 403 errors as they were', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'forbidden', message: 'Admins only' } }, 403)),
    );
    const closed = vi.fn();
    window.addEventListener(ACCESS_CLOSED_EVENT, closed);
    try {
      const error = (await api('/users').catch((e: unknown) => e)) as ApiError;
      expect(error.code).toBe('forbidden');
      expect(closed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(ACCESS_CLOSED_EVENT, closed);
    }
  });
});

describe('AccessGate', () => {
  it('renders the app while access is open', async () => {
    stubFetch(() => ({ open: true }));
    render(
      <Shell>
        <AccessGate>
          <h1>Inbox</h1>
        </AccessGate>
      </Shell>,
    );
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
  });

  it('treats a server without GET /api/access as open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'not_found', message: 'x' } }, 404)),
    );
    render(
      <Shell>
        <AccessGate>
          <h1>Inbox</h1>
        </AccessGate>
      </Shell>,
    );
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
  });

  it('shows the core paused screen when /api/access says closed', async () => {
    stubFetch(() => ({ open: false, code: 'license_required' }));
    render(
      <Shell>
        <AccessGate>
          <h1>Inbox</h1>
        </AccessGate>
      </Shell>,
    );
    expect(await screen.findByTestId('access-paused')).toBeTruthy();
    expect(screen.getByText('Reason: license_required')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
  });

  it('shows the lock screen as soon as an API call answers 403 with the gate code', async () => {
    stubFetch(() => ({ open: true }));
    render(
      <Shell>
        <AccessGate>
          <h1>Inbox</h1>
        </AccessGate>
      </Shell>,
    );
    await screen.findByRole('heading', { name: 'Inbox' });
    act(() => dispatchAccessClosed('trial_ended'));
    expect(await screen.findByText('Reason: trial_ended')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
  });

  it("uses the extension's lock screen, and recheck reloads once access is open", async () => {
    let open = false;
    const fetchFn = stubFetch(() => (open ? { open: true } : { open: false, code: 'expired' }));
    const reload = vi.fn();
    function Lock({ code, recheck }: WebExtensionLockScreenProps) {
      return (
        <div>
          <p>Licence lock: {code}</p>
          <button type="button" onClick={recheck}>
            Retry
          </button>
        </div>
      );
    }
    render(
      <Shell extensions={[{ name: 'enterprise', lockScreen: Lock }]}>
        <AccessGate reload={reload}>
          <h1>Inbox</h1>
        </AccessGate>
      </Shell>,
    );
    expect(await screen.findByText('Licence lock: expired')).toBeTruthy();
    expect(screen.queryByTestId('access-paused')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(accessCalls(fetchFn)).toBe(2));
    expect(reload).not.toHaveBeenCalled();

    open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('checks again every minute while closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let open = false;
    const fetchFn = stubFetch(() => (open ? { open: true } : { open: false, code: 'expired' }));
    const reload = vi.fn();
    render(
      <Shell>
        <AccessGate reload={reload}>
          <h1>Inbox</h1>
        </AccessGate>
      </Shell>,
    );
    await screen.findByTestId('access-paused');
    expect(accessCalls(fetchFn)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS);
    });
    expect(accessCalls(fetchFn)).toBe(2);
    open = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS);
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('the paused screen recheck button reads /api/access again', async () => {
    const fetchFn = stubFetch(() => ({ open: false, code: 'expired' }));
    render(
      <Shell>
        <AccessGate>
          <h1>Inbox</h1>
        </AccessGate>
      </Shell>,
    );
    await screen.findByTestId('access-paused');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(accessCalls(fetchFn)).toBe(2));
  });
});

describe('ExtensionBannerSlot', () => {
  const Empty = () => null;
  const Trial = () => <SlimBanner tone="warning">Trial ends in 3 days</SlimBanner>;
  const Other = () => <SlimBanner>Second banner</SlimBanner>;

  it('shows only the first banner that renders something', () => {
    render(
      <Shell
        extensions={[
          { name: 'first', banners: [Empty] },
          { name: 'second', banners: [Trial, Other] },
        ]}
      >
        <ExtensionBannerSlot />
      </Shell>,
    );
    expect(isShown(screen.getByText('Trial ends in 3 days'))).toBe(true);
    expect(isShown(screen.getByText('Second banner'))).toBe(false);
    expect(isShown(screen.getByTestId('extension-banner-slot'))).toBe(true);
  });

  it('hides the slot when every banner is empty, and follows a banner that appears later', async () => {
    let show: (value: boolean) => void = () => {};
    function Later() {
      const [visible, setVisible] = useState(false);
      show = setVisible;
      return visible ? <SlimBanner>Now visible</SlimBanner> : null;
    }
    render(
      <Shell extensions={[{ name: 'first', banners: [Empty, Later] }]}>
        <ExtensionBannerSlot />
      </Shell>,
    );
    expect(isShown(screen.getByTestId('extension-banner-slot'))).toBe(false);
    act(() => show(true));
    await waitFor(() => expect(isShown(screen.getByText('Now visible'))).toBe(true));
  });

  it('renders nothing without banners', () => {
    render(
      <Shell>
        <ExtensionBannerSlot />
      </Shell>,
    );
    expect(screen.queryByTestId('extension-banner-slot')).toBeNull();
  });
});

describe('app links', () => {
  it("keeps Lite's links by default and applies overrides, with null hiding a link", () => {
    expect(resolveAppLinks()).toEqual(LITE_APP_LINKS);
    // Connector requests open a WhatsApp chat with the EzyChat team, message ready.
    expect(LITE_APP_LINKS.connectorRequest?.('Add Xero & co')).toBe(
      'https://wa.me/601159246128?text=Add%20Xero%20%26%20co',
    );
    expect(resolveAppLinks({ connectorRequest: null }).connectorRequest).toBeNull();
    const links = resolveAppLinks({
      website: 'https://ezychat.ai/',
      reportIssue: null,
      sourceCode: null,
      releaseNotes: null,
      supportEmail: 'general@anchorsprint.com',
    });
    expect(links.reportIssue).toBeNull();
    expect(reportIssueHref(links)).toBe('mailto:general@anchorsprint.com');
    expect(reportIssueHref({ ...links, supportEmail: null })).toBeNull();
    expect(shareAppUrl(links)).toBe('https://ezychat.ai/');
  });

  function withLinks(overrides: Parameters<typeof resolveAppLinks>[0], node: ReactNode) {
    return render(<AppLinksProvider links={resolveAppLinks(overrides)}>{node}</AppLinksProvider>);
  }

  it('AppCredits: Send feedback replaces the GitHub link; an edition without one keeps its support email', () => {
    render(<AppCredits />);
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeTruthy();
    expect(document.querySelector('a[href*="github.com"]')).toBeNull();
    expect(screen.queryByRole('link', { name: /email support/i })).toBeNull();
    cleanup();
    withLinks({ reportIssue: null, supportEmail: 'general@anchorsprint.com' }, <AppCredits />);
    expect(screen.getByRole('link', { name: /email support/i }).getAttribute('href')).toBe(
      'mailto:general@anchorsprint.com',
    );
    cleanup();
    withLinks({ reportIssue: null, supportEmail: null }, <AppCredits />);
    expect(screen.queryByRole('link', { name: /report an issue|email support/i })).toBeNull();
  });

  it('AboutDialog links the website instead of GitHub when there is no source code link', () => {
    withLinks(
      { website: 'https://ezychat.ai/', sourceCode: null, reportIssue: null },
      <AboutDialog open onOpenChange={() => {}} version="1.0.0" />,
    );
    expect(screen.getByRole('link', { name: /visit the website/i }).getAttribute('href')).toBe(
      'https://ezychat.ai/',
    );
    expect(document.querySelector('a[href*="github.com"]')).toBeNull();
  });
});

describe('validateWebExtensions: banners and lockScreen', () => {
  const Banner = () => null;
  const Lock = () => null;

  it('accepts component banners and a lock screen', () => {
    expect(() =>
      validateWebExtensions([{ name: 'enterprise', banners: [Banner], lockScreen: Lock }]),
    ).not.toThrow();
  });

  it('rejects banners or lock screens that are not components', () => {
    expect(() =>
      validateWebExtensions([{ name: 'enterprise', banners: ['text' as unknown as () => null] }]),
    ).toThrow(WebExtensionError);
    expect(() =>
      validateWebExtensions([{ name: 'enterprise', banners: Banner as unknown as (() => null)[] }]),
    ).toThrow(WebExtensionError);
    expect(() =>
      validateWebExtensions([{ name: 'enterprise', lockScreen: 'x' as unknown as () => null }]),
    ).toThrow(WebExtensionError);
  });
});

beforeEach(() => {
  // AboutDialog's ResponsiveDialog reads matchMedia.
  if (!window.matchMedia)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
});

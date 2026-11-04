import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { FeedbackDefaults } from '@ezychat/shared';
import { AppLinksProvider } from '@/lib/app-links';
import { GITHUB_ISSUES_URL, resolveAppLinks } from '@/lib/links';
import { ErrorBoundary } from './ErrorBoundary';
import { areaForPath, FeedbackHost, languageName, openFeedback } from './FeedbackDialog';

const auth = vi.hoisted(() => ({
  user: { id: 1, username: 'aisyah', displayName: 'Aisyah', role: 'agent' } as unknown,
}));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user }) }));

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DEFAULTS: FeedbackDefaults = {
  company: null,
  logLines: 2,
  logPreview: '{"level":30,"msg":"connection update"}\n{"level":30,"msg":"tick"}',
  diagnostics: {
    edition: 'lite',
    version: '0.1.73',
    os: 'Windows 11',
    osVersion: '10.0.26100',
    mode: 'standalone',
    waConnected: true,
    aiMode: 'chatgpt',
  },
};

interface Sent {
  report: Record<string, unknown>;
  files: File[];
}

function setup({
  path = '/admin/reports',
  defaults = DEFAULTS,
  respond = (): Response => json({ reference: 'FB-0043' }, 201),
  links = {},
}: {
  path?: string;
  defaults?: FeedbackDefaults;
  respond?: () => Response;
  links?: Parameters<typeof resolveAppLinks>[0];
} = {}) {
  const sent: Sent[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/feedback/defaults') return json(defaults);
    if (url === '/api/feedback' && init?.method === 'POST') {
      const form = init.body as FormData;
      sent.push({
        report: JSON.parse(form.get('report') as string) as Record<string, unknown>,
        files: form.getAll('file') as File[],
      });
      return respond();
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AppLinksProvider links={resolveAppLinks(links)}>
          <FeedbackHost />
        </AppLinksProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // delay: null types without a timer between keys: the long texts below took over 5 s on a busy Windows runner.
  return { sent, fetchMock, user: userEvent.setup({ applyAccept: false, delay: null }) };
}

async function openDialog(prefill?: Parameters<typeof openFeedback>[0]) {
  act(() => openFeedback(prefill));
  return screen.findByRole('dialog');
}

async function fillValid(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText('Short title'), 'Photos do not open');
  await user.type(
    within(dialog).getByLabelText('Details'),
    'Customer photos stay grey since this morning.',
  );
  const email = within(dialog).getByLabelText('Email');
  await user.clear(email);
  await user.type(email, 'aisyah@example.com');
}

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  auth.user = { id: 1, username: 'aisyah', displayName: 'Aisyah', role: 'agent' };
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.watiCapture;
  delete window.watiUpdates;
});

describe('areaForPath', () => {
  it('picks the part of the app from the screen', () => {
    expect(areaForPath('/')).toBe('inbox');
    expect(areaForPath('/chats/1')).toBe('inbox');
    expect(areaForPath('/admin/members/ai/1')).toBe('ai_agent');
    expect(areaForPath('/admin/ai')).toBe('ai_agent');
    expect(areaForPath('/admin/whatsapp')).toBe('whatsapp_link');
    expect(areaForPath('/admin/inboxes')).toBe('whatsapp_link');
    expect(areaForPath('/admin/connectors/google-calendar')).toBe('connectors');
    expect(areaForPath('/admin/reports')).toBe('reports');
    expect(areaForPath('/admin/members')).toBe('settings');
  });
});

// 20 s: each test renders the whole dialog and types several fields; windows-latest took over 5 s.
describe('Send feedback dialog', { timeout: 20_000 }, () => {
  it('shows nothing to a signed-out visitor', async () => {
    auth.user = null;
    setup();
    act(() => openFeedback());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks the missing fields and sends nothing', async () => {
    const { user, sent } = setup();
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(within(dialog).getByText('Fix the marked fields, then press Send again.')).toBeTruthy();
    expect(within(dialog).getByText('Write a short title (at least 3 characters).')).toBeTruthy();
    expect(within(dialog).getByText('Enter your email so we can reply.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Email'), 'nope');
    expect(within(dialog).getByText('Enter a valid email, like name@company.com.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Your name')).toHaveProperty('value', 'Aisyah');
    expect(sent).toHaveLength(0);
  });

  it('sends a problem with files, app details and the area of the screen, and remembers the email', async () => {
    const { user, sent } = setup();
    const dialog = await openDialog();
    expect(within(dialog).getByRole('combobox')).toHaveProperty('textContent', 'Reports');
    await fillValid(user, dialog);
    await user.click(within(dialog).getByRole('radio', { name: 'Every time' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Stops my work' }));
    const input = within(dialog).getByTestId('feedback-file-input') as HTMLInputElement;
    await user.upload(input, [
      new File(['png'], 'shot.png', { type: 'image/png' }),
      new File(['x'], 'virus.exe', { type: 'application/octet-stream' }),
    ]);
    expect(within(dialog).getByText(/virus\.exe cannot be attached/)).toBeTruthy();
    expect(within(dialog).getByTestId('feedback-files').textContent).toContain('shot.png');
    // the GitHub link is Lite's issues page
    expect(
      within(dialog)
        .getByRole('link', { name: /Prefer GitHub/ })
        .getAttribute('href'),
    ).toBe(GITHUB_ISSUES_URL);
    // no screenshot button in a browser
    expect(within(dialog).queryByRole('button', { name: 'Screenshot of this window' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('feedback-sent')).toBeTruthy();
    expect(screen.getByText('Reference: FB-0043')).toBeTruthy();
    expect(screen.getByText(/We will reply to aisyah@example.com/)).toBeTruthy();
    expect(sent[0]!.report).toMatchObject({
      type: 'problem',
      title: 'Photos do not open',
      area: 'reports',
      frequency: 'always',
      impact: 'blocking',
      name: 'Aisyah',
      email: 'aisyah@example.com',
      contactOk: true,
      includeDetails: true,
      includeLog: false,
      screen: '/admin/reports',
      client: 'browser',
      language: 'en',
    });
    expect(sent[0]!.files.map((f) => f.name)).toEqual(['shot.png']);
    expect(localStorage.getItem('ezychat.feedback.email')).toBe('aisyah@example.com');

    // Send another starts a new, empty report with the email kept
    await user.click(screen.getByRole('button', { name: 'Send another' }));
    const again = await screen.findByRole('dialog');
    expect(within(again).getByLabelText('Short title')).toHaveProperty('value', '');
    expect(within(again).getByLabelText('Email')).toHaveProperty('value', 'aisyah@example.com');
  });

  it('shows what is sent and the exact log, and sends an idea without problem questions', async () => {
    const { user, sent } = setup({ path: '/' });
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole('radio', { name: 'Idea' }));
    expect(within(dialog).queryByText('How often?')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'See what is sent' }));
    const diag = await within(dialog).findByTestId('feedback-diagnostics');
    for (const text of [
      'EzyChat Lite',
      '0.1.73',
      'Windows 11',
      'Browser',
      'On this computer',
      'ChatGPT sign-in',
      'Yes',
    ])
      expect(diag.textContent).toContain(text);
    await user.click(within(dialog).getByTestId('feedback-include-log'));
    await user.click(within(dialog).getByRole('button', { name: 'See the log' }));
    expect(within(dialog).getByTestId('feedback-log').textContent).toBe(DEFAULTS.logPreview);
    await user.click(within(dialog).getByTestId('feedback-include-details'));
    await user.click(within(dialog).getByRole('checkbox', { name: /may email me/ }));
    await fillValid(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/asked us not to email you/)).toBeTruthy();
    expect(sent[0]!.report).toMatchObject({
      type: 'idea',
      area: 'inbox',
      includeLog: true,
      includeDetails: false,
      contactOk: false,
    });
    expect(sent[0]!.report).not.toHaveProperty('frequency');
  });

  it.each([
    [502, 'feedback_unreachable', /could not reach the EzyChat team/],
    [429, 'rate_limited', /a lot of feedback in a short time/],
    [503, 'feedback_closed', /closed for now/],
    [503, 'feedback_unavailable', /cannot send feedback/],
    [413, 'too_large', /too large to send/],
    [415, 'file_type', /cannot be attached/],
    [500, 'internal', /Something went wrong/],
  ])(
    'keeps the text after a %s %s and retries with the same report id',
    async (status, code, text) => {
      let fail = true;
      const { user, sent } = setup({
        respond: () =>
          fail
            ? json({ error: { code, message: 'nope' } }, status)
            : json({ reference: 'FB-0044' }, 201),
      });
      const dialog = await openDialog();
      await fillValid(user, dialog);
      await user.click(within(dialog).getByRole('button', { name: 'Send' }));
      expect(await within(dialog).findByText(text)).toBeTruthy();
      expect(within(dialog).getByLabelText('Short title')).toHaveProperty(
        'value',
        'Photos do not open',
      );
      fail = false;
      await user.click(within(dialog).getByRole('button', { name: 'Send' }));
      await screen.findByTestId('feedback-sent');
      expect(sent[1]!.report.clientReportId).toBe(sent[0]!.report.clientReportId);
    },
  );

  it("fills the edition's company and hides the GitHub link without an issues page", async () => {
    setup({
      defaults: {
        ...DEFAULTS,
        company: 'Kopi Apong Sdn Bhd',
        diagnostics: { ...DEFAULTS.diagnostics, edition: 'enterprise' },
      },
      links: { reportIssue: null, supportEmail: 'general@anchorsprint.com' },
    });
    const dialog = await openDialog();
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/Company/)).toHaveProperty(
        'value',
        'Kopi Apong Sdn Bhd',
      ),
    );
    expect(within(dialog).queryByText('(optional)')).toBeNull();
    expect(within(dialog).queryByRole('link', { name: /GitHub/ })).toBeNull();
  });

  it('attaches a screenshot of the desktop window', async () => {
    const capture = vi.fn(
      async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) as Uint8Array | null,
    );
    window.watiCapture = { captureWindow: capture };
    window.watiUpdates = {} as never;
    const { user, sent } = setup();
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Screenshot of this window' }));
    expect(within(dialog).getByTestId('feedback-files').textContent).toMatch(/screenshot-\d+\.png/);
    capture.mockResolvedValueOnce(null);
    await user.click(within(dialog).getByRole('button', { name: 'Screenshot of this window' }));
    expect(within(dialog).getByText(/screenshot could not be taken/)).toBeTruthy();
    await fillValid(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await screen.findByTestId('feedback-sent');
    expect(sent[0]!.report.client).toBe('desktop');
    expect(sent[0]!.files[0]!.type).toBe('image/png');
  });

  it('removes a file and stops at 3 files', async () => {
    const { user } = setup();
    const dialog = await openDialog();
    const input = within(dialog).getByTestId('feedback-file-input') as HTMLInputElement;
    await user.upload(
      input,
      ['a', 'b', 'c', 'd'].map((n) => new File([n], `${n}.txt`, { type: 'text/plain' })),
    );
    expect(within(dialog).getByText('You can attach up to 3 files.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove b.txt' }));
    expect(within(dialog).getByTestId('feedback-files').textContent).not.toContain('b.txt');
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await user.upload(input, big);
    expect(within(dialog).getByText('big.pdf is larger than 10 MB.')).toBeTruthy();
  });

  it('opens from the error panel as a problem with the error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('Cannot read properties of undefined');
    };
    const { user } = setup();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole('button', { name: 'Report this problem' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Details') as HTMLTextAreaElement).value).toContain(
      'Error shown: Cannot read properties of undefined',
    );
    expect(within(dialog).getByRole('radio', { name: 'Problem' })).toHaveProperty(
      'ariaChecked',
      'true',
    );
  });
});

describe('languageName', () => {
  it('names the language and falls back to the code', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('ms', 'en')).toBe('Malay');
    expect(languageName('!!')).toBe('!!');
  });
});

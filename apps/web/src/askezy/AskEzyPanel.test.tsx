import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AskEzyAnswer, AskEzyEvent } from '@ezychat/shared';
import { AskEzyProvider } from './AskEzyContext';
import { AskEzyPanel } from './AskEzyPanel';
import { AskEzyButton } from './AskEzyButton';

const auth = vi.hoisted(() => ({
  user: { id: 1, username: 'aisyah', displayName: 'Aisyah Rahman', role: 'admin' },
  isAdmin: true,
}));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
  window.matchMedia ??= ((q: string) => ({
    matches: q.includes('min-width'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});

type Reply = { status?: number; events?: AskEzyEvent[]; json?: unknown; hang?: boolean };
let replies: Reply[];
let connected: boolean;
const sent: Array<{ url: string; body: unknown }> = [];

const stream = (events: AskEzyEvent[]) =>
  new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
    headers: { 'content-type': 'application/x-ndjson' },
  });

beforeEach(() => {
  replies = [];
  connected = true;
  sent.length = 0;
  auth.isAdmin = true;
  auth.user.role = 'admin';
  (auth.user as { chatScope?: string }).chatScope = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ url, body });
      if (url === '/api/ask-ezy/status')
        return new Response(JSON.stringify({ connected }), {
          headers: { 'content-type': 'application/json' },
        });
      const next = replies.shift() ?? { events: [] };
      if (next.hang)
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        );
      if (next.json !== undefined)
        return new Response(JSON.stringify(next.json), {
          status: next.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      return stream(next.events ?? []);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answer = (a: Partial<AskEzyAnswer>): AskEzyEvent => ({
  type: 'answer',
  answer: { text: 'Done.', blocks: [], steps: [], followUps: [], ...a },
});

function renderPanel() {
  render(
    <MemoryRouter>
      <AskEzyProvider>
        <AskEzyButton />
        <AskEzyPanel />
      </AskEzyProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}
async function openAndAsk(user: ReturnType<typeof userEvent.setup>, question: string) {
  await user.click(screen.getByRole('button', { name: /ask ezy/i }));
  const box = await screen.findByRole('textbox');
  await user.type(box, `${question}{Enter}`);
}

it('hides the Ask Ezy button for an agent limited to chosen chats', () => {
  auth.isAdmin = false;
  auth.user.role = 'agent';
  (auth.user as { chatScope?: string }).chatScope = 'chosen';
  renderPanel();
  expect(screen.queryByRole('button', { name: /ask ezy/i })).toBeNull();
});

describe('AskEzyPanel', () => {
  it('greets an admin with suggestions, streams what Ezy read, and shows every block', async () => {
    replies.push({
      events: [
        { type: 'step', key: 'get_stats', count: 1 },
        { type: 'step', key: 'list_chats', count: 3 },
        answer({
          text: 'A good week.',
          steps: [
            { key: 'get_stats', count: 1 },
            { key: 'list_chats', count: 3 },
          ],
          followUps: ['Why does the AI hand off chats?'],
          blocks: [
            {
              type: 'stats',
              items: [{ label: 'New conversations', value: '18', change: '+4', good: true }],
            },
            { type: 'bars', title: 'Hand-offs', rows: [{ label: 'Missing facts', count: 5 }] },
            {
              type: 'heatmap',
              title: 'Busy hours',
              hours: Array.from({ length: 7 }, (_, wd) =>
                Array.from({ length: 24 }, (_, h) => (wd === 5 && h === 12 ? 9 : 1)),
              ),
            },
            {
              type: 'chats',
              title: 'Waiting',
              chats: [
                {
                  jid: '601@s.whatsapp.net',
                  name: 'Priya',
                  preview: 'Order?',
                  wait: '42 min',
                  assignee: null,
                },
              ],
            },
            {
              type: 'customer',
              jid: '602@s.whatsapp.net',
              name: 'Farah Aziz',
              facts: ['4 messages'],
              points: ['Catering for 30.'],
              open: ['Deposit'],
              next: 'Confirm the deposit.',
            },
            {
              type: 'test',
              question: 'Ada hantar?',
              before: 'A human will help.',
              after: 'Ya, RM8.',
            },
          ],
        }),
      ],
    });
    const user = renderPanel();
    await user.click(screen.getByRole('button', { name: /ask ezy/i }));
    expect(await screen.findByText('Hi Aisyah, what do you want to know?')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Fix my knowledge and hand-off rules' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'How is my inbox this week?' }));
    const answerEl = await screen.findByTestId('ask-ezy-answer');
    expect(within(answerEl).getByText('A good week.')).toBeTruthy();
    expect(within(answerEl).getByTestId('ask-block-stats').textContent).toContain('18');
    expect(within(answerEl).getByTestId('ask-block-bars').textContent).toContain('Missing facts');
    expect(within(answerEl).getByTestId('ask-block-heatmap').textContent).toContain('Saturday');
    expect(within(answerEl).getByRole('link', { name: /Priya/ }).getAttribute('href')).toContain(
      '/chats/',
    );
    expect(within(answerEl).getByTestId('ask-block-customer').textContent).toContain(
      'Confirm the deposit.',
    );
    expect(within(answerEl).getByTestId('ask-block-test').textContent).toContain('Ya, RM8.');
    expect(within(answerEl).getByText('Ezy read: inbox statistics · 3 chats')).toBeTruthy();
    expect(sent.find((r) => r.url === '/api/ask-ezy')!.body).toEqual({
      question: 'How is my inbox this week?',
      history: [],
      chatJid: null,
    });
  });

  it('sends the earlier turns with a follow-up question', async () => {
    replies.push(
      { events: [answer({ text: 'First answer.' })] },
      { events: [answer({ text: 'Second.' })] },
    );
    const user = renderPanel();
    await openAndAsk(user, 'First question');
    await screen.findByText('First answer.');
    await user.type(screen.getByRole('textbox'), 'And then?{Enter}');
    await screen.findByText('Second.');
    const asks = sent.filter((r) => r.url === '/api/ask-ezy');
    expect((asks[1]!.body as { history: unknown }).history).toEqual([
      { role: 'user', text: 'First question' },
      { role: 'assistant', text: 'First answer.' },
    ]);
  });

  it('shows the setup first when no AI is connected, with the box off', async () => {
    connected = false;
    const user = renderPanel();
    await user.click(screen.getByRole('button', { name: /ask ezy/i }));
    expect(await screen.findByText('Connect an AI to use Ask Ezy')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings → AI' }).getAttribute('href')).toBe(
      '/admin/settings/ai',
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('docks beside the page on a wide screen and gives the page its room back on close', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 1280px)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      const user = renderPanel();
      await user.click(screen.getByRole('button', { name: /ask ezy/i }));
      await screen.findByTestId('ask-ezy-panel');
      expect(document.documentElement.dataset.askEzy).toBe('docked');
      await user.click(screen.getByRole('button', { name: 'Close Ask Ezy' }));
      await waitFor(() => expect(document.documentElement.dataset.askEzy).toBeUndefined());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tells a team member to ask their admin, without a settings link', async () => {
    connected = false;
    auth.isAdmin = false;
    auth.user.role = 'agent';
    const user = renderPanel();
    await user.click(screen.getByRole('button', { name: /ask ezy/i }));
    expect(await screen.findByText(/Ask them to connect one/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open Settings → AI' })).toBeNull();
  });

  it('explains a timeout and offers Try again and Edit question', async () => {
    replies.push({ events: [{ type: 'error', code: 'ai_timeout' }] });
    const user = renderPanel();
    await openAndAsk(user, 'A very long question');
    const error = await screen.findByTestId('ask-ezy-error');
    expect(error.textContent).toContain('Ezy took too long');
    await user.click(within(error).getByRole('button', { name: 'Edit question' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('A very long question');
  });

  it('shows the setup message when the server says there is no connection', async () => {
    replies.push({ status: 409, json: { error: { code: 'ai_not_connected', message: 'x' } } });
    const user = renderPanel();
    await openAndAsk(user, 'Hi');
    expect((await screen.findByTestId('ask-ezy-error')).textContent).toContain(
      'Connect an AI to use Ask Ezy',
    );
  });

  it('stops a running question and keeps what was read', async () => {
    replies.push({ hang: true });
    const user = renderPanel();
    await openAndAsk(user, 'Slow one');
    await screen.findByTestId('ask-ezy-thinking');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect((await screen.findByTestId('ask-ezy-stopped')).textContent).toContain(
      'Nothing was changed.',
    );
  });

  it('applies a change, undoes it, and explains a conflict with Ask again', async () => {
    const change = {
      type: 'change' as const,
      id: 'c1',
      agent: 'Aina',
      title: 'Delivery to Bayan Lepas',
      target: 'context_text' as const,
      itemName: 'Delivery areas',
      added: 1,
      removed: 0,
      before: 'George Town.',
      after: 'George Town.\nBayan Lepas: RM8.',
      reason: '4 customers asked.',
      status: 'proposed' as const,
    };
    replies.push(
      { events: [answer({ text: 'One change.', blocks: [change] })] },
      { json: { status: 'applied', version: 14 } },
      { json: { status: 'proposed' } },
      { status: 409, json: { error: { code: 'setup_changed', message: 'changed' } } },
      { events: [answer({ text: 'Asked again.' })] },
    );
    const user = renderPanel();
    await openAndAsk(user, 'Fix my knowledge');
    const card = await screen.findByTestId('ask-block-change-c1');
    expect(card.textContent).toContain('Adds 1 line · Business context · Delivery areas · Aina');
    expect(card.textContent).toContain('+ Added');
    await user.click(within(card).getByRole('button', { name: 'Apply' }));
    expect(
      await within(card).findByText(
        'Applied to Aina’s setup. Undo stays here until you start over.',
      ),
    ).toBeTruthy();
    // The Apply button is gone: focus stays on this card's title, not the top of the page.
    expect(document.activeElement).toBe(within(card).getByRole('heading', { level: 3 }));
    expect(sent.at(-1)!.url).toBe('/api/ask-ezy/changes/c1/apply');
    await user.click(within(card).getByRole('button', { name: 'Undo' }));
    await within(card).findByRole('button', { name: 'Apply' });
    await user.click(within(card).getByRole('button', { name: 'Apply' }));
    expect(await within(card).findByText('Not applied')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Apply' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Ask again' }));
    expect(await screen.findByText('Asked again.')).toBeTruthy();
  });

  it('asks before a new conversation clears change cards', async () => {
    replies.push({
      events: [
        answer({
          text: 'One change.',
          blocks: [
            {
              type: 'change',
              id: 'c2',
              agent: 'Aina',
              title: 'Rule',
              target: 'handoff_rules',
              itemName: null,
              added: 1,
              removed: 0,
              before: 'A',
              after: 'A\nB',
              reason: 'Late orders.',
              status: 'proposed',
            },
          ],
        }),
      ],
    });
    const user = renderPanel();
    await openAndAsk(user, 'Fix rules');
    await screen.findByTestId('ask-block-change-c2');
    await user.click(screen.getByRole('button', { name: /start over/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Keep this conversation' }));
    expect(screen.getByTestId('ask-block-change-c2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /start over/i }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start over' }),
    );
    await waitFor(() => expect(screen.queryByTestId('ask-block-change-c2')).toBeNull());
  });

  it('copies an answer as plain text with its blocks, and says when copying fails', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no'));
    replies.push({
      events: [
        answer({
          text: 'Your week.',
          blocks: [
            {
              type: 'stats',
              items: [
                { label: 'New conversations', value: '18', change: '+4', good: true },
                { label: 'Hand-offs', value: '9' },
              ],
            },
            {
              type: 'bars',
              title: 'Hand-offs by reason',
              rows: [{ label: 'Missing facts', count: 5 }],
            },
            {
              type: 'heatmap',
              title: 'Busy hours',
              finding: 'Saturday noon is busiest.',
              hours: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 1)),
            },
            {
              type: 'chats',
              title: 'Waiting',
              chats: [
                {
                  jid: '601@s.whatsapp.net',
                  name: 'Priya',
                  preview: 'Order?',
                  wait: '42 min',
                  assignee: null,
                },
              ],
            },
            {
              type: 'customer',
              jid: '602@s.whatsapp.net',
              name: 'Farah Aziz',
              facts: [],
              points: ['Catering for 30.'],
              open: [],
              next: 'Confirm the deposit.',
            },
          ],
        }),
      ],
    });
    const user = renderPanel();
    // userEvent.setup() installs its own clipboard: replace it after setup.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await openAndAsk(user, 'How is my week?');
    await screen.findByTestId('ask-block-stats');
    await user.click(screen.getByRole('button', { name: 'Copy answer' }));
    expect(writeText).toHaveBeenCalledWith(
      [
        'Your week.',
        'New conversations: 18 (+4)',
        'Hand-offs: 9',
        'Hand-offs by reason',
        '- Missing facts: 5',
        'Saturday noon is busiest.',
        'Waiting',
        '- Priya (42 min): Order?',
        'Farah Aziz',
        '- Catering for 30.',
        'Next: Confirm the deposit.',
      ].join('\n'),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied'));
    await user.click(screen.getByRole('button', { name: 'Copy answer' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not copy. Select the text instead.'),
    );
  });

  it('applies both suggested changes with one button', async () => {
    const change = (id: string, title: string) => ({
      type: 'change' as const,
      id,
      agent: 'Aina',
      title,
      target: 'handoff_rules' as const,
      itemName: null,
      added: 1,
      removed: 0,
      before: 'Old rule.',
      after: `Old rule.\n${title}.`,
      reason: 'Seen in hand-offs.',
      status: 'proposed' as const,
    });
    replies.push(
      {
        events: [
          answer({
            text: 'Two changes.',
            blocks: [change('c1', 'Late orders'), change('c2', 'Refunds')],
          }),
        ],
      },
      { json: { status: 'applied', version: 3 } },
      { json: { status: 'applied', version: 4 } },
    );
    const user = renderPanel();
    await openAndAsk(user, 'Fix my hand-off rules');
    await user.click(await screen.findByTestId('ask-ezy-apply-all'));
    await waitFor(() =>
      expect(sent.map((s) => s.url).filter((u) => u.includes('/changes/'))).toEqual([
        '/api/ask-ezy/changes/c1/apply',
        '/api/ask-ezy/changes/c2/apply',
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId('ask-ezy-apply-all')).toBeNull());
  });

  it('explains too many questions and an unavailable AI, with Settings for an admin', async () => {
    replies.push(
      { status: 429, json: { error: { code: 'rate_limited', message: 'slow down' } } },
      { status: 503, json: { error: { code: 'ai_unavailable', message: 'down' } } },
    );
    const user = renderPanel();
    await openAndAsk(user, 'First');
    expect(await screen.findByText('Too many questions')).toBeTruthy();
    // The Send button asks too, not only Enter.
    await user.type(screen.getByRole('textbox'), 'Second');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Ezy could not answer this time')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Check Settings → AI' }).getAttribute('href')).toBe(
      '/admin/settings/ai',
    );
    expect(
      sent
        .filter((s) => s.url === '/api/ask-ezy')
        .map((s) => (s.body as { question: string }).question),
    ).toEqual(['First', 'Second']);
  });
});

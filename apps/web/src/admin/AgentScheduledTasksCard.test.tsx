import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  Chat,
  ScheduledPreviewResponse,
  ScheduledRun,
  ScheduledTask,
  ScheduledTasksResponse,
} from '@ezychat/shared';
import { toast } from 'sonner';
import { AgentScheduledTasksCard } from './AgentScheduledTasksCard';
import { json, renderWithQuery, stubFetch } from './agent-cards.test.helpers';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const BASE = '/api/ai/agents/3/scheduled-tasks';
const STAFF = '120363000000000001@g.us';
const FARAH = '60123456789@s.whatsapp.net';
const FAMILY = '120363000000000002@g.us';
/** Monday 9 November 2026, 8:30 in Kuala Lumpur (UTC+8). */
const NEXT = Date.UTC(2026, 10, 9, 0, 30);
/** Thursday 5 November 2026, 8:30 in Kuala Lumpur. */
const LAST = Date.UTC(2026, 10, 5, 0, 30);

const run = (patch: Partial<ScheduledRun> = {}): ScheduledRun => ({
  id: 1,
  at: LAST,
  trigger: 'schedule',
  byUserName: null,
  result: 'sent',
  reason: null,
  messageId: 'M-1',
  ...patch,
});

const task = (id: number, patch: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id,
  agentId: 3,
  name: `Task ${id}`,
  enabled: true,
  time: '08:30',
  dayRule: 'weekdays',
  days: [],
  chatJid: STAFF,
  instruction: "Tell the team today's bookings.",
  chat: { jid: STAFF, name: 'Kopi Apong Staff', type: 'group' },
  nextRunAt: NEXT,
  lastRun: null,
  ...patch,
});

const TASKS = [
  task(1, { name: 'Morning bookings', lastRun: run() }),
  task(2, {
    name: 'Bean order reminder',
    time: '09:00',
    dayRule: 'custom',
    days: [4, 1],
    chatJid: FARAH,
    chat: { jid: FARAH, name: 'Farah Aziz', type: 'dm' },
  }),
  task(3, {
    name: 'Family Day overdue tasks',
    enabled: false,
    time: '17:00',
    dayRule: 'daily',
    chat: null,
    chatJid: FAMILY,
    nextRunAt: null,
    lastRun: run({ result: 'failed', reason: 'lookup_failed' }),
  }),
];

const chat = (jid: string, name: string, type: Chat['type']): Chat => ({
  jid,
  inboxId: 1,
  waJid: jid,
  type,
  name,
  avatarUrl: null,
  unreadCount: 0,
  lastMessageAt: null,
  lastMessagePreview: null,
  status: 'open',
  assignedTo: null,
  updatedAt: 0,
  phone: null,
  lastInboundAt: null,
});
const CHATS = [
  chat(FARAH, 'Farah Aziz', 'dm'),
  chat(STAFF, 'Kopi Apong Staff', 'group'),
  chat(FAMILY, 'Family Day 2026', 'group'),
];

type Answer = { status: number; body: unknown };
interface Server {
  list?: Partial<ScheduledTasksResponse>;
  runs?: ScheduledRun[];
  preview?: Answer;
  runNow?: Answer;
  save?: Answer;
  patch?: Answer;
  listStatus?: number;
  runsStatus?: number;
}

const refuse = (status: number, code: string): Answer => ({
  status,
  body: { error: { code, message: 'Refused' } },
});

/** A stand-in server for one agent's scheduled tasks and the chat list of its inbox. */
function stubServer(opts: Server = {}) {
  const state: ScheduledTasksResponse = {
    tasks: TASKS,
    max: 10,
    paused: null,
    timeZone: 'Asia/Kuala_Lumpur',
    inboxId: 1,
    ...opts.list,
  };
  return stubFetch((url, method, body) => {
    if (url.startsWith('/api/chats?')) {
      const params = new URLSearchParams(url.slice('/api/chats?'.length));
      const q = params.get('q')?.toLowerCase() ?? '';
      return json({
        chats: CHATS.filter((c) => c.name.toLowerCase().includes(q)),
        nextCursor: null,
      });
    }
    if (url === BASE && method === 'GET') {
      if (opts.listStatus) return json({ error: { code: 'server', message: 'Boom' } }, 500);
      return json(state);
    }
    if (url === BASE && method === 'POST') {
      if (opts.save) return json(opts.save.body, opts.save.status);
      const created = task(99, { ...(body as Partial<ScheduledTask>), chat: null });
      state.tasks = [...state.tasks, created];
      return json(created);
    }
    if (url === `${BASE}/preview` && method === 'POST') {
      const answer = opts.preview ?? {
        status: 200,
        body: { result: 'skipped', text: null, reason: null, lookups: [] },
      };
      return json(answer.body, answer.status);
    }
    const one = /^\/api\/ai\/agents\/3\/scheduled-tasks\/(\d+)(\/runs|\/run)?$/.exec(url);
    if (!one) return undefined;
    const id = Number(one[1]);
    if (one[2] === '/runs')
      return opts.runsStatus
        ? json({ error: { code: 'server', message: 'Boom' } }, opts.runsStatus)
        : json({ runs: opts.runs ?? [] });
    if (one[2] === '/run') {
      const answer = opts.runNow ?? { status: 200, body: { run: run({ trigger: 'run_now' }) } };
      return json(answer.body, answer.status);
    }
    if (method === 'PATCH') {
      if (opts.patch) return json(opts.patch.body, opts.patch.status);
      state.tasks = state.tasks.map((t) =>
        t.id === id ? { ...t, ...(body as Partial<ScheduledTask>) } : t,
      );
      return json(state.tasks.find((t) => t.id === id));
    }
    if (method === 'DELETE') {
      state.tasks = state.tasks.filter((t) => t.id !== id);
      return json({ ok: true });
    }
    return undefined;
  });
}

function renderCard() {
  renderWithQuery(
    <MemoryRouter initialEntries={['/admin/members/ai/3']}>
      <Routes>
        <Route
          path="/admin/members/ai/3"
          element={<AgentScheduledTasksCard agentId={3} name="Aina" />}
        />
        <Route path="/chats/:jid" element={<p>Chat page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const rows = () => screen.getAllByTestId('scheduled-row');
const callsTo = (calls: ReturnType<typeof stubServer>, url: string, method: string) =>
  calls.filter((c) => c.url === url && c.method === method);

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => {
  // A desktop window: the dialogs open as dialogs (phones get the bottom drawer).
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string, item: string) {
  await user.click(await screen.findByRole('button', { name: `More for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

describe('Agent page → Scheduled tasks', () => {
  it('lists each task with its schedule, chat, next run and last result', async () => {
    stubServer();
    renderCard();
    expect(await screen.findByText('Morning bookings')).toBeTruthy();
    const [morning, beans, family] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(morning).getByText('Weekdays · 8:30')).toBeTruthy();
    expect(within(morning).getByText('Kopi Apong Staff')).toBeTruthy();
    expect(within(morning).getByTestId('scheduled-next').textContent).toBe('Next: Mon 9 Nov, 8:30');
    expect(within(morning).getByTestId('scheduled-result').textContent).toBe('Sent');
    expect(
      within(morning).getByRole('button', {
        name: 'Last run: Sent, Thu 5 Nov, 8:30. Open history',
      }),
    ).toBeTruthy();
    // Chosen days read Monday first, whatever order they were saved in.
    expect(within(beans).getByText('Mon, Thu · 9:00')).toBeTruthy();
    expect(within(beans).queryByTestId('scheduled-last-run')).toBeNull();
    expect(within(family).getByText('Every day · 17:00')).toBeTruthy();
    expect(within(family).getByText('Off')).toBeTruthy();
    expect(within(family).getByTestId('scheduled-result').textContent).toBe('Failed');
    expect(within(family).getByTestId('scheduled-chat-gone').textContent).toBe(
      'The chat is no longer in this inbox. Edit the task to choose another.',
    );
    expect(
      screen
        .getByRole('switch', { name: 'Family Day overdue tasks on or off' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByTestId('scheduled-count').textContent).toBe('3 of 10 tasks');
    expect(screen.getByTestId('scheduled-add').hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/never to new numbers or lists of people/)).toBeTruthy();
    expect(screen.queryByTestId('scheduled-paused')).toBeNull();
    expect(screen.queryByTestId('scheduled-show-all')).toBeNull();
  });

  it('shows the empty state with an Add button', async () => {
    stubServer({ list: { tasks: [] } });
    renderCard();
    const empty = await screen.findByTestId('scheduled-empty');
    expect(empty.textContent).toContain('No scheduled tasks yet');
    expect(empty.textContent).toContain("Aina tells the staff group today's bookings");
    const user = userEvent.setup();
    await user.click(within(empty).getByRole('button', { name: 'Add task' }));
    expect(await screen.findByRole('dialog', { name: 'Add scheduled task' })).toBeTruthy();
  });

  it('shows the pause as a banner and on every switched-on row', async () => {
    stubServer({ list: { paused: 'wa_disconnected' } });
    renderCard();
    expect((await screen.findByTestId('scheduled-paused')).textContent).toBe(
      'WhatsApp is not connected. Tasks start again when it is.',
    );
    expect(screen.getByText('Scheduled tasks are paused')).toBeTruthy();
    expect(screen.getAllByText('Paused')).toHaveLength(2);
    expect(screen.queryByTestId('scheduled-next')).toBeNull();
  });

  it('folds a long list after 5 rows and disables Add at the limit', async () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      task(i + 1, {
        name: i === 9 ? 'A very long task name that wraps on a phone screen' : `Task ${i + 1}`,
      }),
    );
    stubServer({ list: { tasks: ten } });
    renderCard();
    await screen.findByText('Task 1');
    expect(rows()).toHaveLength(5);
    expect(screen.getByTestId('scheduled-count').textContent).toBe(
      '10 of 10 tasks. Delete one to add another.',
    );
    expect(screen.getByTestId('scheduled-add').hasAttribute('disabled')).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show all (10)' }));
    expect(rows()).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(rows()).toHaveLength(5);
  });

  it('asks for an inbox first when the agent serves none', async () => {
    stubServer({ list: { tasks: [], inboxId: null } });
    renderCard();
    expect(await screen.findByText('Choose an inbox for Aina first.')).toBeTruthy();
    expect(screen.queryByTestId('scheduled-add')).toBeNull();
  });

  it('shows a load error with Retry', async () => {
    stubServer({ listStatus: 500 });
    renderCard();
    expect(await screen.findByText("Couldn't load")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('switches a task off with { enabled } and says so when it cannot', async () => {
    const calls = stubServer();
    renderCard();
    const user = userEvent.setup();
    const sw = await screen.findByRole('switch', { name: 'Morning bookings on or off' });
    await user.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    expect(callsTo(calls, `${BASE}/1`, 'PATCH').map((c) => c.body)).toEqual([{ enabled: false }]);

    cleanup();
    stubServer({ patch: refuse(500, 'server') });
    renderCard();
    await user.click(await screen.findByRole('switch', { name: 'Morning bookings on or off' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save. Try again.'));
  });

  it('checks the form, picks a chat, previews and adds a task', async () => {
    const calls = stubServer({
      preview: {
        status: 200,
        body: {
          result: 'sent',
          text: 'Good morning team. Today: 3 bookings.',
          reason: null,
          lookups: [{ title: 'Bookings today', sourceLabel: 'Google Calendar' }],
        } satisfies ScheduledPreviewResponse,
      },
    });
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scheduled-add'));
    const dialog = await screen.findByRole('dialog', { name: 'Add scheduled task' });
    expect(
      within(dialog).getByText('Business time zone: Asia/Kuala_Lumpur (Settings → AI).'),
    ).toBeTruthy();
    expect(within(dialog).getByTestId('scheduled-preview-button').hasAttribute('disabled')).toBe(
      true,
    );

    // Nothing filled in: every required field says what is missing and nothing is sent.
    await user.click(within(dialog).getByTestId('scheduled-save'));
    expect(within(dialog).getByText('Give the task a name.')).toBeTruthy();
    expect(within(dialog).getByText('Choose where to send it.')).toBeTruthy();
    expect(within(dialog).getByText('Write what the message should say.')).toBeTruthy();
    expect(callsTo(calls, BASE, 'POST')).toEqual([]);

    await user.type(within(dialog).getByLabelText('Name'), 'Daily specials');

    // Send to: groups first, then people; the search goes to the server.
    await user.click(within(dialog).getByRole('combobox', { name: 'Send to' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Kopi Apong Staff',
      'Family Day 2026',
      'Farah Aziz',
    ]);
    expect(screen.getByText('Groups')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
    await user.type(screen.getByPlaceholderText('Search chats and groups'), 'nobody');
    expect(await screen.findByText('No chat found.')).toBeTruthy();
    await user.clear(screen.getByPlaceholderText('Search chats and groups'));
    await user.type(screen.getByPlaceholderText('Search chats and groups'), 'kopi');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(calls.some((c) => c.url === '/api/chats?assigned=any&q=kopi&inbox=1')).toBe(true);
    await user.click(screen.getByRole('option', { name: 'Kopi Apong Staff' }));
    expect(within(dialog).getByRole('combobox', { name: 'Send to' }).textContent).toContain(
      'Kopi Apong Staff',
    );

    // Time in 5-minute steps; Chosen days need at least one day.
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '07:58' } });
    expect((within(dialog).getByLabelText('Time') as HTMLInputElement).value).toBe('08:00');
    await user.click(within(dialog).getByRole('radio', { name: 'Chosen days' }));
    const days = within(dialog).getByTestId('scheduled-days');
    expect(within(days).getByRole('checkbox', { name: 'Mon' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    // Chosen days start from the weekdays the task had.
    expect(within(days).getByRole('checkbox', { name: 'Sat' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
      await user.click(within(days).getByRole('checkbox', { name: day }));
    }
    await user.click(within(dialog).getByTestId('scheduled-save'));
    expect(within(dialog).getByText('Choose at least one day.')).toBeTruthy();
    await user.click(within(days).getByRole('checkbox', { name: 'Thu' }));
    await user.click(within(days).getByRole('checkbox', { name: 'Tue' }));
    expect(within(dialog).queryByText('Choose at least one day.')).toBeNull();

    await user.type(
      within(dialog).getByLabelText('What should it say?'),
      "Tell the team today's specials.",
    );
    await user.click(within(dialog).getByTestId('scheduled-preview-button'));
    const preview = await within(dialog).findByTestId('scheduled-preview');
    expect(preview.textContent).toContain('Aina looked up Bookings today (Google Calendar).');
    expect(preview.textContent).toContain('Would send to Kopi Apong Staff:');
    expect(preview.textContent).toContain('Good morning team. Today: 3 bookings.');
    expect(preview.textContent).toContain('Preview only. Nothing is sent.');
    expect(callsTo(calls, `${BASE}/preview`, 'POST').map((c) => c.body)).toEqual([
      { chatJid: STAFF, instruction: "Tell the team today's specials." },
    ]);
    // A change makes the preview out of date.
    await user.type(within(dialog).getByLabelText('Name'), '!');
    expect(within(dialog).queryByTestId('scheduled-preview')).toBeNull();

    await user.click(within(dialog).getByTestId('scheduled-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo(calls, BASE, 'POST').map((c) => c.body)).toEqual([
      {
        name: 'Daily specials!',
        time: '08:00',
        dayRule: 'custom',
        days: [2, 4],
        chatJid: STAFF,
        instruction: "Tell the team today's specials.",
        enabled: true,
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Task added');
  });

  it('shows why a preview sends nothing, and a preview that failed', async () => {
    stubServer({
      preview: {
        status: 200,
        body: { result: 'skipped', text: null, reason: 'window_closed', lookups: [] },
      },
    });
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Morning bookings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit scheduled task' });
    await user.click(within(dialog).getByTestId('scheduled-preview-button'));
    expect((await within(dialog).findByTestId('scheduled-preview')).textContent).toContain(
      'Would send nothing. The 24-hour reply window of this chat was closed (WhatsApp Business API).',
    );

    cleanup();
    stubServer({ preview: refuse(503, 'ai_unavailable') });
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Morning bookings' }));
    const again = await screen.findByRole('dialog', { name: 'Edit scheduled task' });
    await user.click(within(again).getByTestId('scheduled-preview-button'));
    expect(await within(again).findByText('The preview did not work')).toBeTruthy();
    expect(within(again).getByText('Refused')).toBeTruthy();
  });

  it('edits a task with its saved values and shows a chat the server refused', async () => {
    const calls = stubServer();
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bean order reminder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit scheduled task' });
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Bean order reminder',
    );
    expect(within(dialog).getByRole('combobox', { name: 'Send to' }).textContent).toContain(
      'Farah Aziz',
    );
    expect(
      within(dialog).getByRole('radio', { name: 'Chosen days' }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(dialog).getByRole('radio', { name: 'Every day' }));
    expect(within(dialog).queryByTestId('scheduled-days')).toBeNull();
    await user.click(within(dialog).getByTestId('scheduled-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo(calls, `${BASE}/2`, 'PATCH').map((c) => c.body)).toEqual([
      {
        name: 'Bean order reminder',
        time: '09:00',
        dayRule: 'daily',
        days: [],
        chatJid: FARAH,
        instruction: "Tell the team today's bookings.",
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Task saved');

    cleanup();
    stubServer({ patch: refuse(400, 'chat_not_in_inbox') });
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Bean order reminder' }));
    const again = await screen.findByRole('dialog', { name: 'Edit scheduled task' });
    await user.click(within(again).getByTestId('scheduled-save'));
    expect(
      await within(again).findByText("That chat is not in this agent's inbox. Choose another."),
    ).toBeTruthy();
    expect(
      within(again).getByRole('combobox', { name: 'Send to' }).getAttribute('aria-invalid'),
    ).toBe('true');
    // Choosing another chat clears the refusal.
    await user.click(within(again).getByRole('combobox', { name: 'Send to' }));
    await user.click(await screen.findByRole('option', { name: 'Kopi Apong Staff' }));
    expect(
      within(again).queryByText("That chat is not in this agent's inbox. Choose another."),
    ).toBeNull();
  });

  it('says the limit is reached when the server refuses another task', async () => {
    stubServer({ save: refuse(409, 'scheduled_task_limit') });
    renderCard();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scheduled-add'));
    const dialog = await screen.findByRole('dialog', { name: 'Add scheduled task' });
    await user.type(within(dialog).getByLabelText('Name'), 'One more');
    await user.click(within(dialog).getByRole('combobox', { name: 'Send to' }));
    await user.click(await screen.findByRole('option', { name: 'Farah Aziz' }));
    await user.type(within(dialog).getByLabelText('What should it say?'), 'Say hello.');
    await user.click(within(dialog).getByTestId('scheduled-save'));
    expect(
      await within(dialog).findByText('10 of 10 tasks. Delete one to add another.'),
    ).toBeTruthy();
  });

  it('runs a task now after confirming, with Open chat on the sent toast', async () => {
    const calls = stubServer();
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Run now');
    const dialog = await screen.findByRole('dialog', { name: 'Send now to Kopi Apong Staff?' });
    expect(
      within(dialog).getByText(
        'Aina runs the task once now and sends its message, as at the set time.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByTestId('scheduled-run-confirm'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo(calls, `${BASE}/1/run`, 'POST')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [text, options] = vi.mocked(toast.success).mock.calls[0]!;
    expect(text).toBe('Sent to Kopi Apong Staff');
    const action = (options as { action: { label: string; onClick: () => void } }).action;
    expect(action.label).toBe('Open chat');
    act(() => action.onClick());
    expect(await screen.findByText('Chat page')).toBeTruthy();
  });

  it('tells a skipped and a failed run apart', async () => {
    stubServer({
      runNow: {
        status: 200,
        body: { run: run({ trigger: 'run_now', result: 'skipped', reason: 'nothing_to_say' }) },
      },
    });
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Run now');
    await user.click(await screen.findByTestId('scheduled-run-confirm'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Nothing sent. Nothing to tell today, so nothing was sent.',
      ),
    );

    cleanup();
    stubServer({
      runNow: {
        status: 200,
        body: { run: run({ trigger: 'run_now', result: 'failed', reason: 'send_failed' }) },
      },
    });
    renderCard();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Run now');
    await user.click(await screen.findByTestId('scheduled-run-confirm'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Not sent. WhatsApp did not take the message.'),
    );
  });

  it('explains the Run now limit and a pause in the dialog', async () => {
    stubServer({ runNow: refuse(429, 'rate_limited') });
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Run now');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByTestId('scheduled-run-confirm'));
    expect(
      await within(dialog).findByText(
        'Run now was used too often in the last hour. Try again later.',
      ),
    ).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();

    cleanup();
    stubServer({ runNow: refuse(409, 'scheduled_paused') });
    renderCard();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Run now');
    const paused = await screen.findByRole('dialog');
    await user.click(within(paused).getByTestId('scheduled-run-confirm'));
    expect(await within(paused).findByText('Scheduled tasks are paused')).toBeTruthy();

    cleanup();
    stubServer({ runNow: refuse(500, 'server') });
    renderCard();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Run now');
    const broken = await screen.findByRole('dialog');
    await user.click(within(broken).getByTestId('scheduled-run-confirm'));
    expect(await within(broken).findByText('Refused')).toBeTruthy();
  });

  it('blocks Run now while paused or when the chat is gone', async () => {
    stubServer({ list: { paused: 'agent_off' } });
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Run now');
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Aina is off. Turn the agent on to run its tasks.'),
    ).toBeTruthy();
    expect(within(dialog).getByTestId('scheduled-run-confirm').hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    cleanup();
    stubServer();
    renderCard();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Family Day overdue tasks', 'Run now');
    const gone = await screen.findByRole('dialog');
    expect(within(gone).getByTestId('scheduled-run-confirm').hasAttribute('disabled')).toBe(true);
    expect(
      within(gone).getByText(
        'The chat is no longer in this inbox. Edit the task to choose another.',
      ),
    ).toBeTruthy();
  });

  it('shows the history with reasons, who ran it and a link to the chat', async () => {
    stubServer({
      runs: [
        run({ id: 4, trigger: 'run_now', byUserName: 'Aisyah' }),
        run({ id: 3, result: 'skipped', reason: 'missed' }),
        run({ id: 2, result: 'failed', reason: 'ai_unavailable', messageId: null }),
        run({ id: 1, trigger: 'run_now', result: null, messageId: null }),
      ],
    });
    renderCard();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Last run: Sent, Thu 5 Nov, 8:30. Open history',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'History: Morning bookings' });
    const list = await within(dialog).findByTestId('scheduled-history-list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).toContain('Run now by Aisyah');
    const open = within(items[0]!).getByRole('link', { name: 'Open Kopi Apong Staff' });
    expect(open.getAttribute('href')).toBe(`/chats/${encodeURIComponent(STAFF)}`);
    expect(items[1]!.textContent).toContain(
      'The app was not running at that time. Missed runs are not sent later.',
    );
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    expect(items[2]!.textContent).toContain('FailedThu 5 Nov, 8:30');
    expect(items[3]!.textContent).toBe('RunningThu 5 Nov, 8:30Run now');
  });

  it('says when a task has not run yet, and closes with Escape', async () => {
    stubServer();
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Bean order reminder');
    await openMenu(user, 'Bean order reminder', 'History');
    expect(await screen.findByTestId('scheduled-history-empty')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a history that could not load with Retry', async () => {
    stubServer({ runsStatus: 500 });
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Bean order reminder');
    await openMenu(user, 'Bean order reminder', 'History');
    const dialog = await screen.findByRole('dialog', { name: 'History: Bean order reminder' });
    expect(await within(dialog).findByText("Couldn't load")).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows times in the device zone when the business zone is unknown', async () => {
    stubServer({ list: { timeZone: 'Not/AZone' } });
    renderCard();
    await screen.findByText('Morning bookings');
    const expected = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(NEXT));
    expect(screen.getAllByTestId('scheduled-next')[0]!.textContent).toBe(`Next: ${expected}`);
  });

  it('deletes a task after confirming', async () => {
    const calls = stubServer();
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Morning bookings');
    await openMenu(user, 'Morning bookings', 'Delete');
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete "Morning bookings"?' });
    expect(within(confirm).getByText(/Messages it already sent stay in the chat/)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(callsTo(calls, `${BASE}/1`, 'DELETE')).toHaveLength(0);
    await openMenu(user, 'Morning bookings', 'Delete');
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(screen.queryByText('Morning bookings')).toBeNull());
    expect(callsTo(calls, `${BASE}/1`, 'DELETE')).toHaveLength(1);
    expect(rows()).toHaveLength(2);
  });

  it('opens Edit from the menu; Chosen days start on Monday for an every-day task', async () => {
    stubServer();
    renderCard();
    const user = userEvent.setup();
    await screen.findByText('Family Day overdue tasks');
    await openMenu(user, 'Family Day overdue tasks', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit scheduled task' });
    // Its chat left the inbox: Send to asks for a new one.
    expect(within(dialog).getByRole('combobox', { name: 'Send to' }).textContent).toBe(
      'Choose a chat or group',
    );
    await user.click(within(dialog).getByRole('radio', { name: 'Chosen days' }));
    const days = within(dialog).getByTestId('scheduled-days');
    expect(
      within(days)
        .getAllByRole('checkbox')
        .filter((c) => c.getAttribute('aria-checked') === 'true')
        .map((c) => c.parentElement?.textContent),
    ).toEqual(['Mon']);
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '23:59' } });
    expect((within(dialog).getByLabelText('Time') as HTMLInputElement).value).toBe('23:55');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openMenu(user, 'Morning bookings', 'Run now');
    await screen.findByRole('dialog', { name: 'Send now to Kopi Apong Staff?' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

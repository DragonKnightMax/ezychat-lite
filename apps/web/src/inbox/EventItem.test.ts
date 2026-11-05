import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@ezychat/shared';
import { describeEvent } from './EventItem';
import type { Directory } from './useDirectory';

const names: Record<number, string> = { 1: 'Jazz', 2: 'Jee Fong' };
const dir = {
  nameOf: (id: number | null | undefined, opts?: { youLabel?: boolean }) =>
    id == null ? null : opts?.youLabel && id === 1 ? 'You' : (names[id] ?? null),
} as Directory;

const event = (
  type: ChatEvent['type'],
  actorId: number | null,
  payload: Record<string, unknown> = {},
): ChatEvent => ({
  id: 1,
  chatJid: '60123@s.whatsapp.net',
  type,
  actorId,
  payload,
  at: 0,
});

describe('describeEvent', () => {
  it('explains an owner claimed by replying', () => {
    expect(
      describeEvent(event('assigned', 2, { assignedTo: 2, previous: null, reason: 'reply' }), dir),
    ).toBe('Jee Fong took this chat by replying');
  });

  it('explains an owner released by resolving', () => {
    expect(describeEvent(event('unassigned', 1, { previous: 1, reason: 'resolved' }), dir)).toBe(
      'Chat returned to the team',
    );
  });

  it('keeps the wording for manual assignment changes', () => {
    expect(describeEvent(event('assigned', 1, { assignedTo: 1 }), dir)).toBe('You took this chat');
    expect(describeEvent(event('assigned', 1, { assignedTo: 2 }), dir)).toBe(
      'You assigned this chat to Jee Fong',
    );
    expect(describeEvent(event('unassigned', 2, { previous: 1 }), dir)).toBe(
      'Jee Fong unassigned this chat',
    );
  });

  it('names a hand-off because the reply window closed', () => {
    expect(
      describeEvent(event('unassigned', 2, { previous: 2, handoff: 'window_closed' }), dir),
    ).toBe(
      'Jee Fong handed this chat to the team: the reply window closed (only a template can be sent)',
    );
  });

  it('explains why the AI handed a chat to the team', () => {
    expect(
      describeEvent(event('unassigned', 2, { previous: 2, handoff: 'needs_action' }), dir),
    ).toBe(
      'Jee Fong handed this chat to the team: customer wants something done (order, booking, payment…)',
    );
    expect(
      describeEvent(
        event('assigned', 2, { assignedTo: 1, previous: 2, handoff: 'sensitive' }),
        dir,
      ),
    ).toBe('Jee Fong handed this chat to You: sensitive topic');
    // Unknown or missing reasons keep the plain wording.
    expect(describeEvent(event('unassigned', 2, { previous: 2, handoff: 'other' }), dir)).toBe(
      'Jee Fong unassigned this chat',
    );
  });

  it('describes an AI look-up by title and source only, and a failed look-up hand-over', () => {
    expect(
      describeEvent(
        event('ai_tool_used', 3, { title: 'Get order status', sourceLabel: 'Demo catalogue' }),
        dir,
      ),
    ).toBe('AI looked up Get order status · Demo catalogue');
    expect(describeEvent(event('ai_tool_used', 3, { title: '' }), dir)).toBe('');
    expect(
      describeEvent(event('unassigned', 2, { previous: 2, handoff: 'lookup_failed' }), dir),
    ).toBe('Jee Fong handed this chat to the team: a look-up in a connected system failed');
  });

  it('says the AI added a row to a Google Sheets tab', () => {
    const payload = {
      title: 'Add a row to Claims',
      sourceLabel: 'Google Sheets',
      sheet: { action: 'row_added', tab: 'Claims' },
    };
    expect(describeEvent(event('ai_tool_used', 3, payload), dir)).toBe(
      'AI added a row to Claims · Google Sheets',
    );
  });

  it('says the AI saved a file to Google Drive', () => {
    const payload = {
      title: 'Save a file',
      sourceLabel: 'Google Drive',
      drive: { action: 'saved' },
    };
    expect(describeEvent(event('ai_tool_used', 3, payload), dir)).toBe(
      'AI saved a file to Google Drive · Google Drive',
    );
  });

  it('names Google Calendar checks and bookings with the booked time', () => {
    const source = { title: 'Check free times', sourceLabel: 'Google Calendar' };
    expect(
      describeEvent(event('ai_tool_used', 3, { ...source, calendar: { action: 'checked' } }), dir),
    ).toBe('AI checked free times · Google Calendar');
    const start = new Date(2026, 9, 30, 19, 30).toISOString();
    const end = new Date(2026, 9, 30, 21, 0).toISOString();
    expect(
      describeEvent(
        event('ai_tool_used', 3, { ...source, calendar: { action: 'booked', start, end } }),
        dir,
      ),
    ).toMatch(/^AI booked Fri,? 30 Oct, 19:30–21:00 · Google Calendar$/);
    expect(
      describeEvent(event('ai_tool_used', 3, { ...source, calendar: { action: 'booked' } }), dir),
    ).toBe('AI booked a time · Google Calendar');
  });
});

describe('describeEvent in WhatsApp groups', () => {
  const source = { title: 'Group answer', sourceLabel: 'WhatsApp group' };
  const line = (group: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    describeEvent(event('ai_tool_used', 2, { ...source, ...extra, group }), dir);

  it('names the member the AI answered, by a tag or a quote', () => {
    expect(line({ kind: 'answered', member: 'Nurul Huda' })).toBe('Jee Fong answered Nurul Huda');
    expect(line({ kind: 'answered', member: 'Nurul Huda', quoted: true })).toBe(
      'Jee Fong answered Nurul Huda’s reply to the AI',
    );
    expect(line({ kind: 'answered', member: null })).toBe('Jee Fong answered a member');
  });

  it('says a question went to the team, with the reason when there is one', () => {
    expect(line({ kind: 'handover', member: 'Farah Aziz' }, { handoff: 'needs_action' })).toMatch(
      /^Jee Fong handed Farah Aziz’s question to the team: .+/,
    );
    expect(line({ kind: 'handover', member: 'Farah Aziz' })).toBe(
      'Jee Fong handed Farah Aziz’s question to the team',
    );
  });

  it('says the loop guard paused the AI', () => {
    expect(line({ kind: 'paused', member: null })).toBe('AI paused: many answers in a row');
  });
});

import type { ChatEvent, Message, Note } from '@ezychat/shared';

export type TimelineItem =
  | { kind: 'day'; key: string; /** Local midnight (epoch ms) of that day. */ date: number }
  | { kind: 'message'; key: string; at: number; message: Message }
  | { kind: 'event'; key: string; at: number; event: ChatEvent }
  | { kind: 'note'; key: string; at: number; note: Note };

type Entry = Exclude<TimelineItem, { kind: 'day' }>;

// For equal timestamps: events first, then messages, then notes.
const kindOrder: Record<Entry['kind'], number> = { event: 0, message: 1, note: 2 };

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function tieKey(e: Entry): string {
  if (e.kind === 'message') return e.message.id;
  if (e.kind === 'event') return String(e.event.id).padStart(12, '0');
  return String(e.note.id).padStart(12, '0');
}

/**
 * Merge messages, chat events and notes into one ascending timeline, inserting a
 * `{ kind: 'day' }` separator before the first item of every local calendar day.
 */
export function buildTimeline(
  messages: Message[],
  events: ChatEvent[],
  notes: Note[],
): TimelineItem[] {
  const entries: Entry[] = [
    ...messages.map(
      (m): Entry => ({ kind: 'message', key: `m:${m.clientId ?? m.id}`, at: m.timestamp, message: m }),
    ),
    ...events.map((e): Entry => ({ kind: 'event', key: `e:${e.id}`, at: e.at, event: e })),
    ...notes.map((n): Entry => ({ kind: 'note', key: `n:${n.id}`, at: n.createdAt, note: n })),
  ];

  entries.sort(
    (a, b) =>
      a.at - b.at ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      (tieKey(a) < tieKey(b) ? -1 : tieKey(a) > tieKey(b) ? 1 : 0),
  );

  const out: TimelineItem[] = [];
  const seen = new Set<string>();
  let lastDay: number | null = null;
  for (const e of entries) {
    // Guard against duplicate keys (e.g. an optimistic row and its server copy).
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    const day = startOfLocalDay(e.at);
    if (day !== lastDay) {
      out.push({ kind: 'day', key: `d:${day}`, date: day });
      lastDay = day;
    }
    out.push(e);
  }
  return out;
}

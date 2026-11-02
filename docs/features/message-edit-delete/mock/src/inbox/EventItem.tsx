import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import type { ChatEvent, Note } from '@ezychat/shared';
import { i18n } from '@/i18n';
import { formatTime } from '../lib/format';
import { handoffReasonLabel, isHandoffReason } from '../lib/ai-handoff';
import type { Directory } from './useDirectory';

function payloadUserId(payload: Record<string, unknown>): number | null {
  for (const k of ['assignedTo', 'to', 'userId', 'assigneeId']) {
    const v = payload[k];
    if (typeof v === 'number') return v;
  }
  return null;
}

/** Localized sentence for a chat event, in the active UI language. */
export function describeEvent(e: ChatEvent, dir: Directory): string {
  const actor =
    e.actorId == null
      ? i18n.t('inbox:events.system')
      : (dir.nameOf(e.actorId, { youLabel: true }) ?? i18n.t('inbox:events.someone'));
  // An AI hand-off records why it gave the chat to the team.
  const handoff = isHandoffReason(e.payload.handoff) ? handoffReasonLabel(e.payload.handoff) : null;
  switch (e.type) {
    case 'assigned': {
      const to = payloadUserId(e.payload);
      if (handoff && to != null && to !== e.actorId)
        return i18n.t('inbox:events.handedTo', {
          actor,
          assignee: dir.nameOf(to, { youLabel: true }) ?? i18n.t('inbox:events.someoneLower'),
          reason: handoff,
        });
      if (to != null && to === e.actorId)
        return e.payload.reason === 'reply'
          ? i18n.t('inbox:events.tookByReply', { actor })
          : i18n.t('inbox:events.took', { actor });
      const assignee =
        to == null ? i18n.t('inbox:events.someoneLower') : dir.nameOf(to, { youLabel: true });
      return i18n.t('inbox:events.assigned', { actor, assignee });
    }
    case 'unassigned':
      if (handoff) return i18n.t('inbox:events.handedToTeam', { actor, reason: handoff });
      return e.payload.reason === 'resolved'
        ? i18n.t('inbox:events.returned')
        : i18n.t('inbox:events.unassigned', { actor });
    case 'resolved':
      return i18n.t('inbox:events.resolved', { actor });
    case 'reopened':
      return e.actorId == null
        ? i18n.t('inbox:events.reopenedByMessage')
        : i18n.t('inbox:events.reopened', { actor });
    case 'ai_tool_used': {
      // Proposed (ai-groups): the agent's lines in a group (answered, hand-over, loop guard).
      const group = e.payload.group;
      if (group === 'paused') return i18n.t('inbox:events.mockGroupPaused');
      if (group === 'answered' || group === 'handover') {
        const member = String(e.payload.member ?? '');
        if (group === 'handover')
          return i18n.t('inbox:events.mockGroupHandover', {
            actor,
            member,
            reason: handoff ?? handoffReasonLabel('needs_action'),
          });
        return e.payload.followUp
          ? i18n.t('inbox:events.mockGroupFollowUp', { actor, member })
          : i18n.t('inbox:events.mockGroupAnswered', { actor, member });
      }
      // Proposed (google-calendar): "AI checked free times" / "AI booked Fri 31 Oct, 7:30–9:00 pm".
      const source = String(e.payload.sourceLabel ?? '');
      const booking = e.payload.booking as { start?: string; end?: string } | undefined;
      if (booking?.start && booking.end) {
        const day = new Intl.DateTimeFormat(i18n.language, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }).format(new Date(booking.start));
        const time = (iso: string) =>
          new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }).format(
            new Date(iso),
          );
        return i18n.t('inbox:events.mockBooked', {
          when: `${day}, ${time(booking.start)}–${time(booking.end)}`,
          source,
        });
      }
      if (e.payload.calendar === 'free_times')
        return i18n.t('inbox:events.mockCheckedFree', { source });
      return i18n.t('inbox:events.mockLookedUp', { title: String(e.payload.title ?? ''), source });
    }
    default:
      // Other event types added after this reference are not part of this mock.
      return String(e.type);
  }
}

/** Centered chip for assignment / status events. */
export function EventItem({ event, directory }: { event: ChatEvent; directory: Directory }) {
  useTranslation(); // re-render on language change
  return (
    <div className="flex justify-center px-3 py-1">
      <span className="max-w-[90%] rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
        {describeEvent(event, directory)} · {formatTime(event.at)}
      </span>
    </div>
  );
}

/** Amber internal-note card shown inline in the timeline (never looks like a bubble). */
export function NoteItem({ note, directory }: { note: Note; directory: Directory }) {
  const { t } = useTranslation('inbox');
  return (
    <div className="flex justify-center px-3 py-1">
      <div className="w-full max-w-md rounded-lg border border-dashed border-note-border bg-note px-3 py-2 text-sm text-note-foreground shadow-sm">
        <p className="mb-0.5 flex items-center gap-1.5 text-xs font-semibold">
          <Lock className="size-3 shrink-0" aria-hidden="true" />
          <span>{t('events.internalNote')}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{directory.nameOf(note.userId, { youLabel: true })}</span>
          <span className="ml-auto shrink-0 font-normal opacity-80">
            {formatTime(note.createdAt)}
          </span>
        </p>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{note.body}</p>
      </div>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { AiToolUsedPayload, type ChatEvent, type Note } from '@ezychat/shared';
import { i18n } from '@/i18n';
import { formatTime, formatTimeRange } from '../lib/format';
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
      // Title and source come from the extension; anything else in the payload is ignored.
      const used = AiToolUsedPayload.safeParse(e.payload);
      if (!used.success) return '';
      // A WhatsApp group: the AI answered a tag or a quote, handed it over, or the loop guard paused it.
      const group = used.data.group;
      if (group) {
        if (group.kind === 'paused') return i18n.t('inbox:events.aiGroupPaused');
        const member = group.member ?? i18n.t('inbox:events.aiGroupMember');
        if (group.kind === 'handover')
          return handoff
            ? i18n.t('inbox:events.aiGroupHandover', { actor, member, reason: handoff })
            : i18n.t('inbox:events.aiGroupHandoverNoReason', { actor, member });
        return group.quoted
          ? i18n.t('inbox:events.aiGroupQuoted', { actor, member })
          : i18n.t('inbox:events.aiGroupAnswered', { actor, member });
      }
      const source = used.data.sourceLabel;
      // Google Calendar: "AI checked free times" / "AI booked Fri, 30 Oct, 7:30–9:00 pm".
      const calendar = used.data.calendar;
      if (calendar?.action === 'checked') return i18n.t('inbox:events.calendarChecked', { source });
      if (calendar?.action === 'booked') {
        const when =
          calendar.start && calendar.end ? formatTimeRange(calendar.start, calendar.end) : '';
        return when
          ? i18n.t('inbox:events.calendarBooked', { when, source })
          : i18n.t('inbox:events.calendarBookedNoTime', { source });
      }
      // Google Sheets: "AI added a row to Claims".
      if (used.data.sheet?.action === 'row_added')
        return i18n.t('inbox:events.sheetRowAdded', { tab: used.data.sheet.tab, source });
      // Google Drive: "AI saved a file to Google Drive". Reads use the generic look-up line.
      if (used.data.drive?.action === 'saved')
        return i18n.t('inbox:events.driveFileSaved', { source });
      return i18n.t('inbox:events.aiToolUsed', { title: used.data.title, source });
    }
  }
}

/** Centered chip for assignment / status events. */
export function EventItem({ event, directory }: { event: ChatEvent; directory: Directory }) {
  useTranslation(); // re-render on language change
  const text = describeEvent(event, directory);
  if (!text) return null;
  return (
    <div className="flex justify-center px-3 py-1">
      <span className="max-w-[90%] rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
        {text} · {formatTime(event.at)}
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

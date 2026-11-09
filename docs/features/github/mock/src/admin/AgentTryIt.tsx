import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, CalendarSearch, Lock, ShieldCheck, Users } from 'lucide-react';
import { AI_TRY_QUESTION_CHARACTERS } from '@ezychat/shared';
import { useAiMember } from '../api/ai';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { handoffReasonLabel } from '@/lib/ai-handoff';
import type { AgentPreset, MockAgentItem } from '../mock/agents';
import { bookingFor, demoFreeSlots, useGoogleCalendar } from '../mock/googleCalendar';
import { connectionReady } from './ai-status';
import { Field, Pending } from './adminUi';

type Decision = 'answer' | 'ask_resolution' | 'handoff';
interface Result {
  action: Decision;
  reply: string;
  usedInternal?: string;
  /** The hand-over rule line (from this page's texts, also unsaved) that decided. */
  rule?: string;
  safety?: boolean;
  /** Proposed (google-calendar): calendar steps shown as the chat's system lines. */
  calendar?: { checked: boolean; wouldBook: Date | null; offered: Date[]; bookOff: boolean };
  /** Proposed (ai-groups): answered as a group mention (the question it quotes). */
  group?: { question: string };
}

// Proposed (google-calendar): a customer asks to book (English, Malay, Chinese).
const BOOKING =
  /\b(book|booking|reserve|reservation|appointment|table for|tempah|temujanji)\b|预约|订位|预订/i;

// Words that say nothing about the topic (and the "The customer …" frame of every hand-over rule).
const STOP_WORDS = new Set(
  'the and for you your are can with from this that our any how what when does have has was not but all its who will would could please there their them they about into than then also just customer customers asks wants want'.split(
    ' ',
  ),
);
const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
const lines = (text: string) =>
  text
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[-•*#\s]+/, '').trim())
    .filter((line) => line.length > 3 && !line.endsWith(':'));
/** Shared topic words; "order" also matches "orders". */
const score = (line: string, asked: Set<string>) =>
  [...words(line)].filter((w) =>
    [...asked].some(
      (q) => q === w || (q.length > 3 && w.length > 3 && (w.startsWith(q) || q.startsWith(w))),
    ),
  ).length;
const best = <T extends { line: string }>(entries: T[], asked: Set<string>) =>
  entries
    .map((entry) => ({ ...entry, score: score(entry.line, asked) }))
    .sort((a, b) => b.score - a.score)[0];

/** The line of `items` that shares the most words with the question (like the runner's demo answer). */
const bestLine = (items: MockAgentItem[], asked: Set<string>) =>
  best(
    items.flatMap((item) => lines(item.text).map((line) => ({ item, line }))),
    asked,
  );

// Customer text that asks for the hidden setup (a prompt-injection attempt in the demo).
const PROBE =
  /instruction|prompt|system message|ignore (all|the|previous|your)|reveal|internal|hidden rule|developer/i;

/**
 * Proposed (custom-agents): Try it with this page's draft name, role and hand-over rules (also unsaved)
 * and the agent's SAVED items. Mock: a deterministic answer in the browser, no model call: a hand-over
 * rule line that matches the question better than any customer-facing line hands over and names the
 * rule; a blank role gets a note. Production: `POST /api/ai/agents/:agentId/try` with the draft, the
 * guardrails first and the Internal items marked.
 */
export function AgentTryIt({
  agentId,
  name,
  preset,
  instructions,
  handoffRules,
  items,
  onAnswered,
}: Readonly<{
  /** Proposed (google-calendar): the agent whose Bookings settings Try it uses. */
  agentId?: string;
  name: string;
  preset: AgentPreset;
  instructions: string;
  handoffRules: string;
  items: MockAgentItem[];
  /** Round 2: the page marks its Next steps row "Try a test question" done. */
  onAnswered?: () => void;
}>) {
  const { t } = useTranslation('admin');
  const status = useAiMember();
  const ready = status.data ? connectionReady(status.data) : false;
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // Proposed (ai-groups): ask as a member who @mentioned the business in a group.
  const [asGroup, setAsGroup] = useState(false);
  const groupSwitchId = useId();
  const groupMember = t('mockGroups.try.member');
  const calendar = useGoogleCalendar();
  const booking = agentId === undefined ? null : bookingFor(calendar.data, agentId);
  const calendarOn = booking !== null && calendar.data?.state === 'connected' && booking.checkFree;
  const when = (date: Date) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  const decisionLabels: Record<Decision, string> = {
    answer: t('ai.try.decision.answer'),
    ask_resolution: t('ai.try.decision.ask_resolution'),
    handoff: t('ai.try.decision.handoff'),
  };

  /** Proposed (google-calendar): offer 3 free times; "pick" = the customer took the first one. */
  const bookingAnswer = (pick: boolean): Result => {
    const offered = demoFreeSlots(booking!);
    if (!pick)
      return {
        action: 'answer',
        reply: t('mockCalendar.try.offer', {
          times: offered.map(when).join(', '),
        }),
        calendar: { checked: true, wouldBook: null, offered, bookOff: !booking!.book },
      };
    if (!booking!.book)
      return {
        action: 'handoff',
        reply: t('mockCalendar.try.teamConfirms'),
        calendar: { checked: false, wouldBook: null, offered, bookOff: true },
      };
    return {
      action: 'answer',
      reply: t('mockCalendar.try.booked', { time: when(offered[0]!) }),
      calendar: { checked: false, wouldBook: offered[0]!, offered, bookOff: false },
    };
  };

  const answer = (text: string): Result => {
    if (calendarOn && BOOKING.test(text)) return bookingAnswer(false);
    if (PROBE.test(text))
      return {
        action: 'answer',
        reply: preset === 'faq' ? t('mockAgents.try.refuseFaq') : t('mockAgents.try.refuse'),
        safety: true,
      };
    const asked = words(text);
    const open = bestLine(
      items.filter((i) => !i.internal),
      asked,
    );
    const openScore = open?.score ?? 0;
    const hidden = bestLine(
      items.filter((i) => i.internal),
      asked,
    );
    // An Internal item decides only when it fits the question strictly better than any open line.
    if (hidden && hidden.score > 0 && hidden.score > openScore)
      return {
        action: 'handoff',
        reply: t('mockAgents.try.internalHandoff'),
        usedInternal: hidden.item.name,
      };
    const rule = best(
      lines(handoffRules).map((line) => ({ line })),
      asked,
    );
    if (rule && rule.score > 0 && rule.score > openScore)
      return { action: 'handoff', reply: t('mockAgents.try.missing'), rule: rule.line };
    if (open && open.score > 0)
      return { action: 'ask_resolution', reply: `${open.line} ${t('mockAgents.try.resolve')}` };
    return { action: 'handoff', reply: t('mockAgents.try.missing') };
  };

  /**
   * Proposed (ai-groups): the same decision, said as a group answer: it names the member, never asks
   * "Does that answer your question?" (the AI does not own the group), hands over with the group
   * line, and only looks things up (no booking from a group).
   */
  const groupAnswer = (text: string): Result => {
    const r = answer(text);
    const first = groupMember.split(/\s+/)[0] ?? groupMember;
    const group = { question: text };
    if (r.action === 'handoff') return { ...r, reply: t('mockGroups.try.handover'), group };
    const plain = r.reply.replace(t('mockAgents.try.resolve'), '').trim();
    return {
      ...r,
      action: 'answer',
      reply: t('mockGroups.try.greeting', { first, answer: plain }),
      calendar: r.calendar ? { ...r.calendar, bookOff: true } : undefined,
      group,
    };
  };

  const submit = () => {
    const text = question.trim();
    if (!text || pending) return;
    setPending(true);
    setResult(null);
    window.setTimeout(() => {
      setResult(asGroup ? groupAnswer(text) : answer(text));
      setPending(false);
      onAnswered?.();
    }, 600);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="agent-try">
      <p className="text-sm text-muted-foreground">{t('mockAgents.try.hint')}</p>
      {!instructions.trim() && (
        <p className="text-sm text-muted-foreground" data-testid="try-no-role">
          {t('mockAgents.try.noRole')}
        </p>
      )}
      {!ready && status.data && (
        <Banner tone="warning">{t('mockAgents.try.needsConnection')}</Banner>
      )}
      <Field label={t('ai.try.label')} hint={t('ai.try.enterHint')}>
        {(p) => (
          <Textarea
            {...p}
            rows={2}
            value={question}
            maxLength={AI_TRY_QUESTION_CHARACTERS}
            placeholder={t('ai.try.placeholder')}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              submit();
            }}
          />
        )}
      </Field>
      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2">
        <div className="min-w-0">
          <Label htmlFor={groupSwitchId}>{t('mockGroups.try.group')}</Label>
          <p className="mt-1 text-sm text-muted-foreground">{t('mockGroups.try.groupHint')}</p>
        </div>
        <Label
          htmlFor={groupSwitchId}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
        >
          <Switch
            id={groupSwitchId}
            data-testid="try-group"
            checked={asGroup}
            onCheckedChange={(on) => {
              setAsGroup(on);
              setResult(null);
            }}
          />
        </Label>
      </div>
      <Button
        type="button"
        size="touch"
        className="self-start"
        disabled={!question.trim() || pending || !ready}
        onClick={submit}
      >
        <Pending show={pending} />
        {t('ai.try.ask')}
      </Button>
      <div aria-live="polite" className="flex flex-col gap-2">
        {result && (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline">{decisionLabels[result.action]}</Badge>
              <span className="text-xs text-muted-foreground">
                {t('mockAgents.try.answeredAs', { name })} · {t('mockAgents.try.simulated')}
              </span>
            </div>
            {result.action === 'handoff' && !result.usedInternal && !result.rule && (
              <p className="mb-2 text-xs text-muted-foreground">
                {t('ai.try.handoffReason', {
                  reason: handoffReasonLabel(result.calendar ? 'needs_action' : 'missing_facts'),
                })}
              </p>
            )}
            {result.rule && (
              <p className="mb-2 text-xs break-words text-muted-foreground">
                {t('mockAgents.try.ruleMatched', { rule: result.rule })}
              </p>
            )}
            {result.calendar?.checked && (
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarSearch aria-hidden className="size-3.5 shrink-0" />
                {t('mockCalendar.try.checked')}
              </p>
            )}
            {result.calendar?.wouldBook && (
              <p
                className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground"
                data-testid="try-would-book"
              >
                <CalendarCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {t('mockCalendar.try.wouldBook', { time: when(result.calendar.wouldBook) })}
              </p>
            )}
            {result.group && (
              <>
                <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users aria-hidden className="size-3.5 shrink-0" />
                  {t('mockGroups.try.inGroup', { member: groupMember })} ·{' '}
                  {t('mockGroups.try.notSent')}
                </p>
                <div
                  className="mb-2 rounded-md border-l-2 border-primary bg-surface px-2 py-1 text-xs"
                  data-testid="try-group-quote"
                >
                  <p className="font-semibold text-primary">{groupMember}</p>
                  <p className="break-words text-muted-foreground">{result.group.question}</p>
                </div>
              </>
            )}
            <p className="break-words whitespace-pre-wrap">{result.reply}</p>
            {result.group && result.calendar?.checked && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('mockGroups.try.lookupsOnly', { name })}
              </p>
            )}
            {!result.group &&
              result.calendar &&
              !result.calendar.wouldBook &&
              result.calendar.checked && (
                <div className="mt-3 flex flex-col items-start gap-1">
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    onClick={() => setResult(bookingAnswer(true))}
                  >
                    {t('mockCalendar.try.pickFirst')}
                  </Button>
                  {result.calendar.bookOff && (
                    <span className="text-xs text-muted-foreground">
                      {t('mockCalendar.try.bookOffNote')}
                    </span>
                  )}
                </div>
              )}
            {result.usedInternal && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {t('mockAgents.try.usedInternal', { name: result.usedInternal })}
              </p>
            )}
            {result.safety && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
                {t('mockAgents.try.safety')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

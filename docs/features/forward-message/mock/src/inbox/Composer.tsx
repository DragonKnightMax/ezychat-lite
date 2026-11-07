import type React from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Lock,
  MessageSquareText,
  Mic,
  Paperclip,
  SendHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type { GroupMember, QuickReply } from '@ezychat/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/api/client';
import {
  completionReady,
  fetchCompletion,
  fetchSuggestions,
  useReplySuggestionsState,
  type ReplySuggestion,
} from '@/mock/replySuggestions';
import { matchPhrase, notePhraseUsed, usePhraseList } from '@/mock/phrases';
import { useQueryClient } from '@tanstack/react-query';
import {
  addTeamWord,
  applyIssues,
  teamWordsKey,
  useGrammarState,
  type GrammarIssue,
} from '@/mock/grammar';
import { GrammarCard, GrammarFixButton, GrammarMarks, useGrammarCheck } from './GrammarFix';
import { QuickReplyPicker, filterQuickReplies } from './QuickReplyPicker';
import { MentionPicker } from './MentionPicker';
import {
  MAX_TAGS,
  filterMembers,
  insertTag,
  mentionQuery,
  toWhatsApp,
  type DraftTag,
} from './mentions';
import { ReplySuggestions, type SuggestionStrip } from './ReplySuggestions';
import { EmojiPicker } from './EmojiPicker';
import { VoiceNoteBar, useVoiceNote } from './VoiceNote';
import { voiceSupport } from '@/lib/voice-recorder';
import './composer.css';

export interface ComposerProps {
  quickReplies: QuickReply[];
  /** Proposed (group-mentions): `mentions` are the tagged members' addresses (groups only). */
  onSend(text: string, mentions?: string[], shown?: string): void;
  /** Attach button: file + caption (current text, if any). */
  onAttach(file: File, caption?: string): void;
  /**
   * Mic button (shown while the box is empty): a recorded Ogg/Opus voice note with the clientId it
   * keeps across retries. Resolve once it is uploaded; reject to keep it in Review.
   */
  onVoiceNote?(file: File, clientId: string): void | Promise<void>;
  /** Called while typing; throttled to once per 2s. */
  onTyping?(): void;
  /**
   * Called before every send/attach. Resolve `false` to cancel (the text is kept).
   * Used for the "Assigned to X — reply anyway?" confirmation.
   */
  confirmSend?(): boolean | Promise<boolean>;
  disabled?: boolean;
  placeholder?: string;
  /** The message being replied to: shown in a bar above the box until sent or cancelled. */
  replyTo?: { id: string; author: string; preview: string } | null;
  onCancelReply?(): void;
  /**
   * Proposed (ai-reply-suggestions): AI help in this chat (direct chats only). The chips clear when
   * `lastCustomerMessageId` changes (a new customer message).
   */
  aiSuggest?: { chatJid: string; lastCustomerMessageId: string | null; isAdmin: boolean } | null;
  /**
   * Proposed (group-mentions): a group whose connection can tag members. `members` is null while
   * loading. Absent: no `@` picker (direct chats, Business API groups).
   */
  mentions?: { members: GroupMember[] | null; error: boolean; onOpen(): void } | null;
}

const TYPING_THROTTLE_MS = 2_000;
/** Completion waits for a short pause after a full word, so typing makes no model calls. */
const COMPLETION_PAUSE_MS = 500;
const MAX_HEIGHT_PX = 160;
/** How long "3 fixed · Undo" stays after Fix all. */
const UNDO_MS = 5_000;

/** The grey text still ahead of the caret (type-through, PR #188). */
function ghostAhead(ghost: { for: string; text: string } | null, text: string): string {
  if (!ghost || !text.startsWith(ghost.for)) return '';
  const full = ghost.for + ghost.text;
  return full.length > text.length && full.startsWith(text) ? full.slice(text.length) : '';
}

/** Touch devices: Enter inserts a newline, the Send button sends. */
function isCoarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** `/pri` → `pri`; anything else (incl. text with spaces) → null. */
function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? (m[1] ?? '') : null;
}

export function Composer({
  quickReplies,
  onSend,
  onAttach,
  onVoiceNote,
  onTyping,
  confirmSend,
  disabled = false,
  placeholder,
  replyTo = null,
  onCancelReply,
  aiSuggest = null,
  mentions = null,
}: ComposerProps) {
  const { t } = useTranslation('inbox');
  const [text, setText] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  // Proposed (group-mentions): tags picked in this draft, and where the caret is.
  const [tags, setTags] = useState<DraftTag[]>([]);
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null);
  const [browseReplies, setBrowseReplies] = useState(false);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const repliesButtonRef = useRef<HTMLButtonElement>(null);
  const lastTyping = useRef(0);
  const emojiSelection = useRef({ start: 0, end: 0 });
  const pendingCaret = useRef<number | null>(null);
  const pickerId = useId();
  const unavailableId = useId();
  const [coarsePointer] = useState(isCoarsePointer);
  const [voiceSupported] = useState(voiceSupport);
  const voice = useVoiceNote(async (file, clientId) => {
    if (!onVoiceNote || disabled || !(await confirmed())) return false;
    await onVoiceNote(file, clientId);
    return true;
  });

  // Proposed (ai-reply-suggestions): chips after "Suggest reply" and grey completion text.
  const suggestState = useReplySuggestionsState();
  const aiMode = aiSuggest ? (suggestState.data?.composer ?? 'off') : 'off';
  const [strip, setStrip] = useState<SuggestionStrip | null>(null);
  const [pendingPick, setPendingPick] = useState<ReplySuggestion | null>(null);
  const [ghost, setGhost] = useState<{ for: string; text: string; phraseId?: number } | null>(null);
  const suggestAbort = useRef<AbortController | null>(null);
  /** The one completion request in flight (the app since the speed fix, PR #188). */
  const completing = useRef<{ typed: string; cancel: AbortController } | null>(null);
  const [completionDone, setCompletionDone] = useState(0);
  const dismissedFor = useRef<string | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostText = ghostAhead(ghost, text);
  // Proposed (ai-phrase-dictionary): the team's phrase list, matched locally on every key.
  const phraseList = usePhraseList(aiMode === 'on');

  // Proposed (grammar-fix): Fix English. Underlines after a pause, a card per word, Fix all.
  const grammarState = useGrammarState();
  const spellingMode = grammarState.data?.spelling ?? 'off';
  const grammarMode = grammarState.data?.grammar ?? 'off';
  const grammar = useGrammarCheck(text, {
    spelling: spellingMode === 'on' && !disabled,
    grammar: grammarMode === 'on' && !disabled,
  });
  const queryClient = useQueryClient();
  const marksRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ id: string; left: number; bottom: number } | null>(null);
  const cardHover = useRef(false);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undo, setUndo] = useState<{ before: string; after: string; count: number } | null>(null);
  const cardIssue = card ? grammar.issues.find((i) => i.id === card.id) : undefined;

  /** The underlined word under a point of the box (the marks layer lets the pointer through). */
  function issueAt(x: number, y: number): string | null {
    for (const span of marksRef.current?.querySelectorAll<HTMLElement>('[data-issue]') ?? [])
      for (const r of span.getClientRects())
        if (x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 4)
          return span.dataset.issue ?? null;
    return null;
  }

  function openCard(id: string) {
    const span = marksRef.current?.querySelector<HTMLElement>(`[data-issue="${CSS.escape(id)}"]`);
    const box = boxRef.current?.getBoundingClientRect();
    const rect = span?.getClientRects()[0];
    if (!box || !rect) return;
    if (cardTimer.current) clearTimeout(cardTimer.current);
    setCard({
      id,
      left: Math.max(0, Math.min(rect.left - box.left - 8, box.width - 220)),
      bottom: box.bottom - rect.top + 6,
    });
  }

  function closeCardSoon() {
    if (cardTimer.current) clearTimeout(cardTimer.current);
    cardTimer.current = setTimeout(() => {
      if (!cardHover.current) setCard(null);
    }, 250);
  }

  function acceptIssue(issue: GrammarIssue) {
    const next = applyIssues(text, [issue]);
    pendingCaret.current = issue.start + (issue.replacement ?? issue.original).length;
    setCard(null);
    setText(next);
  }

  function addWord(issue: GrammarIssue) {
    setCard(null);
    void addTeamWord(issue.original).then((data) => queryClient.setQueryData(teamWordsKey, data));
  }

  function fixAll() {
    const count = grammar.fixable.length;
    if (!count) return;
    const next = applyIssues(text, grammar.fixable);
    pendingCaret.current = next.length;
    setCard(null);
    setUndo({ before: text, after: next, count });
    setText(next);
  }

  function undoFix() {
    if (!undo) return;
    pendingCaret.current = undo.before.length;
    setText(undo.before);
    setUndo(null);
  }

  // "3 fixed · Undo" goes after a few seconds, or as soon as the teammate types on.
  useEffect(() => {
    if (!undo) return;
    if (text !== undo.after) {
      setUndo(null);
      return;
    }
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo, text]);
  useEffect(() => {
    if (card && !cardIssue) setCard(null);
  }, [card, cardIssue]);

  function closeSuggestions() {
    suggestAbort.current?.abort();
    setStrip(null);
    setPendingPick(null);
  }

  async function suggest() {
    if (!aiSuggest) return;
    suggestAbort.current?.abort();
    const cancel = new AbortController();
    suggestAbort.current = cancel;
    setPendingPick(null);
    setStrip({ phase: 'loading' });
    try {
      const result = await fetchSuggestions(aiSuggest.chatJid, cancel.signal);
      if (!cancel.signal.aborted) setStrip({ phase: 'ready', result });
    } catch (err) {
      if (!cancel.signal.aborted) setStrip({ phase: 'error', message: errorMessage(err) });
    }
  }

  function applyDraft(s: ReplySuggestion) {
    setPendingPick(null);
    setGhost(null);
    pendingCaret.current = s.text.length;
    setText(s.text);
    setBrowseReplies(false);
    setPickerDismissed(true);
  }

  function pick(s: ReplySuggestion) {
    // Typed work is never lost: replacing it needs a confirm.
    if (text.trim()) setPendingPick(s);
    else applyDraft(s);
  }

  function acceptGhost() {
    if (!ghostText) return;
    if (ghost?.phraseId) notePhraseUsed(ghost.phraseId);
    const next = text + ghostText;
    pendingCaret.current = next.length;
    setGhost(null);
    setText(next);
  }

  // A new customer message makes the chips out of date.
  const lastCustomer = aiSuggest?.lastCustomerMessageId ?? null;
  useEffect(() => {
    closeSuggestions();
  }, [lastCustomer]);

  // Completion. 1) Proposed (ai-phrase-dictionary): a phrase from the team's list shows at once
  // (local match, no model, no pause). 2) Otherwise the fast model after a full word and a short
  // pause, one request at a time that survives typing while the text still extends it
  // (type-through, PR #188).
  const suggestJid = aiSuggest?.chatJid ?? null;
  const hasGhost = ghostText !== '';
  useEffect(() => {
    const running = completing.current;
    if (running && (aiMode !== 'on' || !text.startsWith(running.typed))) {
      running.cancel.abort();
      completing.current = null;
    }
    if (hasGhost || aiMode !== 'on' || !suggestJid || dismissedFor.current === text) return;
    const el = areaRef.current;
    if (el && el.selectionStart !== text.length) return;
    const phrase = phraseList.data ? matchPhrase(phraseList.data, text) : null;
    if (phrase) {
      setGhost({ for: text, text: phrase.rest, phraseId: phrase.id });
      return;
    }
    if (completing.current || !completionReady(text)) return;
    const timer = setTimeout(() => {
      const cancel = new AbortController();
      const typed = text;
      completing.current = { typed, cancel };
      fetchCompletion(suggestJid, typed, cancel.signal)
        .then(({ completion, phraseId }) => {
          if (!cancel.signal.aborted && completion)
            setGhost({ for: typed, text: completion, phraseId });
        })
        .catch(() => undefined)
        .finally(() => {
          if (completing.current?.cancel !== cancel) return;
          completing.current = null;
          setCompletionDone((n) => n + 1);
        });
    }, COMPLETION_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, aiMode, suggestJid, hasGhost, completionDone, phraseList.data]);
  useEffect(() => () => completing.current?.cancel.abort(), []);
  useEffect(() => {
    setGhost(null);
    dismissedFor.current = null;
  }, [suggestJid]);

  const query = browseReplies ? '' : slashQuery(text);
  const matches = query == null ? [] : filterQuickReplies(quickReplies, query);
  const quickOpen = query != null && !pickerDismissed && quickReplies.length > 0;
  // Proposed (group-mentions): `@name` right before the caret opens the member picker.
  const mention = mentions && !quickOpen ? mentionQuery(text, caret) : null;
  const mentionOpen = !!mention && mentionDismissed !== mention.start;
  const memberMatches =
    mentionOpen && mentions?.members ? filterMembers(mentions.members, mention!.query) : [];
  const pickerOpen = quickOpen || mentionOpen;
  const onOpenMentions = mentions?.onOpen;
  useEffect(() => {
    if (mentionOpen) onOpenMentions?.();
  }, [mentionOpen, onOpenMentions]);
  useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Choosing Reply puts the cursor in the box, ready to type.
  const replyId = replyTo?.id;
  useEffect(() => {
    if (replyId) areaRef.current?.focus();
  }, [replyId]);

  // scrollHeight includes padding, but not borders. Include the borders so a
  // single line does not overflow by two pixels and show a native scrollbar.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    function resize() {
      if (!el) return;
      el.style.height = 'auto';
      const style = getComputedStyle(el);
      const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const ghostHeight = ghostRef.current?.scrollHeight ?? 0;
      const height =
        Math.max(el.scrollHeight, ghostHeight) + (Number.isFinite(borders) ? borders : 0);
      el.style.height = `${Math.min(height, MAX_HEIGHT_PX)}px`;
      el.style.overflowY = height > MAX_HEIGHT_PX ? 'auto' : 'hidden';
    }
    resize();
    if (pendingCaret.current != null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    // Reflow a draft when the pane is resized or the device rotates.
    if (typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        resize();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, ghostText]);

  function insertEmoji(emoji: string) {
    const { start, end } = emojiSelection.current;
    const next = text.slice(0, start) + emoji + text.slice(end);
    const caret = start + emoji.length;
    if (next === text) {
      areaRef.current?.focus();
      areaRef.current?.setSelectionRange(caret, caret);
    } else {
      pendingCaret.current = caret;
    }
    setText(next);
    setBrowseReplies(false);
    setPickerDismissed(false);
    emitTyping(next);
  }

  function insertReply(r: QuickReply) {
    const next =
      browseReplies && slashQuery(text) == null && text.trim() ? `${text}\n${r.body}` : r.body;
    setText(next);
    setBrowseReplies(false);
    setPickerDismissed(true);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  }

  /** Proposed (group-mentions): put the picked member's `@Name` tag in place of `@query`. */
  function insertMember(member: GroupMember) {
    if (!mention) return;
    const r = insertTag(text, mention.start, caret, member);
    setText(r.text);
    setCaret(r.caret);
    pendingCaret.current = r.caret;
    setTags((list) =>
      list.some((tg) => tg.jid === r.tag.jid && tg.label === r.tag.label) || list.length >= MAX_TAGS
        ? list
        : [...list, r.tag],
    );
    emitTyping(r.text);
  }

  /** Proposed (group-mentions): the cursor moved (click, arrows): re-read the `@query` under it. */
  function trackCaret(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(e.currentTarget.selectionStart ?? 0);
  }

  async function confirmed(): Promise<boolean> {
    if (!confirmSend) return true;
    try {
      return await confirmSend();
    } catch {
      return false;
    }
  }

  async function submit() {
    const value = text.trim();
    if (!value || disabled || busy) return;
    setBusy(true);
    try {
      if (!(await confirmed())) return;
      // Proposed (group-mentions): `@Name` tags go out as WhatsApp's `@<number>` + mentions.
      const out = mentions && tags.length ? toWhatsApp(value, tags) : null;
      if (out?.mentions.length) onSend(out.text, out.mentions, value);
      else onSend(value);
      setTags([]);
      setMentionDismissed(null);
      setText('');
      setGhost(null);
      setUndo(null);
      closeSuggestions();
      setBrowseReplies(false);
      setPickerDismissed(false);
    } finally {
      setBusy(false);
      areaRef.current?.focus();
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || disabled) return;
    if (!(await confirmed())) return;
    const caption = text.trim();
    onAttach(file, caption || undefined);
    setText('');
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setText(v);
    setCaret(e.target.selectionStart ?? v.length);
    if (!v) setTags([]);
    setBrowseReplies(false);
    if (slashQuery(v) == null) setPickerDismissed(false);
    emitTyping(v);
  }

  function emitTyping(value: string) {
    if (onTyping && value.length > 0) {
      const now = Date.now();
      if (now - lastTyping.current >= TYPING_THROTTLE_MS) {
        lastTyping.current = now;
        onTyping();
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    // Proposed (grammar-fix): Ctrl+J / ⌘J fixes every underlined mistake at once.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      fixAll();
      return;
    }
    if (card && e.key === 'Escape') {
      e.preventDefault();
      setCard(null);
      return;
    }
    if (ghostText && e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    if (ghostText && e.key === 'Escape') {
      e.preventDefault();
      dismissedFor.current = text;
      setGhost(null);
      return;
    }
    // Proposed (group-mentions): the member picker drives ↑/↓/Enter/Tab/Escape while it is open.
    if (mentionOpen && memberMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % memberMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + memberMatches.length) % memberMatches.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const m = memberMatches[Math.min(activeIndex, memberMatches.length - 1)];
        if (m) insertMember(m);
        return;
      }
    }
    if (mentionOpen && e.key === 'Escape') {
      e.preventDefault();
      setMentionDismissed(mention!.start);
      return;
    }
    if (quickOpen && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const r = matches[Math.min(activeIndex, matches.length - 1)];
        if (r) insertReply(r);
        return;
      }
    }
    if (quickOpen && e.key === 'Escape') {
      e.preventDefault();
      setPickerDismissed(true);
      setBrowseReplies(false);
      return;
    }
    if (replyTo && e.key === 'Escape') {
      e.preventDefault();
      onCancelReply?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !coarsePointer) {
      e.preventDefault();
      void submit();
    }
  }

  const canSend = text.trim().length > 0 && !disabled && !busy;
  // An empty box offers the mic instead of Send, as WhatsApp does.
  const offerVoice = !!onVoiceNote && voiceSupported !== 'unsupported' && !text.trim();
  const voiceInsecure = offerVoice && voiceSupported === 'insecure';

  const replyBar = replyTo && (
    <div
      className="mb-1.5 flex min-w-0 items-center gap-2 rounded-md border-l-4 border-primary bg-muted py-1 pl-2.5 pr-1"
      data-testid="reply-bar"
    >
      <div className="min-w-0 flex-1 text-xs">
        <p className="truncate font-semibold text-primary">
          {t('composer.replyingTo', { name: replyTo.author })}
        </p>
        <p className="truncate text-muted-foreground">{replyTo.preview}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('composer.cancelReply')}
        title={t('composer.cancelReply')}
        onClick={() => {
          onCancelReply?.();
          areaRef.current?.focus();
        }}
        className="size-8 shrink-0 text-muted-foreground pointer-coarse:size-11"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );

  if (voice.phase !== 'idle') {
    return (
      <>
        {replyBar}
        <VoiceNoteBar voice={voice} />
      </>
    );
  }

  return (
    <>
      {replyBar}
      {voiceInsecure && (
        <p
          role="note"
          className="mb-1.5 flex items-start gap-2 rounded-lg border border-note-border bg-note px-3 py-2 text-xs text-note-foreground"
        >
          <Lock className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {t('composer.voice.insecure')}
        </p>
      )}
      {strip && (
        <ReplySuggestions
          strip={strip}
          isAdmin={!!aiSuggest?.isAdmin}
          onPick={pick}
          onRetry={() => void suggest()}
          onClose={closeSuggestions}
        />
      )}
      {pendingPick && (
        <div
          role="alertdialog"
          aria-label={t('mockSuggest.replaceTitle')}
          className="mb-1.5 flex flex-wrap items-center gap-2 rounded-lg border bg-muted px-3 py-1.5 text-sm"
          data-testid="replace-confirm"
        >
          <span className="min-w-0 flex-1">{t('mockSuggest.replaceTitle')}</span>
          <Button
            size="sm"
            className="pointer-coarse:min-h-11"
            onClick={() => applyDraft(pendingPick)}
          >
            {t('mockSuggest.replace')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="pointer-coarse:min-h-11"
            onClick={() => setPendingPick(null)}
          >
            {t('mockSuggest.keep')}
          </Button>
        </div>
      )}
      {ghostText && coarsePointer && (
        <div className="mb-1.5 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 rounded-full border-primary/40"
            onMouseDown={(e) => e.preventDefault()}
            onClick={acceptGhost}
            data-testid="accept-completion"
          >
            <Check className="text-primary" aria-hidden="true" />
            {t('mockSuggest.accept')}
          </Button>
        </div>
      )}
      <Popover
        open={pickerOpen}
        onOpenChange={(o) => {
          if (!o) {
            if (mentionOpen) setMentionDismissed(mention!.start);
            setPickerDismissed(true);
            setBrowseReplies(false);
          }
        }}
      >
        <PopoverAnchor asChild>
          <div ref={rowRef} className="flex items-end gap-1.5">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => void onFile(e)}
            />
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label={t('composer.attach')}
              title={t('composer.attach')}
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
              className="rounded-full text-muted-foreground"
            >
              <Paperclip className="size-5" aria-hidden="true" />
            </Button>
            <EmojiPicker
              disabled={disabled}
              onOpen={() => {
                const el = areaRef.current;
                emojiSelection.current = {
                  start: el?.selectionStart ?? text.length,
                  end: el?.selectionEnd ?? text.length,
                };
                setBrowseReplies(false);
                setPickerDismissed(true);
              }}
              onPick={insertEmoji}
            />
            <div ref={boxRef} className="relative min-w-0 flex-1">
              <Textarea
                ref={areaRef}
                aria-label={t('composer.message')}
                aria-autocomplete="list"
                aria-expanded={pickerOpen}
                aria-controls={pickerOpen ? pickerId : undefined}
                rows={1}
                value={text}
                disabled={disabled}
                placeholder={placeholder ?? t('composer.placeholder')}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onSelect={trackCaret}
                onScroll={(e) => {
                  if (marksRef.current) marksRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                // Proposed (grammar-fix): hover (mouse) or tap/click an underlined word for its card.
                onMouseMove={(e) => {
                  if (coarsePointer || !grammar.issues.length) return;
                  const id = issueAt(e.clientX, e.clientY);
                  if (id) {
                    if (id !== card?.id) openCard(id);
                    else if (cardTimer.current) clearTimeout(cardTimer.current);
                  } else if (card) closeCardSoon();
                }}
                onMouseLeave={() => card && closeCardSoon()}
                onClick={(e) => {
                  const id = issueAt(e.clientX, e.clientY);
                  if (id) openCard(id);
                  else setCard(null);
                }}
                // Enter inserts a newline on touch keyboards, so label the key accordingly.
                enterKeyHint={coarsePointer ? 'enter' : 'send'}
                // Proposed (grammar-fix): Fix English marks spelling itself, so the browser's own
                // red underline would mark the same words twice.
                spellCheck={spellingMode !== 'on'}
                className="composer-input field-sizing-fixed min-h-11 w-full min-w-0 resize-none rounded-2xl bg-surface px-3.5 py-2.5 text-base leading-6 md:text-base"
              />
              <GrammarMarks
                ref={marksRef}
                text={text}
                issues={grammar.issues}
                activeId={card?.id ?? null}
              />
              {cardIssue && card && (
                <GrammarCard
                  issue={cardIssue}
                  position={card}
                  touch={coarsePointer}
                  onAccept={() => acceptIssue(cardIssue)}
                  onAddWord={() => addWord(cardIssue)}
                  onIgnore={() => {
                    grammar.ignore(cardIssue);
                    setCard(null);
                  }}
                  onClose={() => setCard(null)}
                  onHover={(inside) => {
                    cardHover.current = inside;
                    if (!inside) closeCardSoon();
                    else if (cardTimer.current) clearTimeout(cardTimer.current);
                  }}
                />
              )}
              {/* The grey text is drawn over the box, never put in it: Send can never send it. */}
              <div
                ref={ghostRef}
                aria-hidden="true"
                className={
                  ghostText
                    ? 'pointer-events-none absolute inset-0 overflow-hidden rounded-2xl border border-transparent px-3.5 py-2.5 text-base leading-6 break-words whitespace-pre-wrap'
                    : 'hidden'
                }
                data-testid="completion-ghost"
              >
                <span className="invisible">{text}</span>
                <span className="text-muted-foreground">{ghostText}</span>
              </div>
              {ghostText && (
                <span className="sr-only" role="status">
                  {t('mockSuggest.completionStatus', { text: ghostText })}
                </span>
              )}
            </div>
            {offerVoice ? (
              <Button
                size="icon-touch"
                aria-label={t('composer.voice.record')}
                title={
                  voiceInsecure ? t('composer.voice.insecureShort') : t('composer.voice.record')
                }
                disabled={disabled || voiceInsecure}
                onClick={() => void voice.start()}
                className="rounded-full"
              >
                <Mic className="size-5" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                size="icon-touch"
                aria-label={t('composer.send')}
                title={t('composer.send')}
                disabled={!canSend}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void submit()}
                className="rounded-full"
              >
                <SendHorizontal className="size-5" aria-hidden="true" />
              </Button>
            )}
          </div>
        </PopoverAnchor>
        <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
          {quickReplies.length > 0 && (
            <Button
              ref={repliesButtonRef}
              variant="ghost"
              size="touch"
              disabled={disabled}
              aria-expanded={pickerOpen}
              aria-controls={pickerOpen ? pickerId : undefined}
              onClick={() => {
                setBrowseReplies(!pickerOpen);
                setPickerDismissed(pickerOpen);
                areaRef.current?.focus();
              }}
              className="text-muted-foreground"
            >
              <MessageSquareText aria-hidden="true" />
              {t('composer.quickReplies')}
            </Button>
          )}
          {aiMode !== 'off' && (
            <Button
              variant="ghost"
              size="touch"
              disabled={disabled || aiMode === 'unavailable' || strip?.phase === 'loading'}
              aria-describedby={aiMode === 'unavailable' ? unavailableId : undefined}
              onClick={() => void suggest()}
              className="text-primary"
              data-testid="suggest-reply"
            >
              <Sparkles aria-hidden="true" />
              {t('mockSuggest.button')}
            </Button>
          )}
          {aiMode === 'unavailable' && (
            <span id={unavailableId} className="text-xs text-muted-foreground">
              {t('mockSuggest.unavailable')}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            {ghostText && !coarsePointer && (
              <span className="text-xs text-muted-foreground" data-testid="completion-hint">
                {t('mockSuggest.tabHint')}
              </span>
            )}
            {spellingMode !== 'off' && text.trim() !== '' && (
              <GrammarFixButton
                count={grammar.fixable.length}
                marks={grammar.issues.length}
                status={grammar.status}
                grammar={grammarMode}
                touch={coarsePointer}
                undo={undo}
                onFixAll={fixAll}
                onUndo={undoFix}
              />
            )}
          </div>
        </div>
        <PopoverContent
          id={pickerId}
          side="top"
          align="start"
          sideOffset={8}
          // Focus stays in the textarea; the Composer drives the highlighted row.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (
              rowRef.current?.contains(e.target as Node) ||
              repliesButtonRef.current?.contains(e.target as Node)
            )
              e.preventDefault();
          }}
          className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        >
          {mentionOpen ? (
            <MentionPicker
              members={mentions?.members ? memberMatches : null}
              error={!!mentions?.error}
              query={mention!.query}
              activeIndex={activeIndex}
              onPick={insertMember}
              onHover={setActiveIndex}
            />
          ) : (
            <QuickReplyPicker
              replies={quickReplies}
              query={query ?? ''}
              activeIndex={activeIndex}
              onPick={insertReply}
              onHover={setActiveIndex}
            />
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}

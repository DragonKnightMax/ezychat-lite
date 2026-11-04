import type React from 'react';
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  FileText,
  Lock,
  MessageSquareText,
  BotMessageSquare,
  Mic,
  Paperclip,
  SendHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import {
  completionReady,
  matchPhrase,
  MEDIA_UPLOAD_LIMIT_BYTES,
  type GroupMember,
  type QuickReply,
  type ReplyPhraseListItem,
  type FixEnglishStatus,
  type ReplySuggestion,
} from '@ezychat/shared';
import { Button } from '@/components/ui/button';
import { useAskEzy } from '../askezy/AskEzyContext';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { fetchCompletion, fetchSuggestions, sendPhraseFeedback } from '@/api/reply-suggestions';
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
import {
  MAX_ATTACHMENTS,
  checkAttachments,
  filesFromTransfer,
  formatBytes,
} from '@/lib/file-transfer';
import {
  FixEnglishButton,
  FixEnglishCard,
  FixEnglishMarks,
  useFixEnglish,
  type FixIssue,
} from './FixEnglish';
import './composer.css';

/** Lets the conversation hand files dropped anywhere on it to the composer. */
export interface ComposerHandle {
  addFiles(files: readonly File[]): void;
}

export interface ComposerProps {
  quickReplies: QuickReply[];
  /**
   * `mentions`: the tagged members' addresses (groups only; the text then carries `@<number>`);
   * `shown`: the text as the box showed it (`@Name`), for the pending bubble.
   */
  onSend(text: string, mentions?: string[], shown?: string): void;
  /**
   * One file to send, with the caption (the typed text goes with the first file). Files picked,
   * pasted or dropped wait in the tray until Send; they are sent one after another, in order:
   * resolve when this one is handed over. `index` is the file's place in that send (0 = first).
   */
  onAttach(file: File, caption?: string, index?: number): void | Promise<void>;
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
   * AI reply suggestions in this chat (direct chats and groups; null = off). `unavailable` shows the
   * button disabled. The chips clear when `lastCustomerMessageId` changes (a new customer message).
   */
  ref?: React.Ref<ComposerHandle>;
  aiSuggest?: {
    chatJid: string;
    lastCustomerMessageId: string | null;
    isAdmin: boolean;
    state: 'on' | 'unavailable';
    /** The team's phrase list, matched on every key (docs/features/ai-phrase-dictionary). */
    phrases?: readonly ReplyPhraseListItem[];
  } | null;
  /** Ask Ezy (docs/features/ask-ezy/design.md): direct chats and groups; opens Ezy scoped to this chat. */
  askEzy?: { chatJid: string; name: string } | null;
  /**
   * Tag group members with `@` (docs/features/group-mentions/design.md): a group whose connection
   * can tag. `members` is null while loading; `onOpen` runs when the picker opens. Null: no picker.
   */
  mentions?: { members: GroupMember[] | null; error: boolean; onOpen(): void } | null;
  /**
   * Fix English (docs/features/grammar-fix/design.md): spelling and grammar marks in this chat
   * (any chat type; null or a status with both checks off = nothing shown).
   */
  fixEnglish?: {
    chatJid: string;
    chatName: string;
    status: FixEnglishStatus | undefined;
    /** Team words and Business context words, lower case: never marked. */
    teamWords: ReadonlySet<string>;
    /** "Add to team words" on a word the dictionary does not know. */
    onAddWord(word: string): Promise<unknown>;
  } | null;
}

const TYPING_THROTTLE_MS = 2_000;
/** Completion waits for a short pause after a full word, so typing makes no model calls. */
const COMPLETION_PAUSE_MS = 500;
const MAX_HEIGHT_PX = 160;
/** How long "3 fixed · Undo" stays after Fix all. */
const FIX_UNDO_MS = 5_000;
const NO_WORDS: ReadonlySet<string> = new Set();

/**
 * The grey text still ahead of the caret: the completion asked for `ghost.for`, minus what was
 * typed since. Typing other letters, or deleting into the asked-for text, hides it.
 */
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
  askEzy = null,
  fixEnglish = null,
  mentions = null,
  ref,
}: ComposerProps) {
  const { t } = useTranslation('inbox');
  const { openPanel: openAskEzy } = useAskEzy();
  const [text, setText] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  // @ tags picked in this draft, the caret, and the `@` whose picker was closed with Escape.
  const [tags, setTags] = useState<DraftTag[]>([]);
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null);
  const [browseReplies, setBrowseReplies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // Several drops or pastes can land before a render: count against what is already queued.
  const filesRef = useRef<File[]>([]);
  const queueFiles = (next: File[]) => {
    filesRef.current = next;
    setFiles(next);
  };
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

  function addFiles(incoming: readonly File[]) {
    if (disabled || incoming.length === 0) return;
    const { accepted, rejected } = checkAttachments(incoming, filesRef.current.length);
    for (const r of rejected)
      toast.error(
        t(`composer.files.${r.reason}`, {
          name: r.file.name,
          max: MAX_ATTACHMENTS,
          limit: formatBytes(MEDIA_UPLOAD_LIMIT_BYTES),
        }),
      );
    if (accepted.length) queueFiles([...filesRef.current, ...accepted]);
    areaRef.current?.focus();
  }
  useImperativeHandle(ref, () => ({ addFiles }));

  // AI reply suggestions: chips after "Suggest reply" and grey completion text.
  const aiMode = aiSuggest?.state ?? 'off';
  const suggestJid = aiSuggest?.chatJid ?? null;
  const [strip, setStrip] = useState<SuggestionStrip | null>(null);
  const [pendingPick, setPendingPick] = useState<ReplySuggestion | null>(null);
  /** The grey text: what it was asked for, the rest, and the phrase it came from (if any). */
  const [ghost, setGhost] = useState<{ for: string; text: string; phraseId?: number } | null>(null);
  const suggestAbort = useRef<AbortController | null>(null);
  /** The one completion request in flight, for the text it was asked for. */
  const completing = useRef<{ typed: string; jid: string; cancel: AbortController } | null>(null);
  /** Bumped when a request ends, so the next one can start for the text typed meanwhile. */
  const [completionDone, setCompletionDone] = useState(0);
  /** Text whose grey text was dismissed with Esc: not asked again until the text changes. */
  const dismissedFor = useRef<string | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostText = ghostAhead(ghost, text);

  // Fix English: marks after each key (spelling) or pause (grammar), a card per word, Fix all.
  const fixStatus = fixEnglish?.status;
  const fixOn = fixStatus?.spelling === 'on';
  const fix = useFixEnglish(text, {
    jid: fixEnglish?.chatJid ?? null,
    status: fixStatus,
    chatName: fixEnglish?.chatName ?? '',
    teamWords: fixEnglish?.teamWords ?? NO_WORDS,
    disabled,
  });
  const marksRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ id: string; left: number; bottom: number } | null>(null);
  const cardHover = useRef(false);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fixUndo, setFixUndo] = useState<{ before: string; after: string; count: number } | null>(
    null,
  );
  const cardIssue = card ? fix.issues.find((i) => i.id === card.id) : undefined;

  /** The marked word under a point of the box (the marks layer lets the pointer through). */
  function issueAt(x: number, y: number): string | null {
    for (const span of marksRef.current?.querySelectorAll<HTMLElement>('[data-issue]') ?? [])
      for (const r of span.getClientRects())
        if (x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 4)
          return span.dataset.issue ?? null;
    return null;
  }

  function openCard(id: string) {
    const span = [...(marksRef.current?.querySelectorAll<HTMLElement>('[data-issue]') ?? [])].find(
      (el) => el.dataset.issue === id,
    );
    const rect = span?.getClientRects()[0];
    if (!rect) return;
    if (cardTimer.current) clearTimeout(cardTimer.current);
    setCard({
      id,
      left: rect.left - 8,
      bottom: window.innerHeight - rect.top + 6,
    });
  }

  function closeCardSoon() {
    if (cardTimer.current) clearTimeout(cardTimer.current);
    cardTimer.current = setTimeout(() => {
      if (!cardHover.current) setCard(null);
    }, 250);
  }

  function pickFix(issue: FixIssue, replacement: string) {
    pendingCaret.current = issue.start + replacement.length;
    setCard(null);
    setText(fix.apply(text, [issue], replacement));
  }

  function addWord(issue: FixIssue) {
    setCard(null);
    fixEnglish?.onAddWord(issue.original).catch((e: unknown) => toast.error(errorMessage(e)));
  }

  function fixAll() {
    const count = fix.fixable.length;
    if (!count) return;
    const next = fix.apply(text, fix.fixable);
    pendingCaret.current = next.length;
    setCard(null);
    setFixUndo({ before: text, after: next, count });
    setText(next);
  }

  function undoFixAll() {
    if (!fixUndo) return;
    pendingCaret.current = fixUndo.before.length;
    setText(fixUndo.before);
    setFixUndo(null);
  }

  // "3 fixed · Undo" goes after a few seconds, or as soon as the teammate types on.
  useEffect(() => {
    if (!fixUndo) return;
    if (text !== fixUndo.after) {
      setFixUndo(null);
      return;
    }
    const timer = setTimeout(() => setFixUndo(null), FIX_UNDO_MS);
    return () => clearTimeout(timer);
  }, [fixUndo, text]);
  useEffect(() => {
    if (card && !cardIssue) setCard(null);
  }, [card, cardIssue]);
  useEffect(
    () => () => {
      if (cardTimer.current) clearTimeout(cardTimer.current);
    },
    [],
  );

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
    if (ghost?.phraseId && suggestJid) sendPhraseFeedback(suggestJid, ghost.phraseId, true);
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

  // Completion. First the team's phrase list, matched here on every key: a phrase shows at once,
  // with no model call and no pause (docs/features/ai-phrase-dictionary). Otherwise the model, after
  // a full word and a short pause, one request at a time. People type on while it runs, so a
  // request stays alive while the text still extends what it was asked for; its answer then shows
  // the part still ahead (type-through). Other edits cancel it.
  const hasGhost = ghostText !== '';
  const phrases = aiSuggest?.phrases;
  useEffect(() => {
    const running = completing.current;
    if (
      running &&
      (aiMode !== 'on' || running.jid !== suggestJid || !text.startsWith(running.typed))
    ) {
      running.cancel.abort();
      completing.current = null;
    }
    if (hasGhost || aiMode !== 'on' || !suggestJid) return;
    if (dismissedFor.current === text) return;
    const el = areaRef.current;
    if (el && el.selectionStart !== text.length) return;
    const phrase = phrases?.length ? matchPhrase(phrases, text) : null;
    if (phrase) {
      setGhost({ for: text, text: phrase.rest, phraseId: phrase.id });
      return;
    }
    if (completing.current || !completionReady(text)) return;
    const timer = setTimeout(() => {
      const cancel = new AbortController();
      const typed = text;
      completing.current = { typed, jid: suggestJid, cancel };
      fetchCompletion(suggestJid, typed, cancel.signal)
        .then(({ completion }) => {
          if (cancel.signal.aborted || !completion) return;
          // A phrase already showing for the current text stays (no flicker).
          setGhost((shown) =>
            shown && ghostAhead(shown, areaRef.current?.value ?? typed)
              ? shown
              : { for: typed, text: completion },
          );
        })
        .catch(() => undefined)
        .finally(() => {
          if (completing.current?.cancel !== cancel) return;
          completing.current = null;
          setCompletionDone((n) => n + 1);
        });
    }, COMPLETION_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, aiMode, suggestJid, hasGhost, completionDone, phrases]);
  useEffect(() => () => completing.current?.cancel.abort(), []);
  // Grey text belongs to one chat: another chat starts without it.
  useEffect(() => {
    setGhost(null);
    dismissedFor.current = null;
  }, [suggestJid]);

  const query = browseReplies ? '' : slashQuery(text);
  const matches = query == null ? [] : filterQuickReplies(quickReplies, query);
  const quickOpen = query != null && !pickerDismissed && quickReplies.length > 0;
  // `@name` right before the caret opens the member picker (groups that can tag only).
  const mention = mentions && !quickOpen ? mentionQuery(text, caret) : null;
  const mentionOpen = !!mention && mentionDismissed !== mention.start;
  const memberMatches =
    mention && mentionOpen && mentions?.members
      ? filterMembers(mentions.members, mention.query)
      : [];
  const pickerOpen = quickOpen || mentionOpen;
  const onOpenMentions = mentions?.onOpen;
  useEffect(() => {
    if (mentionOpen) onOpenMentions?.();
  }, [mentionOpen, onOpenMentions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, mention?.query]);

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

  /** Puts the picked member's `@Name` tag in place of the `@query` being typed. */
  function insertMember(member: GroupMember) {
    if (!mention) return;
    const r = insertTag(text, mention.start, caret, member);
    setText(r.text);
    setCaret(r.caret);
    pendingCaret.current = r.caret;
    setTags((list) =>
      list.some((tag) => tag.jid === r.tag.jid && tag.label === r.tag.label) ||
      list.length >= MAX_TAGS
        ? list
        : [...list, r.tag],
    );
    emitTyping(r.text);
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
    if ((!value && files.length === 0) || disabled || busy) return;
    setBusy(true);
    try {
      if (!(await confirmed())) return;
      // `@Name` tags go out as WhatsApp's `@<number>` with the members' addresses. A caption keeps
      // the names as typed: WhatsApp media captions are sent without tags.
      const tagged = mentions && tags.length && files.length === 0 ? toWhatsApp(value, tags) : null;
      if (files.length > 0) sendFiles(files, value);
      else if (tagged?.mentions.length) onSend(tagged.text, tagged.mentions, value);
      else onSend(value);
      setTags([]);
      setMentionDismissed(null);
      queueFiles([]);
      setText('');
      setGhost(null);
      setFixUndo(null);
      closeSuggestions();
      setBrowseReplies(false);
      setPickerDismissed(false);
    } finally {
      setBusy(false);
      areaRef.current?.focus();
    }
  }

  /** Uploads one after another so WhatsApp gets them in the order they were added. */
  function sendFiles(queued: readonly File[], caption: string) {
    void (async () => {
      for (const [i, file] of queued.entries()) {
        try {
          await onAttach(file, (i === 0 && caption) || undefined, i);
        } catch {
          // The conversation reports the failure on that file's bubble; the rest still go.
        }
      }
    })();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    addFiles(picked);
  }

  /** Pasted files (a screenshot, files copied in Explorer or Finder) join the tray; text pastes as text. */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const dt = e.clipboardData;
    if (!dt) return;
    // Office and browsers put a picture of copied text next to the text itself: keep the text. An
    // image copied from a web page also carries HTML but no text: then the image is the paste.
    if (dt.types.includes('text/html') && dt.getData('text/plain').trim() !== '') return;
    const pasted = filesFromTransfer(dt);
    if (pasted.length === 0) return;
    e.preventDefault();
    addFiles(pasted);
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
    // Fix English: Ctrl+J / ⌘J fixes every mark with a safe fix at once.
    if (fixOn && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'j') {
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
      if (ghost?.phraseId && suggestJid) sendPhraseFeedback(suggestJid, ghost.phraseId, false);
      setGhost(null);
      return;
    }
    // The member picker drives ↑/↓/Enter/Tab/Escape while it is open.
    if (mention && mentionOpen && memberMatches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((i) => (i + step + memberMatches.length) % memberMatches.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const m = memberMatches[Math.min(activeIndex, memberMatches.length - 1)];
        if (m) insertMember(m);
        return;
      }
    }
    if (mention && mentionOpen && e.key === 'Escape') {
      e.preventDefault();
      setMentionDismissed(mention.start);
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

  const canSend = (text.trim().length > 0 || files.length > 0) && !disabled && !busy;
  // An empty box offers the mic instead of Send, as WhatsApp does.
  const offerVoice =
    !!onVoiceNote && voiceSupported !== 'unsupported' && !text.trim() && files.length === 0;
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
      {files.length > 0 && (
        <AttachmentTray
          files={files}
          onRemove={(i) => queueFiles(files.filter((_, j) => j !== i))}
          onClear={() => queueFiles([])}
        />
      )}
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
          aria-label={t('composer.suggest.replaceTitle')}
          className="mb-1.5 flex flex-wrap items-center gap-2 rounded-lg border bg-muted px-3 py-1.5 text-sm"
          data-testid="replace-confirm"
        >
          <span className="min-w-0 flex-1">{t('composer.suggest.replaceTitle')}</span>
          <Button
            size="sm"
            className="pointer-coarse:min-h-11"
            onClick={() => applyDraft(pendingPick)}
          >
            {t('composer.suggest.replace')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="pointer-coarse:min-h-11"
            onClick={() => setPendingPick(null)}
          >
            {t('composer.suggest.keep')}
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
            {t('composer.suggest.accept')}
          </Button>
        </div>
      )}
      <Popover
        open={pickerOpen}
        onOpenChange={(o) => {
          if (!o) {
            if (mention && mentionOpen) setMentionDismissed(mention.start);
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
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={onFile}
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
            <div className="relative min-w-0 flex-1">
              <Textarea
                ref={areaRef}
                aria-label={t('composer.message')}
                aria-autocomplete="list"
                aria-expanded={pickerOpen}
                aria-controls={pickerOpen ? pickerId : undefined}
                rows={1}
                value={text}
                disabled={disabled}
                placeholder={
                  files.length > 0
                    ? t('composer.files.caption')
                    : (placeholder ?? t('composer.placeholder'))
                }
                onChange={onChange}
                onKeyDown={onKeyDown}
                // The cursor moved (click, arrows): re-read the `@query` under it.
                onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                onPaste={onPaste}
                onScroll={(e) => {
                  if (marksRef.current) marksRef.current.scrollTop = e.currentTarget.scrollTop;
                  // Focusing the box can scroll it (phones): the card follows its word.
                  if (card) openCard(card.id);
                }}
                // Fix English: hover (mouse) or tap/click a marked word for its card.
                onMouseMove={(e) => {
                  if (coarsePointer || !fix.issues.length) return;
                  const id = issueAt(e.clientX, e.clientY);
                  if (id) {
                    if (id !== card?.id) openCard(id);
                    else if (cardTimer.current) clearTimeout(cardTimer.current);
                  } else if (card) closeCardSoon();
                }}
                onMouseLeave={() => card && closeCardSoon()}
                onClick={(e) => {
                  if (!fix.issues.length) return;
                  const id = issueAt(e.clientX, e.clientY);
                  if (id) openCard(id);
                  else setCard(null);
                }}
                // Enter inserts a newline on touch keyboards, so label the key accordingly.
                enterKeyHint={coarsePointer ? 'enter' : 'send'}
                // Fix English marks spelling itself; the browser's own underline would mark it twice.
                spellCheck={!fixOn}
                className="composer-input field-sizing-fixed min-h-11 w-full min-w-0 resize-none rounded-2xl bg-surface px-3.5 py-2.5 text-base leading-6 md:text-base"
              />
              <FixEnglishMarks
                ref={marksRef}
                text={text}
                issues={fix.issues}
                activeId={card?.id ?? null}
              />
              {cardIssue && card && (
                <FixEnglishCard
                  issue={cardIssue}
                  position={card}
                  touch={coarsePointer}
                  onPick={(replacement) => pickFix(cardIssue, replacement)}
                  onAddWord={() => addWord(cardIssue)}
                  onIgnore={() => {
                    fix.ignore(cardIssue);
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
                  {t('composer.suggest.completionStatus', { text: ghostText })}
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
        <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 max-sm:-mx-2 max-sm:gap-x-0">
          {quickReplies.length > 0 && (
            <Button
              ref={repliesButtonRef}
              variant="ghost"
              size="touch"
              disabled={disabled}
              aria-expanded={quickOpen}
              aria-controls={quickOpen ? pickerId : undefined}
              onClick={() => {
                setBrowseReplies(!quickOpen);
                setPickerDismissed(quickOpen);
                areaRef.current?.focus();
              }}
              className="text-muted-foreground max-sm:has-[>svg]:px-2"
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
              className="text-primary max-sm:has-[>svg]:px-2"
              data-testid="suggest-reply"
            >
              <Sparkles aria-hidden="true" />
              {t('composer.suggest.button')}
            </Button>
          )}
          {askEzy && (
            <Button
              variant="ghost"
              size="touch"
              className="text-primary max-sm:has-[>svg]:px-2"
              data-testid="ask-ezy-about-chat"
              data-ask-ezy-trigger
              onClick={() =>
                openAskEzy({
                  question: t('askEzy.summariseChat', { name: askEzy.name }),
                  chatJid: askEzy.chatJid,
                  chatName: askEzy.name,
                })
              }
            >
              <BotMessageSquare aria-hidden="true" />
              <span className="sm:hidden">
                {t('askEzy.button')}
                <span className="sr-only"> {t('askEzy.aboutChatSuffix')}</span>
              </span>
              <span className="max-sm:hidden">{t('askEzy.summariseButton')}</span>
            </Button>
          )}
          {aiMode === 'unavailable' && (
            <span id={unavailableId} className="text-xs text-muted-foreground">
              {t('composer.suggest.unavailable')}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            {ghostText && !coarsePointer && (
              <span className="text-xs text-muted-foreground" data-testid="completion-hint">
                {t('composer.suggest.tabHint')}
              </span>
            )}
            {fixOn && fixStatus && text.trim() !== '' && (
              <FixEnglishButton
                count={fix.fixable.length}
                marks={fix.issues.length}
                grammarStatus={fix.grammarStatus}
                grammar={fixStatus.grammar}
                touch={coarsePointer}
                undo={fixUndo}
                onFixAll={fixAll}
                onUndo={undoFixAll}
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
          {mention && mentionOpen ? (
            <MentionPicker
              members={mentions?.members ? memberMatches : null}
              error={!!mentions?.error}
              query={mention.query}
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

/** Thumbnail of an image file waiting in the tray (object URL freed on removal). */
function FileThumb({ file }: Readonly<{ file: File }>) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? (
    <img
      src={url}
      alt=""
      // A file named .png that is not one shows the file icon instead of a broken image.
      onError={() => setUrl(null)}
      className="size-10 shrink-0 rounded-md object-cover"
    />
  ) : (
    <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
      <FileText className="size-5" aria-hidden="true" />
    </span>
  );
}

/** Files picked, pasted or dropped, waiting for Send. */
function AttachmentTray({
  files,
  onRemove,
  onClear,
}: Readonly<{
  files: readonly File[];
  onRemove(index: number): void;
  onClear(): void;
}>) {
  const { t } = useTranslation('inbox');
  return (
    <div
      className="mb-1.5 rounded-lg border bg-muted/50 p-1.5"
      role="group"
      aria-label={t('composer.files.title', { count: files.length })}
      data-testid="attachment-tray"
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <p className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {t('composer.files.title', { count: files.length })}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-7 shrink-0 px-2 text-xs text-muted-foreground pointer-coarse:min-h-11"
        >
          {t('composer.files.clear')}
        </Button>
      </div>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {files.map((file, i) => (
          <li
            key={`${i}-${file.name}-${file.size}-${file.lastModified}`}
            className="flex min-w-0 items-center gap-2 rounded-md bg-surface p-1 pr-0.5"
          >
            <FileThumb file={file} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{file.name}</span>
              <span className="block text-xs text-muted-foreground">{formatBytes(file.size)}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('composer.files.remove', { name: file.name })}
              title={t('composer.files.remove', { name: file.name })}
              onClick={() => onRemove(i)}
              className="size-8 shrink-0 text-muted-foreground pointer-coarse:size-11"
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

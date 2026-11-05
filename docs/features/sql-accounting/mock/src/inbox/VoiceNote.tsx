import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MicOff, Pause, Play, SendHorizontal, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  VOICE_NOTE_MAX_SECONDS,
  VoiceStartFailure,
  startVoiceRecording,
  type VoiceRecording,
  type VoiceStartError,
} from '@/lib/voice-recorder';
import { newClientId } from '../api/queries';

/** `lost`: the recording could not be finished (the encoder failed), so there is nothing to send. */
export type VoicePhase = 'idle' | 'starting' | 'recording' | 'review' | 'lost' | VoiceStartError;

const LIVE_BARS = 48;
const REVIEW_BARS = 48;
const SAMPLE_MS = 100;

export const formatClock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** `levels` (0–1) squeezed or stretched into `n` bars. */
function toBars(levels: number[], n: number): number[] {
  if (!levels.length) return Array.from({ length: n }, () => 0);
  return Array.from({ length: n }, (_, i) => {
    const start = Math.floor((i * levels.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / n));
    return Math.max(...levels.slice(start, end));
  });
}

interface Review {
  /** One id per recording: every send attempt of it uses this clientId, so retries never duplicate. */
  clientId: string;
  blob: Blob;
  url: string;
  seconds: number;
  bars: number[];
}

/**
 * Record → (review) → send a voice note. `send` gets the Ogg/Opus file and resolves `true` once it
 * accepted it; until then (a declined confirmation, a disabled composer) the recording is kept.
 */
export function useVoiceNote(send: (file: File, clientId: string) => boolean | Promise<boolean>) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [live, setLive] = useState<number[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const recording = useRef<VoiceRecording | null>(null);
  const levels = useRef<number[]>([]);
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Bumped by Delete and unmount: a start still waiting for the microphone is then abandoned. */
  const attempt = useRef(0);

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const finish = useCallback(async (): Promise<Review | null> => {
    const rec = recording.current;
    recording.current = null;
    stopTimer();
    if (!rec) return null;
    const mine = attempt.current;
    let blob: Blob;
    try {
      blob = await rec.stop();
    } catch {
      if (mine === attempt.current) setPhase('lost');
      return null;
    }
    // Deleted, or the chat closed, while the encoder was finishing: drop it.
    if (mine !== attempt.current) return null;
    // Whole seconds, rounded down like the audio player that plays it back.
    const secs = Math.max(1, Math.floor((Date.now() - started.current) / 1000));
    return {
      clientId: newClientId(),
      blob,
      url: URL.createObjectURL(blob),
      seconds: secs,
      bars: toBars(levels.current, REVIEW_BARS),
    };
  }, []);

  const showReview = useCallback((r: Review) => {
    setReview(r);
    setPhase('review');
  }, []);

  const toReview = useCallback(async () => {
    const r = await finish();
    if (r) showReview(r);
  }, [finish, showReview]);

  // Called from the mic button's click: the browser only starts audio from a user action.
  const start = useCallback(async () => {
    const mine = ++attempt.current;
    setPhase('starting');
    let rec: VoiceRecording;
    try {
      rec = await startVoiceRecording();
    } catch (err) {
      if (mine === attempt.current)
        setPhase(err instanceof VoiceStartFailure ? err.reason : 'failed');
      return;
    }
    // Deleted, or the chat closed, while the microphone was starting: switch it straight off.
    if (mine !== attempt.current) {
      rec.cancel();
      return;
    }
    recording.current = rec;
    levels.current = [];
    started.current = Date.now();
    setSeconds(0);
    setLive([]);
    setPhase('recording');
    timer.current = setInterval(() => {
      const current = recording.current;
      if (!current) return;
      levels.current.push(current.level());
      setLive(levels.current.slice(-LIVE_BARS));
      const elapsed = (Date.now() - started.current) / 1000;
      setSeconds(Math.floor(elapsed));
      if (elapsed >= VOICE_NOTE_MAX_SECONDS) void toReview();
    }, SAMPLE_MS);
  }, [toReview]);

  const discard = useCallback(() => {
    attempt.current++;
    stopTimer();
    recording.current?.cancel();
    recording.current = null;
    setReview(null);
    setSendFailed(false);
    setPhase('idle');
  }, []);

  const deliver = useCallback(
    async (r: Review) => {
      setSending(true);
      setSendFailed(false);
      try {
        const file = new File([r.blob], 'voice-note.ogg', { type: 'audio/ogg' });
        if (!(await send(file, r.clientId))) return;
      } catch {
        // Upload failed: keep it in Review to send again.
        setSendFailed(true);
        return;
      } finally {
        setSending(false);
      }
      setReview(null);
      setPhase('idle');
    },
    [send],
  );

  // Send straight from recording: the note stays in Review if the send is not accepted.
  const sendNow = useCallback(async () => {
    const r = await finish();
    if (!r) return;
    showReview(r);
    await deliver(r);
  }, [deliver, finish, showReview]);
  const sendReviewed = useCallback(async () => {
    if (review) await deliver(review);
  }, [deliver, review]);

  // Leaving the chat mid-recording stops the microphone and drops the recording.
  useEffect(
    () => () => {
      attempt.current++;
      stopTimer();
      recording.current?.cancel();
    },
    [],
  );
  useEffect(
    () => () => {
      if (review) URL.revokeObjectURL(review.url);
    },
    [review],
  );

  return {
    phase,
    seconds,
    // Newest level on the right; empty slots on the left until the bar fills.
    liveBars: [...Array.from({ length: LIVE_BARS - live.length }, () => 0), ...live],
    review,
    sending,
    sendFailed,
    start,
    toReview,
    sendNow,
    sendReviewed,
    discard,
    dismiss: () => setPhase('idle'),
  };
}

export type VoiceNoteState = ReturnType<typeof useVoiceNote>;

function Bars({
  values,
  className,
  played,
}: Readonly<{ values: number[]; className: string; played?: number }>) {
  return (
    <span
      className="flex h-8 min-w-0 flex-1 items-center justify-between gap-px overflow-hidden"
      aria-hidden="true"
    >
      {values.map((v, i) => (
        <span
          // Fixed-length, positional bars: the index is the identity. NOSONAR
          key={i}
          className={cn(
            'w-[3px] shrink-0 rounded-full',
            played !== undefined && i / values.length < played ? 'bg-primary' : className,
          )}
          style={{ height: `${Math.max(4, Math.round(v * 28))}px` }}
        />
      ))}
    </span>
  );
}

function StartProblem({ voice }: Readonly<{ voice: VoiceNoteState }>) {
  const { t } = useTranslation('inbox');
  let message: ReactNode = t('composer.voice.failed');
  if (voice.phase === 'lost') message = t('composer.voice.lost');
  else if (voice.phase === 'blocked')
    message = (
      <>
        <strong>{t('composer.voice.blockedTitle')}</strong> {t('composer.voice.blockedBody')}
      </>
    );
  else if (voice.phase === 'no-microphone') message = t('composer.voice.noMicrophone');
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm"
    >
      <MicOff className="size-5 shrink-0 text-destructive" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-60">{message}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="touch" onClick={voice.dismiss}>
          {t('composer.voice.cancel')}
        </Button>
        <Button size="touch" onClick={() => void voice.start()}>
          {t('composer.voice.tryAgain')}
        </Button>
      </div>
    </div>
  );
}

function DeleteButton({ onClick }: Readonly<{ onClick(): void }>) {
  const { t } = useTranslation('inbox');
  return (
    <Button
      variant="ghost"
      size="icon-touch"
      aria-label={t('composer.voice.delete')}
      title={t('composer.voice.delete')}
      onClick={onClick}
      className="rounded-full text-destructive hover:text-destructive"
    >
      <Trash2 className="size-5" aria-hidden="true" />
    </Button>
  );
}

function SendButton({ onClick, disabled }: Readonly<{ onClick(): void; disabled?: boolean }>) {
  const { t } = useTranslation('inbox');
  return (
    <Button
      size="icon-touch"
      aria-label={t('composer.voice.send')}
      title={t('composer.voice.send')}
      disabled={disabled}
      onClick={onClick}
      className="rounded-full"
    >
      <SendHorizontal className="size-5" aria-hidden="true" />
    </Button>
  );
}

function ReviewBar({ voice, review }: Readonly<{ voice: VoiceNoteState; review: Review }>) {
  const { t } = useTranslation('inbox');
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playAt, setPlayAt] = useState(0);
  const [canPreview] = useState(
    () => document.createElement('audio').canPlayType('audio/ogg; codecs=opus') !== '',
  );
  const clock = playing
    ? `${formatClock(playAt)} / ${formatClock(review.seconds)}`
    : formatClock(review.seconds);
  return (
    <div className="flex items-center gap-1.5" data-testid="voice-review">
      <DeleteButton onClick={voice.discard} />
      <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-muted py-1 pr-3.5 pl-1">
        <Button
          size="icon"
          aria-label={playing ? t('composer.voice.pause') : t('composer.voice.play')}
          title={canPreview ? undefined : t('composer.voice.previewUnavailable')}
          disabled={!canPreview}
          onClick={() => {
            const el = audio.current;
            if (!el) return;
            if (el.paused) void el.play().catch(() => setPlaying(false));
            else el.pause();
          }}
          className="size-9 shrink-0 rounded-full"
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </Button>
        <Bars
          values={review.bars}
          className="bg-muted-foreground/50"
          played={playing ? playAt / review.seconds : undefined}
        />
        <span className="text-xs text-muted-foreground tabular-nums">{clock}</span>
        {voice.sendFailed && (
          <span role="alert" className="shrink-0 text-xs font-medium text-destructive">
            {t('composer.voice.sendFailed')}
          </span>
        )}
        {/* The user's own recording, played back before sending: there is nothing to caption. */}
        <audio
          ref={audio}
          src={review.url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPlayAt(0);
          }}
          onTimeUpdate={(e) => setPlayAt(e.currentTarget.currentTime)}
        />
      </div>
      <SendButton disabled={voice.sending} onClick={() => void voice.sendReviewed()} />
    </div>
  );
}

function RecordingBar({ voice }: Readonly<{ voice: VoiceNoteState }>) {
  const { t } = useTranslation('inbox');
  return (
    <div className="flex items-center gap-1.5" data-testid="voice-recording">
      <DeleteButton onClick={voice.discard} />
      <span
        className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span
        role="timer"
        aria-label={t('composer.voice.recordingTime', { time: formatClock(voice.seconds) })}
        className="w-11 shrink-0 text-sm font-semibold tabular-nums"
      >
        {formatClock(voice.seconds)}
      </span>
      <Bars values={voice.liveBars} className="bg-destructive/70" />
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {t('composer.voice.maxLength', { time: formatClock(VOICE_NOTE_MAX_SECONDS) })}
      </span>
      <Button
        variant="outline"
        size="touch"
        disabled={voice.phase !== 'recording'}
        onClick={() => void voice.toReview()}
        className="shrink-0 rounded-full"
      >
        <Square className="size-3.5 fill-current" aria-hidden="true" />
        {t('composer.voice.review')}
      </Button>
      <SendButton disabled={voice.sending} onClick={() => void voice.sendNow()} />
    </div>
  );
}

/** The composer row while a voice note is being recorded, reviewed, or could not start. */
export function VoiceNoteBar({ voice }: Readonly<{ voice: VoiceNoteState }>) {
  if (['blocked', 'no-microphone', 'failed', 'lost'].includes(voice.phase))
    return <StartProblem voice={voice} />;
  if (voice.phase === 'review' && voice.review)
    return <ReviewBar voice={voice} review={voice.review} />;
  return <RecordingBar voice={voice} />;
}

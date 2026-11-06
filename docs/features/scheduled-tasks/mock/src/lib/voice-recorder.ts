/**
 * Records a WhatsApp voice note: microphone → Ogg/Opus (mono, 48 kHz, voice mode), encoded in a
 * worker by opus-recorder's bundled WebAssembly encoder, so every browser (Safari included) yields
 * the format WhatsApp expects. The encoder is loaded only when a recording starts.
 */

/** Longest recording; the server refuses longer voice notes. */
export const VOICE_NOTE_MAX_SECONDS = 300;
/** How long the encoder may take to hand over the file after Stop. */
const STOP_TIMEOUT_MS = 10_000;

export type VoiceSupport = 'ok' | 'insecure' | 'unsupported';

/** Why a recording could not start. */
export type VoiceStartError = 'blocked' | 'no-microphone' | 'failed';

export interface VoiceRecording {
  /** Current input level, 0 (silence) to 1. */
  level(): number;
  /** Ends the recording and returns the Ogg/Opus file. */
  stop(): Promise<Blob>;
  /** Ends the recording and discards it. */
  cancel(): void;
}

/** Browsers allow the microphone only on secure pages (https, localhost, the desktop app). */
export function voiceSupport(): VoiceSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined')
    return 'unsupported';
  return 'ok';
}

export class VoiceStartFailure extends Error {
  constructor(readonly reason: VoiceStartError) {
    super(reason);
  }
}

function startError(err: unknown): VoiceStartFailure {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new VoiceStartFailure('blocked');
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return new VoiceStartFailure('no-microphone');
  return new VoiceStartFailure('failed');
}

/** Must be called from a click or tap: browsers only start audio from a user action. */
export async function startVoiceRecording(): Promise<VoiceRecording> {
  // Created before any await, while the tap still counts as a user action (Safari otherwise
  // starts it suspended and records silence).
  const context = new AudioContext();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    void context.close().catch(() => {});
    throw startError(err);
  }
  const close = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  try {
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const [{ default: Recorder }, { default: encoderPath }] = await Promise.all([
      import('opus-recorder'),
      import('opus-recorder/dist/encoderWorker.min.js?url'),
    ]);
    const recorder = new Recorder({
      sourceNode: source,
      encoderPath,
      encoderApplication: 2048, // voice
      encoderSampleRate: 48_000,
      numberOfChannels: 1,
      streamPages: false,
    });
    let resolveData: (blob: Blob) => void = () => {};
    let rejectData: (err: Error) => void = () => {};
    const data = new Promise<Blob>((resolve, reject) => {
      resolveData = resolve;
      rejectData = reject;
    });
    recorder.ondataavailable = (bytes: Uint8Array<ArrayBuffer>) =>
      resolveData(new Blob([bytes], { type: 'audio/ogg; codecs=opus' }));
    await recorder.start();
    // A synchronous throw from the encoder becomes a rejection, so cleanup below always runs.
    const stopRecorder = (): Promise<void> => {
      try {
        return Promise.resolve(recorder.stop());
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error('Recording failed to stop'));
      }
    };
    const samples = new Uint8Array(analyser.fftSize);
    let done = false;
    return {
      level() {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += ((s - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / samples.length) * 4);
      },
      async stop() {
        if (done) throw new Error('Recording already ended');
        done = true;
        // A failed or silent encoder must never leave the microphone on or the composer waiting.
        stopRecorder().catch((err: unknown) =>
          rejectData(err instanceof Error ? err : new Error('Recording failed to stop')),
        );
        const timeout = setTimeout(
          () => rejectData(new Error('Recording did not finish')),
          STOP_TIMEOUT_MS,
        );
        try {
          return await data;
        } finally {
          clearTimeout(timeout);
          close();
        }
      },
      cancel() {
        if (done) return;
        done = true;
        void stopRecorder().catch(() => {});
        close();
      },
    };
  } catch (err) {
    close();
    throw err instanceof VoiceStartFailure ? err : new VoiceStartFailure('failed');
  }
}

import type { SendResult, WaTemplateSend } from '@ezychat/wa';

export interface SendJob {
  /** row id of the pending message (`local-<clientId>`) */
  localId: string;
  chatJid: string;
  /** JID WhatsApp sends to (the customer's last inbound address); `chatJid` is the queue key */
  targetJid: string;
  /** epoch ms; jobs older than maxAgeMs are failed with 'expired' instead of being sent */
  createdAt: number;
  kind: 'text' | 'media' | 'template';
  text?: string;
  quotedId?: string;
  /** text jobs in groups: the members the text tags (WhatsApp mentions) */
  mentions?: string[];
  /** media jobs: relative media path (MediaStore) + metadata */
  mediaPath?: string;
  mime?: string;
  fileName?: string;
  caption?: string;
  /** media jobs: send the Ogg/Opus file as a WhatsApp voice note */
  voiceNote?: boolean;
  /** media jobs: send any file (e.g. a video above the video limit) as a document */
  asDocument?: boolean;
  /** a forwarded copy: WhatsApp's forwarding score it carries (the source's + 1) */
  forwardingScore?: number;
  /** template jobs: the approved template and its body values */
  template?: WaTemplateSend;
  /**
   * Retry of a message WhatsApp already took (row keeps its WhatsApp id): send it again under that
   * same WhatsApp id, so phones that already have it never show a second copy.
   */
  resendId?: string;
}

export interface SendQueueDeps {
  send: (job: SendJob) => Promise<SendResult>;
  onSent(job: SendJob, r: SendResult): void;
  onFailed(job: SendJob, err: Error): void;
  isConnected(): boolean;
  /**
   * True while the access gate is closed: nothing is sent and nothing expires (call onResumed()
   * when it opens; each waiting job then gets the full maxAgeMs again).
   */
  isPaused?: () => boolean;
  presence?: (job: SendJob) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** default 600000 (10 min) */
  maxAgeMs?: number;
  /** default 1000 */
  spacingMs?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/** wait after a wa_unavailable send error while the connection still reports open */
export const UNAVAILABLE_RETRY_MS = 2_000;

function isUnavailable(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'wa_unavailable';
}

/**
 * Outbound queue: FIFO per chat, chats processed concurrently.
 * Before each send: expired jobs fail; waits while disconnected (but never past expiry);
 * keeps >= spacingMs between sends in the same chat; sends 'composing' presence.
 */
export class SendQueue {
  private readonly queues = new Map<string, SendJob[]>();
  private readonly running = new Set<string>();
  private readonly lastSentAt = new Map<string, number>();
  private connWaiters: Array<() => void> = [];
  private stopped = false;
  /** epoch ms of the last onResumed(); expiry counts from here at the earliest */
  private resumedAt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAgeMs: number;
  private readonly spacingMs: number;

  constructor(private readonly deps: SendQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.maxAgeMs = deps.maxAgeMs ?? 600_000;
    this.spacingMs = deps.spacingMs ?? 1000;
  }

  enqueue(job: SendJob): void {
    if (this.stopped) return;
    let q = this.queues.get(job.chatJid);
    if (!q) {
      q = [];
      this.queues.set(job.chatJid, q);
    }
    q.push(job);
    this.kick(job.chatJid);
  }

  /** Call when the WA connection becomes open: wakes all chats waiting for a connection. */
  onConnected(): void {
    const w = this.connWaiters;
    this.connWaiters = [];
    for (const fn of w) fn();
  }

  /** Call when the access gate opens: wakes paused chats; time spent closed never counts toward expiry. */
  onResumed(): void {
    this.resumedAt = this.now();
    this.onConnected();
  }

  /** Re-enqueue persisted pending jobs (startup). */
  restore(jobs: SendJob[]): void {
    for (const j of [...jobs].sort((a, b) => a.createdAt - b.createdAt)) this.enqueue(j);
  }

  stop(): void {
    this.stopped = true;
    this.queues.clear();
    this.onConnected();
  }

  /** Number of queued (not yet finished) jobs. */
  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  private kick(chatJid: string): void {
    if (this.running.has(chatJid)) return;
    this.running.add(chatJid);
    void this.run(chatJid).finally(() => {
      this.running.delete(chatJid);
      // a job may have been enqueued right as the worker exited
      const q = this.queues.get(chatJid);
      if (!this.stopped && q && q.length) this.kick(chatJid);
    });
  }

  private waitConnected(maxMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.connWaiters = this.connWaiters.filter((f) => f !== finish);
        resolve();
      };
      this.connWaiters.push(finish);
      void this.sleep(Math.max(1, maxMs)).then(finish);
    });
  }

  /** Waits for onConnected()/onResumed()/stop() with no timeout (paused jobs never expire). */
  private waitWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.connWaiters = this.connWaiters.filter((f) => f !== finish);
        resolve();
      };
      this.connWaiters.push(finish);
    });
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // callbacks must not break the queue
    }
  }

  private async run(chatJid: string): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const q = this.queues.get(chatJid);
      const job = q?.[0];
      if (!q || !job) {
        this.queues.delete(chatJid);
        return;
      }

      if (this.deps.isPaused?.()) {
        await this.waitWake();
        continue; // re-check pause / expiry / connection
      }

      const age = this.now() - Math.max(job.createdAt, this.resumedAt);
      if (age > this.maxAgeMs) {
        q.shift();
        this.safe(() => this.deps.onFailed(job, new Error('expired')));
        continue;
      }

      if (!this.deps.isConnected()) {
        await this.waitConnected(this.maxAgeMs - age + 1);
        continue; // re-check expiry / connection
      }

      const last = this.lastSentAt.get(chatJid);
      if (last !== undefined) {
        const wait = last + this.spacingMs - this.now();
        if (wait > 0) {
          await this.sleep(wait);
          continue; // re-check expiry / connection after waiting
        }
      }

      if (this.deps.presence) await this.deps.presence(job).catch(() => undefined);
      if (this.stopped) return;
      if (this.deps.isPaused?.()) continue; // closed during presence: wait, still pending

      try {
        const r = await this.deps.send(job);
        q.shift();
        this.lastSentAt.set(chatJid, this.now());
        this.safe(() => this.deps.onSent(job, r));
      } catch (err) {
        if (isUnavailable(err)) {
          // Connection dropped mid-send: stay pending. Our status may still read 'open' for a moment
          // (the close event lags the failed send), so back off briefly before re-checking.
          if (this.deps.isConnected()) await this.sleep(UNAVAILABLE_RETRY_MS);
          continue;
        }
        q.shift();
        this.lastSentAt.set(chatJid, this.now());
        this.safe(() =>
          this.deps.onFailed(job, err instanceof Error ? err : new Error(String(err))),
        );
      }
    }
  }
}

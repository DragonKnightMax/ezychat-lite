import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';
import type { Logger } from 'pino';
import { MCP_UPLOAD_TTL_MS, type McpUploadResponse } from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { ResponseTooLargeError } from '../connectors/mcp/net.js';
import { HttpError, errors } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { MCP_UPLOAD_TYPES } from '../mcp/media-types.js';

/**
 * Large files on their way into a message (design docs/features/mcp-file-upload/design.md): an MCP
 * upload (`POST /mcp/uploads`, sent later by `uploadId`), an MCP link download and a composer upload
 * (`POST /chats/:jid/media`). Each is streamed to a private file under `<data>/uploads/` (never held
 * in memory) and then moved into the media store by the send. There is no size cap of our own: the
 * caller passes the WhatsApp number's limit, and the free disk space is the only other bound.
 * MCP uploads are typed from their bytes, owned by one token and deleted when sent, when they expire
 * (1 hour) or when the server starts again.
 */

export interface UploadLimits {
  /** MCP uploads started per token per hour (failed ones count too). */
  perHour: { windowMs: number; max: number };
  /** MCP uploads of one token waiting to be sent. */
  pendingPerToken: number;
  /** Transfers receiving at the same time, per token or user and in total. */
  activePerKey: number;
  activeTotal: number;
  /** Free disk space the data folder keeps after every transfer in progress. */
  minFreeBytes: number;
}

export const UPLOAD_LIMITS: Readonly<UploadLimits> = {
  perHour: { windowMs: 60 * 60_000, max: 30 },
  pendingPerToken: 10,
  activePerKey: 2,
  activeTotal: 4,
  minFreeBytes: 1024 * 1024 * 1024,
};

/** A transfer stops after this long without data, or this long in total. */
export const UPLOAD_TIMEOUTS = { idleMs: 60_000, totalMs: 60 * 60_000 };

export interface McpUpload {
  id: string;
  tokenId: number;
  /** Absolute path of the private file. */
  path: string;
  name: string;
  mime: string;
  ext: string;
  size: number;
  expiresAt: number;
}

const UPLOAD_ID = /^upl_[a-f0-9]{32}$/;
const MB = 1024 * 1024;
/** Control characters and the bidirectional overrides and isolates (a name that reads backwards). */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** A file name safe to show: no folders, no control characters, at most 120 characters. */
export function cleanUploadName(raw = ''): string {
  let name = raw;
  try {
    // X-File-Name may be percent-encoded so a name outside ASCII fits in a header.
    name = decodeURIComponent(raw);
  } catch {
    // not encoded
  }
  const base = (name.split(/[/\\]/).pop() ?? '')
    .replace(UNSAFE_NAME_CHARS, '')
    .trim()
    .slice(0, 120);
  return base === '' || base === '.' || base === '..' ? 'file' : base;
}

/** More bytes arrived than the transfer may take. */
export class TooLargeError extends Error {
  constructor() {
    super('too large');
    this.name = 'TooLargeError';
  }
}

/** The body stopped before it ended (the client went away, the link broke). */
export class IncompleteError extends Error {
  constructor() {
    super('incomplete');
    this.name = 'IncompleteError';
  }
}

/** Counts bytes through a stream and fails it once more than `max` arrive. */
class ByteCounter extends Transform {
  bytes = 0;
  constructor(
    private readonly max: number,
    private readonly onChunk: () => void,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
    this.onChunk();
    this.bytes += chunk.length;
    if (this.bytes > this.max) return done(new TooLargeError());
    done(null, chunk);
  }
}

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;

/** WhatsApp takes no more: Forward's code and wording. */
export const tooLargeForWhatsApp = (max: number) =>
  new HttpError(
    413,
    'too_large_for_whatsapp',
    `Too large for this WhatsApp number: files up to ${mb(max)}`,
  );

const storageFull = () =>
  new HttpError(
    507,
    'upload_storage_full',
    'Not enough free disk space on the computer that runs EzyChat for this file.',
  );

/** How much a transfer may write, and what refuses it when it goes over. */
interface Allowance {
  max: number;
  refusal: () => HttpError;
}

/** Options of one transfer into a private file. */
export interface TransferOptions {
  /** WhatsApp's largest file for this number (or the token owner's numbers); absent = none known. */
  maxBytes?: number;
  /** The request's Content-Length: refused before reading when it can never fit. */
  declaredLength?: number;
}

export interface UploadStore {
  /** Receives one MCP upload of `tokenId`; 400/408/413/415/429/507 HttpErrors for a refused one. */
  receive(
    tokenId: number,
    body: Readable,
    opts: TransferOptions & { name: string | undefined },
  ): Promise<McpUploadResponse>;
  /** The token's own upload that has not expired, or null ("not found" for every other case). */
  get(tokenId: number, id: string): McpUpload | null;
  /**
   * Takes the token's upload out of the store for one send, so a second send or the expiry sweep
   * cannot touch its file meanwhile; null when there is none. The send moves the file, or gives the
   * upload back with `restore`.
   */
  take(tokenId: number, id: string): McpUpload | null;
  /** Gives back an upload a send did not use (refused); its file is still there. */
  restore(upload: McpUpload): void;
  /**
   * Streams `body` into a new private file (a composer upload, an MCP link download) under the same
   * transfer slots and disk checks; `key` names who sends it (`token:<id>`, `user:<id>`). The caller
   * moves or deletes the file (`discard`). Refusals are HttpErrors (413 above `maxBytes`, 507, 408,
   * 429); IncompleteError when the stream broke. The body is always ended.
   */
  writeTemp(
    key: string,
    body: Readable,
    opts: TransferOptions,
  ): Promise<{ path: string; size: number }>;
  discard(path: string): void;
  /** Deletes expired uploads (also on a timer). */
  sweep(): void;
  shutdown(): void;
}

export function createUploadStore(
  dir: string,
  deps: {
    log: Logger;
    now?: () => number;
    freeBytes?: (dir: string) => number;
    /** Tests: smaller limits and timeouts than the real ones. */
    limits?: Partial<UploadLimits>;
    timeouts?: Partial<typeof UPLOAD_TIMEOUTS>;
  },
): UploadStore {
  const now = deps.now ?? Date.now;
  const limits = { ...UPLOAD_LIMITS, ...deps.limits };
  const timeouts = { ...UPLOAD_TIMEOUTS, ...deps.timeouts };
  const log = deps.log;
  const freeBytes =
    deps.freeBytes ??
    ((d: string) => {
      const s = statfsSync(d);
      return Number(s.bavail) * Number(s.bsize);
    });
  // Nothing outlives a restart: whatever is left from before is deleted.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const uploads = new Map<string, McpUpload>();
  const perHour = new WindowLimiter({ ...limits.perHour, now });
  const active = new Map<string, number>();
  let activeTotal = 0;
  /** Bytes the transfers in progress may still write: counted as used disk. */
  let reserved = 0;

  const remove = (path: string) => rmSync(path, { force: true });

  /** Disk space a new transfer may use (Infinity when the free space cannot be read). */
  function diskRoom(): number {
    try {
      return freeBytes(dir) - reserved - limits.minFreeBytes;
    } catch {
      return Number.POSITIVE_INFINITY; // the write itself fails when the disk is full
    }
  }

  /** WhatsApp's limit, or the disk when it leaves less room; refused at once when nothing fits. */
  function allowance(opts: TransferOptions): Allowance {
    const room = diskRoom();
    const wa = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    const a: Allowance =
      room < wa
        ? { max: room, refusal: storageFull }
        : { max: wa, refusal: () => tooLargeForWhatsApp(wa) };
    if (a.max <= 0) throw storageFull();
    if (opts.declaredLength !== undefined && opts.declaredLength > a.max) throw a.refusal();
    return a;
  }

  /** One transfer slot of `key`, with its possible size reserved on disk while it runs. */
  async function transfer(key: string, body: Readable, opts: TransferOptions) {
    const a = allowance(opts);
    const mine = active.get(key) ?? 0;
    if (mine >= limits.activePerKey || activeTotal >= limits.activeTotal)
      throw errors.rateLimited(5);
    // A declared size is held for the transfer; an unknown one only has the room left when it began
    // (and a full disk ends it with a 507).
    const reserve = Math.min(opts.declaredLength ?? 0, a.max);
    active.set(key, mine + 1);
    activeTotal++;
    reserved += reserve;
    try {
      return await write(body, a.max);
    } catch (err) {
      throw err instanceof TooLargeError ? a.refusal() : err;
    } finally {
      active.set(key, (active.get(key) ?? 1) - 1);
      activeTotal--;
      reserved -= reserve;
    }
  }

  /** Streams into a new private file; deletes the file on any failure. */
  async function write(body: Readable, max: number): Promise<{ path: string; size: number }> {
    const path = join(dir, `${randomBytes(16).toString('hex')}.bin`);
    // Fastify has no request timeout: a sender that stalls or trickles never holds a slot for long.
    const abort = new AbortController();
    const idle = setTimeout(() => abort.abort(), timeouts.idleMs);
    const total = setTimeout(() => abort.abort(), timeouts.totalMs);
    const counter = new ByteCounter(max, () => idle.refresh());
    try {
      await pipeline(body, counter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
        signal: abort.signal,
      });
      return { path, size: counter.bytes };
    } catch (err) {
      remove(path);
      throw writeFailure(err, counter.bytes > max, abort.signal.aborted);
    } finally {
      clearTimeout(idle);
      clearTimeout(total);
    }
  }

  function sweep() {
    const t = now();
    for (const u of uploads.values()) {
      if (u.expiresAt > t) continue;
      uploads.delete(u.id);
      remove(u.path);
      log.info({ tokenId: u.tokenId, uploadId: u.id }, 'mcp upload expired');
    }
  }
  const timer = setInterval(sweep, 5 * 60_000);
  timer.unref();

  function get(tokenId: number, id: string): McpUpload | null {
    if (!UPLOAD_ID.test(id)) return null;
    const u = uploads.get(id);
    if (u?.tokenId !== tokenId) return null;
    if (u.expiresAt <= now()) {
      uploads.delete(id);
      remove(u.path);
      return null;
    }
    return u;
  }

  /** The type of a received file from its bytes, or a 415 (the file is deleted). */
  async function typeOf(path: string) {
    const type = await fileTypeFromFile(path).catch(() => undefined);
    const ext = type ? MCP_UPLOAD_TYPES.get(type.mime) : undefined;
    if (type && ext) return { mime: type.mime, ext };
    remove(path);
    throw new HttpError(
      415,
      'upload_type',
      'Only JPEG, PNG or WebP images, PDF or Word (.docx) files and MP4 videos can be uploaded.',
    );
  }

  return {
    async receive(tokenId, body, opts) {
      sweep();
      const hit = perHour.hit(String(tokenId));
      if (!hit.allowed) throw errors.rateLimited(hit.retryAfterSec);
      if (
        [...uploads.values()].filter((u) => u.tokenId === tokenId).length >= limits.pendingPerToken
      )
        throw new HttpError(
          429,
          'upload_pending_limit',
          `This token has ${limits.pendingPerToken} uploads waiting; send them or wait until they expire.`,
        );
      const started = now();
      const file = await transfer(`token:${tokenId}`, body, opts).catch((err: unknown) => {
        throw err instanceof IncompleteError
          ? new HttpError(
              400,
              'upload_incomplete',
              'The upload stopped before the whole file arrived.',
            )
          : err;
      });
      if (!file.size) {
        remove(file.path);
        throw errors.validation('The file is empty.');
      }
      const type = await typeOf(file.path);
      const upload: McpUpload = {
        id: `upl_${randomBytes(16).toString('hex')}`,
        tokenId,
        path: file.path,
        name: cleanUploadName(opts.name),
        ...type,
        size: file.size,
        expiresAt: now() + MCP_UPLOAD_TTL_MS,
      };
      uploads.set(upload.id, upload);
      // ids, type and size only: never the name or the content
      log.info(
        { tokenId, uploadId: upload.id, type: upload.mime, size: upload.size, ms: now() - started },
        'mcp upload',
      );
      const { id: uploadId, name, mime, size, expiresAt } = upload;
      return { uploadId, name, type: mime, size, expiresAt };
    },

    get,

    take(tokenId, id) {
      const u = get(tokenId, id);
      if (u) uploads.delete(id);
      return u;
    },

    restore(upload) {
      if (upload.expiresAt <= now() || !existsSync(upload.path)) remove(upload.path);
      else uploads.set(upload.id, upload);
    },

    async writeTemp(key, body, opts) {
      try {
        return await transfer(key, body, opts);
      } finally {
        // a refused or failed download never leaves its connection open
        body.destroy();
      }
    },

    discard: remove,
    sweep,

    shutdown() {
      clearInterval(timer);
    },
  };
}

/** What a failed write means: too large, too slow, a full disk, or a body that broke off. */
function writeFailure(err: unknown, over: boolean, timedOut: boolean): Error {
  if (over || err instanceof ResponseTooLargeError) return new TooLargeError();
  if (timedOut)
    return new HttpError(408, 'upload_timeout', 'The upload was too slow and was stopped.');
  if ((err as { code?: string }).code === 'ENOSPC') return storageFull();
  return new IncompleteError();
}

declare module '../context.js' {
  interface Services {
    uploads?: UploadStore;
  }
}

/** The server's one upload store (`<data>/uploads/`), created on first use. */
export function uploadStore(ctx: AppContext): UploadStore {
  ctx.services.uploads ??= createUploadStore(join(ctx.config.dataDir, 'uploads'), {
    log: ctx.log.child({ mod: 'uploads' }),
  });
  return ctx.services.uploads;
}

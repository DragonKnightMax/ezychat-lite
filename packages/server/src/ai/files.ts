import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { constants, inflateSync } from 'node:zlib';
import { fileTypeFromFile } from 'file-type';
import type { Message } from '@ezychat/shared';
import type { AiPromptImage, AiPromptPdf } from './provider-types.js';
import {
  AI_IMAGE_WAIT_MS,
  AI_LIVE_MEDIA_MS,
  AI_MAX_IMAGE_BYTES,
  AI_MAX_IMAGES,
  sniffImageMime,
} from './images.js';
import { extractKnowledgeIsolated } from './knowledge-worker.js';

/** At most this many PDFs (the newest of the batch) go to one answer. */
export const AI_MAX_PDFS = 3;
/** Larger PDFs are not read. */
export const AI_MAX_PDF_BYTES = 10 * 1024 * 1024;
/** PDFs with more pages are not read (cost and time of one answer). */
export const AI_MAX_PDF_PAGES = 20;
/** Bound for decompressing a PDF's object streams while counting its pages. */
const PDF_INFLATE_BYTES = 8 * 1024 * 1024;
const PDF_MAX_OBJECT_STREAMS = 200;

/**
 * The files of one batch the model is given (design docs/features/group-agents/design.md, Part C):
 * photos (JPEG/PNG/WebP) and PDFs the person sent. Owned by the files work; `service.ts` only calls
 * `collectPromptFiles`.
 */
export interface PromptFileDeps {
  /** Waits until a live download finishes (or the deadline / abort). */
  waitForMedia(messageId: string, signal: AbortSignal, deadline: number): Promise<void>;
  mediaPending(messageId: string): boolean;
  mediaPath(messageId: string): { path: string } | null;
  /** WhatsApp Safety level of a message; `high` files never reach the model. */
  safetyLevel(messageId: string): string | null;
}

export type SkippedFileReason = 'type' | 'size' | 'pages' | 'safety' | 'unreadable' | 'limit';

export interface SkippedFile {
  messageId: string;
  reason: SkippedFileReason;
  /** What the file is, from its bytes (for the note): Word, Excel, PowerPoint, ZIP, PDF, photo, file. */
  kind?: string;
}

export interface PromptFiles {
  images: AiPromptImage[];
  pdfs: AiPromptPdf[];
  /** Files of the batch the model was not given (type, size, pages, safety or over the limit), for the prompt note. */
  skipped: SkippedFile[];
}

export interface CollectPromptFilesOptions {
  /** Images per turn (default AI_MAX_IMAGES = 3; 10 for an agent that adds sheet rows). */
  maxImages?: number;
  /** PDFs per turn (default and maximum AI_MAX_PDFS). */
  maxPdfs?: number;
  /**
   * Also extract each PDF's text layer (for the ChatGPT sign-in mode, which takes no files).
   * Default true; pass false for the API key and Claude modes to save the worker round trip.
   */
  textLayer?: boolean;
  signal: AbortSignal;
  /** Text-layer extractor; tests replace it. Default: the isolated document worker. */
  extractText?: (buffer: Buffer) => Promise<string | null>;
}

/**
 * The newest images and PDFs the person sent in a batch (newest first while collecting, returned
 * oldest first), each type decided from the file's bytes, never its name or declared type. One
 * live-download wait budget for the whole batch; imported history media is never waited for.
 * High-risk files (WhatsApp Safety) are never read. Other documents are listed as skipped.
 */
export async function collectPromptFiles(
  batch: readonly Message[],
  deps: PromptFileDeps,
  options: CollectPromptFilesOptions,
): Promise<PromptFiles> {
  const found = new FoundFiles(
    Math.max(0, options.maxImages ?? AI_MAX_IMAGES),
    Math.min(AI_MAX_PDFS, Math.max(0, options.maxPdfs ?? AI_MAX_PDFS)),
  );
  const deadline = Date.now() + AI_IMAGE_WAIT_MS;
  for (const message of batch.toReversed()) {
    if (options.signal.aborted) break;
    if (!found.wanted(message, deps)) continue;
    // Sequential on purpose: newest first, one shared wait deadline, and each file's kind decides
    // whether the next one still fits the limits.
    await deps.waitForMedia(message.id, options.signal, deadline);
    const file = deps.mediaPath(message.id);
    found.add(message, file ? await readPromptFile(file.path) : { reason: 'unreadable' });
  }
  const extract = options.extractText ?? defaultExtractText;
  const pdfs = await Promise.all(
    found.pdfs.map(async ({ buffer, ...pdf }): Promise<AiPromptPdf> => ({
      ...pdf,
      base64: buffer.toString('base64'),
      text: options.textLayer === false ? null : await textOrNull(extract, buffer, options.signal),
    })),
  );
  return {
    images: found.images.toReversed(),
    pdfs: pdfs.toReversed(),
    skipped: found.skipped.toReversed(),
  };
}

/** The files found so far (newest first) and the limits they fill. */
class FoundFiles {
  readonly images: AiPromptImage[] = [];
  readonly pdfs: Array<Omit<AiPromptPdf, 'text'> & { buffer: Buffer }> = [];
  readonly skipped: SkippedFile[] = [];
  constructor(
    private readonly maxImages: number,
    private readonly maxPdfs: number,
  ) {}

  private full(kind: 'image' | 'pdf'): boolean {
    return kind === 'image'
      ? this.images.length >= this.maxImages
      : this.pdfs.length >= this.maxPdfs;
  }

  /** Whether to wait for and read this message's file; records why not when it is a skipped file. */
  wanted(message: Message, deps: PromptFileDeps): boolean {
    if (message.fromMe || (message.type !== 'image' && message.type !== 'document')) return false;
    if (deps.safetyLevel(message.id) === 'high') {
      this.skipped.push({ messageId: message.id, reason: 'safety' });
      return false;
    }
    // Imported history media stays pending until someone opens it: never wait for it.
    if (deps.mediaPending(message.id) && Date.now() - message.timestamp > AI_LIVE_MEDIA_MS) {
      return false;
    }
    // A photo over the limit is not waited for; a document may still turn out to be either kind.
    if (message.type === 'image' && this.full('image')) {
      this.skipped.push({ messageId: message.id, reason: 'limit', kind: 'photo' });
      return false;
    }
    return true;
  }

  add(message: Message, read: ReadFile): void {
    const id = message.id;
    if ('reason' in read) {
      this.skipped.push({ messageId: id, reason: read.reason, ...kindOf(read) });
    } else if (read.kind === 'image') {
      if (this.full('image')) this.skipped.push({ messageId: id, reason: 'limit', kind: 'photo' });
      else this.images.push(read.image);
    } else if (this.full('pdf')) {
      this.skipped.push({ messageId: id, reason: 'limit', kind: 'PDF' });
    } else {
      const name = pdfName(message.mediaName);
      this.pdfs.push({ name, base64: '', pages: read.pages, buffer: read.buffer });
    }
  }
}

const kindOf = (read: { kind?: string }) =>
  'kind' in read && read.kind ? { kind: read.kind } : {};

type ReadFile =
  | { kind: 'image'; image: AiPromptImage }
  | { kind: 'pdf'; buffer: Buffer; pages: number }
  | { reason: SkippedFileReason; kind?: string };

/** One stored file as a prompt image or PDF, or why it is not given to the model. */
export async function readPromptFile(path: string): Promise<ReadFile> {
  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) return { reason: 'unreadable' };
    size = info.size;
  } catch {
    return { reason: 'unreadable' };
  }
  let head: Buffer;
  try {
    head = readHead(path, size);
  } catch {
    return { reason: 'unreadable' };
  }
  const imageMime = sniffImageMime(head);
  if (imageMime) {
    if (size > AI_MAX_IMAGE_BYTES) return { reason: 'size', kind: 'photo' };
    const bytes = readBounded(path, AI_MAX_IMAGE_BYTES);
    return bytes
      ? { kind: 'image', image: { mime: imageMime, base64: bytes.toString('base64') } }
      : { reason: 'unreadable', kind: 'photo' };
  }
  if (!isPdf(head)) return { reason: 'type', kind: await documentKind(path) };
  if (size > AI_MAX_PDF_BYTES) return { reason: 'size', kind: 'PDF' };
  const buffer = readBounded(path, AI_MAX_PDF_BYTES);
  if (!buffer) return { reason: 'unreadable', kind: 'PDF' };
  const pages = countPdfPages(buffer);
  if (pages === null) return { reason: 'unreadable', kind: 'PDF' };
  if (pages > AI_MAX_PDF_PAGES) return { reason: 'pages', kind: 'PDF' };
  return { kind: 'pdf', buffer, pages };
}

/** The first bytes only: a large file of another type is never read in full. */
function readHead(path: string, size: number): Buffer {
  const head = Buffer.alloc(Math.min(size, 16));
  const fd = openSync(path, 'r');
  try {
    return head.subarray(0, readSync(fd, head, 0, head.length, 0));
  } finally {
    closeSync(fd);
  }
}

/** The whole file, or null when it grew past the bound or cannot be read. */
function readBounded(path: string, max: number): Buffer | null {
  try {
    const bytes = readFileSync(path);
    return bytes.length > 0 && bytes.length <= max ? bytes : null;
  } catch {
    return null;
  }
}

/** A PDF starts with `%PDF-` (the header the PDF reader also requires). */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/** A plain name for a file the AI cannot open, from its bytes (labels the note only). */
async function documentKind(path: string): Promise<string> {
  try {
    const type = await fileTypeFromFile(path);
    switch (type?.ext) {
      case 'docx':
      case 'doc':
      case 'rtf':
      case 'odt':
        return 'Word';
      case 'xlsx':
      case 'xls':
      case 'ods':
        return 'Excel';
      case 'pptx':
      case 'ppt':
      case 'odp':
        return 'PowerPoint';
      case 'zip':
      case 'rar':
      case '7z':
      case 'gz':
      case 'tar':
        return 'ZIP';
      default:
        return 'file';
    }
  } catch {
    return 'file';
  }
}

/** The file name the model sees (the sheet's Source column uses it): one plain line, bounded. */
export function pdfName(name: string | null | undefined): string {
  const isControl = (char: string) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;
  const clean = Array.from(name ?? '', (char) => (isControl(char) ? ' ' : char))
    .join('')
    .trim()
    .slice(0, 120);
  return clean || 'document.pdf';
}

/**
 * The page count of a PDF read from its structure, never by running or rendering it: the largest
 * `/Count` of a `/Type /Pages` dictionary (the page tree root), else the number of `/Type /Page`
 * objects. Compressed object streams (PDF 1.5+) are inflated with a bound. Null when no page is
 * found or the file is encrypted (no model could read it either).
 */
export function countPdfPages(bytes: Buffer): number | null {
  const raw = bytes.toString('latin1');
  if (/\/Encrypt(?![A-Za-z])/.test(raw)) return null;
  const sources = [stripStreams(raw), ...objectStreams(bytes, raw)];
  let count = 0;
  let leaves = 0;
  for (const source of sources) {
    count = Math.max(count, pageTreeCount(source));
    leaves += source.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  }
  const pages = count || leaves;
  return pages > 0 ? pages : null;
}

const stripStreams = (text: string) => text.replace(/stream\r?\n[\s\S]*?endstream/g, ' ');

/** The largest /Count of a /Type /Pages dictionary, read innermost dictionaries first. */
function pageTreeCount(text: string): number {
  // Hex strings (<0a1b>) would hide the dictionary brackets; they never hold a page count.
  let rest = text.replace(/<[0-9A-Fa-f\s]*>/g, ' ');
  let count = 0;
  for (let depth = 0; depth < 32; depth++) {
    let found = false;
    rest = rest.replace(/<<([^<>]*)>>/g, (_match, body: string) => {
      found = true;
      if (/\/Type\s*\/Pages(?![A-Za-z])/.test(body)) {
        const value = /\/Count\s+(\d{1,6})(?!\d)/.exec(body);
        if (value) count = Math.max(count, Number(value[1]));
      }
      return ' ';
    });
    if (!found) break;
  }
  return count;
}

/** The decompressed text of the file's Flate object streams (bounded in count and size). */
function objectStreams(bytes: Buffer, raw: string): string[] {
  const out: string[] = [];
  let budget = PDF_INFLATE_BYTES;
  const marker = /\/Type\s*\/ObjStm(?![A-Za-z])/g;
  for (const match of raw.matchAll(marker)) {
    if (out.length >= PDF_MAX_OBJECT_STREAMS || budget <= 0) break;
    const keyword = raw.indexOf('stream', match.index);
    if (keyword === -1) break;
    const dictionary = raw.slice(match.index, keyword);
    if (!/\/FlateDecode(?![A-Za-z])/.test(dictionary) || /\/DecodeParms/.test(dictionary)) continue;
    let start = keyword + 'stream'.length;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    const end = raw.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      const text = inflateSync(bytes.subarray(start, end), {
        maxOutputLength: budget,
        finishFlush: constants.Z_SYNC_FLUSH,
      }).toString('latin1');
      budget -= text.length;
      out.push(text);
    } catch {
      // A broken or oversized stream is not counted.
    }
  }
  return out;
}

async function textOrNull(
  extract: (buffer: Buffer) => Promise<string | null>,
  buffer: Buffer,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) return null;
  let onAbort = () => {};
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const text = await Promise.race([extract(buffer).catch(() => null), aborted]);
    return text?.trim() ? text : null;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The text layer through the isolated document worker (the Business context extractor: its own
 * thread, memory bound and 15 s limit). A scanned PDF has none: null.
 */
async function defaultExtractText(buffer: Buffer): Promise<string | null> {
  try {
    // A fixed name: the worker picks the PDF reader by extension and never sees the person's name.
    return await extractKnowledgeIsolated('file.pdf', buffer);
  } catch {
    return null;
  }
}

const KIND_ORDER = ['Word', 'Excel', 'PowerPoint', 'ZIP', 'file'] as const;

/**
 * A short neutral note for the input when files of the batch were not given to the model, or null.
 * It names what kind of file it was, never the file name or content.
 */
export function skippedFilesNote(skipped: readonly SkippedFile[]): string | null {
  const lines: string[] = [];
  const of = (reason: SkippedFileReason) => skipped.filter((file) => file.reason === reason);
  const types = of('type');
  if (types.length) {
    const named = KIND_ORDER.filter(
      (kind) => kind !== 'file' && types.some((file) => file.kind === kind),
    );
    const label = named.length ? named.join(', ') : 'not a photo or PDF';
    lines.push(`The person sent a file the AI cannot open (${label}). Ask for a PDF or a photo.`);
  }
  if (of('size').length) {
    lines.push('The person sent a file too large to read. Ask for a smaller PDF or a photo.');
  }
  if (of('pages').length) {
    lines.push(
      `The person sent a PDF with more than ${AI_MAX_PDF_PAGES} pages, which was not read. Ask for the pages that matter.`,
    );
  }
  if (of('unreadable').length) {
    lines.push('The person sent a file that could not be read. Ask them to send it again.');
  }
  if (of('safety').length) {
    lines.push('The person sent a file that WhatsApp Safety flagged as risky; it was not opened.');
  }
  const limit = of('limit').length;
  if (limit) {
    lines.push(
      `${limit} more file${limit === 1 ? '' : 's'} from the person ${limit === 1 ? 'was' : 'were'} not read in this turn (only the newest ones are).`,
    );
  }
  return lines.length ? lines.join(' ') : null;
}

/** Counts for the log line: never names, content or values. */
export function promptFilesLog(files: PromptFiles) {
  return {
    images: files.images.length,
    pdfs: files.pdfs.length,
    pdfPages: files.pdfs.reduce((sum, pdf) => sum + pdf.pages, 0),
    pdfText: files.pdfs.filter((pdf) => pdf.text !== null).length,
    skipped: files.skipped.length,
    skippedTypes: [...new Set(files.skipped.map((file) => file.kind ?? file.reason))].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

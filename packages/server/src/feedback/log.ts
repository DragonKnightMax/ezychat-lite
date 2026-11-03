import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FEEDBACK_LOG_LINES, FEEDBACK_LOG_MAX_BYTES } from '@ezychat/shared';
import { logsDir } from '../admin/logs.js';
import { redactLogLine } from '../log-redaction.js';

/** How much of the newest log file is read to find its last lines. */
const TAIL_BYTES = 512 * 1024;

/**
 * Fields whose values are customer or personal data (message text, names, addresses, numbers,
 * file names) or say where the computer is: their values are replaced, whatever their type.
 */
const DROP_FIELDS = new Set(
  [
    'text',
    'body',
    'caption',
    'content',
    'preview',
    'snippet',
    'quoted',
    'quotedText',
    'q',
    'query',
    'search',
    'title',
    'details',
    'description',
    'note',
    'instructions',
    'question',
    'answer',
    'reply',
    'draft',
    'prompt',
    'word',
    'words',
    'name',
    'pushName',
    'notifyName',
    'verifiedName',
    'displayName',
    'username',
    'about',
    'email',
    'phone',
    'phoneNumber',
    'number',
    'address',
    'company',
    'fileName',
    'filename',
    'ip',
    'remoteAddress',
    'remotePort',
    'clientIp',
    'hostname',
  ].map((f) => f.toLowerCase()),
);

const JID = /[\w.+-]+(?:@|%40)(?:s\.whatsapp\.net|lid|g\.us|c\.us|broadcast|newsletter)\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}\b/gi;
const PHONE = /\+\d[\d\s-]{6,}\d|\b\d{7,}\b/g;

function homeDirPattern(): RegExp | null {
  const home = homedir();
  if (!home || home.length < 3) return null;
  return new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '[\\\\/]+'), 'gi');
}

/** Removes chat ids, emails, internet addresses, phone numbers and the user folder from text. */
export function scrubFeedbackText(text: string, home: RegExp | null = homeDirPattern()): string {
  let out = text;
  if (home) out = out.replace(home, '~');
  return out
    .replace(JID, '[chat]')
    .replace(EMAIL, '[email]')
    .replace(IPV4, '[ip]')
    .replace(IPV6, '[ip]')
    .replace(PHONE, '[number]');
}

function scrub(value: unknown, home: RegExp | null, depth = 0): unknown {
  if (typeof value === 'string') return scrubFeedbackText(value, home);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[removed]';
  if (Array.isArray(value)) return value.map((item) => scrub(item, home, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    out[key] = DROP_FIELDS.has(key.toLowerCase()) ? '[removed]' : scrub(child, home, depth + 1);
  return out;
}

/**
 * One log line as it may leave the computer: the support-export redaction (secrets, tokens,
 * search terms) plus message text, names, numbers, chat ids, emails and internet addresses
 * removed. null for a line that is not a complete JSON record (never sent unexamined).
 */
export function redactFeedbackLogLine(
  line: string,
  home: RegExp | null = homeDirPattern(),
): string | null {
  if (!line.trim()) return null;
  const redacted = redactLogLine(line).trim();
  let record: unknown;
  try {
    record = JSON.parse(redacted);
  } catch {
    /* c8 ignore next 2 -- redactLogLine always returns JSON */
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  // redactLogLine's fail-closed placeholder: nothing useful in it.
  if (Object.keys(record).length === 1 && 'msg' in record && !('level' in record)) return null;
  return JSON.stringify(scrub(record, home));
}

function newestLogFile(dataDir: string): string | null {
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(logsDir(dataDir))) {
      if (!name.endsWith('.log')) continue;
      const file = join(logsDir(dataDir), name);
      try {
        const st = statSync(file);
        if (st.isFile() && (!newest || st.mtimeMs > newest.mtime))
          newest = { file, mtime: st.mtimeMs };
      } catch {
        // rotated away between readdir and stat
      }
    }
  } catch {
    return null;
  }
  return newest?.file ?? null;
}

function tail(file: string): string[] {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, read).toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // started inside a line
    return lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * The redacted last lines of the newest server log, as attached to a report: at most
 * FEEDBACK_LOG_LINES lines and FEEDBACK_LOG_MAX_BYTES (the oldest lines go first).
 */
export function recentFeedbackLog(dataDir: string): { lines: number; text: string } {
  const file = newestLogFile(dataDir);
  if (!file) return { lines: 0, text: '' };
  let raw: string[];
  try {
    raw = tail(file);
  } catch {
    return { lines: 0, text: '' };
  }
  const home = homeDirPattern();
  const kept: string[] = [];
  for (let i = raw.length - 1; i >= 0 && kept.length < FEEDBACK_LOG_LINES; i--) {
    const line = redactFeedbackLogLine(raw[i]!, home);
    if (line) kept.unshift(line);
  }
  let bytes = kept.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
  while (kept.length && bytes > FEEDBACK_LOG_MAX_BYTES)
    bytes -= Buffer.byteLength(kept.shift()!) + 1;
  return { lines: kept.length, text: kept.join('\n') };
}

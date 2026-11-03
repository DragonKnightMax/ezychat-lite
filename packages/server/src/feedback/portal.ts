import { HttpError } from '../http/errors.js';

/** Where Lite sends feedback (the licence portal of Anchor Sprint). */
export const FEEDBACK_PORTAL_URL = 'https://license.anchorsprint.app/v1/feedback';
/** Dev and test only (`--mode dev --fake-wa`): a local portal or a fake. */
export const FEEDBACK_URL_ENV = 'EZYCHAT_FEEDBACK_URL';
export const FEEDBACK_TIMEOUT_MS = 30_000;
/** The portal answers a small JSON object; anything larger is not read. */
export const FEEDBACK_RESPONSE_MAX_BYTES = 16 * 1024;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `${origin}/v1/feedback` for an edition's own portal (`feedbackAuth().portalOrigin`): https, or
 * http only to this computer (a dev portal). null for anything else.
 */
export function portalUrlFromOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  return ok ? `${url.origin}/v1/feedback` : null;
}

export interface PortalFile {
  name: string;
  type: string;
  bytes: Buffer;
}

const unreachable = () =>
  new HttpError(502, 'feedback_unreachable', 'Could not reach the EzyChat feedback service');

async function readCapped(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FEEDBACK_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const field = (data: unknown, key: string): unknown =>
  data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;

/**
 * Posts one report to the portal (multipart: `report` JSON + `file` parts) and returns its
 * reference. No retries, no redirects, 30 s. Portal answers become the app's errors: 400/413/415/429
 * pass through, 403 product_closed → 503 feedback_closed, anything else → 502 feedback_unreachable.
 */
export async function forwardFeedback(opts: {
  url: string;
  report: Record<string, unknown>;
  files: readonly PortalFile[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const form = new FormData();
  form.append('report', JSON.stringify(opts.report));
  for (const f of opts.files)
    form.append('file', new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name);
  let res: Response;
  let data: unknown;
  try {
    res = await (opts.fetch ?? fetch)(opts.url, {
      method: 'POST',
      body: form,
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? FEEDBACK_TIMEOUT_MS),
    });
    data = await readCapped(res);
  } catch {
    throw unreachable();
  }
  const error = field(data, 'error');
  if (res.status === 201 || res.status === 200) {
    const reference = field(data, 'reference');
    if (typeof reference === 'string' && /^[\w-]{1,40}$/.test(reference)) return reference;
    throw unreachable();
  }
  if (res.status === 400) {
    const name = field(data, 'field');
    const what = typeof name === 'string' && /^[\w.]{1,40}$/.test(name) ? name : 'report';
    throw new HttpError(400, 'validation', `The feedback service refused the ${what} field`);
  }
  if (res.status === 413) throw new HttpError(413, 'too_large', 'The files are too large to send');
  if (res.status === 415)
    throw new HttpError(415, 'file_type', 'This kind of file cannot be attached');
  if (res.status === 429) {
    const after = Number(field(data, 'retryAfterSeconds'));
    const seconds = Number.isFinite(after) && after > 0 ? Math.min(Math.ceil(after), 86_400) : 3600;
    throw new HttpError(429, 'rate_limited', `Too many reports, retry in ${seconds}s`, {
      'retry-after': String(seconds),
    });
  }
  if (res.status === 403 && error === 'product_closed')
    throw new HttpError(503, 'feedback_closed', 'Sending feedback from the app is closed for now');
  throw unreachable();
}

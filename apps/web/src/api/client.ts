import type { z } from 'zod';
import { ApiErrorSchema } from '@ezychat/shared';
import { accessGateCode, dispatchAccessClosed } from '@/access/events';
import { i18n } from '@/i18n';
import type enErrors from '@/i18n/locales/en/errors.json';

export const UNAUTHORIZED_EVENT = 'wati:unauthorized';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiInit<T> {
  method?: string;
  body?: unknown;
  form?: FormData;
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

/**
 * Fetch `/api${path}` with same-origin cookies. JSON in / JSON out.
 * Non-2xx → ApiError (code/message from the server's `{ error: { code, message } }` body).
 * 401 additionally dispatches a `wati:unauthorized` window event.
 */
export async function api<T = unknown>(path: string, init: ApiInit<T> = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      credentials: 'same-origin',
      signal: init.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }

  const data = parseBody(res.status === 204 ? '' : await res.text());

  if (!res.ok) throw failure(res.status, res.statusText, data);

  if (init.schema) return init.schema.parse(data);
  return data as T;
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The ApiError of a non-2xx answer (code/message from `{ error: { code, message } }`, else
 * `http_<status>`); a closed access gate and a 401 also dispatch their window events.
 */
function failure(status: number, statusText: string, data: unknown): ApiError {
  // The edition closed the access gate: the AccessGate swaps the app for the lock screen.
  // No unauthorized event, so no sign-in redirect loop.
  const gateCode = accessGateCode(status, data);
  if (gateCode) {
    dispatchAccessClosed(gateCode);
    return new ApiError(403, gateCode, 'The app is not available right now.');
  }
  if (status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  const parsed = ApiErrorSchema.safeParse(data);
  if (parsed.success)
    return new ApiError(status, parsed.data.error.code, parsed.data.error.message);
  return new ApiError(status, `http_${status}`, statusText || `Request failed (${status})`);
}

/**
 * POST a form to `/api${path}` with upload progress (fetch reports none): `onProgress` gets the share
 * sent so far. Same answers and errors as `api()`.
 */
export function apiUpload<T = unknown>(
  path: string,
  form: FormData,
  onProgress: (share: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () =>
      reject(new ApiError(0, 'network', 'Cannot reach the server. Check your connection.'));
    xhr.onload = () => {
      const data = parseBody(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(failure(xhr.status, xhr.statusText, data));
    };
    xhr.send(form);
  });
}

type KnownErrorKey = `known.${keyof (typeof enErrors)['known']}`;

/**
 * Server messages that have a translation. API errors stay English on the wire (logs stay
 * greppable); add an entry here and to `errors.json` to translate another one.
 */
const KNOWN_SERVER_MESSAGES = new Map<string, KnownErrorKey>([
  ['Invalid username or password', 'known.invalidCredentials'],
  ['Current password is incorrect', 'known.currentPasswordIncorrect'],
  ['New password must differ from the current password', 'known.newPassSame'],
  ['Admin only', 'known.adminOnly'],
  ['Password change required', 'known.passwordChangeRequired'],
  ['First-time setup is only allowed from this computer', 'known.setupLocalOnly'],
  ['You cannot disable your own account', 'known.cannotDisableSelf'],
  ['Cannot demote or disable the last active admin', 'known.lastAdmin'],
  ['Username already exists', 'known.usernameExists'],
  ['Assignee must be an active user', 'known.assigneeInactive'],
  ['Media is no longer available', 'known.mediaUnavailable'],
  ['Only failed outgoing messages can be retried', 'known.onlyFailedRetry'],
  ['This message can no longer be re-sent', 'known.cannotResend'],
  ['Message is already being re-sent', 'known.alreadyResending'],
  ['Empty file', 'known.emptyFile'],
  ['Sign in to Cloudflare first.', 'known.cloudflareSignInFirst'],
  ['Choose a domain from your Cloudflare account.', 'known.cloudflareChooseDomain'],
  ['Finish the current Cloudflare setup first.', 'known.cloudflareFinishSetup'],
  [
    'Finish or cancel Cloudflare setup before changing remote access.',
    'known.cloudflareFinishBeforeChange',
  ],
  ['That tunnel name is already in use. Choose another name.', 'known.tunnelNameInUse'],
  ['This address is already in use. Choose another address.', 'known.addressInUse'],
  ['A tunnel token is required for a named tunnel', 'known.tunnelTokenRequired'],
]);

/** Error codes whose meaning doesn't depend on the server's free-form message. */
const GENERIC_CODES = [
  'network',
  'rate_limited',
  'unauthorized',
  'forbidden',
  'not_found',
  'bad_origin',
  'wa_unavailable',
] as const;
const isGenericCode = (code: string): code is (typeof GENERIC_CODES)[number] =>
  (GENERIC_CODES as readonly string[]).includes(code);

/** Friendly, translated message for any thrown error. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const known = KNOWN_SERVER_MESSAGES.get(e.message);
    if (known) return i18n.t(`errors:${known}`);
    const retry = e.code === 'rate_limited' ? /retry in (\d+)s/.exec(e.message)?.[1] : undefined;
    if (retry) return i18n.t('errors:rate_limited_retry', { seconds: Number(retry) });
    if (isGenericCode(e.code)) return i18n.t(`errors:${e.code}`);
    if (e.status >= 500 && !e.message) return i18n.t('errors:server');
    // validation / conflict / feature-specific codes carry a specific English explanation.
    return e.message || i18n.t('errors:generic');
  }
  if (e instanceof Error) return e.message;
  return i18n.t('errors:generic');
}

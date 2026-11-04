import type { z } from 'zod';
import { ApiErrorSchema } from '@ezychat/shared';
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

  const text = res.status === 204 ? '' : await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const parsed = ApiErrorSchema.safeParse(data);
    if (parsed.success)
      throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
    throw new ApiError(
      res.status,
      `http_${res.status}`,
      res.statusText || `Request failed (${res.status})`,
    );
  }

  if (init.schema) return init.schema.parse(data);
  return data as T;
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

/**
 * Google OAuth ("installed app" flow with PKCE S256) and the few Calendar REST v3 calls the
 * connector needs. Base URLs and `fetch` are injectable, so tests and `--fake-wa` never reach Google.
 *
 * Never log tokens, codes, URLs with codes, event text, names or phone numbers.
 */
import { decodeJwtPayload } from '../../ai/chatgpt-oauth.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned',
] as const;
/** Without these the connector cannot work at all (booking also needs the events scope). */
export const REQUIRED_SCOPES = [GOOGLE_SCOPES[2], GOOGLE_SCOPES[3]] as const;
export const EVENTS_SCOPE = GOOGLE_SCOPES[4];

export interface GoogleEndpoints {
  auth: string;
  token: string;
  api: string;
  revoke: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  api: 'https://www.googleapis.com/calendar/v3',
  revoke: 'https://oauth2.googleapis.com/revoke',
};

export const GOOGLE_TIMEOUT_MS = 10_000;
/** Largest response body read from Google. */
export const GOOGLE_MAX_BYTES = 2 * 1024 * 1024;

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
}

/**
 * `expired`: Google refused the saved sign-in (invalid_grant, or 401 with a fresh token).
 * `unavailable`: network error, timeout, 429 or 5xx. `rejected`: any other 4xx (e.g. 403 on a
 * calendar the account cannot write).
 */
export type GoogleErrorKind = 'expired' | 'unavailable' | 'rejected';

export class GoogleError extends Error {
  override name = 'GoogleError';
  constructor(
    readonly kind: GoogleErrorKind,
    readonly status: number | null = null,
  ) {
    super(`Google ${kind}${status ? ` (${status})` : ''}`);
  }
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string[];
  account: string | null;
}

export interface GoogleCalendarEntry {
  id: string;
  name: string;
  primary: boolean;
  accessRole: string;
}

export interface GoogleEventInput {
  id: string;
  summary: string;
  description: string;
  start: number;
  end: number;
  timeZone: string;
}

type FetchFn = typeof fetch;

/** Reads at most GOOGLE_MAX_BYTES of the body; larger answers count as unavailable. */
async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > GOOGLE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new GoogleError('unavailable');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    throw new GoogleError('unavailable');
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : null);

export class GoogleClient {
  constructor(
    readonly app: GoogleApp,
    readonly endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  /** Google's sign-in page; `scopes` defaults to the calendar's (another Google connector passes its own). */
  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    challenge: string;
    scopes?: readonly string[];
  }): string {
    const url = new URL(this.endpoints.auth);
    url.searchParams.set('client_id', this.app.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', (input.scopes ?? GOOGLE_SCOPES).join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  /** One request with a 10 s timeout, no redirects, a bounded body; errors mapped to GoogleError. */
  protected async request(
    url: string,
    init: RequestInit,
    expiredOn401 = true,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(GOOGLE_TIMEOUT_MS)])
          : AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new GoogleError('unavailable');
    }
    const json = parseJson(await readBody(response));
    if (response.ok) return { status: response.status, json };
    const status = response.status;
    if (status === 429 || status >= 500) throw new GoogleError('unavailable', status);
    if (status === 401 && expiredOn401) throw new GoogleError('expired', status);
    if (status === 400 && str(json.error) === 'invalid_grant')
      throw new GoogleError('expired', status);
    throw new GoogleError('rejected', status);
  }

  private async tokenRequest(
    body: URLSearchParams,
    previousRefresh: string | null,
  ): Promise<GoogleTokens> {
    body.set('client_id', this.app.clientId);
    body.set('client_secret', this.app.clientSecret);
    const { json } = await this.request(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const accessToken = str(json.access_token);
    const refreshToken = str(json.refresh_token) ?? previousRefresh;
    if (!accessToken || !refreshToken) throw new GoogleError('rejected');
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    const email = str(decodeJwtPayload(str(json.id_token))?.email);
    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      scope: (str(json.scope) ?? '').split(/\s+/).filter(Boolean),
      account: email,
    };
  }

  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<GoogleTokens> {
    return this.tokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      null,
    );
  }

  refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.tokenRequest(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      refreshToken,
    );
  }

  /** Best effort: a failure is ignored (the tokens are deleted here anyway). */
  async revoke(token: string): Promise<void> {
    try {
      await this.request(this.endpoints.revoke, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // ignore
    }
  }

  protected api(path: string, token: string, init: RequestInit = {}) {
    return this.request(`${this.endpoints.api}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  }

  async calendarList(token: string, signal?: AbortSignal): Promise<GoogleCalendarEntry[]> {
    const { json } = await this.api('/users/me/calendarList?maxResults=250', token, { signal });
    const items = Array.isArray(json.items) ? (json.items as Array<Record<string, unknown>>) : [];
    return items.slice(0, 250).flatMap((item) => {
      const id = str(item.id);
      if (!id) return [];
      return [
        {
          id: id.slice(0, 300),
          name: (str(item.summaryOverride) ?? str(item.summary) ?? id).slice(0, 200),
          primary: item.primary === true,
          accessRole: str(item.accessRole) ?? 'reader',
        },
      ];
    });
  }

  async freeBusy(
    token: string,
    calendarId: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<Array<{ start: number; end: number }>> {
    const { json } = await this.api('/freeBusy', token, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    const calendars = (json.calendars ?? {}) as Record<string, Record<string, unknown>>;
    const entry = calendars[calendarId];
    if (!entry || (Array.isArray(entry.errors) && entry.errors.length))
      throw new GoogleError('rejected');
    const busy = Array.isArray(entry.busy) ? (entry.busy as Array<Record<string, unknown>>) : [];
    return busy.slice(0, 2000).flatMap((b) => {
      const start = Date.parse(str(b.start) ?? '');
      const end = Date.parse(str(b.end) ?? '');
      return Number.isFinite(start) && Number.isFinite(end) ? [{ start, end }] : [];
    });
  }

  /** Inserts the event with our own id; 409 = it exists already (`false`). */
  async insertEvent(
    token: string,
    calendarId: string,
    event: GoogleEventInput,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.api(`/calendars/${encodeURIComponent(calendarId)}/events`, token, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          id: event.id,
          summary: event.summary,
          description: event.description,
          start: { dateTime: new Date(event.start).toISOString(), timeZone: event.timeZone },
          end: { dateTime: new Date(event.end).toISOString(), timeZone: event.timeZone },
        }),
      });
      return true;
    } catch (error) {
      if (error instanceof GoogleError && error.status === 409) return false;
      throw error;
    }
  }

  /** The event's status, or null when it does not exist. */
  async eventStatus(
    token: string,
    calendarId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const { json } = await this.api(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        token,
        { signal },
      );
      return str(json.status) ?? 'confirmed';
    } catch (error) {
      if (error instanceof GoogleError && (error.status === 404 || error.status === 410))
        return null;
      throw error;
    }
  }
}

/**
 * One Google sign-in of a core connector (Google Sheets; the same flow as Google Calendar's): PKCE
 * S256 with a loopback callback on this server, tokens only in an encrypted setting, refreshed
 * before expiry, a stored problem state (`expired` / `unavailable`) while Google refuses or cannot
 * be reached. One Google account per connector per install.
 *
 * Logs carry events, states and counts only: never tokens, codes or URLs with codes.
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  GoogleCalendarConnectProgress,
  GoogleCalendarConnectStart,
  GoogleCalendarState,
} from '@ezychat/shared';
import { createPkce } from '../ai/chatgpt-oauth.js';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { HttpError } from '../http/errors.js';
import { GoogleError, type GoogleClient, type GoogleTokens } from './google-calendar/google.js';

export const CONNECT_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
/** Refresh this long before the access token runs out. */
const REFRESH_EARLY_MS = 60_000;

export interface StoredGoogleTokens extends GoogleTokens {
  connectedAt: number;
}

interface Problem {
  state: 'expired' | 'unavailable';
  since: number;
}

interface Pending {
  requestId: string;
  verifier: string;
  challenge: string;
  redirectUri: string;
  createdAt: number;
  userId: number;
  ip: string | null;
  status: GoogleCalendarConnectProgress['status'];
  error: GoogleCalendarConnectProgress['error'];
  used: boolean;
}

export interface CallbackPage {
  status: number;
  title: string;
  message: string;
}

/** The fake Google of `--fake-wa`: its consent page's Allow issues a code for the challenge. */
export interface FakeSignIn {
  issueCode(challenge: string, scope: string): string;
}

export interface GoogleAccountOptions {
  /** Short id for logs and audit actions, e.g. `google_sheets`. */
  key: string;
  /** Shown on the callback page, e.g. "Google Sheets". */
  label: string;
  tokensSetting: string;
  problemSetting: string;
  scopes: readonly string[];
  /** Without these the connector cannot work: the sign-in is refused and revoked. */
  requiredScopes: readonly string[];
  client: GoogleClient | null;
  fake: FakeSignIn | null;
  /** The fake's consent page path (`--fake-wa` only). */
  fakeConsentPath: string;
  now: () => number;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export function createGoogleAccount(ctx: AppContext, options: GoogleAccountOptions) {
  const { client, fake, key, now } = options;
  const log = ctx.log.child({ mod: key.replace(/_/g, '-') });
  const pending = new Map<string, Pending>(); // by state hash
  const byRequest = new Map<string, string>(); // requestId → state hash
  let refreshing: Promise<StoredGoogleTokens> | null = null;
  const listeners = new Set<() => void>();

  const loadTokens = (): StoredGoogleTokens | null => {
    const raw = ctx.settings.getSecret(options.tokensSetting);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as StoredGoogleTokens;
      return value.accessToken && value.refreshToken ? value : null;
    } catch {
      return null;
    }
  };
  const saveTokens = (tokens: StoredGoogleTokens | null) =>
    ctx.settings.setSecret(options.tokensSetting, tokens ? JSON.stringify(tokens) : null);
  const problem = (): Problem | null =>
    ctx.settings.get<Problem | null>(options.problemSetting, null);
  const changed = () => {
    for (const listener of listeners) listener();
  };

  function markProblem(error: unknown) {
    if (!(error instanceof GoogleError) || error.kind === 'rejected') return;
    const current = problem();
    if (error.kind === 'unavailable' && current?.state === 'expired') return;
    if (current?.state === error.kind) return;
    log.warn(
      { event: `${key}_problem`, state: error.kind, status: error.status },
      `${options.label} problem`,
    );
    ctx.settings.set(options.problemSetting, { state: error.kind, since: now() });
  }

  function clearProblem() {
    if (!problem()) return;
    ctx.settings.set(options.problemSetting, null);
    log.info({ event: `${key}_problem`, state: 'connected' }, `${options.label} works again`);
  }

  async function refreshNow(tokens: StoredGoogleTokens): Promise<StoredGoogleTokens> {
    if (!refreshing)
      refreshing = (async () => {
        try {
          const fresh = await client!.refresh(tokens.refreshToken);
          const next: StoredGoogleTokens = {
            ...fresh,
            account: fresh.account ?? tokens.account,
            scope: fresh.scope.length ? fresh.scope : tokens.scope,
            connectedAt: tokens.connectedAt,
          };
          // A disconnect while refreshing wins.
          if (loadTokens()) saveTokens(next);
          return next;
        } finally {
          refreshing = null;
        }
      })();
    return refreshing;
  }

  function prune() {
    const at = now();
    for (const [hash, entry] of pending)
      if (at - entry.createdAt > CONNECT_TTL_MS) {
        pending.delete(hash);
        byRequest.delete(entry.requestId);
      }
  }

  const configured = () => client !== null;

  const account = {
    configured,
    tokens: loadTokens,

    state(): GoogleCalendarState {
      if (!configured()) return 'not_configured';
      if (!loadTokens()) return 'disconnected';
      return problem()?.state ?? 'connected';
    },

    /** When it stopped working (expired/unavailable), else null. */
    problemSince(): number | null {
      const state = account.state();
      return state === 'expired' || state === 'unavailable' ? (problem()?.since ?? null) : null;
    },

    /** Called after a sign-in or a disconnect (caches of the connector are cleared). */
    onChange(listener: () => void) {
      listeners.add(listener);
    },

    /** Runs Google calls with a valid access token; records problems and recoveries. */
    async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
      if (!client) throw new GoogleError('rejected');
      let tokens = loadTokens();
      if (!tokens) throw new GoogleError('rejected');
      try {
        let refreshed = false;
        if (tokens.expiresAt - REFRESH_EARLY_MS <= now()) {
          tokens = await refreshNow(tokens);
          refreshed = true;
        }
        let result: T;
        try {
          result = await fn(tokens.accessToken);
        } catch (error) {
          // An access token Google no longer accepts: refresh once and try again.
          if (refreshed || !(error instanceof GoogleError) || error.status !== 401) throw error;
          tokens = await refreshNow(tokens);
          result = await fn(tokens.accessToken);
        }
        clearProblem();
        return result;
      } catch (error) {
        markProblem(error);
        throw error;
      }
    },

    /** Starts a sign-in: Google (or, with --fake-wa, the local consent page) opens in a new window. */
    startConnect(
      redirectUri: string,
      actor: { userId: number; ip: string | null },
    ): GoogleCalendarConnectStart {
      if (!client)
        throw new HttpError(409, 'not_configured', 'Google sign-in is not set up in this build');
      prune();
      while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value!;
        byRequest.delete(pending.get(oldest)!.requestId);
        pending.delete(oldest);
      }
      const state = randomBytes(24).toString('base64url');
      const { verifier, challenge } = createPkce();
      const requestId = randomBytes(12).toString('hex');
      const hash = sha(state);
      pending.set(hash, {
        requestId,
        verifier,
        challenge,
        redirectUri,
        createdAt: now(),
        userId: actor.userId,
        ip: actor.ip,
        status: 'pending',
        error: null,
        used: false,
      });
      byRequest.set(requestId, hash);
      let authorizationUrl: string;
      if (fake) {
        const url = new URL(options.fakeConsentPath, redirectUri);
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', challenge);
        authorizationUrl = url.toString();
      } else
        authorizationUrl = client.authorizationUrl({
          redirectUri,
          state,
          challenge,
          scopes: options.scopes,
        });
      log.info({ event: `${key}_connect_start` }, 'Google sign-in started');
      return { requestId, authorizationUrl };
    },

    progress(requestId: string): GoogleCalendarConnectProgress | null {
      const hash = byRequest.get(requestId);
      const entry = hash ? pending.get(hash) : undefined;
      if (!entry) return null;
      if (entry.status === 'pending' && now() - entry.createdAt > CONNECT_TTL_MS)
        return { status: 'failed', error: 'expired' };
      return { status: entry.status, error: entry.error };
    },

    /** The redirect from Google: one-time `state`, PKCE verifier, code exchange, tokens saved. */
    async callback(query: Record<string, unknown>): Promise<CallbackPage> {
      const expiredPage: CallbackPage = {
        status: 400,
        title: 'Sign-in link expired',
        message: 'Start the Google sign-in again from EzyChat.',
      };
      const stateParam = typeof query.state === 'string' ? query.state : '';
      const entry = stateParam ? pending.get(sha(stateParam)) : undefined;
      // A forged, reused or stale callback never changes the real sign-in.
      if (!entry || entry.used) return expiredPage;
      entry.used = true;
      if (now() - entry.createdAt > CONNECT_TTL_MS) {
        entry.status = 'failed';
        entry.error = 'expired';
        return expiredPage;
      }
      const fail = (error: 'denied' | 'error', title: string): CallbackPage => {
        entry.status = 'failed';
        entry.error = error;
        log.info({ event: `${key}_connect_failed`, reason: error }, 'Google sign-in failed');
        return {
          status: 400,
          title,
          message: 'You can close this window and try again from EzyChat.',
        };
      };
      if (typeof query.error === 'string' && query.error)
        return fail(query.error === 'access_denied' ? 'denied' : 'error', 'Sign-in cancelled');
      const code = typeof query.code === 'string' ? query.code : '';
      if (!code || code.length > 2048) return fail('error', 'Sign-in failed');
      let tokens: GoogleTokens;
      try {
        tokens = await client!.exchangeCode(code, entry.verifier, entry.redirectUri);
      } catch (error) {
        log.warn(
          { event: `${key}_exchange_failed`, status: (error as GoogleError)?.status ?? null },
          'Google sign-in exchange failed',
        );
        return fail('error', 'Sign-in failed');
      }
      if (!options.requiredScopes.every((scope) => tokens.scope.includes(scope))) {
        await client!.revoke(tokens.refreshToken);
        return fail('error', `${options.label} access was not allowed`);
      }
      saveTokens({ ...tokens, connectedAt: now() });
      ctx.settings.set(options.problemSetting, null);
      entry.status = 'done';
      changed();
      audit(ctx.db, {
        userId: entry.userId,
        action: `${key}.connect`,
        ip: entry.ip,
        meta: { scopes: tokens.scope.length },
      });
      log.info({ event: `${key}_connected`, scopes: tokens.scope.length }, 'Google connected');
      return {
        status: 200,
        title: `${options.label} connected`,
        message: 'You can close this window and return to EzyChat.',
      };
    },

    /** Fake consent page (--fake-wa only): where Allow / Cancel lead, always our own callback. */
    fakeConsent(stateParam: string, allow: boolean): string | null {
      if (!fake) return null;
      const entry = pending.get(sha(stateParam));
      if (!entry || entry.used) return null;
      const url = new URL(entry.redirectUri);
      url.searchParams.set('state', stateParam);
      if (allow)
        url.searchParams.set('code', fake.issueCode(entry.challenge, options.scopes.join(' ')));
      else url.searchParams.set('error', 'access_denied');
      return url.toString();
    },

    async disconnect(actor: { userId: number; ip: string | null }): Promise<void> {
      const tokens = loadTokens();
      saveTokens(null);
      ctx.settings.set(options.problemSetting, null);
      changed();
      if (tokens && client) await client.revoke(tokens.refreshToken);
      audit(ctx.db, { userId: actor.userId, action: `${key}.disconnect`, ip: actor.ip });
      log.info({ event: `${key}_disconnected` }, 'Google disconnected');
    },

    shutdown() {
      pending.clear();
      byRequest.clear();
      listeners.clear();
    },
  };
  return account;
}

export type GoogleAccount = ReturnType<typeof createGoogleAccount>;

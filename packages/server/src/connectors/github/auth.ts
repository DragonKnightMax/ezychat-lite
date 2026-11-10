/**
 * The GitHub sign-in of the connector (design docs/features/github/design.md, "Sign-in"), one per
 * install, two ways:
 *
 * - App: Anchor Sprint's GitHub App through GitHub's device flow, with the public client id only
 *   (no secret). The device code never leaves the server; the page polls by an opaque request id.
 *   Access tokens last 8 h; the refresh token is single-use and a refresh revokes the old access
 *   token at once (spike 2026-11-10), so one refresh runs at a time, the new pair is saved before it
 *   is used, and a 401 is retried once with the newest token.
 * - Token: a fine-grained personal access token (`github_pat_…`), checked with `GET /user`; never a
 *   classic token. No refresh: it warns before and stops after GitHub's expiry.
 *
 * The sign-in lives only in the encrypted setting `github_auth`. Logs carry events and states only.
 */
import { randomBytes } from 'node:crypto';
import type { GitHubDeviceProgress, GitHubMethod, GitHubTokenError } from '@ezychat/shared';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/audit.js';
import { GitHubError, type GitHubClient } from './client.js';

export const AUTH_SETTING = 'github_auth';
export const PROBLEM_SETTING = 'github_problem';
/** Refresh an App token this long before it runs out. */
export const REFRESH_EARLY_MS = 5 * 60_000;
/** `slow_down` adds this to the poll interval. */
export const SLOW_DOWN_MS = 5_000;
const MAX_DEVICE_REQUESTS = 10;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CLASSIC_TOKEN = /^gh[pousr]_/;
const FINE_GRAINED_TOKEN = /^github_pat_[A-Za-z0-9_]{20,}$/;

export interface StoredGitHubAuth {
  method: GitHubMethod;
  login: string;
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  /** Token sign-in: GitHub's expiry of the token, when it has one. */
  tokenExpiresAt?: number;
  connectedAt: number;
}

export interface GitHubProblem {
  state: 'expired' | 'unavailable' | 'no_installation';
  since: number;
}

/** A pasted token EzyChat does not accept (400 `{error: {code}}`). */
export class TokenRefused extends Error {
  constructor(readonly reason: GitHubTokenError) {
    super(`GitHub token refused: ${reason}`);
    this.name = 'TokenRefused';
  }
}

export interface Actor {
  userId: number;
  ip: string | null;
}

interface DeviceRequest {
  requestId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  status: GitHubDeviceProgress['status'];
  actor: Actor;
  polling: Promise<void> | null;
}

/** `2026-12-01 00:00:00 UTC` or `… +0800` (GitHub's header), as ms; null when absent or odd. */
export function parseTokenExpiry(header: string | null): number | null {
  const found = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(
    header?.trim() ?? '',
  );
  if (!found) return null;
  const zone = found[3] === 'UTC' ? 'Z' : `${found[3]!.slice(0, 3)}:${found[3]!.slice(3)}`;
  const at = Date.parse(`${found[1]}T${found[2]}${zone}`);
  return Number.isFinite(at) ? at : null;
}

const seconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
/** `at` plus GitHub's `expires_in`-style seconds, or undefined without one. */
const after = (value: unknown, at: number): number | undefined => {
  const ms = seconds(value);
  return ms === undefined ? undefined : at + ms;
};

export function createGitHubAuth(
  ctx: AppContext,
  options: {
    client: GitHubClient;
    clientId: string;
    now: () => number;
    /** After a device sign-in is saved (the service checks the installations). */
    afterSignIn: () => Promise<void>;
  },
) {
  const { client, clientId, now } = options;
  const log = ctx.log.child({ mod: 'github' });
  const devices = new Map<string, DeviceRequest>();
  let refreshing: Promise<StoredGitHubAuth> | null = null;
  const listeners = new Set<() => void>();

  const load = (): StoredGitHubAuth | null => {
    const raw = ctx.settings.getSecret(AUTH_SETTING);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as StoredGitHubAuth;
      return value.accessToken && value.login ? value : null;
    } catch {
      return null;
    }
  };
  const save = (value: StoredGitHubAuth | null) =>
    ctx.settings.setSecret(AUTH_SETTING, value ? JSON.stringify(value) : null);
  const problem = (): GitHubProblem | null =>
    ctx.settings.get<GitHubProblem | null>(PROBLEM_SETTING, null);
  const changed = () => {
    for (const listener of listeners) listener();
  };

  function setProblem(state: GitHubProblem['state'] | null) {
    const current = problem();
    if ((current?.state ?? null) === state) return;
    // "Sign in again" stays until a new sign-in.
    if (current?.state === 'expired' && state !== null) return;
    ctx.settings.set(PROBLEM_SETTING, state ? { state, since: now() } : null);
    log.info({ event: 'github_problem', state: state ?? 'connected' }, 'GitHub state changed');
  }

  /** The stored sign-in after a refresh (single flight; the newest pair is saved before use). */
  function refresh(usedToken: string): Promise<StoredGitHubAuth> {
    if (refreshing) return refreshing;
    const current = load();
    if (!current) return Promise.reject(new GitHubError('unauthorized'));
    // Another call refreshed since this one read the token: use the newest.
    if (current.accessToken !== usedToken) return Promise.resolve(current);
    refreshing = (async () => {
      try {
        if (!current.refreshToken) throw new GitHubError('unauthorized');
        const answer = await client.oauth('/login/oauth/access_token', {
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
        });
        if (typeof answer.access_token !== 'string' || !answer.access_token) {
          log.warn({ event: 'github_refresh_refused' }, 'GitHub refused the token refresh');
          throw new GitHubError('unauthorized');
        }
        const at = now();
        const next: StoredGitHubAuth = {
          ...current,
          accessToken: answer.access_token,
          refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : undefined,
          accessExpiresAt: after(answer.expires_in, at),
          refreshExpiresAt: after(answer.refresh_token_expires_in, at),
        };
        // A disconnect (or another sign-in) while refreshing wins.
        if (load()?.accessToken === current.accessToken) save(next);
        log.info({ event: 'github_refreshed' }, 'GitHub token refreshed');
        return next;
      } catch (error) {
        if (error instanceof GitHubError && error.kind === 'unauthorized') setProblem('expired');
        throw error;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function pollOnce(entry: DeviceRequest): Promise<void> {
    let answer: Record<string, unknown>;
    try {
      answer = await client.oauth('/login/oauth/access_token', {
        client_id: clientId,
        device_code: entry.deviceCode,
        grant_type: DEVICE_GRANT,
      });
    } catch {
      // GitHub did not answer: try again at the next interval.
      entry.nextPollAt = now() + entry.intervalMs;
      return;
    }
    const error = typeof answer.error === 'string' ? answer.error : null;
    if (error === 'authorization_pending') {
      entry.nextPollAt = now() + entry.intervalMs;
      return;
    }
    if (error === 'slow_down') {
      entry.intervalMs = Math.max(entry.intervalMs + SLOW_DOWN_MS, seconds(answer.interval) ?? 0);
      entry.nextPollAt = now() + entry.intervalMs;
      return;
    }
    if (error === 'access_denied') entry.status = 'denied';
    else if (error === 'expired_token') entry.status = 'expired';
    else if (typeof answer.access_token !== 'string' || !answer.access_token)
      entry.status = 'failed';
    if (entry.status !== 'pending') {
      log.info({ event: 'github_device_end', status: entry.status }, 'GitHub sign-in ended');
      return;
    }
    const accessToken = answer.access_token as string;
    let login: unknown;
    try {
      login = (await client.get<{ login?: unknown }>(accessToken, '/user')).data.login;
    } catch {
      login = null;
    }
    if (typeof login !== 'string' || !login) {
      entry.status = 'failed';
      return;
    }
    const at = now();
    save({
      method: 'app',
      login,
      accessToken,
      refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : undefined,
      accessExpiresAt: after(answer.expires_in, at),
      refreshExpiresAt: after(answer.refresh_token_expires_in, at),
      connectedAt: at,
    });
    ctx.settings.set(PROBLEM_SETTING, null);
    changed();
    audit(ctx.db, {
      userId: entry.actor.userId,
      action: 'github.connect',
      ip: entry.actor.ip,
      meta: { method: 'app' },
    });
    log.info({ event: 'github_connected', method: 'app' }, 'GitHub connected');
    try {
      await options.afterSignIn();
    } catch {
      // The status shows what the installation check found (or GitHub being unavailable).
    }
    entry.status = 'done';
  }

  const auth = {
    load,
    problem,
    setProblem,

    onChange(listener: () => void) {
      listeners.add(listener);
    },

    /** Runs GitHub calls with a valid token: refreshes an App token early or after a 401, once. */
    async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
      let current = load();
      if (!current) throw new GitHubError('unauthorized');
      if (current.method === 'token') {
        if (current.tokenExpiresAt !== undefined && current.tokenExpiresAt <= now())
          throw new GitHubError('unauthorized');
        try {
          return await fn(current.accessToken);
        } catch (error) {
          if (error instanceof GitHubError && error.kind === 'unauthorized') setProblem('expired');
          throw error;
        }
      }
      if (
        current.accessExpiresAt !== undefined &&
        current.accessExpiresAt - REFRESH_EARLY_MS <= now()
      )
        current = await refresh(current.accessToken);
      try {
        return await fn(current.accessToken);
      } catch (error) {
        if (!(error instanceof GitHubError) || error.kind !== 'unauthorized') throw error;
      }
      // A 401: the token was refreshed elsewhere (revoking this one) or GitHub dropped it.
      current = await refresh(current.accessToken);
      try {
        return await fn(current.accessToken);
      } catch (error) {
        if (error instanceof GitHubError && error.kind === 'unauthorized') setProblem('expired');
        throw error;
      }
    },

    /** Starts the App sign-in: GitHub's user code for the page; the device code stays here. */
    async startDevice(actor: Actor) {
      const answer = await client.oauth('/login/device/code', { client_id: clientId });
      const deviceCode = answer.device_code;
      const userCode = answer.user_code;
      const verificationUri = answer.verification_uri;
      if (
        typeof deviceCode !== 'string' ||
        typeof userCode !== 'string' ||
        typeof verificationUri !== 'string' ||
        !/^https:\/\/github\.com\//.test(verificationUri)
      )
        throw new GitHubError('unavailable');
      const at = now();
      for (const [id, entry] of devices)
        if (entry.status !== 'pending' || entry.expiresAt <= at) devices.delete(id);
      while (devices.size >= MAX_DEVICE_REQUESTS) devices.delete(devices.keys().next().value!);
      // GitHub's interval (5 s); the fake of the tests may say 0.
      const intervalMs =
        typeof answer.interval === 'number' && answer.interval >= 0
          ? answer.interval * 1000
          : 5_000;
      const requestId = randomBytes(12).toString('hex');
      devices.set(requestId, {
        requestId,
        deviceCode,
        userCode,
        verificationUri,
        expiresAt: at + (seconds(answer.expires_in) ?? 900_000),
        intervalMs,
        nextPollAt: at + intervalMs,
        status: 'pending',
        actor,
        polling: null,
      });
      log.info({ event: 'github_device_start' }, 'GitHub sign-in started');
      return {
        requestId,
        userCode,
        verificationUri,
        expiresAt: devices.get(requestId)!.expiresAt,
      };
    },

    /**
     * Where a device sign-in stands. The page polls this; GitHub is asked at most once per
     * interval (shortcut: polled when the page asks, not on a server timer; the page polls every
     * few seconds while the dialog is open).
     */
    async deviceStatus(requestId: string): Promise<GitHubDeviceProgress['status'] | null> {
      const entry = devices.get(requestId);
      if (!entry) return null;
      if (entry.status === 'pending' && entry.expiresAt <= now()) entry.status = 'expired';
      if (entry.status === 'pending' && !entry.polling && now() >= entry.nextPollAt)
        entry.polling = pollOnce(entry).finally(() => {
          entry.polling = null;
        });
      if (entry.polling) await entry.polling;
      return entry.status;
    },

    /** Cancel: stops polling; the request answers 404 from now on. */
    cancelDevice(requestId: string): boolean {
      return devices.delete(requestId);
    },

    /**
     * Checks a pasted token, failing closed: fine-grained only, `GET /user` 200. Returns the
     * sign-in to save (the caller checks it reaches at least one repository). GitHub not
     * answering is thrown as `GitHubError` `unavailable`.
     */
    async checkToken(token: string): Promise<StoredGitHubAuth> {
      if (CLASSIC_TOKEN.test(token)) throw new TokenRefused('classic');
      if (!FINE_GRAINED_TOKEN.test(token)) throw new TokenRefused('invalid');
      let login: unknown;
      let expiresAt: number | null;
      try {
        const answer = await client.get<{ login?: unknown }>(token, '/user');
        login = answer.data.login;
        expiresAt = parseTokenExpiry(answer.headers.get('github-authentication-token-expiration'));
      } catch (error) {
        if (
          error instanceof GitHubError &&
          (error.kind === 'unavailable' || error.kind === 'rate_limited')
        )
          throw error;
        throw new TokenRefused('invalid');
      }
      if (typeof login !== 'string' || !login) throw new TokenRefused('invalid');
      if (expiresAt !== null && expiresAt <= now()) throw new TokenRefused('invalid');
      return {
        method: 'token',
        login,
        accessToken: token,
        ...(expiresAt !== null ? { tokenExpiresAt: expiresAt } : {}),
        connectedAt: now(),
      };
    },

    /** Saves a checked token sign-in. */
    saveToken(value: StoredGitHubAuth, actor: Actor) {
      save(value);
      ctx.settings.set(PROBLEM_SETTING, null);
      changed();
      audit(ctx.db, {
        userId: actor.userId,
        action: 'github.connect',
        ip: actor.ip,
        meta: { method: 'token' },
      });
      log.info({ event: 'github_connected', method: 'token' }, 'GitHub connected');
    },

    /** Forgets the sign-in (GitHub's own authorisation stays: EzyChat has no secret to revoke). */
    disconnect(actor: Actor) {
      save(null);
      ctx.settings.set(PROBLEM_SETTING, null);
      devices.clear();
      changed();
      audit(ctx.db, { userId: actor.userId, action: 'github.disconnect', ip: actor.ip });
      log.info({ event: 'github_disconnected' }, 'GitHub disconnected');
    },

    shutdown() {
      devices.clear();
      listeners.clear();
    },
  };
  return auth;
}

export type GitHubAuth = ReturnType<typeof createGitHubAuth>;

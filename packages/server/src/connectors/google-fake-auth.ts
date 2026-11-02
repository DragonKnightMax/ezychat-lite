/**
 * The sign-in half of the in-process fake Googles (Calendar, Sheets), used ONLY with `--fake-wa`:
 * one-time codes bound to the PKCE challenge, access and refresh tokens, the token endpoint and the
 * `ok` / `expired` / `unavailable` modes. Nothing here touches the network.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FakeSignIn } from './google-account.js';

export type FakeGoogleMode = 'ok' | 'expired' | 'unavailable';

export const fakeJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeJwt = (payload: object) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

export class FakeGoogleAuth implements FakeSignIn {
  mode: FakeGoogleMode = 'ok';
  /** Requests answered, by kind (tests check what was asked, never the network). */
  readonly calls: string[] = [];
  private readonly codes = new Map<string, { challenge: string; scope: string }>();
  private readonly access = new Set<string>();
  private readonly refresh = new Set<string>();

  /** `account`: the signed-in email; `refreshScope`: the scopes a refresh answers with. */
  constructor(
    private readonly account: string,
    private readonly refreshScope: string,
  ) {}

  /** The consent page's Allow: a one-time code bound to the PKCE challenge of that sign-in. */
  issueCode(challenge: string, scope: string): string {
    const code = `fake-code-${randomBytes(8).toString('hex')}`;
    this.codes.set(code, { challenge, scope });
    return code;
  }

  /** Expire every access token now (the next call refreshes). */
  expireAccessTokens(): void {
    this.access.clear();
  }

  private tokens(scope: string, refresh?: string) {
    const accessToken = `fake-access-${randomBytes(8).toString('hex')}`;
    this.access.add(accessToken);
    const refreshToken = refresh ?? `fake-refresh-${randomBytes(8).toString('hex')}`;
    this.refresh.add(refreshToken);
    return {
      access_token: accessToken,
      expires_in: 3600,
      scope,
      token_type: 'Bearer',
      ...(refresh ? {} : { refresh_token: refreshToken }),
      id_token: fakeJwt({ email: this.account }),
    };
  }

  private token(body: URLSearchParams): Response {
    if (this.mode === 'unavailable') return fakeJson(503, { error: 'backend_error' });
    if (body.get('grant_type') === 'authorization_code') {
      const code = body.get('code') ?? '';
      const issued = this.codes.get(code);
      this.codes.delete(code);
      const challenge = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (!issued || issued.challenge !== challenge)
        return fakeJson(400, { error: 'invalid_grant' });
      return fakeJson(200, this.tokens(issued.scope));
    }
    const refresh = body.get('refresh_token') ?? '';
    if (this.mode === 'expired' || !this.refresh.has(refresh))
      return fakeJson(400, { error: 'invalid_grant' });
    return fakeJson(200, this.tokens(this.refreshScope, refresh));
  }

  /**
   * The sign-in endpoints (`/token`, `/revoke`) and the API's mode and token check: a Response to
   * send, or null when the API request may go on.
   */
  protected authorize(pathname: string, init: RequestInit | undefined): Response | null {
    if (pathname === '/token') {
      this.calls.push('token');
      return this.token(new URLSearchParams(String(init?.body ?? '')));
    }
    if (pathname === '/revoke') {
      this.calls.push('revoke');
      return fakeJson(200, {});
    }
    if (this.mode === 'unavailable') return fakeJson(503, { error: { code: 503 } });
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (this.mode === 'expired' || !this.access.has(auth.replace(/^Bearer /, '')))
      return fakeJson(401, { error: { code: 401 } });
    return null;
  }
}

import { guardedFetch } from '../mcp/net.js';

/**
 * Requests to GitHub (design docs/features/github/design.md, "Network"): only `https://github.com`
 * (device flow, token refresh) and `https://api.github.com` (REST, GET only), through the connector
 * network guard (no private address, no redirect at all, 10 s, 1 MB). Errors carry what they mean:
 * a 5xx, a timeout or a rate-limit answer (403/429 with rate-limit headers) is `unavailable` /
 * `rate_limited`, both failures. Tokens and query words are never logged here.
 */
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_WEB = 'https://github.com';
export const GITHUB_TIMEOUT_MS = 10_000;
export const GITHUB_MAX_BYTES = 1024 * 1024;
const USER_AGENT = 'EzyChat-Lite';

export type GitHubErrorKind =
  'unauthorized' | 'not_found' | 'rejected' | 'rate_limited' | 'unavailable';

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    readonly status: number | null = null,
  ) {
    super(status ? `GitHub ${kind} ${status}` : `GitHub ${kind}`);
    this.name = 'GitHubError';
  }
}

/** What an HTTP status means (null: fine). */
export function statusError(res: Response): GitHubError | null {
  const status = res.status;
  if (status >= 200 && status < 300) return null;
  if (status === 401) return new GitHubError('unauthorized', status);
  if (
    (status === 403 || status === 429) &&
    (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))
  )
    return new GitHubError('rate_limited', status);
  if (status === 404) return new GitHubError('not_found', status);
  if (status >= 500) return new GitHubError('unavailable', status);
  return new GitHubError('rejected', status);
}

export interface GitHubAnswer<T> {
  data: T;
  headers: Headers;
}

export type OAuthPath = '/login/device/code' | '/login/oauth/access_token';

export class GitHubClient {
  private readonly fetchFn: typeof fetch;

  /** `fetchFn` replaces the guarded fetch (the fake and tests). */
  constructor(fetchFn?: typeof fetch) {
    this.fetchFn =
      fetchFn ??
      guardedFetch({
        allowLoopback: false,
        timeoutMs: GITHUB_TIMEOUT_MS,
        maxResponseBytes: GITHUB_MAX_BYTES,
      });
  }

  private async send(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ res: Response; text: string }> {
    const timeout = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url.href, {
        ...init,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      return { res, text: await res.text() };
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new GitHubError('unavailable');
    }
  }

  private static json(text: string, status: number): unknown {
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new GitHubError('unavailable', status);
    }
  }

  /** `GET https://api.github.com<path>`: only that host, the path exactly as given. */
  async get<T>(
    token: string,
    path: string,
    query: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<GitHubAnswer<T>> {
    const url = new URL(path, GITHUB_API);
    // No other host, no `..` or `.` segments, no query in the path.
    if (url.origin !== GITHUB_API || url.pathname !== path) throw new GitHubError('rejected');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const { res, text } = await this.send(
      url,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': USER_AGENT,
          authorization: `Bearer ${token}`,
        },
      },
      signal,
    );
    const problem = statusError(res);
    if (problem) throw problem;
    return { data: GitHubClient.json(text, res.status) as T, headers: res.headers };
  }

  /** `POST https://github.com<path>` with a form: the device flow and the token refresh. */
  async oauth(
    path: OAuthPath,
    form: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { res, text } = await this.send(
      new URL(path, GITHUB_WEB),
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams(form).toString(),
      },
      signal,
    );
    const problem = statusError(res);
    if (problem && problem.kind !== 'rejected') throw problem;
    const body = GitHubClient.json(text, res.status);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new GitHubError('unavailable', res.status);
    return body as Record<string, unknown>;
  }
}

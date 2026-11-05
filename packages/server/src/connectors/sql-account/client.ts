import { SQL_ACCESS_KEY, type SqlAccountProblem } from '@ezychat/shared';
import { BlockedAddressError, NetProbe, ResponseTooLargeError, guardedFetch } from '../mcp/net.js';
import { canonicalQuery, rfc3986, signRequest } from './sigv4.js';

/**
 * Requests to SQL Account's API service: HTTPS to a `*.sql.my` name only (no IP literal, port 443,
 * no path in the host), signed with SigV4, through the connector network guard (no private address,
 * no redirect, 10 s, 1 MB). One request at a time and at most 30 a minute per install: the service
 * is a desktop program on the customer's own server. Errors carry the connection state they mean.
 */
export const SQL_TIMEOUT_MS = 10_000;
export const SQL_MAX_BYTES = 1024 * 1024;
export const SQL_PAGE_SIZE = 50;
export const SQL_MAX_PAGES = 4;
export const SQL_PER_MINUTE = 30;

/** `<32 hex>.sql.my` or `api.sql.my`, nothing else (design Q2). */
const HOST = /^(?:[0-9a-f]{32}|api)\.sql\.my$/;

export function validSqlHost(host: string): boolean {
  return HOST.test(host);
}

export interface SqlConnection {
  host: string;
  accessKey: string;
  secretKey: string;
}

export function validConnection(c: SqlConnection): boolean {
  return validSqlHost(c.host) && SQL_ACCESS_KEY.test(c.accessKey) && c.secretKey.length > 0;
}

export class SqlError extends Error {
  constructor(
    readonly kind: SqlAccountProblem,
    readonly status: number | null = null,
  ) {
    super(status ? `SQL Account ${kind} ${status}` : `SQL Account ${kind}`);
    this.name = 'SqlError';
  }
}

export type SqlRecord = Record<string, unknown>;

/** A record value as text: strings as they are, numbers in decimal, anything else empty. */
export function sqlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** A document body SQL Account accepts: customer code, date and at least one complete line. */
export function completeDocument(body: SqlRecord): boolean {
  const lines = body.sdsdocdetail;
  return (
    typeof body.code === 'string' &&
    body.code !== '' &&
    typeof body.docdate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.docdate) &&
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every(
      (l) =>
        !!l &&
        typeof l === 'object' &&
        typeof (l as SqlRecord).itemcode === 'string' &&
        typeof (l as SqlRecord).qty === 'string' &&
        typeof (l as SqlRecord).unitprice === 'string',
    )
  );
}

const isRecord = (v: unknown): v is SqlRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a network failure means for the admin. */
export function classifyFailure(error: unknown, probe: NetProbe): SqlError {
  if (error instanceof SqlError) return error;
  if (error instanceof BlockedAddressError || probe.blocked) return new SqlError('private_ip');
  if (error instanceof ResponseTooLargeError) return new SqlError('unexpected');
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA')
    return new SqlError('no_dns');
  if (error instanceof TypeError && /redirect/.test(error.message))
    return new SqlError('unexpected');
  return new SqlError('unreachable');
}

/** What an HTTP status means. */
export function classifyStatus(status: number): SqlError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return new SqlError('bad_keys', status);
  if (status === 404 || status === 405) return new SqlError('old_version', status);
  if (status >= 500) return new SqlError('unreachable', status);
  return new SqlError('unexpected', status);
}

export interface SqlClientOptions {
  /** Replaces the guarded fetch (tests and the fake API). */
  fetch?: typeof fetch;
  now?: () => number;
  perMinute?: number;
}

export class SqlClient {
  private readonly now: () => number;
  private readonly perMinute: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sent: number[] = [];

  constructor(
    private readonly connection: SqlConnection,
    private readonly options: SqlClientOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.perMinute = options.perMinute ?? SQL_PER_MINUTE;
  }

  /** One request, queued behind the previous one. Throws `SqlError` with a state. */
  private request(
    method: 'GET' | 'POST',
    path: string,
    query: Readonly<Record<string, string>>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const run = async () => {
      if (!validConnection(this.connection)) throw new SqlError('unexpected');
      const at = this.now();
      while (this.sent.length && at - this.sent[0]! > 60_000) this.sent.shift();
      if (this.sent.length >= this.perMinute) throw new SqlError('unreachable', 429);
      this.sent.push(at);
      const text = body === undefined ? '' : JSON.stringify(body);
      const headers = signRequest({
        method,
        host: this.connection.host,
        path,
        query,
        body: text,
        accessKey: this.connection.accessKey,
        secretKey: this.connection.secretKey,
        now: at,
      });
      const qs = canonicalQuery(query);
      const search = qs ? '?' + qs : '';
      const url = `https://${this.connection.host}${path}${search}`;
      const probe = new NetProbe();
      const doFetch =
        this.options.fetch ??
        guardedFetch(
          { allowLoopback: false, timeoutMs: SQL_TIMEOUT_MS, maxResponseBytes: SQL_MAX_BYTES },
          probe,
        );
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: { ...headers, accept: 'application/json' },
          body: text || undefined,
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(SQL_TIMEOUT_MS)])
            : AbortSignal.timeout(SQL_TIMEOUT_MS),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw classifyFailure(error, probe);
      }
      const problem = classifyStatus(res.status);
      const raw = await res.text().catch(() => '');
      if (problem) throw problem;
      if (raw.length > SQL_MAX_BYTES) throw new SqlError('unexpected');
      try {
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        throw new SqlError('old_version', res.status);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** `GET /<object>` list: `{pagination, data: [...]}`; up to `pages` pages of 50. */
  async list(
    object: string,
    filters: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    pages = 1,
  ): Promise<SqlRecord[]> {
    const out: SqlRecord[] = [];
    for (let page = 0; page < Math.min(pages, 40); page++) {
      const answer = await this.request(
        'GET',
        `/${rfc3986(object)}`,
        { ...filters, offset: String(page * SQL_PAGE_SIZE) },
        undefined,
        signal,
      );
      if (!isRecord(answer) || !Array.isArray(answer.data)) throw new SqlError('old_version');
      const rows = answer.data.filter(isRecord);
      out.push(...rows);
      if (rows.length < SQL_PAGE_SIZE) break;
    }
    return out;
  }

  /** `GET /<object>/<key>` single record with details: `{data: [record]}`. */
  async one(object: string, key: string, signal?: AbortSignal): Promise<SqlRecord | null> {
    const answer = await this.request(
      'GET',
      `/${rfc3986(object)}/${rfc3986(key)}`,
      {},
      undefined,
      signal,
    ).catch((error: unknown) => {
      if (error instanceof SqlError && error.status === 404) return null;
      throw error;
    });
    if (answer === null) return null;
    if (!isRecord(answer) || !Array.isArray(answer.data)) throw new SqlError('old_version');
    return answer.data.find(isRecord) ?? null;
  }

  /**
   * `POST /<object>`: the answer (a record, `{data:[…]}` or plain text) as parsed. An empty or
   * partial body crashes SQL Account's service (S4 "Known issues"), so a body without a customer
   * code, a date and at least one detail line is never sent.
   */
  create(object: string, body: SqlRecord, signal?: AbortSignal): Promise<unknown> {
    if (!completeDocument(body)) return Promise.reject(new SqlError('unexpected'));
    return this.request('POST', `/${rfc3986(object)}`, {}, body, signal);
  }

  /** Test connection: one small signed read (eStream's own Postman sample). */
  async check(signal?: AbortSignal): Promise<void> {
    await this.list('agent', {}, signal);
  }
}

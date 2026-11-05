import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, as SQL Account's API service checks it (eStream docs
 * `integration/sql-account-api/setup-configuration.md`: region `ap-southeast-5`, service
 * `sqlaccount`). Header form (`Authorization: AWS4-HMAC-SHA256 …`); the query string is part of
 * the signature. No dependency: the algorithm is small and its test vector is pinned in the tests.
 */
export const SQL_REGION = 'ap-southeast-5';
export const SQL_SERVICE = 'sqlaccount';

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** Byte order (AWS sorts names this way, never by locale). */
export function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** RFC 3986 encoding (AWS: everything but unreserved characters). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
}

/** `a=1&b=x%20y`, keys sorted, both sides encoded (the same text is sent and signed). */
export function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort(byCodeUnit)
    .map((key) => `${rfc3986(key)}=${rfc3986(query[key]!)}`)
    .join('&');
}

/** `20261105T074500Z`. */
export function amzDate(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export interface SignInput {
  method: string;
  host: string;
  /** Path as sent; each segment already RFC 3986 encoded. */
  path: string;
  query: Readonly<Record<string, string>>;
  body: string;
  accessKey: string;
  secretKey: string;
  now: number;
  region?: string;
  service?: string;
  /** Send `x-amz-content-sha256` (default; AWS's plain test vectors leave it out). */
  contentHashHeader?: boolean;
}

/** The headers to send with the request (host, date, payload hash, authorization). */
export function signRequest(input: SignInput): Record<string, string> {
  const region = input.region ?? SQL_REGION;
  const service = input.service ?? SQL_SERVICE;
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    host: input.host,
    ...(input.contentHashHeader === false ? {} : { 'x-amz-content-sha256': payloadHash }),
    'x-amz-date': date,
  };
  if (input.body) headers['content-type'] = 'application/json';
  const names = Object.keys(headers).sort(byCodeUnit);
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.query),
    names.map((name) => `${name}:${headers[name]!.trim()}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretKey}`, day), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/** Parses an Authorization header (the fake API and tests verify signatures with it). */
export function parseAuthorization(
  header: string | null,
): { accessKey: string; scope: string; signedHeaders: string[]; signature: string } | null {
  const match =
    /^AWS4-HMAC-SHA256 Credential=(.+)\/(\d{8}\/[^/]+\/[^/]+\/aws4_request), SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      header ?? '',
    );
  if (!match) return null;
  return {
    accessKey: match[1]!,
    scope: match[2]!,
    signedHeaders: match[3]!.split(';'),
    signature: match[4]!,
  };
}

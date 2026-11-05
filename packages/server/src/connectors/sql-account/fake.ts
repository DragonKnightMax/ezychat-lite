import { createHash, createHmac } from 'node:crypto';
import { BlockedAddressError } from '../mcp/net.js';
import { canonicalQuery, parseAuthorization, rfc3986 } from './sigv4.js';
import type { SqlRecord } from './client.js';

/**
 * In-process stand-in for SQL Account's API service (tests, `--fake-wa` Dev Builds, e2e). Same
 * paths and envelopes as the real one (`{pagination, data}`, 50 per page, `{data:[…]}` for one
 * record, POST answers the new record), and it checks the SigV4 signature with its own key pair:
 * a wrong secret answers 401 like the real service. Nothing here talks to the network.
 */
export const FAKE_SQL_ACCESS_KEY = '0123456789abcdef0123456789abcdef.sql.my/APIUSER';
export const FAKE_SQL_SECRET = 'fake-sql-secret';
export const FAKE_SQL_HOST = '0123456789abcdef0123456789abcdef.sql.my';

export type FakeSqlScenario =
  'ok' | 'no_dns' | 'unreachable' | 'private_ip' | 'bad_keys' | 'old_version';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();

function demoData(): Record<string, SqlRecord[]> {
  return {
    agent: [{ code: '----', description: 'DEFAULT AGENT', isactive: true }],
    customer: [
      {
        code: '300-F0001',
        companyname: 'Farah Catering Co',
        creditterm: '30 Days',
        creditlimit: '30000',
        phone1: '04-226 1188',
        mobile: '+60123110021',
      },
      {
        code: '300-P0007',
        companyname: 'Priya Nair Enterprise',
        creditterm: 'C.O.D.',
        creditlimit: '5000',
        phone1: '',
        mobile: '012-881 4455',
      },
      {
        code: '300-J0003',
        companyname: 'JL Trading',
        creditterm: '30 Days',
        creditlimit: '10000',
        phone1: '0129001234',
        mobile: '',
      },
      {
        code: '300-J0004',
        companyname: 'Jason Lim Kopitiam',
        creditterm: '30 Days',
        creditlimit: '10000',
        phone1: '',
        mobile: '+60 12-900 1234',
      },
    ],
    stockitem: [
      {
        dockey: 11,
        code: 'KP-L',
        description: 'Kopi Peng Large',
        refprice: '6.50',
        refcost: '2.10',
        balsqty: '42',
        uom: 'CUP',
      },
      {
        dockey: 12,
        code: 'KP-R',
        description: 'Kopi Peng Regular',
        refprice: '4.80',
        refcost: '1.60',
        balsqty: '0',
        uom: 'CUP',
      },
      {
        dockey: 13,
        code: 'NL-01',
        description: 'Nasi Lemak Biasa',
        refprice: '5.00',
        refcost: '2.00',
        balsqty: '18',
        uom: 'PACK',
      },
    ],
    salesinvoice: [
      {
        dockey: 501,
        docno: 'IV-02231',
        docdate: '2026-10-12',
        code: '300-F0001',
        docamt: '1240.00',
        cancelled: false,
      },
      {
        dockey: 502,
        docno: 'IV-02305',
        docdate: '2026-10-28',
        code: '300-F0001',
        docamt: '860.00',
        cancelled: false,
      },
      {
        dockey: 503,
        docno: 'IV-02310',
        docdate: '2026-10-30',
        code: '300-P0007',
        docamt: '99.00',
        cancelled: false,
      },
    ],
    salesorder: [
      {
        dockey: 601,
        docno: 'SO-00412',
        docdate: '2026-11-02',
        code: '300-F0001',
        docamt: '412.00',
        cancelled: false,
      },
      {
        dockey: 602,
        docno: 'SO-00399',
        docdate: '2026-10-25',
        code: '300-P0007',
        docamt: '120.00',
        cancelled: false,
      },
    ],
    deliveryorder: [
      {
        dockey: 701,
        docno: 'DO-00388',
        docdate: '2026-11-04',
        code: '300-F0001',
        docamt: '412.00',
        cancelled: false,
      },
    ],
    salesquotation: [],
    customerpayment: [
      {
        dockey: 801,
        docno: 'OR-00120',
        docdate: '2026-10-20',
        code: '300-F0001',
        docamt: '500.00',
      },
    ],
  };
}

export class FakeSqlAccount {
  scenario: FakeSqlScenario = 'ok';
  /** Off: the customer list carries no phone numbers (a SQL Account that keeps them on branches only). */
  phonesInList = true;
  data = demoData();
  requests: Array<{ method: string; path: string; query: Record<string, string> }> = [];
  private nextDockey = 1100;

  constructor(
    readonly keys: Readonly<Record<string, string>> = { [FAKE_SQL_ACCESS_KEY]: FAKE_SQL_SECRET },
  ) {}

  /** A `fetch` that answers like the API service (bound, so it can be handed around). */
  readonly fetch: typeof fetch = (input, init) => {
    try {
      return Promise.resolve(this.answer(input, init));
    } catch (error) {
      return Promise.reject(error as Error);
    }
  };

  private answer(input: Parameters<typeof fetch>[0], init?: RequestInit): Response {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    this.failNetwork();
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.sql.my'))
      return text(400, 'bad host');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    if (!this.verify(method, url, new Headers(init?.headers), body))
      return text(401, 'Unauthorized');
    if (this.scenario === 'bad_keys') return text(403, 'Forbidden');
    if (this.scenario === 'old_version') return text(404, 'Not Found');
    const query = Object.fromEntries(url.searchParams);
    const [object, key] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    this.requests.push({ method, path: url.pathname, query });
    const rows = object ? this.data[object] : undefined;
    if (!rows) return text(404, 'Not Found');
    if (method === 'POST') return this.create(rows, body);
    if (key !== undefined) {
      const found = rows.find((r) => String(r.dockey ?? r.code) === key || r.code === key);
      return found ? json(200, { data: [found] }) : text(404, 'Not Found');
    }
    return this.list(object!, rows, query);
  }

  /** The network scenarios fail before any answer, like DNS, a refused port or a blocked address. */
  private failNetwork(): void {
    if (this.scenario === 'no_dns')
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    if (this.scenario === 'unreachable')
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (this.scenario === 'private_ip') throw new BlockedAddressError();
  }

  private create(rows: SqlRecord[], body: string): Response {
    if (!body) return text(500, 'Access violation');
    const record = JSON.parse(body) as SqlRecord;
    const dockey = this.nextDockey++;
    const created = { ...record, dockey, docno: `QT-${String(dockey).padStart(5, '0')}` };
    rows.push(created);
    return json(200, created);
  }

  private list(object: string, rows: SqlRecord[], query: Record<string, string>): Response {
    const offset = Number(query.offset ?? 0);
    const filters = Object.entries(query).filter(([f]) => f !== 'offset' && f !== 'limit');
    const matches = rows
      .filter((row) => filters.every(([field, wanted]) => fieldMatches(row[field], wanted)))
      .map((row) => (object === 'customer' && !this.phonesInList ? withoutPhones(row) : row));
    const page = matches.slice(offset, offset + 50);
    return json(200, { pagination: { offset, limit: 50, count: page.length }, data: page });
  }

  /** Checks the SigV4 header exactly as signed (method, path, sorted query, signed headers, body). */
  private verify(method: string, url: URL, headers: Headers, body: string): boolean {
    const auth = parseAuthorization(headers.get('authorization'));
    if (!auth) return false;
    const secret = this.keys[auth.accessKey];
    if (!secret) return false;
    const date = headers.get('x-amz-date') ?? '';
    if (!/^\d{8}T\d{6}Z$/.test(date) || !auth.scope.startsWith(date.slice(0, 8))) return false;
    if (!auth.scope.endsWith('/ap-southeast-5/sqlaccount/aws4_request')) return false;
    const query = Object.fromEntries(url.searchParams);
    const canonicalHeaders = auth.signedHeaders
      .map((name) => `${name}:${(name === 'host' ? url.host : (headers.get(name) ?? '')).trim()}\n`)
      .join('');
    const canonical = [
      method,
      url.pathname
        .split('/')
        .map((s) => rfc3986(decodeURIComponent(s)))
        .join('/'),
      canonicalQuery(query),
      canonicalHeaders,
      auth.signedHeaders.join(';'),
      sha(body),
    ].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', date, auth.scope, sha(canonical)].join('\n');
    const day = date.slice(0, 8);
    const key = hmac(
      hmac(hmac(hmac(`AWS4${secret}`, day), 'ap-southeast-5'), 'sqlaccount'),
      'aws4_request',
    );
    return createHmac('sha256', key).update(toSign).digest('hex') === auth.signature;
  }
}

/** A list filter: exact, or `*part*` (case-insensitive contains) as SQL Account's wildcards. */
function fieldMatches(raw: unknown, wanted: string): boolean {
  let value = '';
  if (typeof raw === 'string') value = raw;
  else if (typeof raw === 'number' || typeof raw === 'boolean') value = String(raw);
  if (!wanted.includes('*')) return value === wanted;
  return value.toLowerCase().includes(wanted.replaceAll('*', '').toLowerCase());
}

function withoutPhones(row: SqlRecord): SqlRecord {
  const { phone1: _p, mobile: _m, ...rest } = row;
  return rest;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });

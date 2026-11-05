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
export const FAKE_SQL_HOST = 'api.sql.my';

export type FakeSqlScenario =
  'ok' | 'no_dns' | 'unreachable' | 'private_ip' | 'bad_keys' | 'old_version';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();

const branch = (phone1: string, mobile: string, attention: string): SqlRecord => ({
  dtlkey: 1,
  branchtype: 'B',
  branchname: 'BILLING',
  attention,
  phone1,
  phone2: '',
  mobile,
  email: '',
});

/**
 * Demo records in the shapes of eStream's SQL Account API Postman collection (2026-05-28): lower-case
 * fields, customer phones on `sdsbranch[]`, the amount owed on the accounts-receivable invoice
 * (`/customerinvoice`: `docamt`, `paymentamt`, `outstanding`) and the customer (`outstanding`).
 */
function demoData(): Record<string, SqlRecord[]> {
  const customer = (
    code: string,
    companyname: string,
    creditterm: string,
    outstanding: string,
    branches: SqlRecord[],
  ): SqlRecord => ({
    code,
    controlaccount: '300-000',
    companyname,
    creditterm,
    creditlimit: '30000.00',
    overduelimit: '0.00',
    outstanding,
    agingon: 'I',
    status: 'A',
    sdsbranch: branches,
  });
  const doc = (dockey: number, docno: string, docdate: string, code: string, docamt: string) => ({
    dockey,
    docno,
    docdate,
    code,
    docamt,
    localdocamt: docamt,
    cancelled: false,
    status: 0,
  });
  return {
    agent: [{ code: '----', description: 'DEFAULT AGENT', isactive: true }],
    customer: [
      customer('300-F0001', 'Farah Catering Co', '30 Days', '2100.00', [
        branch('04-226 1188', '+60123110021', 'Farah Aziz'),
      ]),
      customer('300-P0007', 'Priya Nair Enterprise', 'C.O.D.', '0.00', [
        branch('', '012-881 4455', 'Priya Nair'),
      ]),
      customer('300-J0003', 'JL Trading', '30 Days', '0.00', [branch('0129001234', '', 'Jason')]),
      customer('300-J0004', 'Jason Lim Kopitiam', '30 Days', '0.00', [
        branch('', '+60 12-900 1234', 'Jason Lim'),
      ]),
    ],
    stockitem: [
      {
        dockey: 11,
        code: 'KP-L',
        description: 'Kopi Peng Large',
        stockgroup: 'DEFAULT',
        stockcontrol: true,
        uom: 'CUP',
        refprice: '6.50',
        refcost: '2.10',
        balsqty: '42',
        isactive: true,
      },
      {
        dockey: 12,
        code: 'KP-R',
        description: 'Kopi Peng Regular',
        stockgroup: 'DEFAULT',
        stockcontrol: true,
        uom: 'CUP',
        refprice: '4.80',
        refcost: '1.60',
        balsqty: '0',
        isactive: true,
      },
      {
        dockey: 13,
        code: 'NL-01',
        description: 'Nasi Lemak Biasa',
        stockgroup: 'DEFAULT',
        stockcontrol: true,
        uom: 'PACK',
        refprice: '5.00',
        refcost: '2.00',
        balsqty: '18',
        isactive: true,
      },
    ],
    customerinvoice: [
      {
        ...doc(401, 'IV-02231', '2026-10-12', '300-F0001', '1240.00'),
        duedate: '2026-11-11',
        paymentamt: '0.00',
        outstanding: '1240.00',
      },
      {
        ...doc(402, 'IV-02305', '2026-10-28', '300-F0001', '860.00'),
        duedate: '2026-11-27',
        paymentamt: '0.00',
        outstanding: '860.00',
      },
      {
        ...doc(403, 'IV-02190', '2026-09-30', '300-F0001', '500.00'),
        duedate: '2026-10-30',
        paymentamt: '500.00',
        outstanding: '0.00',
      },
      {
        ...doc(404, 'IV-02310', '2026-10-30', '300-P0007', '99.00'),
        duedate: '2026-10-30',
        paymentamt: '99.00',
        outstanding: '0.00',
      },
    ],
    salesinvoice: [
      doc(501, 'IV-02231', '2026-10-12', '300-F0001', '1240.00'),
      doc(502, 'IV-02305', '2026-10-28', '300-F0001', '860.00'),
      doc(503, 'IV-02310', '2026-10-30', '300-P0007', '99.00'),
    ],
    salesorder: [
      doc(601, 'SO-00412', '2026-11-02', '300-F0001', '412.00'),
      doc(602, 'SO-00399', '2026-10-25', '300-P0007', '120.00'),
    ],
    deliveryorder: [doc(701, 'DO-00388', '2026-11-04', '300-F0001', '412.00')],
    salesquotation: [],
    customerpayment: [
      {
        ...doc(801, 'OR-00120', '2026-10-20', '300-F0001', '500.00'),
        paymentmethod: '310-000',
        unappliedamt: '0.00',
        sdsknockoff: [
          {
            doctype: 'IV',
            docno: 'IV-02190',
            docamt: '500.00',
            originaloutstanding: '500.00',
            outstanding: '0.00',
            koamt: '500.00',
          },
        ],
      },
    ],
  };
}

export class FakeSqlAccount {
  scenario: FakeSqlScenario = 'ok';
  /** Off: the customers' branches carry no phone numbers. */
  phonesOnBranches = true;
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
      return found ? json(200, { data: [this.detail(found)] }) : text(404, 'Not Found');
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

  /** One record with its detail rows (a customer's branches without phones when switched off). */
  private detail(row: SqlRecord): SqlRecord {
    if (this.phonesOnBranches || !Array.isArray(row.sdsbranch)) return row;
    return { ...row, sdsbranch: row.sdsbranch.map((b) => withoutPhones(b as SqlRecord)) };
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
      .map(masterOnly);
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
  const { phone1: _p, phone2: _q, mobile: _m, ...rest } = row;
  return rest;
}

/** A list answer carries master fields only (eStream FAQ): no `sds…` detail arrays. */
function masterOnly(row: SqlRecord): SqlRecord {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('sds')));
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });

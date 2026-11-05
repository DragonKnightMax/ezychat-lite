import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SQL_AGENT_SETTINGS,
  SqlAgentSettings,
  sqlAccessOf,
  sqlHostFromKey,
  sqlKeyEnd,
} from '@ezychat/shared';
import {
  SqlClient,
  SqlError,
  classifyFailure,
  classifyStatus,
  validSqlHost,
} from '../src/connectors/sql-account/client.js';
import {
  FAKE_SQL_ACCESS_KEY,
  FAKE_SQL_HOST,
  FAKE_SQL_SECRET,
  FakeSqlAccount,
} from '../src/connectors/sql-account/fake.js';
import { normalizePhone, recordPhones } from '../src/connectors/sql-account/service.js';
import {
  amzDate,
  canonicalQuery,
  parseAuthorization,
  rfc3986,
  signRequest,
} from '../src/connectors/sql-account/sigv4.js';
import { customerWroteNumber } from '../src/connectors/sql-account/tools.js';
import { BlockedAddressError, NetProbe, ResponseTooLargeError } from '../src/connectors/mcp/net.js';

const conn = { host: FAKE_SQL_HOST, accessKey: FAKE_SQL_ACCESS_KEY, secretKey: FAKE_SQL_SECRET };

describe('SigV4 for SQL Account', () => {
  it('encodes like AWS (RFC 3986) and sorts the query', () => {
    expect(rfc3986("a b*(c)!'")).toBe('a%20b%2A%28c%29%21%27');
    expect(canonicalQuery({ offset: '0', description: '*Kopi*', code: 'A/B' })).toBe(
      'code=A%2FB&description=%2AKopi%2A&offset=0',
    );
    expect(amzDate(Date.UTC(2026, 10, 5, 7, 45, 0))).toBe('20261105T074500Z');
  });

  it('signs with region ap-southeast-5 and service sqlaccount (pinned vector)', () => {
    const headers = signRequest({
      method: 'GET',
      host: FAKE_SQL_HOST,
      path: '/agent',
      query: { offset: '0' },
      body: '',
      accessKey: FAKE_SQL_ACCESS_KEY,
      secretKey: FAKE_SQL_SECRET,
      now: Date.UTC(2026, 10, 5, 7, 45, 0),
    });
    const auth = parseAuthorization(headers.authorization!);
    expect(auth).toMatchObject({
      accessKey: FAKE_SQL_ACCESS_KEY,
      scope: '20261105/ap-southeast-5/sqlaccount/aws4_request',
      signedHeaders: ['host', 'x-amz-content-sha256', 'x-amz-date'],
    });
    expect(headers['x-amz-date']).toBe('20261105T074500Z');
    expect(headers['content-type']).toBeUndefined();
    // Pinned: a change in canonicalisation changes this value.
    expect(auth!.signature).toBe(
      'df14276205e9efaab3fbad3f51909dae46fdeeefe52885dec76ebf0d35f8d683',
    );
    const post = signRequest({
      method: 'POST',
      host: FAKE_SQL_HOST,
      path: '/salesquotation',
      query: {},
      body: '{"a":1}',
      accessKey: FAKE_SQL_ACCESS_KEY,
      secretKey: FAKE_SQL_SECRET,
      now: 0,
    });
    expect(post['content-type']).toBe('application/json');
    expect(parseAuthorization('Bearer x')).toBeNull();
    expect(parseAuthorization(null)).toBeNull();
  });
});

describe('SigV4 against the AWS test suite', () => {
  it('matches the official get-vanilla vector', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      query: {},
      body: '',
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: Date.UTC(2015, 7, 30, 12, 36, 0),
      region: 'us-east-1',
      service: 'service',
      contentHashHeader: false,
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('matches the official get-vanilla-query-order-key-case vector', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      query: { Param2: 'value2', Param1: 'value1' },
      body: '',
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: Date.UTC(2015, 7, 30, 12, 36, 0),
      region: 'us-east-1',
      service: 'service',
      contentHashHeader: false,
    });
    expect(headers.authorization).toContain(
      'Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    );
  });
});

describe('SQL Account contract helpers', () => {
  it('reads the host and the key end from an access key', () => {
    expect(sqlHostFromKey(FAKE_SQL_ACCESS_KEY)).toBe(FAKE_SQL_HOST);
    expect(sqlKeyEnd(FAKE_SQL_ACCESS_KEY)).toBe('…cdef/APIUSER');
    expect(sqlHostFromKey('my-key')).toBeNull();
    expect(sqlKeyEnd('my-key')).toBeNull();
    expect(sqlHostFromKey('0123456789abcdef0123456789abcdef.evil.com/APIUSER')).toBeNull();
  });

  it('allows only sql.my hosts', () => {
    expect(validSqlHost(FAKE_SQL_HOST)).toBe(true);
    expect(validSqlHost('api.sql.my')).toBe(true);
    expect(validSqlHost('192.168.0.2')).toBe(false);
    expect(validSqlHost('x.sql.my.evil.com')).toBe(false);
    expect(validSqlHost('evil.com')).toBe(false);
  });

  it('defaults each object and allows create only on quotations', () => {
    const s = SqlAgentSettings.parse({});
    expect(s).toEqual(DEFAULT_SQL_AGENT_SETTINGS);
    expect(sqlAccessOf(s, 'stockitem')).toBe('read');
    expect(sqlAccessOf(s, 'customer')).toBe('off');
    expect(sqlAccessOf(s, 'customerpayment')).toBe('off');
    expect(sqlAccessOf({ ...s, access: { salesorder: 'create' } }, 'salesorder')).toBe('read');
    expect(sqlAccessOf({ ...s, access: { salesquotation: 'create' } }, 'salesquotation')).toBe(
      'create',
    );
  });
});

describe('SQL Account errors', () => {
  it('maps HTTP answers to connection states', () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(401)?.kind).toBe('bad_keys');
    expect(classifyStatus(403)?.kind).toBe('bad_keys');
    expect(classifyStatus(404)?.kind).toBe('old_version');
    expect(classifyStatus(502)?.kind).toBe('unreachable');
    expect(classifyStatus(418)?.kind).toBe('unexpected');
  });

  it('maps network failures to connection states', () => {
    const probe = new NetProbe();
    expect(classifyFailure(new BlockedAddressError(), probe).kind).toBe('private_ip');
    expect(classifyFailure(new ResponseTooLargeError(), probe).kind).toBe('unexpected');
    expect(classifyFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), probe).kind).toBe(
      'no_dns',
    );
    expect(classifyFailure(new TypeError('redirect refused'), probe).kind).toBe('unexpected');
    expect(classifyFailure(new Error('ECONNRESET'), probe).kind).toBe('unreachable');
    const known = new SqlError('bad_keys', 401);
    expect(classifyFailure(known, probe)).toBe(known);
    const blocked = new NetProbe();
    blocked.blocked = true;
    expect(classifyFailure(new Error('x'), blocked).kind).toBe('private_ip');
  });
});

describe('SQL Account client against the fake API', () => {
  it('reads pages, one record and creates through signed requests', async () => {
    const fake = new FakeSqlAccount();
    const client = new SqlClient(conn, { fetch: fake.fetch });
    await client.check();
    expect(fake.requests[0]).toMatchObject({
      method: 'GET',
      path: '/agent',
      query: { offset: '0' },
    });
    const items = await client.list('stockitem', { description: '*kopi*' });
    expect(items.map((i) => i.code)).toEqual(['KP-L', 'KP-R']);
    expect(await client.one('customer', '300-F0001')).toMatchObject({ code: '300-F0001' });
    expect(await client.one('customer', 'NOPE')).toBeNull();
    const created = (await client.create('salesquotation', {
      code: '300-F0001',
      docdate: '2026-11-05',
      sdsdocdetail: [{ itemcode: 'KP-L', qty: '1.00', unitprice: '6.50' }],
    })) as { dockey: number };
    expect(created.dockey).toBeGreaterThan(0);
  });

  it('pages through long lists, 50 at a time, up to the page limit', async () => {
    const fake = new FakeSqlAccount();
    fake.data.customer = Array.from({ length: 120 }, (_, i) => ({
      code: `C${i}`,
      companyname: `Co ${i}`,
    }));
    const client = new SqlClient(conn, { fetch: fake.fetch });
    expect(await client.list('customer', {}, undefined, 2)).toHaveLength(100);
    expect(await client.list('customer', {}, undefined, 5)).toHaveLength(120);
  });

  it('answers each failure with its state and never sends without a valid connection', async () => {
    const fake = new FakeSqlAccount();
    const client = new SqlClient(conn, { fetch: fake.fetch });
    for (const [scenario, kind] of [
      ['no_dns', 'no_dns'],
      ['unreachable', 'unreachable'],
      ['private_ip', 'private_ip'],
      ['bad_keys', 'bad_keys'],
      ['old_version', 'old_version'],
    ] as const) {
      fake.scenario = scenario;
      await expect(client.check()).rejects.toMatchObject({ kind });
    }
    fake.scenario = 'ok';
    const wrong = new SqlClient({ ...conn, secretKey: 'wrong' }, { fetch: fake.fetch });
    await expect(wrong.check()).rejects.toMatchObject({ kind: 'bad_keys', status: 401 });
    const bad = new SqlClient({ ...conn, host: 'evil.com' }, { fetch: fake.fetch });
    await expect(bad.check()).rejects.toMatchObject({ kind: 'unexpected' });
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses answers that are not the documented JSON', async () => {
    const notJson = new SqlClient(conn, {
      fetch: async () => new Response('<html>', { status: 200 }),
    });
    await expect(notJson.check()).rejects.toMatchObject({ kind: 'old_version' });
    const noData = new SqlClient(conn, {
      fetch: async () => new Response('{"rows":[]}', { status: 200 }),
    });
    await expect(noData.check()).rejects.toMatchObject({ kind: 'old_version' });
    await expect(noData.one('customer', 'X')).rejects.toMatchObject({ kind: 'old_version' });
    const empty = new SqlClient(conn, { fetch: async () => new Response('', { status: 200 }) });
    expect(
      await empty.create('salesquotation', {
        code: 'C',
        docdate: '2026-11-05',
        sdsdocdetail: [{ itemcode: 'A', qty: '1.00', unitprice: '1.00' }],
      }),
    ).toBeNull();
  });

  it('keeps to 30 requests a minute per install', async () => {
    let at = 0;
    const fake = new FakeSqlAccount();
    const client = new SqlClient(conn, { fetch: fake.fetch, now: () => at, perMinute: 2 });
    await client.check();
    await client.check();
    await expect(client.check()).rejects.toMatchObject({ kind: 'unreachable', status: 429 });
    at = 61_000;
    await client.check();
  });

  it('passes a cancelled turn through as is', async () => {
    const controller = new AbortController();
    const client = new SqlClient(conn, {
      fetch: async () => {
        controller.abort(new Error('cancelled'));
        throw new Error('cancelled');
      },
    });
    await expect(client.check(controller.signal)).rejects.toThrow('cancelled');
  });

  it('fake refuses unsigned, wrongly scoped and foreign-host requests', async () => {
    const fake = new FakeSqlAccount();
    expect((await fake.fetch(`https://${FAKE_SQL_HOST}/agent?offset=0`)).status).toBe(401);
    expect((await fake.fetch('https://example.com/agent')).status).toBe(400);
    const headers = signRequest({
      method: 'GET',
      host: FAKE_SQL_HOST,
      path: '/agent',
      query: { offset: '0' },
      body: '',
      accessKey: FAKE_SQL_ACCESS_KEY,
      secretKey: FAKE_SQL_SECRET,
      now: Date.now(),
      region: 'us-east-1',
    });
    expect((await fake.fetch(`https://${FAKE_SQL_HOST}/agent?offset=0`, { headers })).status).toBe(
      401,
    );
    const ok = signRequest({
      method: 'GET',
      host: FAKE_SQL_HOST,
      path: '/nothing',
      query: {},
      body: '',
      accessKey: FAKE_SQL_ACCESS_KEY,
      secretKey: FAKE_SQL_SECRET,
      now: Date.now(),
    });
    expect((await fake.fetch(`https://${FAKE_SQL_HOST}/nothing`, { headers: ok })).status).toBe(
      404,
    );
    const post = signRequest({
      method: 'POST',
      host: FAKE_SQL_HOST,
      path: '/salesquotation',
      query: {},
      body: '',
      accessKey: FAKE_SQL_ACCESS_KEY,
      secretKey: FAKE_SQL_SECRET,
      now: Date.now(),
    });
    expect(
      (
        await fake.fetch(`https://${FAKE_SQL_HOST}/salesquotation`, {
          method: 'POST',
          headers: post,
        })
      ).status,
    ).toBe(500);
  });
});

describe('SQL Account never posts an empty or partial body', () => {
  it('refuses without a request', async () => {
    const fake = new FakeSqlAccount();
    const client = new SqlClient(conn, { fetch: fake.fetch });
    for (const body of [
      {},
      { code: '300-F0001' },
      {
        code: '300-F0001',
        docdate: '5/11/2026',
        sdsdocdetail: [{ itemcode: 'A', qty: '1', unitprice: '1' }],
      },
      { code: '300-F0001', docdate: '2026-11-05', sdsdocdetail: [] },
      {
        code: '',
        docdate: '2026-11-05',
        sdsdocdetail: [{ itemcode: 'A', qty: '1', unitprice: '1' }],
      },
      {
        code: '300-F0001',
        docdate: '2026-11-05',
        sdsdocdetail: [{ itemcode: 'A', qty: 1, unitprice: '1' }],
      },
      { code: '300-F0001', docdate: '2026-11-05', sdsdocdetail: [null] },
    ])
      await expect(client.create('salesquotation', body)).rejects.toMatchObject({
        kind: 'unexpected',
      });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('SQL Account phone matching helpers', () => {
  it('normalises Malaysian numbers and ignores short ones', () => {
    expect(normalizePhone('012-881 4455')).toBe('60128814455');
    expect(normalizePhone('+60 12-900 1234')).toBe('60129001234');
    expect(normalizePhone('60123110021')).toBe('60123110021');
    expect(normalizePhone('1234')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  it('reads phone fields, also on branches, never other fields', () => {
    expect(
      recordPhones({
        code: '300-A0001',
        companyname: '0123456789 Sdn Bhd',
        phone1: '04-226 1188',
        sdsbranch: [{ mobile: '+60123110021', fax: '0400000000' }],
      }).sort(),
    ).toEqual(['60123110021', '6042261188']);
  });

  it('accepts a quantity only as a whole number the customer wrote', () => {
    expect(customerWroteNumber(20, ['can I have 20 cups'])).toBe(true);
    expect(customerWroteNumber(2, ['can I have 20 cups'])).toBe(false);
    expect(customerWroteNumber(5, ['five please'])).toBe(false);
  });
});

// Pure rules of partner (MCP) connections: address checks, the test-only allowance, header
// templates, result handling, tool names, schemas, guards and pending sign-ins. Address, header and
// result cases ported from Enterprise ent-connectors (test/rules.test.ts).
import { describe, expect, it } from 'vitest';
import type { ConnectorSetting, ConnectorTool } from '@ezychat/shared';
import {
  buildHeaders,
  checkCredentials,
  checkSecret,
  fillTemplate,
  fillUrl,
  headerNameProblem,
} from './credentials.js';
import {
  argAt,
  cleanArgs,
  customerGave,
  fitsSetting,
  localTime,
  MAP_LIMITS,
  refusalText,
} from './guards.js';
import {
  boundedInputSchema,
  capText,
  classify,
  interpretResult,
  isRpcError,
  leafValues,
  McpError,
  partnerTool,
} from './mcp.js';
import { connectorUrlProblem, guardedFetch, isBlockedIp, NetProbe } from './net.js';
import {
  ConnectorOAuthProvider,
  InteractiveSignInNeeded,
  PendingSignIns,
  tokensExpired,
  SIGN_IN_TTL_MS,
} from './oauth.js';
import { choicesOf, problemError, testAllowance } from './service.js';
import { connectorToolName } from './tools.js';
import { McpError as RpcError } from '@modelcontextprotocol/sdk/types.js';

describe('isBlockedIp', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:a00:1::1',
    '2001:db8::1',
    '2001:0:1::1',
    '100::1',
    '::7f00:1',
    'fec0::1',
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => expect(isBlockedIp(ip)).toBe(false),
  );

  it('allows loopback only with the test allowance, never other private ranges', () => {
    expect(isBlockedIp('127.0.0.1', true)).toBe(false);
    expect(isBlockedIp('::1', true)).toBe(false);
    expect(isBlockedIp('10.0.0.1', true)).toBe(true);
    expect(isBlockedIp('169.254.169.254', true)).toBe(true);
  });
});

describe('connectorUrlProblem', () => {
  it.each([
    ['http://example.com/mcp', 'url_not_https'],
    ['ftp://example.com/mcp', 'url_invalid'],
    ['https://user:pw@example.com/mcp', 'url_invalid'],
    ['https://localhost/mcp', 'url_private'],
    ['https://nas.local/mcp', 'url_private'],
    ['https://intranet/mcp', 'url_private'],
    ['https://127.0.0.1:7600/mcp', 'url_private'],
    ['https://[::1]/mcp', 'url_private'],
    ['https://169.254.169.254/', 'url_private'],
    ['', 'url_invalid'],
    ['not a url', 'url_invalid'],
    ['https://catalogue.example.com/mcp', null],
  ])('%s → %s', (url, problem) => expect(connectorUrlProblem(url)).toBe(problem));

  it('lets the test allowance reach loopback only', () => {
    expect(connectorUrlProblem('https://127.0.0.1:7600/mcp', true)).toBeNull();
    expect(connectorUrlProblem('https://localhost:7600/mcp', true)).toBeNull();
    expect(connectorUrlProblem('https://10.0.0.1/mcp', true)).toBe('url_private');
    expect(connectorUrlProblem('http://127.0.0.1:7600/mcp', true)).toBe('url_not_https');
  });

  it('blocks a public-looking name that resolves to a private address, before connecting', async () => {
    const probe = new NetProbe();
    const fetchFn = guardedFetch(
      { allowLoopback: false, resolve: async () => [{ address: '10.0.0.8', family: 4 }] },
      probe,
    );
    await expect(fetchFn('https://catalogue.example.com/mcp')).rejects.toThrow(/not allowed/);
    expect(probe.blocked).toBe(true);
    await expect(guardedFetch({ allowLoopback: false })('http://example.com/')).rejects.toThrow(
      /url_not_https/,
    );
    await expect(
      guardedFetch({ allowLoopback: false })(new URL('https://127.0.0.1/')),
    ).rejects.toThrow(/not allowed/);
  });
});

describe('testAllowance', () => {
  const on = { CONNECTORS_TEST_ALLOW_LOCAL: '1' };
  it('needs the env switch, dev mode and fake WhatsApp together', () => {
    expect(testAllowance({ mode: 'dev', fakeWa: true }, on)).toBe(true);
    expect(testAllowance({ mode: 'dev', fakeWa: false }, on)).toBe(false);
    expect(testAllowance({ mode: 'standalone', fakeWa: true }, on)).toBe(false);
    expect(testAllowance({ mode: 'service', fakeWa: true }, on)).toBe(false);
    expect(testAllowance({ mode: 'dev', fakeWa: true }, {})).toBe(false);
    expect(
      testAllowance({ mode: 'dev', fakeWa: true }, { CONNECTORS_TEST_ALLOW_LOCAL: 'true' }),
    ).toBe(false);
  });
});

describe('credentials', () => {
  it('checks header names, keys and fields', () => {
    expect(headerNameProblem('X-API-Key')).toBeNull();
    for (const n of [
      'host',
      'Cookie',
      'content-length',
      'sec-fetch-mode',
      'proxy-authorization',
      'x-forwarded-for',
    ])
      expect(headerNameProblem(n)).toBe('header_name_forbidden');
    expect(headerNameProblem('two words')).toBe('header_name_invalid');
    expect(checkSecret('  abc  ', 'key')).toBe('abc');
    expect(() => checkSecret('', 'key')).toThrow(/Enter the key/);
    expect(() => checkSecret('a\r\nb', 'key')).toThrow(/not allowed/);
    expect(() => checkSecret(5, 'key')).toThrow(/Enter the key/);
  });

  it('fills header templates: {key}, {field} and {a:b} as Basic', () => {
    expect(fillTemplate('Bearer {key}', { key: 'k1' })).toBe('Bearer k1');
    expect(fillTemplate('Basic {u:p}', { u: 'demo', p: 'pw' })).toBe(
      `Basic ${Buffer.from('demo:pw').toString('base64')}`,
    );
    expect(() => fillTemplate('{missing}', {})).toThrow(/unknown value missing/);
    expect(() => fillTemplate('{u:missing}', { u: 'x' })).toThrow(/unknown value missing/);
    expect(() => fillTemplate('{key}', { key: 'a\nb' })).toThrow(/not allowed/);
    expect(() =>
      buildHeaders(
        { type: 'api_key', label: { en: 'Key' }, header: { name: 'Host', value: '{key}' } },
        { key: 'x' },
      ),
    ).toThrow(/not allowed/);
  });

  it('fills the address only with safe field values', () => {
    expect(fillUrl('https://{tenant}.example.com/mcp', { tenant: 'acme-1' })).toBe(
      'https://acme-1.example.com/mcp',
    );
    expect(() => fillUrl('https://{tenant}.example.com/mcp', { tenant: 'evil.com/x' })).toThrow(
      /only letters/,
    );
    expect(() => fillUrl('https://{tenant}.example.com/mcp', {})).toThrow(/only letters/);
  });

  it('splits secret and visible fields', () => {
    const auth = {
      type: 'credentials' as const,
      fields: [
        { id: 'tenant', label: { en: 'Tenant' }, secret: false },
        { id: 'token', label: { en: 'Token' }, secret: true },
      ],
      headers: [{ name: 'X-Token', value: '{token}' }],
    };
    expect(checkCredentials(auth, { tenant: ' acme ', token: 'abcdef' })).toEqual({
      secret: { token: 'abcdef' },
      fields: { tenant: 'acme' },
      keyEnd: 'cdef',
    });
    expect(() => checkCredentials(auth, { tenant: 'acme' })).toThrow(/Fill in token/);
    expect(() => checkCredentials(auth, { tenant: 'a\u0001', token: 'x' })).toThrow(/not allowed/);
    const open = { ...auth, fields: [auth.fields[0]!] };
    expect(checkCredentials(open, { tenant: 'acme' }).keyEnd).toBeNull();
  });
});

describe('results', () => {
  it('tells data, nothing found and failures apart, and caps the text', () => {
    expect(
      interpretResult({
        content: [{ type: 'text', text: '{"a":1}' }],
        structuredContent: { a: 1 },
      }),
    ).toMatchObject({
      kind: 'ok',
      text: '{"a":1}',
    });
    expect(interpretResult({ content: [] })).toMatchObject({ kind: 'nothing_found' });
    expect(interpretResult(undefined)).toMatchObject({ kind: 'nothing_found' });
    expect(interpretResult({ content: [], structuredContent: [] })).toMatchObject({
      kind: 'nothing_found',
    });
    expect(
      interpretResult({ isError: true, content: [{ type: 'text', text: 'Not found here' }] }),
    ).toMatchObject({
      kind: 'nothing_found',
    });
    expect(
      interpretResult({
        isError: true,
        content: [{ type: 'text', text: '{"error":"invalid_input"}' }],
      }),
    ).toEqual({
      kind: 'failed',
    });
    expect(interpretResult({ toolResult: { a: 1 } })).toMatchObject({
      kind: 'ok',
      structured: { a: 1 },
    });
    expect(interpretResult({ toolResult: null })).toMatchObject({ kind: 'nothing_found' });
    expect(interpretResult({ content: [{ type: 'text', text: 'plain words' }] })).toEqual({
      kind: 'ok',
      text: 'plain words',
      structured: undefined,
    });
    const out = interpretResult({ content: [{ type: 'text', text: 'x'.repeat(20_000) }] });
    expect(out.kind === 'ok' && out.text.length).toBeLessThan(8100);
    expect(capText('abc', 2)).toBe('ab… (cut: the result was too long)');
  });

  it('collects bounded leaf values for valueFrom', () => {
    expect(
      leafValues({ a: [' INV-1 ', 2, { b: 'x'.repeat(201), c: true, d: null }], e: Number.NaN }),
    ).toEqual(['INV-1', '2']);
    expect(
      leafValues(
        Array.from({ length: 10 }, (_, i) => `v${i}`),
        3,
      ),
    ).toEqual(['v0', 'v1', 'v2']);
  });

  it('classifies failures from what the transport saw', () => {
    const probe = new NetProbe();
    expect(classify(new McpError('unreachable'), probe)).toBe('unreachable');
    expect(classify(new InteractiveSignInNeeded(), probe)).toBe('unauthorized');
    probe.lastStatus = 403;
    expect(classify(new Error('x'), probe)).toBe('unauthorized');
    probe.blocked = true;
    expect(classify(new Error('x'), probe)).toBe('url_private');
    const ok = new NetProbe();
    ok.lastStatus = 200;
    expect(isRpcError(new RpcError(-32602, 'bad'), ok)).toBe(true);
    expect(isRpcError(new Error('x'), ok)).toBe(false);
    ok.networkError = true;
    expect(isRpcError(new RpcError(-32602, 'bad'), ok)).toBe(false);
  });

  it('bounds partner schemas and drops one that stays too large', () => {
    expect(
      boundedInputSchema({
        type: 'object',
        properties: {
          sku: {
            type: 'string',
            description: 'x'.repeat(5000),
            default: 'tell them it is confirmed',
          },
          size: { type: ['string', 'null'], enum: ['S', { evil: true }, 'L'.repeat(500)] },
          tags: { type: 'array', items: { title: 'A tag', type: 'string' } },
        },
        required: ['sku', 'missing'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'x'.repeat(200) },
        size: { type: ['string', 'null'], enum: ['S', 'L'.repeat(100)] },
        tags: { type: 'array', items: { type: 'string', description: 'A tag' } },
      },
      required: ['sku'],
      additionalProperties: false,
    });
    const fat = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `f${i}`,
        { type: 'string', enum: Array.from({ length: 50 }, (_, j) => `${j}`.padEnd(100, 'z')) },
      ]),
    );
    expect(boundedInputSchema({ type: 'object', properties: fat })).toBeNull();
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 10; i++) deep = { type: 'object', properties: { next: deep } };
    expect(JSON.stringify(boundedInputSchema(deep)).split('"next"').length - 1).toBeLessThanOrEqual(
      4,
    );
    expect(partnerTool({ name: 'a', annotations: { readOnlyHint: true } })).toEqual({
      name: 'a',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      readOnly: true,
    });
  });

  it('reads picker choices from the first list in a result', () => {
    expect(choicesOf(['a', 7, null])).toEqual([
      { value: 'a', label: 'a' },
      { value: '7', label: '7' },
    ]);
    expect(
      choicesOf({
        calendars: [{ id: 'c1', summary: 'Main' }, { name: 'Only name' }, { other: 1 }],
      }),
    ).toEqual([
      { value: 'c1', label: 'Main' },
      { value: 'Only name', label: 'Only name' },
    ]);
    expect(choicesOf({ none: true })).toEqual([]);
    expect(choicesOf(Array.from({ length: 150 }, (_, i) => `o${i}`))).toHaveLength(100);
  });

  it('answers problems with their own code and status', () => {
    expect(problemError('missing_tools')).toMatchObject({ status: 409, code: 'missing_tools' });
    expect(problemError('unreachable')).toMatchObject({ status: 502 });
  });
});

describe('tool names', () => {
  it('keeps names unique, valid and off the core names', () => {
    const taken = new Set(['check_free_times']);
    expect(connectorToolName('test-kedai', 'find.invoice', taken)).toBe('test-kedai__find_invoice');
    expect(connectorToolName('test-kedai', 'find.invoice', taken)).toBe(
      'test-kedai__find_invoice_2',
    );
    const long = connectorToolName('a'.repeat(49), 'b'.repeat(64), taken);
    expect(long).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });
});

describe('guards', () => {
  const hours: ConnectorSetting = { id: 'hours', type: 'timeRange', label: { en: 'Hours' } };
  const days: ConnectorSetting = { id: 'days', type: 'days', label: { en: 'Days' } };
  const zone = 'Asia/Kuala_Lumpur';

  it('reads argument paths', () => {
    expect(argAt({ a: { b: 'x' } }, 'a.b')).toBe('x');
    expect(argAt({ a: ['x'] }, 'a.0')).toBeUndefined();
    expect(argAt(null, 'a')).toBeUndefined();
    expect(argAt({ a: [{ b: 'x' }] }, 'a.b')).toBeUndefined();
    expect(argAt({}, 'toString')).toBeUndefined();
    expect(argAt({ a: {} }, 'a.b')).toBeUndefined();
  });

  it('checks times against hours and days in the AI time zone', () => {
    expect(localTime(Date.parse('2026-11-02T02:30:00Z'), zone)).toEqual({ day: 1, time: '10:30' });
    expect(fitsSetting('2026-11-02T10:30:00+08:00', hours, ['09:00', '18:00'], zone)).toBe(true);
    expect(fitsSetting('2026-11-02T18:00:00+08:00', hours, ['09:00', '18:00'], zone)).toBe(false);
    expect(fitsSetting('2026-11-02T10:30:00+08:00', hours, ['9', '18:00'], zone)).toBe(false);
    expect(fitsSetting('2026-11-02T10:30:00+08:00', hours, undefined, zone)).toBe(false);
    expect(fitsSetting('2026-11-02T10:30:00+08:00', days, [1, 2], zone)).toBe(true);
    expect(fitsSetting('2026-11-01T10:30:00+08:00', days, [1, 2], zone)).toBe(false);
    expect(fitsSetting('2026-11-02T10:30:00+08:00', days, 'monday', zone)).toBe(false);
    expect(fitsSetting('2026-11-02 10:30', hours, ['09:00', '18:00'], zone)).toBe(false);
    expect(fitsSetting('2026-13-45T10:30:00Z', hours, ['09:00', '18:00'], zone)).toBe(false);
    expect(fitsSetting('2026-11-02T10:30:00Z', undefined, ['09:00', '18:00'], zone)).toBe(false);
    expect(fitsSetting('2026-11-02T10:30:00Z', { ...hours, type: 'text' }, 'x', zone)).toBe(false);
  });

  it('accepts what the customer wrote as whole words or the saved contact, never anything else', () => {
    const texts = () => ['Hi, I am Mei Ying (mei.ying@example.com), call me on +60 12-345 6789.'];
    const saved = () => ['Mei Ying Tan', 'tan@example.com', '60111111111'];
    expect(customerGave('mei ying', texts, saved)).toBe(true);
    expect(customerGave('Mei.Ying@example.com', texts, saved)).toBe(true);
    expect(customerGave('+60 12-345 6789', texts, saved)).toBe(true);
    expect(customerGave('60123456789', texts, saved)).toBe(true);
    expect(customerGave('TAN@example.com', texts, saved)).toBe(true);
    expect(customerGave('+60 11-111 1111', texts, saved)).toBe(true);
    // Part of a word or of a number, short values and other people never match.
    expect(customerGave('ying@example.com', texts, saved)).toBe(false);
    expect(customerGave('Yin', texts, saved)).toBe(false);
    expect(customerGave('ei', texts, saved)).toBe(false);
    expect(customerGave('0123456789', texts, saved)).toBe(false);
    expect(customerGave('6789', texts, saved)).toBe(false);
    expect(customerGave('12345', () => ['my code is 12345'], saved)).toBe(false);
    expect(customerGave('Someone', texts, saved)).toBe(false);
    expect(customerGave('', texts, saved)).toBe(false);
    expect(customerGave('...', texts, saved)).toBe(false);
  });

  it('keeps only the declared fields of the arguments, with their types', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        qty: { type: 'integer' },
        size: { type: 'string', enum: ['S', 'M'] },
        tags: { type: 'array', items: { type: 'string' } },
        who: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
        loose: { type: 'object' },
        any: {},
      },
      required: ['name'],
      additionalProperties: false,
    };
    expect(
      cleanArgs(schema, {
        name: 'a',
        qty: 2,
        size: 'S',
        tags: ['x'],
        who: { email: 'e', alias: 'x' },
        loose: { k: 1 },
        any: 5,
        extra: 'dropped',
      }),
    ).toEqual({
      name: 'a',
      qty: 2,
      size: 'S',
      tags: ['x'],
      who: { email: 'e' },
      loose: { k: 1 },
      any: 5,
    });
    expect(cleanArgs(schema, { qty: 1 })).toBeNull();
    expect(cleanArgs(schema, { name: 'a', qty: 1.5 })).toBeNull();
    expect(cleanArgs(schema, { name: 'a', size: 'L' })).toBeNull();
    expect(cleanArgs(schema, { name: 'a', tags: [1] })).toBeNull();
    expect(cleanArgs(schema, { name: 'a', who: { alias: 'x' } })).toBeNull();
    expect(cleanArgs(schema, ['a'])).toBeNull();
    expect(cleanArgs(schema, null)).toBeNull();
    const types = {
      type: 'object',
      properties: { n: { type: ['number', 'null'] }, b: { type: 'boolean' }, x: { type: 'date' } },
    };
    expect(cleanArgs(types, { n: null, b: true })).toEqual({ n: null, b: true });
    expect(cleanArgs(types, { n: Number.NaN })).toBeNull();
    expect(cleanArgs(types, { x: 'today' })).toBeNull();
    let deep: Record<string, unknown> = { type: 'object', properties: {} };
    let value: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      deep = { type: 'object', properties: { n: deep } };
      value = { n: value };
    }
    expect(cleanArgs(deep, value)).toBeNull();
  });

  it('tells the AI what to do on each refusal', () => {
    const tool: ConnectorTool = {
      name: 'x',
      title: { en: 'X' },
      description: { en: 'X' },
      access: 'write',
      guards: { valueFrom: { sku: 'check_stock' } },
    };
    const name = (n: string) => `p__${n}`;
    expect(refusalText({ ok: false, reason: 'value_from', arg: 'sku' }, tool, name)).toContain(
      'Call p__check_stock first',
    );
    expect(refusalText({ ok: false, reason: 'unreachable' }, tool, name)).toBe(
      'Not done. Hand the chat to the team.',
    );
  });
});

describe('OAuth state', () => {
  it('keeps a given client, drops a registered one, never starts a sign-in in the background', () => {
    const data = { client: { client_id: 'given' }, dynamic: false };
    const provider = new ConnectorOAuthProvider(data, {
      redirectUrl: 'http://127.0.0.1:1/cb',
      interactive: false,
      scope: 's',
    });
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: ['http://127.0.0.1:1/cb'],
      scope: 's',
    });
    provider.saveClientInformation({ client_id: 'given', issuer: 'https://as' } as never);
    expect(data).toMatchObject({
      client: { client_id: 'given', issuer: 'https://as' },
      dynamic: false,
    });
    expect(() => provider.redirectToAuthorization(new URL('https://as/authorize'))).toThrow(
      InteractiveSignInNeeded,
    );
    expect(() => provider.codeVerifier()).toThrow();
    provider.invalidateCredentials('client');
    expect(data.client).toBeDefined();
    const dynamic = new ConnectorOAuthProvider({}, { redirectUrl: 'x', interactive: true });
    dynamic.saveClientInformation({ client_id: 'dcr' });
    dynamic.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 60 });
    dynamic.saveDiscoveryState({ authorizationServerUrl: 'https://as' });
    expect(dynamic.discoveryState()).toEqual({ authorizationServerUrl: 'https://as' });
    expect(typeof dynamic.state()).toBe('string');
    dynamic.invalidateCredentials('all');
    expect(dynamic.data).toEqual({ redirectUrl: 'x' });
    expect(
      new ConnectorOAuthProvider({}, { redirectUrl: 'y', interactive: false }).clientMetadata,
    ).not.toHaveProperty('scope');
  });

  it('knows when an access token ran out', () => {
    expect(
      tokensExpired(
        { tokens: { access_token: 'a', token_type: 'Bearer', expires_in: 60 }, obtainedAt: 0 },
        60_000,
      ),
    ).toBe(true);
    expect(
      tokensExpired(
        { tokens: { access_token: 'a', token_type: 'Bearer', expires_in: 60 }, obtainedAt: 0 },
        1_000,
      ),
    ).toBe(false);
    expect(tokensExpired({ tokens: { access_token: 'a', token_type: 'Bearer' } }, 1e15)).toBe(
      false,
    );
  });

  it('keeps at most 20 pending sign-ins, single use, for 10 minutes', () => {
    let now = 0;
    const pending = new PendingSignIns(() => now);
    const make = (connectorId: string) =>
      pending.create({
        connectorId,
        entry: {} as never,
        url: 'https://p',
        userId: 1,
        ip: null,
        data: {},
      });
    const first = make('a');
    for (let i = 0; i < 20; i++) make(`b${i}`);
    expect(pending.get(first.requestId)).toBeNull();
    const p = make('c');
    expect(pending.waiting('c')).toBe(p);
    expect(pending.takeByState('wrong')).toBeNull();
    expect(pending.takeByState(p.state)).toBe(p);
    expect(pending.takeByState(p.state)).toBeNull();
    const late = make('d');
    now += SIGN_IN_TTL_MS + 1;
    expect(pending.waiting('d')).toBeNull();
    expect(pending.takeByState(late.state)).toBeNull();
    expect(pending.get(late.requestId)).toBe(late);
    now += SIGN_IN_TTL_MS;
    expect(pending.get(late.requestId)).toBeNull();
    pending.forget('c');
    pending.clear();
  });
});

describe('free-form object maps (additionalProperties)', () => {
  // The shape of Notion's notion-create-pages: page `properties` is a map of column name → value.
  const notion = {
    type: 'object',
    properties: {
      parent: {
        type: 'object',
        properties: { database_id: { type: 'string' } },
        additionalProperties: false,
      },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            properties: {
              type: 'object',
              description: 'Page properties: column name → value',
              additionalProperties: { type: ['string', 'number', 'null'] },
            },
            content: { type: 'string' },
          },
        },
      },
    },
    required: ['pages'],
  };

  it('keeps the map keys of a Notion-like create call', () => {
    const schema = boundedInputSchema(notion)!;
    const args = cleanArgs(schema, {
      parent: { database_id: 'db1', alias: 'dropped' },
      pages: [
        { properties: { title: 'Order 42', Qty: 3, Notes: null }, content: 'Hi', extra: 'x' },
      ],
      extra: 'dropped',
    });
    expect(args).toEqual({
      parent: { database_id: 'db1' },
      pages: [{ properties: { title: 'Order 42', Qty: 3, Notes: null }, content: 'Hi' }],
    });
  });

  it('bounds the map in the schema and keeps fixed levels closed', () => {
    expect(
      boundedInputSchema({
        type: 'object',
        properties: {
          any: { type: 'object', additionalProperties: true },
          typed: {
            type: 'object',
            additionalProperties: { type: 'string', description: 'x'.repeat(500), default: 'y' },
          },
          // Fixed fields win: extra keys stay dropped at this level.
          mixed: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: true,
          },
          closed: { type: 'object', additionalProperties: false },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        any: { type: 'object', additionalProperties: true },
        typed: {
          type: 'object',
          additionalProperties: { type: 'string', description: 'x'.repeat(200) },
        },
        mixed: { type: 'object', properties: { a: { type: 'string' } } },
        closed: { type: 'object', properties: {} },
      },
      additionalProperties: false,
    });
    const schema = boundedInputSchema({
      type: 'object',
      properties: {
        mixed: {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true,
        },
        closed: { type: 'object', additionalProperties: false },
      },
    })!;
    expect(cleanArgs(schema, { mixed: { a: 'x', b: 'y' }, closed: { c: 1 } })).toEqual({
      mixed: { a: 'x' },
      closed: {},
    });
  });

  it('checks each map value against the value schema', () => {
    const schema = boundedInputSchema(notion)!;
    const page = (properties: unknown) => ({ pages: [{ properties }] });
    expect(cleanArgs(schema, page({ title: { nested: true } }))).toBeNull();
    expect(cleanArgs(schema, page({ title: ['a'] }))).toBeNull();
    expect(cleanArgs(schema, page('not a map'))).toBeNull();
    expect(cleanArgs(schema, page({}))).toEqual(page({}));
    // A key named like the prototype stays plain data.
    const odd = cleanArgs(schema, page(JSON.parse('{"__proto__":"x","a":1}')));
    const props = (odd!.pages as Array<{ properties: Record<string, unknown> }>)[0]!.properties;
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect(Object.keys(props)).toEqual(['__proto__', 'a']);
    expect(JSON.stringify(props)).toBe('{"__proto__":"x","a":1}');
  });

  it('refuses a map past its bounds, never cuts it', () => {
    const schema = boundedInputSchema({
      type: 'object',
      properties: { data: { type: 'object', additionalProperties: true } },
    })!;
    const keys = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(cleanArgs(schema, { data: keys(MAP_LIMITS.keys) })).toEqual({
      data: keys(MAP_LIMITS.keys),
    });
    expect(cleanArgs(schema, { data: keys(MAP_LIMITS.keys + 1) })).toBeNull();
    // Undefined values are left out and do not count.
    expect(cleanArgs(schema, { data: { a: 1, b: undefined } })).toEqual({ data: { a: 1 } });
    expect(cleanArgs(schema, { data: { ['k'.repeat(MAP_LIMITS.keyChars + 1)]: 1 } })).toBeNull();
    expect(cleanArgs(schema, { data: { '': 1 } })).toBeNull();
    const long = 's'.repeat(MAP_LIMITS.stringChars);
    expect(cleanArgs(schema, { data: { a: long } })).toEqual({ data: { a: long } });
    expect(cleanArgs(schema, { data: { a: `${long}s` } })).toBeNull();
    // Nested values inside a free map are bounded too (strings, arrays, maps, depth).
    expect(cleanArgs(schema, { data: { a: { b: [`${long}s`] } } })).toBeNull();
    expect(
      cleanArgs(schema, {
        data: { a: Array.from({ length: MAP_LIMITS.arrayItems + 1 }, () => 1) },
      }),
    ).toBeNull();
    expect(cleanArgs(schema, { data: { a: { b: keys(MAP_LIMITS.keys + 1) } } })).toBeNull();
    expect(cleanArgs(schema, { data: { a: [{ b: 1 }, 'c'] } })).toEqual({
      data: { a: [{ b: 1 }, 'c'] },
    });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    expect(cleanArgs(schema, { data: deep })).toBeNull();
    // Strings outside a map keep no size cap (a page's content may be long).
    const text = boundedInputSchema({
      type: 'object',
      properties: { content: { type: 'string' } },
    })!;
    expect(cleanArgs(text, { content: `${long}s` })).toEqual({ content: `${long}s` });
  });
});

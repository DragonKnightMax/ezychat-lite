// A local partner MCP server for tests, e2e and Dev Builds: one process on 127.0.0.1 serving one
// MCP endpoint per sign-in type (Streamable HTTP, stateless JSON responses) with the same demo
// tools, plus the signed TEST connector list and its icons. TEST ONLY: never imported by the app.
// Ported and simplified from the Enterprise connector-testkit (packages/connector-testkit/src/server.ts).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { generateSelfSignedCert } from './cert.mjs';
import { buildSignedList, createListKeys, TEST_ICONS } from './list.mjs';
import { OAuthTestServer, sendJson } from './oauth.mjs';

export const ENDPOINTS = ['none', 'api-key', 'credentials', 'oauth', 'oauth-own-app'];
/** ok = normal; down = connections are dropped; refused = every MCP call answers 401; rpc_error = tools/call answers a JSON-RPC error. */
export const STATES = ['ok', 'down', 'refused', 'rpc_error'];

export const PARTNER_CREDENTIALS = {
  apiKey: 'pk_test_kedai_4242',
  account: 'acme',
  username: 'demo',
  password: 'demo-pass-9876',
  /** oauth: a public client ID an entry may carry (no secret). */
  publicClientId: 'ezychat-public-test',
  /** oauth-own-app: the admin's own client. */
  clientId: 'ezychat-own-app',
  clientSecret: 'own-app-secret-55',
};

export const INVOICES = [
  { number: 'INV-1001', customer: 'Farah Catering', status: 'paid', total: 'RM 1,240.00' },
  { number: 'INV-1002', customer: 'Farah Catering', status: 'due 30 Nov 2026', total: 'RM 380.00' },
  { number: 'INV-1003', customer: 'Kedai Runcit Ali', status: 'overdue', total: 'RM 96.50' },
];
export const STOCK = [
  { sku: 'KA-HB-1KG', name: 'House blend coffee 1 kg', in_stock: 42 },
  { sku: 'KA-KY-400', name: 'Kaya jam 400 g', in_stock: 36 },
  { sku: 'KA-KP-250', name: 'Kaya puff box', in_stock: 0 },
];
export const PRICE_LISTS = [
  { id: 'retail', name: 'Retail' },
  { id: 'wholesale', name: 'Wholesale' },
];

const MAX_BODY = 1024 * 1024;
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

class BodyTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const bearerOf = (req) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
const ok = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});
const notFound = (message) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', message }) }],
});

/** A fresh MCP server (stateless: one per HTTP request) with the demo tools. */
function createPartnerServer(endpoint, state) {
  const server = new McpServer({ name: `Test partner (${endpoint})`, version: '1.0.0' });
  const record = (tool) => state.calls.push({ endpoint, tool });
  server.registerTool(
    'find_invoice',
    {
      description: 'Find invoices by invoice number or customer name.',
      inputSchema: {
        invoice_number: z.string().max(40).optional().describe('An invoice number, e.g. INV-1001'),
        customer: z.string().max(200).optional().describe('Customer name'),
      },
      annotations: { title: 'Find invoices', ...READ },
    },
    ({ invoice_number, customer }) => {
      record('find_invoice');
      const found = INVOICES.filter(
        (i) =>
          (!invoice_number || i.number.toLowerCase() === invoice_number.toLowerCase()) &&
          (!customer || i.customer.toLowerCase().includes(customer.toLowerCase())),
      );
      return found.length ? ok({ invoices: found }) : notFound('No invoice matches');
    },
  );
  server.registerTool(
    'check_stock',
    {
      description: 'Stock by SKU or product name.',
      inputSchema: { query: z.string().min(1).max(200).describe('SKU or product name') },
      annotations: { title: 'Check stock', ...READ },
    },
    ({ query }) => {
      record('check_stock');
      const q = query.toLowerCase();
      const items = STOCK.filter(
        (s) => s.sku.toLowerCase() === q || s.name.toLowerCase().includes(q),
      );
      return items.length ? ok({ items }) : notFound('No product matches');
    },
  );
  server.registerTool(
    'list_price_lists',
    {
      description: 'The price lists.',
      inputSchema: {},
      annotations: { title: 'Price lists', ...READ },
    },
    () => {
      record('list_price_lists');
      return ok({ priceLists: PRICE_LISTS });
    },
  );
  server.registerTool(
    'create_quotation',
    {
      description: 'Create a draft quotation.',
      inputSchema: {
        customer_name: z.string().min(1).max(200),
        customer_email: z.string().max(254).optional(),
        sku: z.string().min(1).max(40),
        quantity: z.number().int().min(1).max(10000),
        delivery_at: z.string().min(1).max(40).describe('Delivery time, ISO 8601 with offset'),
      },
      annotations: { title: 'Create quotation', readOnlyHint: false, destructiveHint: false },
    },
    (args) => {
      record('create_quotation');
      const quote = { quote: `Q-${2001 + state.quotations.length}`, status: 'draft', ...args };
      state.quotations.push(quote);
      return ok({ quote: quote.quote, status: 'draft' });
    },
  );
  // Never listed by any entry: the app must not offer it.
  server.registerTool(
    'delete_invoice',
    { description: 'Delete an invoice.', inputSchema: { invoice_number: z.string() } },
    () => {
      record('delete_invoice');
      return ok({ deleted: true });
    },
  );
  return server;
}

/**
 * Starts the endpoints on 127.0.0.1. Options: port (default 7610; 0 picks one), tls (true = a new
 * self-signed certificate, or { cert, key }), accessTokenTtlSeconds (300), states, controlToken,
 * log, list ({ privateKey, sequence } to serve a signed test list; default a new key pair).
 */
export async function startPartnerMcp(options = {}) {
  const ttl = options.accessTokenTtlSeconds ?? 300;
  const states = new Map(ENDPOINTS.map((id) => [id, options.states?.[id] ?? 'ok']));
  const delays = new Map();
  const controlToken = options.controlToken ?? randomBytes(18).toString('base64url');
  const state = { calls: [], quotations: [] };
  const log = options.log ?? (() => {});
  const keys = options.list?.privateKey ? options.list : createListKeys();
  let sequence = options.list?.sequence ?? 1;
  const oauth = {
    oauth: new OAuthTestServer({
      segment: 'oauth',
      dynamicRegistration: true,
      accessTokenTtlSeconds: ttl,
      resourceName: 'Lejar Accounting (test)',
      clients: [{ clientId: PARTNER_CREDENTIALS.publicClientId }],
    }),
    'oauth-own-app': new OAuthTestServer({
      segment: 'oauth-own-app',
      dynamicRegistration: false,
      accessTokenTtlSeconds: ttl,
      resourceName: 'Bayar Payments (test)',
      clients: [
        { clientId: PARTNER_CREDENTIALS.clientId, clientSecret: PARTNER_CREDENTIALS.clientSecret },
      ],
    }),
  };

  const endpointOf = (path) => {
    const m =
      /^\/\.well-known\/(?:oauth-protected-resource|oauth-authorization-server|openid-configuration)\/([^/]+)/.exec(
        path,
      ) ?? /^\/([^/]+)(?:\/|$)/.exec(path);
    return m?.[1] && ENDPOINTS.includes(m[1]) ? m[1] : undefined;
  };

  const authorized = (req, id) => {
    switch (id) {
      case 'none':
        return true;
      case 'api-key':
        return safeEqual(bearerOf(req), PARTNER_CREDENTIALS.apiKey);
      case 'credentials': {
        const basic = Buffer.from(
          `${PARTNER_CREDENTIALS.username}:${PARTNER_CREDENTIALS.password}`,
        ).toString('base64');
        return (
          safeEqual(req.headers.authorization, `Basic ${basic}`) &&
          req.headers['x-account'] === PARTNER_CREDENTIALS.account
        );
      }
      default: {
        const token = bearerOf(req);
        return token !== undefined && oauth[id].verifyAccessToken(token);
      }
    }
  };

  const handleMcp = async (req, res, id) => {
    if (req.method !== 'POST')
      return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    if (states.get(id) === 'refused' || !authorized(req, id)) {
      log(`${id} 401`);
      const challenge =
        oauth[id]?.challenge(!!req.headers.authorization) ?? 'Bearer error="invalid_token"';
      return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': challenge });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof BodyTooLarge) return;
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
    }
    const msg = Array.isArray(body) ? body[0] : body;
    const method = typeof msg?.method === 'string' ? msg.method : 'response';
    const tool =
      method === 'tools/call' && typeof msg?.params?.name === 'string' ? ` ${msg.params.name}` : '';
    const delay = delays.get(id) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (res.destroyed) return;
    if (states.get(id) === 'rpc_error' && method === 'tools/call') {
      log(`${id} ${method}${tool} 200 rpc_error`);
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg?.id ?? null,
        error: { code: -32602, message: 'Invalid params' },
      });
    }
    const server = createPartnerServer(id, state);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    log(`${id} ${method}${tool} ${res.statusCode}`);
  };

  const handleControl = async (req, res) => {
    if (!safeEqual(bearerOf(req), controlToken))
      return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST') {
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: 'invalid_json' });
      }
      if (!ENDPOINTS.includes(parsed.endpoint) || !STATES.includes(parsed.state))
        return sendJson(res, 400, { error: 'invalid_request' });
      kit.setState(parsed.endpoint, parsed.state);
    }
    sendJson(res, 200, Object.fromEntries(states));
  };

  // Built once per sequence: the list and its .sig come in two requests, and a list rebuilt for the second one
  // carries a new generatedAt (whole seconds), so across a second boundary the signature would not match.
  let signedCache = null;
  const signedList = () => {
    if (signedCache?.sequence !== sequence)
      signedCache = {
        sequence,
        signed: buildSignedList({ origin, privateKey: keys.privateKey, sequence }),
      };
    return signedCache.signed;
  };

  const handleList = (req, res, path) => {
    const signed = signedList();
    if (path === '/connectors/list-v1.json')
      return void res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(signed.bytes);
    if (path === '/connectors/list-v1.json.sig')
      return void res
        .writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        .end(signed.signature);
    const file = /^\/connectors\/icons\/([a-z0-9-]+\.svg)$/.exec(path)?.[1];
    if (file && TEST_ICONS[file])
      return void res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(TEST_ICONS[file]);
    return sendJson(res, 404, { error: 'not_found' });
  };

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', origin);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    if (url.pathname === '/_control') return handleControl(req, res);
    if (url.pathname.startsWith('/connectors/')) return handleList(req, res, url.pathname);
    const id = endpointOf(url.pathname);
    if (id && states.get(id) === 'down') {
      req.socket.destroy();
      return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(ENDPOINTS.map((e) => `${e}: ${origin}/${e}/mcp`).join('\n') + '\n');
      return;
    }
    if (!id) return sendJson(res, 404, { error: 'not_found' });
    if (url.pathname === `/${id}/mcp`) return handleMcp(req, res, id);
    const as = oauth[id];
    if (as) {
      if (url.pathname === `/.well-known/oauth-protected-resource/${id}/mcp`)
        return sendJson(res, 200, as.protectedResourceMetadata());
      if (url.pathname === `/.well-known/oauth-authorization-server/${id}`)
        return sendJson(res, 200, as.authorizationServerMetadata());
      try {
        if (await as.handle(req, res, url, () => readBody(req))) return;
      } catch (err) {
        if (err instanceof BodyTooLarge) return;
        throw err;
      }
    }
    sendJson(res, 404, { error: 'not_found' });
  };

  const onRequest = (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
      else res.destroy();
    });
  };

  const tls = options.tls === true ? generateSelfSignedCert() : options.tls || undefined;
  const server = tls
    ? createHttpsServer({ cert: tls.cert, key: tls.key }, onRequest)
    : createHttpServer(onRequest);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7610, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  for (const as of Object.values(oauth)) as.origin = origin;

  const kit = {
    origin,
    port,
    cert: tls?.cert,
    controlToken,
    /** base64 raw Ed25519 public key that verifies the served list (EZYCHAT_CONNECTOR_LIST_TEST_KEY). */
    listPublicKey: keys.publicKeyBase64,
    listBaseUrl: `${origin}/connectors/`,
    listUrl: `${origin}/connectors/list-v1.json`,
    state,
    oauth,
    url: (id) => `${origin}/${id}/mcp`,
    getState: (id) => states.get(id) ?? 'ok',
    setState(id, next) {
      if (next === 'refused') oauth[id]?.revokeAll();
      states.set(id, next);
    },
    /** OAuth endpoints: access tokens stop working, refresh tokens still do. */
    expireAccessTokens(id) {
      oauth[id]?.expireAccessTokens();
    },
    setDelay(id, ms) {
      delays.set(id, Math.max(0, ms));
    },
    /** Publishes a new list version (higher sequence). */
    bumpList() {
      sequence += 1;
      return sequence;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return kit;
}

/**
 * Opens an authorization URL of this server, presses Allow (or Cancel) on its consent page and
 * returns the redirect address the browser would go to (with `code`/`state`, or `error`).
 */
export async function completeConsent(authorizationUrl, decision = 'allow', ca) {
  const { request } = await import('node:https');
  const send = (url, method, body) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          ...(ca ? { ca } : {}),
          headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              location: res.headers.location,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const url = new URL(String(authorizationUrl));
  const pageRes = await send(url, 'GET');
  if (pageRes.status === 302) return new URL(pageRes.location);
  const requestId = /name="request_id" value="([^"]+)"/.exec(pageRes.text)?.[1];
  if (pageRes.status !== 200 || !requestId)
    throw new Error(`consent page failed with HTTP ${pageRes.status}`);
  const res = await send(
    new URL(url.pathname, url.origin),
    'POST',
    new URLSearchParams({ request_id: requestId, decision }).toString(),
  );
  if (res.status !== 302 || !res.location)
    throw new Error(`consent failed with HTTP ${res.status}`);
  return new URL(res.location);
}

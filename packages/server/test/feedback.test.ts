import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackDefaults } from '@ezychat/shared';
import type { ServerExtension } from '../src/extensions.js';
import {
  createFeedbackService,
  FEEDBACK_PER_DAY,
  FEEDBACK_PER_HOUR,
  INSTALL_REF_SETTING,
} from '../src/feedback/service.js';
import { FEEDBACK_PORTAL_URL } from '../src/feedback/portal.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n');
const LOG = Buffer.from('connection closed\nretrying\n');

interface Call {
  url: string;
  init: RequestInit;
  report: Record<string, unknown>;
  files: File[];
}

/** A fake licence portal: records each call, answers `answer` (default 201 FB-0001, FB-0002, …). */
function fakePortal(answer?: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const form = init!.body as FormData;
    calls.push({
      url: String(url),
      init: init!,
      report: JSON.parse(form.get('report') as string) as Record<string, unknown>,
      files: form.getAll('file') as File[],
    });
    if (answer) return answer(calls.length);
    return Response.json(
      { reference: `FB-${String(calls.length).padStart(4, '0')}` },
      { status: 201 },
    );
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

async function setUp(
  opts: {
    portal?: ReturnType<typeof fakePortal>;
    clock?: { now: number };
    extensions?: ServerExtension[];
    edition?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const portal = opts.portal ?? fakePortal();
  t = await makeTestApp({
    config: { version: '0.1.73' },
    extensions: opts.extensions,
    edition: opts.edition,
    beforeBuild: (ctx) => {
      ctx.services.feedback = createFeedbackService(ctx, {
        fetch: portal.fetch,
        ...(opts.clock ? { now: () => opts.clock!.now } : {}),
        env: opts.env ?? {},
      });
    },
  });
  const agent = await createUserAndLogin(t, { role: 'agent' });
  return { portal, cookie: agent.cookie, user: agent.user };
}

const report = (over: Record<string, unknown> = {}) => ({
  clientReportId: crypto.randomUUID(),
  type: 'problem',
  title: 'Photos do not open',
  details: 'Customer photos stay grey since this morning.',
  area: 'inbox',
  frequency: 'always',
  impact: 'slow',
  name: 'Aisyah',
  email: 'aisyah@example.com',
  contactOk: true,
  includeDetails: true,
  includeLog: false,
  screen: '/chats/60123456789@s.whatsapp.net?q=ali',
  client: 'desktop',
  language: 'en',
  timeZone: 'Asia/Kuala_Lumpur',
  ...over,
});

function multipart(
  reportJson: string | null,
  files: { name: string; bytes: Buffer; field?: string }[] = [],
) {
  const boundary = '----ezychat-feedback-test';
  const chunks: Buffer[] = [];
  if (reportJson !== null)
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="report"\r\n\r\n${reportJson}\r\n`,
      ),
    );
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'file'}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      f.bytes,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

function send(cookie: string, body: ReturnType<typeof multipart>) {
  return t.app.inject({
    method: 'POST',
    url: '/api/feedback',
    headers: { ...authHeaders(cookie), 'content-type': body.type },
    payload: body.payload,
  });
}
const sendReport = (
  cookie: string,
  r: Record<string, unknown> = report(),
  files: Parameters<typeof multipart>[1] = [],
) => send(cookie, multipart(JSON.stringify(r), files));

function writeLog(lines: string[]) {
  const dir = join(t.ctx.config.dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.1.log'), lines.join('\n') + '\n');
}

const PINO = [
  '{"level":30,"time":1762150000000,"pid":4120,"hostname":"KEDAI-PC","mod":"wa","msg":"connection update","state":"open"}',
  '{"level":30,"time":1762150001000,"pid":4120,"hostname":"KEDAI-PC","mod":"messages","jid":"60123456789@s.whatsapp.net","text":"Boleh hantar ke Shah Alam?","pushName":"Ali Baba","msg":"message stored"}',
  'not json at all 60123456789',
  '{"level":30,"time":1762150002000,"pid":4120,"hostname":"KEDAI-PC","mod":"web","req":{"method":"GET","url":"/api/chats?q=ali%40mail.com","remoteAddress":"192.168.1.20"},"msg":"incoming request"}',
  '{"level":50,"time":1762150003000,"pid":4120,"hostname":"KEDAI-PC","mod":"ai","apiKey":"sk-live-123456789","err":{"message":"failed for ali@mail.com +60 12-345 6789 from 10.0.0.5"},"msg":"AI answer unavailable"}',
];

describe('GET /api/feedback/defaults', () => {
  it('needs a sign-in', async () => {
    await setUp();
    const res = await t.app.inject({ method: 'GET', url: '/api/feedback/defaults' });
    expect(res.statusCode).toBe(401);
  });

  it('shows the app details and exactly the redacted log that would be sent', async () => {
    const { cookie } = await setUp();
    writeLog(PINO);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/feedback/defaults',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = FeedbackDefaults.parse(res.json());
    expect(body.company).toBeNull();
    expect(body.diagnostics).toMatchObject({
      edition: 'lite',
      version: '0.1.73',
      mode: 'dev',
      waConnected: true,
      aiMode: 'off',
    });
    expect(body.logLines).toBe(4); // the line that is not JSON is left out
    for (const secret of [
      '60123456789',
      'Boleh hantar',
      'Ali Baba',
      'KEDAI-PC',
      'ali@mail.com',
      'ali%40mail.com',
      '192.168.1.20',
      '10.0.0.5',
      'sk-live',
      '12-345 6789',
    ])
      expect(body.logPreview).not.toContain(secret);
    expect(body.logPreview).toContain('"msg":"AI answer unavailable"');
    expect(body.logPreview).toContain('"mod":"wa"');
  });

  it('has no log when there is none', async () => {
    const { cookie } = await setUp();
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/feedback/defaults',
      headers: { cookie },
    });
    expect(res.json()).toMatchObject({ logLines: 0, logPreview: '' });
  });
});

describe('POST /api/feedback', () => {
  it('forwards a report with app details and files as EZC-LITE, with a saved install ref', async () => {
    const { cookie, portal } = await setUp();
    const res = await sendReport(cookie, report(), [
      { name: 'shot.png', bytes: PNG },
      { name: 'C:\\Users\\ali\\invoice.pdf', bytes: PDF },
      { name: 'app.log', bytes: LOG },
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ reference: 'FB-0001' });
    const call = portal.calls[0]!;
    expect(call.url).toBe(FEEDBACK_PORTAL_URL);
    expect(call.init.redirect).toBe('error');
    expect(call.report).toMatchObject({
      product: 'EZC-LITE',
      type: 'problem',
      area: 'inbox',
      frequency: 'always',
      impact: 'slow',
      email: 'aisyah@example.com',
      contactOk: true,
      diagnostics: {
        edition: 'lite',
        version: '0.1.73',
        client: 'desktop',
        mode: 'dev',
        language: 'en',
        timeZone: 'Asia/Kuala_Lumpur',
        screen: '/chats/:id',
        waConnected: true,
        aiMode: 'off',
      },
    });
    expect(call.report).not.toHaveProperty('log');
    expect(call.report).not.toHaveProperty('includeLog');
    const ref = t.ctx.settings.get<string | null>(INSTALL_REF_SETTING, null);
    expect(call.report.installRef).toBe(ref);
    expect(call.files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['shot.png', 'image/png', PNG.length],
      ['invoice.pdf', 'application/pdf', PDF.length],
      ['app.log', 'text/plain', LOG.length],
    ]);
    // never a key, token or the secret file
    const sentText = JSON.stringify(call.report);
    expect(sentText).not.toMatch(/apiKey|token|secret|password/i);

    await sendReport(
      cookie,
      report({ type: 'idea', frequency: undefined, impact: undefined, includeDetails: false }),
    );
    expect(portal.calls[1]!.report.installRef).toBe(ref);
    expect(portal.calls[1]!.report).not.toHaveProperty('diagnostics');
    expect(portal.calls[1]!.report).not.toHaveProperty('frequency');
  });

  it('attaches the redacted log only when asked', async () => {
    const { cookie, portal } = await setUp();
    writeLog(PINO);
    expect((await sendReport(cookie, report({ includeLog: true }))).statusCode).toBe(201);
    const log = portal.calls[0]!.report.log as string;
    expect(log.split('\n')).toHaveLength(4);
    expect(log).not.toContain('60123456789');
    expect(log).not.toContain('Boleh hantar');
  });

  it('sends a retry of the same report once and does not count it again', async () => {
    const { cookie, portal } = await setUp();
    const r = report();
    const first = await sendReport(cookie, r);
    const second = await sendReport(cookie, r);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(portal.calls).toHaveLength(1);
    for (let i = 1; i < FEEDBACK_PER_HOUR; i++)
      expect((await sendReport(cookie)).statusCode).toBe(201);
  });

  it('retries a failed report with the same id without spending the limit', async () => {
    let down = true;
    const portal = fakePortal((n) =>
      down
        ? new Response('oops', { status: 500 })
        : Response.json({ reference: `FB-${n}` }, { status: 201 }),
    );
    const { cookie } = await setUp({ portal });
    const r = report();
    for (let i = 0; i < FEEDBACK_PER_HOUR + 2; i++) {
      const res = await sendReport(cookie, r);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('feedback_unreachable');
    }
    down = false;
    expect((await sendReport(cookie, r)).statusCode).toBe(201);
  });

  it('limits each user to 5 reports an hour and 20 a day', async () => {
    const clock = { now: 1_000_000 };
    const { cookie } = await setUp({ clock });
    for (let i = 0; i < FEEDBACK_PER_HOUR; i++)
      expect((await sendReport(cookie)).statusCode).toBe(201);
    const limited = await sendReport(cookie);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // someone else still may
    const other = await createUserAndLogin(t, { role: 'admin' });
    expect((await sendReport(other.cookie)).statusCode).toBe(201);
    let sent = FEEDBACK_PER_HOUR;
    while (sent < FEEDBACK_PER_DAY) {
      clock.now += 3_600_000;
      for (let i = 0; i < FEEDBACK_PER_HOUR && sent < FEEDBACK_PER_DAY; i++, sent++)
        expect((await sendReport(cookie)).statusCode).toBe(201);
    }
    clock.now += 3_600_000;
    expect((await sendReport(cookie)).statusCode).toBe(429);
    clock.now += 86_400_000;
    expect((await sendReport(cookie)).statusCode).toBe(201);
  });

  it('refuses what is not a valid report', async () => {
    const { cookie, portal } = await setUp();
    const notMultipart = await t.app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: authHeaders(cookie),
      payload: report(),
    });
    expect(notMultipart.statusCode).toBe(400);
    expect((await send(cookie, multipart(null))).statusCode).toBe(400);
    expect((await send(cookie, multipart('{nope'))).statusCode).toBe(400);
    expect((await sendReport(cookie, report({ email: '' }))).statusCode).toBe(400);
    expect((await sendReport(cookie, report({ area: 'ai' }))).statusCode).toBe(400);
    expect((await sendReport(cookie, report({ product: 'EZC-ENT' }))).statusCode).toBe(400);
    const four = await sendReport(
      cookie,
      report(),
      [1, 2, 3, 4].map((n) => ({ name: `${n}.png`, bytes: PNG })),
    );
    expect(four.statusCode).toBe(400);
    expect(portal.calls).toHaveLength(0);
  });

  it('needs a sign-in and a same-origin request', async () => {
    const { cookie } = await setUp();
    const body = multipart(JSON.stringify(report()));
    const anon = await t.app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { origin: 'http://localhost', host: 'localhost', 'content-type': body.type },
      payload: body.payload,
    });
    expect(anon.statusCode).toBe(401);
    const cross = await t.app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: {
        cookie,
        origin: 'http://evil.example',
        host: 'localhost',
        'content-type': body.type,
      },
      payload: body.payload,
    });
    expect(cross.statusCode).toBe(403);
  });

  it('reads the file type from the bytes and checks the sizes', async () => {
    const { cookie, portal } = await setUp();
    const exe = await sendReport(cookie, report(), [
      { name: 'photo.png', bytes: Buffer.from('MZ\x90\x00binary') },
    ]);
    expect(exe.statusCode).toBe(415);
    expect(exe.json().error.code).toBe('file_type');
    const binaryText = await sendReport(cookie, report(), [
      { name: 'notes.txt', bytes: Buffer.from([0x41, 0x00, 0x42]) },
    ]);
    expect(binaryText.statusCode).toBe(415);
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const tooBig = await sendReport(cookie, report(), [{ name: 'big.png', bytes: big }]);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe('too_large');
    const nine = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
    const tooMuch = await sendReport(
      cookie,
      report(),
      [1, 2, 3].map((n) => ({ name: `${n}.png`, bytes: nine })),
    );
    expect(tooMuch.statusCode).toBe(413);
    // a file under another field name is ignored
    const other = await sendReport(cookie, report(), [
      { name: 'x.png', bytes: PNG, field: 'other' },
    ]);
    expect(other.statusCode).toBe(201);
    expect(portal.calls[0]!.files).toHaveLength(0);
  });

  it('passes the portal answers on as the app errors', async () => {
    const answers: Response[] = [];
    const portal = fakePortal(() => answers.shift()!);
    const { cookie } = await setUp({ portal });
    const expectAnswer = async (res: Response, status: number, code: string) => {
      answers.push(res);
      const out = await sendReport(cookie, report());
      expect(out.statusCode).toBe(status);
      expect(out.json().error.code).toBe(code);
      return out;
    };
    await expectAnswer(
      Response.json({ error: 'invalid', field: 'email' }, { status: 400 }),
      400,
      'validation',
    );
    await expectAnswer(
      Response.json({ error: 'product_closed' }, { status: 403 }),
      503,
      'feedback_closed',
    );
    await expectAnswer(
      Response.json({ error: 'bad_install' }, { status: 401 }),
      502,
      'feedback_unreachable',
    );
    const limited = await expectAnswer(
      Response.json({ error: 'rate_limited', retryAfterSeconds: 1800 }, { status: 429 }),
      429,
      'rate_limited',
    );
    expect(limited.headers['retry-after']).toBe('1800');
  });
});

describe('editions', () => {
  const auth = (over: Record<string, unknown> = {}): ServerExtension => ({
    name: 'ent',
    feedbackAuth: async () => ({
      product: 'EZC-ENT',
      installId: 'K7QD-2M9X-PL4A',
      secret: 'install-secret',
      company: 'Kopi Apong Sdn Bhd',
      ...over,
    }),
  });

  it("sends with the first extension's licence and fills the company", async () => {
    const throwing: ServerExtension = {
      name: 'broken',
      feedbackAuth: async () => {
        throw new Error('licence file missing');
      },
    };
    const none: ServerExtension = { name: 'none', feedbackAuth: async () => null };
    const { cookie, portal } = await setUp({
      extensions: [throwing, none, auth(), auth({ product: 'SECOND' }) as never].map((e, i) => ({
        ...e,
        name: `${e.name}${i}`,
      })),
      edition: 'enterprise',
    });
    const defaults = await t.app.inject({
      method: 'GET',
      url: '/api/feedback/defaults',
      headers: { cookie },
    });
    expect(defaults.json()).toMatchObject({
      company: 'Kopi Apong Sdn Bhd',
      diagnostics: { edition: 'enterprise' },
    });
    expect((await sendReport(cookie)).statusCode).toBe(201);
    expect(portal.calls[0]!.report).toMatchObject({
      product: 'EZC-ENT',
      installId: 'K7QD-2M9X-PL4A',
      secret: 'install-secret',
      diagnostics: { edition: 'enterprise' },
    });
    expect(portal.calls[0]!.report).not.toHaveProperty('installRef');
    expect(t.ctx.settings.get(INSTALL_REF_SETTING, null)).toBeNull();
  });

  it("posts to the edition's own portal: https, or http only on this computer", async () => {
    const { cookie, portal } = await setUp({
      extensions: [auth({ portalOrigin: 'http://127.0.0.1:8787/ignored/path' })],
      edition: 'enterprise',
    });
    expect((await sendReport(cookie)).statusCode).toBe(201);
    expect(portal.calls[0]!.url).toBe('http://127.0.0.1:8787/v1/feedback');
  });

  it('refuses a portal origin that is not safe', async () => {
    const { cookie, portal } = await setUp({
      extensions: [auth({ portalOrigin: 'http://portal.example.com' })],
      edition: 'enterprise',
    });
    const res = await sendReport(cookie);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('feedback_unavailable');
    expect(portal.calls).toHaveLength(0);
  });

  it('never sends another edition as Lite when no extension gives a licence', async () => {
    const { cookie, portal } = await setUp({ edition: 'enterprise' });
    const res = await sendReport(cookie);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('feedback_unavailable');
    expect(portal.calls).toHaveLength(0);
  });

  it('reads EZYCHAT_FEEDBACK_URL only in a dev build with fake WhatsApp', async () => {
    const { cookie, portal } = await setUp({
      env: { EZYCHAT_FEEDBACK_URL: 'http://127.0.0.1:9999/v1/feedback' },
    });
    expect((await sendReport(cookie)).statusCode).toBe(201);
    expect(portal.calls[0]!.url).toBe('http://127.0.0.1:9999/v1/feedback');
    await t.close();

    const other = fakePortal();
    t = await makeTestApp({
      config: { mode: 'standalone' },
      beforeBuild: (ctx) => {
        ctx.services.feedback = createFeedbackService(ctx, {
          fetch: other.fetch,
          env: { EZYCHAT_FEEDBACK_URL: 'http://127.0.0.1:9999/v1/feedback' },
        });
      },
    });
    const user = await createUserAndLogin(t);
    expect((await sendReport(user.cookie)).statusCode).toBe(201);
    expect(other.calls[0]!.url).toBe(FEEDBACK_PORTAL_URL);
  });
});

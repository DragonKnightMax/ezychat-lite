import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { EnrichmentExtraction } from '@ezychat/shared';
import type { WaIncomingMessage } from '@ezychat/wa';
import type { AiProvider } from '../src/ai/provider-types.js';
import { createAiService } from '../src/ai/service.js';
import { CustomerRepo } from '../src/customers/repo.js';
import { createEnrichmentService, ENRICHMENT_MAX_AGE_MS } from '../src/customers/enrichment.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';

let t: TestApp;
let provider: AiProvider;
let connected: boolean;
let cookie: string;
let actor: { userId: number; ip: null };
let logs: string[];
const JID = '60129900001@s.whatsapp.net';
const TEXT =
  'I am Jay Low from Anchor Sprint. My email is jay@example.com. My address is 8 Jalan Baru.';
type Proposal = EnrichmentExtraction['fields'][number];
const candidate = (
  field: Proposal['field'],
  value: string,
  extra: Partial<Proposal> = {},
): Proposal => ({
  field,
  value,
  evidence: TEXT,
  ownership: 'self',
  statement: 'explicit',
  current: true,
  points: { ownership: 30, clarity: 25, context: 20, validation: 15, freshness: 10 },
  ...extra,
});
const extraction = (): EnrichmentExtraction => ({
  fields: [
    candidate('name', 'Jay Low'),
    candidate('company', 'Anchor Sprint', {
      points: { ownership: 25, clarity: 25, context: 20, validation: 15, freshness: 10 },
    }),
    candidate('email', 'jay@example.com'),
    candidate('address', '8 Jalan Baru'),
  ],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const events = () =>
  t.ctx.db
    .prepare("SELECT meta FROM audit_log WHERE action = 'customer.enrichment_update'")
    .all() as { meta: string }[];
const profile = () => new CustomerRepo(t.ctx.db).get(JID);
const enable = () => t.ctx.services.enrichment!.setEnabled(true, actor);
async function receive(
  extra: Partial<WaIncomingMessage> = {},
  source: 'live' | 'history' = 'live',
) {
  await t.ctx.services.messages!.ingest(
    {
      id: randomUUID(),
      chatJid: JID,
      senderJid: JID,
      senderName: 'WhatsApp nickname',
      fromMe: false,
      type: 'text',
      body: TEXT,
      timestamp: Date.now(),
      quotedId: null,
      media: null,
      ...extra,
    },
    source,
  );
  await tick();
}
beforeEach(async () => {
  connected = true;
  logs = [];
  provider = {
    generate: vi.fn(),
    extractCustomer: vi.fn().mockImplementation(async () => extraction()),
    connection: () => ({ state: connected ? 'connected' : 'expired', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  t = await makeTestApp({
    beforeBuild: async (ctx) => {
      await ctx.services.ai!.shutdown();
      ctx.services.ai = createAiService(ctx, { provider });
      // The already initialized enrichment service resolves the current shared AI service per call.
      const original = ctx.log.child.bind(ctx.log);
      vi.spyOn(ctx.log, 'child').mockImplementation(((bindings: Record<string, unknown>) =>
        bindings.mod === 'enrichment'
          ? pino({}, { write: (line: string) => logs.push(line) })
          : original(bindings)) as never);
      await ctx.services.enrichment!.shutdown();
      ctx.services.enrichment = createEnrichmentService(ctx);
    },
  });
  const admin = await createUserAndLogin(t, { role: 'admin' });
  cookie = admin.cookie;
  actor = { userId: admin.user.id, ip: null };
  t.ctx.services.ai!.saveConnection({ mode: 'chatgpt', model: '' }, actor);
});
afterEach(async () => {
  await t.close();
  vi.restoreAllMocks();
});

it('defaults off; only admins can change it and invalid bodies are rejected', async () => {
  expect(t.ctx.services.enrichment!.status()).toEqual({ enabled: false, connected: true });
  await receive();
  expect(provider.extractCustomer).not.toHaveBeenCalled();
  const agent = await createUserAndLogin(t);
  for (const method of ['GET', 'PUT'] as const) {
    const res = await t.app.inject({
      method,
      url: '/api/ai/enrichment',
      headers: authHeaders(agent.cookie),
      ...(method === 'PUT' ? { payload: { enabled: true } } : {}),
    });
    expect(res.statusCode).toBe(403);
  }
  const invalid = await t.app.inject({
    method: 'PUT',
    url: '/api/ai/enrichment',
    headers: authHeaders(cookie),
    payload: { enabled: 'yes' },
  });
  expect(invalid.statusCode).toBe(400);
  const valid = await t.app.inject({
    method: 'PUT',
    url: '/api/ai/enrichment',
    headers: authHeaders(cookie),
    payload: { enabled: true },
  });
  expect(valid.json()).toEqual({ enabled: true, connected: true });
  expect(t.ctx.settings.get('customer_enrichment_enabled', false)).toBe(true);
});
it('updates all four fields with Sales Agent absent, retains ownership and emits a live chat update', async () => {
  enable();
  const updated = vi.fn();
  t.ctx.bus.on('chat:updated', updated);
  await receive();
  expect(profile()).toMatchObject({
    name: 'Jay Low',
    company: 'Anchor Sprint',
    email: 'jay@example.com',
    address: '8 Jalan Baru',
    updatedBy: null,
  });
  expect(t.ctx.services.chats!.get(JID)?.assignedTo).toBeNull();
  expect(provider.generate).not.toHaveBeenCalled();
  expect(updated.mock.calls.at(-1)?.[0]).toMatchObject({ name: 'Jay Low' });
  const meta = JSON.parse(events()[0]!.meta);
  expect(meta.enrichment.average).toBe(98.75);
  expect(meta.enrichment.fields).toHaveLength(4);
  expect(events()[0]!.meta).not.toContain('Jay Low');
  expect(events()[0]!.meta).not.toContain('jay@example.com');
});
it.each([
  ['history', {}, 'history'],
  ['group', { chatJid: '123@g.us', senderJid: JID }, 'live'],
  ['outbound', { fromMe: true }, 'live'],
  ['caption', { type: 'image' }, 'live'],
  ['empty', { body: '' }, 'live'],
  ['invalid source reference', { id: 'x'.repeat(257) }, 'live'],
  ['stale', { timestamp: Date.now() - ENRICHMENT_MAX_AGE_MS - 1000 }, 'live'],
] as const)('ignores %s input', async (_name, extra, source) => {
  enable();
  await receive(extra, source);
  expect(provider.extractCustomer).not.toHaveBeenCalled();
  expect(events()).toHaveLength(0);
});
it.each([
  ['third party', { ownership: 'third_party' }],
  ['ambiguous', { ownership: 'unclear' }],
  ['inferred', { statement: 'inferred' }],
  ['not current', { current: false }],
  ['invented evidence', { evidence: 'This did not appear in the message' }],
  ['unquoted value', { value: 'invented@example.com' }],
  ['invalid email', { value: 'invalid-email', evidence: 'My email is invalid-email' }],
  [
    'below add threshold',
    { points: { ownership: 19, clarity: 25, context: 20, validation: 15, freshness: 10 } },
  ],
] as const)('blocks %s even if other criteria score highly', async (_name, extra) => {
  enable();
  vi.mocked(provider.extractCustomer!).mockResolvedValue({
    fields: [candidate('email', 'jay@example.com', extra)],
  });
  await receive({ body: `${TEXT} My email is invalid-email` });
  expect(profile()?.email ?? null).toBeNull();
  expect(events()).toHaveLength(0);
});
it.each([
  [89, false],
  [90, true],
] as const)('requires 90 points to fill an empty field (%i)', async (score, writes) => {
  enable();
  vi.mocked(provider.extractCustomer!).mockResolvedValue({
    fields: [
      candidate('name', 'Jay Low', {
        points: { ownership: score - 70, clarity: 25, context: 20, validation: 15, freshness: 10 },
      }),
    ],
  });
  await receive();
  expect(profile()?.name ?? null).toBe(writes ? 'Jay Low' : null);
});
it.each([
  [94, false],
  [95, true],
] as const)('requires 95 points to replace an existing value (%i)', async (score, writes) => {
  enable();
  await receive();
  const savedId = profile()!.id;
  t.ctx.services.customers!.save(
    JID,
    {
      name: 'Jay Low',
      company: 'Anchor Sprint',
      email: 'old@example.com',
      otherPhone: '+6012345',
      address: '8 Jalan Baru',
      tags: ['VIP'],
    },
    actor,
  );
  vi.mocked(provider.extractCustomer!).mockResolvedValue({
    fields: [
      candidate('email', 'jay@example.com', {
        statement: 'correction',
        points: { ownership: score - 70, clarity: 25, context: 20, validation: 15, freshness: 10 },
      }),
    ],
  });
  await receive();
  expect(profile()).toMatchObject({
    id: savedId,
    email: writes ? 'jay@example.com' : 'old@example.com',
    otherPhone: '+6012345',
    tags: ['VIP'],
  });
  if (writes) {
    const meta = JSON.parse(events().at(-1)!.meta);
    expect(meta.enrichment.average).toBe(95);
    expect(meta.enrichment.fields).toEqual([
      expect.objectContaining({ field: 'email', operation: 'replaced', threshold: 95 }),
    ]);
  } else expect(events()).toHaveLength(1);
});
it('writes the details to the same person’s chat in another inbox, keeping that chat’s tags', async () => {
  // a removed second inbox still holds the customer's chat (read only for admins)
  t.ctx.db
    .prepare(
      "INSERT INTO inboxes (id, name, tone, auth_dir, own_jid, created_at, removed_at) VALUES (2, 'Two', 'info', 'wa-auth-inboxes/2', NULL, 1, 2)",
    )
    .run();
  t.ctx.db
    .prepare(
      "INSERT INTO chats (jid, type, name, updated_at, inbox_id, wa_jid) VALUES (?, 'dm', '', 0, 2, ?)",
    )
    .run(`${JID}#2`, JID);
  const repo = new CustomerRepo(t.ctx.db);
  repo.save(
    `${JID}#2`,
    { name: null, company: null, email: null, otherPhone: null, address: null },
    ['Lead'],
    null,
    1,
  );
  const updated: string[] = [];
  t.ctx.bus.on('chat:updated', (c) => updated.push(c.jid));
  enable();
  await receive();
  await vi.waitFor(() => expect(events()).toHaveLength(1));
  expect(repo.get(`${JID}#2`)).toMatchObject({
    name: 'Jay Low',
    email: 'jay@example.com',
    address: '8 Jalan Baru',
    tags: ['Lead'],
  });
  expect(updated).toEqual(expect.arrayContaining([JID, `${JID}#2`]));
});

it('does not audit unchanged or duplicate fields', async () => {
  enable();
  await receive();
  await receive();
  expect(events()).toHaveLength(1);
  vi.mocked(provider.extractCustomer!).mockResolvedValue({
    fields: [candidate('email', 'other@example.com'), candidate('email', 'jay@example.com')],
  });
  await receive({ body: `${TEXT} My new email is other@example.com` });
  expect(events()).toHaveLength(1);
});
it('retains details split across a burst while discarding the older generation', async () => {
  enable();
  let finish!: (result: EnrichmentExtraction) => void;
  const introduction = 'My name is Jay Low.';
  const email = 'My email is jay@example.com.';
  vi.mocked(provider.extractCustomer!).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await receive({ body: introduction });
  vi.mocked(provider.extractCustomer!).mockResolvedValue({
    fields: [
      candidate('name', 'Jay Low', { evidence: introduction }),
      candidate('email', 'jay@example.com', { evidence: email }),
    ],
  });
  await receive({ body: email });
  finish(extraction());
  await tick();
  expect(profile()).toMatchObject({ name: 'Jay Low', email: 'jay@example.com' });
  expect(provider.extractCustomer).toHaveBeenCalledTimes(2);
  const input = JSON.parse(vi.mocked(provider.extractCustomer!).mock.calls[1]![2].input);
  expect(input.currentSituation.currentMessages.map((m: { text: string }) => m.text)).toEqual([
    introduction,
    email,
  ]);
  const meta = JSON.parse(events()[0]!.meta);
  expect(new Set(meta.enrichment.fields.map((f: { messageId: string }) => f.messageId)).size).toBe(
    2,
  );
});
it('bounds parallel calls across chats and drains pending live work', async () => {
  enable();
  const finish: ((result: EnrichmentExtraction) => void)[] = [];
  vi.mocked(provider.extractCustomer!).mockImplementation(
    () => new Promise((resolve) => finish.push(resolve)),
  );
  for (const digits of ['1', '2', '3'])
    await receive({ chatJid: `6012990000${digits}@s.whatsapp.net` });
  expect(provider.extractCustomer).toHaveBeenCalledTimes(2);
  finish[0]!({ fields: [] });
  await tick();
  expect(provider.extractCustomer).toHaveBeenCalledTimes(3);
  finish[1]!({ fields: [] });
  finish[2]!({ fields: [] });
  await tick();
});
it('does not revive evidence cancelled by turning enrichment off and back on', async () => {
  enable();
  const introduction = 'My name is Jay Low.';
  const email = 'My email is jay@example.com.';
  let finish!: (result: EnrichmentExtraction) => void;
  vi.mocked(provider.extractCustomer!).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await receive({ body: introduction });
  t.ctx.services.enrichment!.setEnabled(false, actor);
  enable();
  vi.mocked(provider.extractCustomer!).mockResolvedValue({
    fields: [
      candidate('name', 'Jay Low', { evidence: introduction }),
      candidate('email', 'jay@example.com', { evidence: email }),
    ],
  });
  await receive({ body: email });
  finish({ fields: [] });
  await tick();
  expect(profile()).toMatchObject({ name: null, email: 'jay@example.com' });
});
it('drops a result when a phone identity is repointed while the model runs', async () => {
  await receive(); // Existing phone-keyed chat, no enrichment while off.
  t.ctx.services.aliases!.learn({ jid: JID, alias: '101234567@lid' }, 'contacts');
  enable();
  let finish!: (result: EnrichmentExtraction) => void;
  vi.mocked(provider.extractCustomer!).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await receive();
  t.ctx.services.aliases!.learn({ jid: JID, alias: '109876543@lid' }, 'contacts');
  expect(t.ctx.services.aliases!.route(JID)).toBe('109876543@lid');
  finish(extraction());
  await tick();
  expect(profile()).toBeNull();
  expect(events()).toHaveLength(0);
});
it.each(['staff edit', 'turn off', 'connection change', 'newer message'] as const)(
  'drops a result after %s even if provider ignores cancellation',
  async (scenario) => {
    enable();
    let finish!: (result: EnrichmentExtraction) => void;
    vi.mocked(provider.extractCustomer!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await receive();
    const signal = vi.mocked(provider.extractCustomer!).mock.calls[0]![3];
    if (scenario === 'staff edit')
      t.ctx.services.customers!.save(
        JID,
        { name: 'Staff name', company: '', email: '', otherPhone: '', address: '', tags: [] },
        actor,
      );
    if (scenario === 'turn off') t.ctx.services.enrichment!.setEnabled(false, actor);
    if (scenario === 'connection change')
      t.ctx.services.ai!.saveConnection({ mode: 'chatgpt', model: '' }, actor);
    if (scenario === 'newer message') {
      vi.mocked(provider.extractCustomer!).mockResolvedValue({ fields: [] });
      await receive({ body: 'Ignore my earlier details, they belong to my colleague.' });
    }
    expect(signal.aborted).toBe(true);
    finish(extraction());
    await tick();
    expect(profile()?.name ?? null).toBe(scenario === 'staff edit' ? 'Staff name' : null);
    expect(events()).toHaveLength(0);
  },
);
it('pauses when disconnected, keeps audit records when off, and resumes only on a new live message', async () => {
  enable();
  await receive();
  connected = false;
  expect(t.ctx.services.enrichment!.status()).toEqual({ enabled: true, connected: false });
  await receive();
  expect(provider.extractCustomer).toHaveBeenCalledTimes(1);
  t.ctx.services.enrichment!.setEnabled(false, actor);
  expect(events()).toHaveLength(1);
  connected = true;
  enable();
  await tick();
  expect(provider.extractCustomer).toHaveBeenCalledTimes(1);
  await receive();
  expect(provider.extractCustomer).toHaveBeenCalledTimes(2);
});
it('rolls back customer values when the enrichment audit cannot be committed', async () => {
  enable();
  t.ctx.db.exec(
    "CREATE TRIGGER deny_enrichment BEFORE INSERT ON audit_log WHEN NEW.action = 'customer.enrichment_update' BEGIN SELECT RAISE(ABORT, 'deny'); END",
  );
  await receive();
  expect(profile()).toBeNull();
  expect(events()).toHaveLength(0);
});
it('keeps private values out of errors and does not retry provider failures', async () => {
  enable();
  vi.mocked(provider.extractCustomer!).mockRejectedValue(new Error(`private ${TEXT}`));
  await receive();
  expect(provider.extractCustomer).toHaveBeenCalledTimes(1);
  expect(profile()).toBeNull();
  expect(events()).toHaveLength(0);
  expect(logs.join('')).toContain('customer_enrichment_failed');
  expect(logs.join('')).not.toContain(TEXT);
});

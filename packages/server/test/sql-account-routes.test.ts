import { afterEach, describe, expect, it } from 'vitest';
import { SqlAccountStatus, SqlConnectResult } from '@ezychat/shared';
import { listAgents } from '../src/ai/agents.js';
import { FAKE_SQL_ACCESS_KEY, FAKE_SQL_SECRET } from '../src/connectors/sql-account/fake.js';
import {
  CONNECTION_SETTING,
  createSqlAccountService,
} from '../src/connectors/sql-account/service.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { expectAdminOnly } from './google-connector-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const FARAH = '60123110021@s.whatsapp.net';
const PRIYA = '60128814455@s.whatsapp.net';
const JASON = '60129001234@s.whatsapp.net';
const AHMAD = '60125550142@s.whatsapp.net';

async function setUp() {
  t = await makeTestApp({
    beforeBuild: (ctx) => {
      ctx.services.sqlAccount = createSqlAccountService(ctx, { sleep: () => Promise.resolve() });
    },
  });
  const admin = await createUserAndLogin(t, { role: 'admin' });
  const agent = await createUserAndLogin(t, { role: 'agent' });
  t.ctx.services.ai!.saveMember(
    { displayName: 'Aina', enabled: false, instructions: '' },
    { userId: admin.user.id, ip: null },
  );
  for (const [i, jid] of [FARAH, PRIYA, JASON, AHMAD].entries())
    await getMessages(t.ctx).ingest(
      {
        id: `m${i}`,
        chatJid: jid,
        body: 'hello',
        type: 'text',
        fromMe: false,
        senderJid: jid,
        senderName: `Person ${i}`,
        timestamp: Date.now() - (10 - i) * 1000,
        quotedId: null,
        media: null,
      },
      'live',
    );
  return { admin: admin.cookie, agent: agent.cookie, agentId: listAgents(t.ctx.db)[0]!.id };
}

const get = (url: string, cookie: string) =>
  t.app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, cookie: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, headers: authHeaders(cookie), payload: payload as object });
const put = (url: string, cookie: string, payload: unknown) =>
  t.app.inject({ method: 'PUT', url, headers: authHeaders(cookie), payload: payload as object });

const connect = (cookie: string, accessKey = FAKE_SQL_ACCESS_KEY, secretKey = FAKE_SQL_SECRET) =>
  post('/api/connectors/sql-account/connect', cookie, { accessKey, secretKey });

const auditActions = () =>
  (
    t.ctx.db.prepare('SELECT action, meta FROM audit_log ORDER BY id').all() as Array<{
      action: string;
      meta: string;
    }>
  ).filter((r) => r.action.startsWith('sql_account'));

describe('SQL Account routes', () => {
  it('are admin only', async () => {
    const { agent, agentId } = await setUp();
    await expectAdminOnly(t, agent, [
      ['GET', '/api/connectors/sql-account'],
      ['POST', '/api/connectors/sql-account/connect'],
      ['POST', '/api/connectors/sql-account/test'],
      ['POST', '/api/connectors/sql-account/disconnect'],
      ['PUT', '/api/connectors/sql-account/match'],
      ['GET', `/api/connectors/sql-account/agents/${agentId}`],
      ['PUT', `/api/connectors/sql-account/agents/${agentId}`],
      ['GET', '/api/connectors/sql-account/customers'],
      ['GET', '/api/connectors/sql-account/debtors'],
      ['PUT', '/api/connectors/sql-account/links'],
      ['GET', '/api/connectors/sql-account/activity'],
      ['POST', '/api/dev/fake-sql-account/scenario'],
      ['GET', '/api/dev/fake-sql-account/quotations'],
    ]);
  });

  it('refuses a key that is not a SQL Account access key and saves nothing', async () => {
    const { admin } = await setUp();
    const res = SqlConnectResult.parse((await connect(admin, 'my-key-123')).json());
    expect(res).toMatchObject({
      ok: false,
      error: 'key_format',
      status: { state: 'disconnected' },
    });
    expect(t.ctx.settings.getSecret(CONNECTION_SETTING)).toBeNull();
  });

  it('reports each "cannot connect" state and saves the keys only when SQL Account answered', async () => {
    const { admin } = await setUp();
    for (const scenario of [
      'no_dns',
      'unreachable',
      'private_ip',
      'bad_keys',
      'old_version',
    ] as const) {
      expect(
        (await post('/api/dev/fake-sql-account/scenario', admin, { scenario })).statusCode,
      ).toBe(200);
      const res = SqlConnectResult.parse((await connect(admin)).json());
      expect(res).toMatchObject({ ok: false, error: scenario, status: { state: 'disconnected' } });
    }
    await post('/api/dev/fake-sql-account/scenario', admin, { scenario: 'ok' });
    const wrong = SqlConnectResult.parse(
      (await connect(admin, FAKE_SQL_ACCESS_KEY, 'nope')).json(),
    );
    expect(wrong.error).toBe('bad_keys');
    expect(t.ctx.settings.getSecret(CONNECTION_SETTING)).toBeNull();

    const ok = SqlConnectResult.parse((await connect(admin)).json());
    expect(ok).toMatchObject({
      ok: true,
      error: null,
      status: {
        state: 'connected',
        host: 'https://api.sql.my',
        keyEnd: '…cdef/APIUSER',
        matchByPhone: true,
      },
    });
    // The secret is stored encrypted and never sent back.
    const raw = t.ctx.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(CONNECTION_SETTING) as { value: string } | undefined;
    expect(raw?.value).not.toContain(FAKE_SQL_SECRET);
    const status = (await get('/api/connectors/sql-account', admin)).body;
    expect(status).not.toContain(FAKE_SQL_SECRET);
    expect(auditActions().map((a) => a.action)).toContain('sql_account.connect');
    expect(JSON.stringify(auditActions())).not.toContain(FAKE_SQL_SECRET);
  });

  it('tests the connection, shows a problem and disconnects', async () => {
    const { admin } = await setUp();
    await connect(admin);
    await post('/api/dev/fake-sql-account/scenario', admin, { scenario: 'unreachable' });
    const failing = SqlAccountStatus.parse(
      (await post('/api/connectors/sql-account/test', admin)).json(),
    );
    expect(failing.state).toBe('unreachable');
    await post('/api/dev/fake-sql-account/scenario', admin, { scenario: 'ok' });
    expect((await post('/api/connectors/sql-account/test', admin)).json().state).toBe('connected');
    const off = SqlAccountStatus.parse(
      (await post('/api/connectors/sql-account/disconnect', admin)).json(),
    );
    expect(off).toMatchObject({ state: 'disconnected', host: null, keyEnd: null });
    expect(t.ctx.settings.getSecret(CONNECTION_SETTING)).toBeNull();
    expect((await post('/api/connectors/sql-account/test', admin)).json().state).toBe(
      'disconnected',
    );
  });

  it("saves each agent's object access, keeping create to quotations", async () => {
    const { admin, agentId } = await setUp();
    expect((await get(`/api/connectors/sql-account/agents/${agentId}`, admin)).json()).toEqual({
      access: {},
      showPrice: true,
      stockDetail: 'inStock',
    });
    const saved = await put(`/api/connectors/sql-account/agents/${agentId}`, admin, {
      access: { salesquotation: 'create', salesorder: 'create', stockitem: 'off' },
      showPrice: false,
      stockDetail: 'quantity',
    });
    expect(saved.json()).toEqual({
      access: { salesquotation: 'create', salesorder: 'read', stockitem: 'off' },
      showPrice: false,
      stockDetail: 'quantity',
    });
    expect((await get(`/api/connectors/sql-account/agents/${agentId}`, admin)).json()).toEqual(
      saved.json(),
    );
    const audit = auditActions().find((a) => a.action === 'sql_account.agent_settings')!;
    expect(JSON.parse(audit.meta)).toMatchObject({
      agentId,
      showPrice: false,
      stockDetail: 'quantity',
    });
    expect((await get('/api/connectors/sql-account/agents/999', admin)).statusCode).toBe(404);
    expect((await put('/api/connectors/sql-account/agents/999', admin, {})).statusCode).toBe(404);
    expect(
      (
        await put(`/api/connectors/sql-account/agents/${agentId}`, admin, {
          access: { customer: 'write' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('matches chats by link or by a unique phone number, never by name', async () => {
    const { admin } = await setUp();
    expect((await get('/api/connectors/sql-account/customers', admin)).json()).toHaveLength(4);
    await connect(admin);
    await t.ctx.services.sqlAccount!.indexReady();
    const rows = (await get('/api/connectors/sql-account/customers', admin)).json() as Array<{
      jid: string;
      kind: string;
      code: string | null;
    }>;
    const by = (jid: string) => rows.find((r) => r.jid === jid)!;
    expect(by(FARAH)).toMatchObject({ kind: 'phone', code: '300-F0001' });
    expect(by(PRIYA)).toMatchObject({ kind: 'phone', code: '300-P0007' });
    expect(by(JASON)).toMatchObject({ kind: 'several', code: null });
    expect(by(AHMAD)).toMatchObject({ kind: 'none', code: null });
    expect((await get('/api/connectors/sql-account', admin)).json().phoneMatch).toBe('available');

    // Link Jason to one of the two customers; a code SQL Account does not know is refused.
    const unknown = await put('/api/connectors/sql-account/links', admin, {
      jid: JASON,
      code: '300-X9999',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('unknown_code');
    expect(
      (
        await put('/api/connectors/sql-account/links', admin, { jid: JASON, code: '300-J0004' })
      ).json(),
    ).toEqual({ ok: true });
    expect(
      (
        await put('/api/connectors/sql-account/links', admin, {
          jid: '120363000000000001@g.us',
          code: '300-J0004',
        })
      ).statusCode,
    ).toBe(404);
    const linked = (
      await get('/api/connectors/sql-account/customers', admin)
    ).json() as typeof rows;
    expect(linked.find((r) => r.jid === JASON)).toMatchObject({
      kind: 'linked',
      code: '300-J0004',
    });
    const link = auditActions().find((a) => a.action === 'sql_account.customer_link')!;
    expect(JSON.parse(link.meta)).toEqual({ chatJid: JASON, linked: true });
    await put('/api/connectors/sql-account/links', admin, { jid: JASON, code: null });
    expect(
      ((await get('/api/connectors/sql-account/customers', admin)).json() as typeof rows).find(
        (r) => r.jid === JASON,
      )!.kind,
    ).toBe('several');

    // Phone matching off: only links.
    await put('/api/connectors/sql-account/match', admin, { matchByPhone: false });
    const off = (await get('/api/connectors/sql-account/customers', admin)).json() as typeof rows;
    expect(off.every((r) => r.kind === 'none')).toBe(true);
  });

  it('reads phones from branches in the background and says when there are none', async () => {
    const { admin } = await setUp();
    t.ctx.services.sqlAccount!.fake!.phonesOnBranches = false;
    await connect(admin);
    await t.ctx.services.sqlAccount!.indexReady();
    expect((await get('/api/connectors/sql-account', admin)).json().phoneMatch).toBe('unavailable');
    // The index read customers one by one (their branches), after the list.
    const paths = t.ctx.services.sqlAccount!.fake!.requests.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(['/customer', '/customer/300-F0001']));
  });

  it('searches SQL Account customers for the Link dialog', async () => {
    const { admin } = await setUp();
    expect((await get('/api/connectors/sql-account/debtors?q=farah', admin)).statusCode).toBe(503);
    await connect(admin);
    expect((await get('/api/connectors/sql-account/debtors?q=300-P0007', admin)).json()).toEqual([
      { code: '300-P0007', name: 'Priya Nair Enterprise' },
    ]);
    expect((await get('/api/connectors/sql-account/debtors?q=jason', admin)).json()).toEqual([
      { code: '300-J0004', name: 'Jason Lim Kopitiam' },
    ]);
    expect((await get('/api/connectors/sql-account/debtors', admin)).json()).toHaveLength(4);
    await post('/api/dev/fake-sql-account/scenario', admin, { scenario: 'bad_keys' });
    expect((await get('/api/connectors/sql-account/debtors?q=x', admin)).statusCode).toBe(503);
    expect(
      (await put('/api/connectors/sql-account/links', admin, { jid: AHMAD, code: '300-J0004' }))
        .statusCode,
    ).toBe(503);
    expect((await get('/api/connectors/sql-account', admin)).json().state).toBe('bad_keys');
  });

  it('lists activity without amounts or names', async () => {
    const { admin, agentId } = await setUp();
    t.ctx.services.sqlAccount!.addActivity({
      tool: 'quotation',
      result: 'done',
      agentId,
      chatJid: FARAH,
      dockey: 1187,
    });
    const rows = (await get('/api/connectors/sql-account/activity', admin)).json();
    expect(rows).toEqual([
      expect.objectContaining({
        agentId,
        agentName: 'Aina',
        chatJid: FARAH,
        chatName: 'Person 0',
        tool: 'quotation',
        result: 'done',
        reason: null,
        dockey: 1187,
      }),
    ]);
    expect((await get('/api/dev/fake-sql-account/quotations', admin)).json()).toEqual([]);
  });
});

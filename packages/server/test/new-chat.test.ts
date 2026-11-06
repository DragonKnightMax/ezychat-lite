// New chat (docs/features/new-chat/design.md): who may start a chat with a number that is not in the
// inbox yet, the linked-phone flow (number checked, empty chat, assigned, audited), the Business API
// flow (template first, chat only once sent), the admin's daily limit (shared with MCP), the hourly
// limit, idempotency and the settings audit.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NewChatStatus, type User } from '@ezychat/shared';
import type { FakeWaAdapter } from '@ezychat/wa';
import type { ApiPrincipal } from '../src/api-tokens/index.js';
import { createNewChatService } from '../src/chats/new-chat.js';
import { FAKE_API_TYPE } from '../src/inboxes/fake-api.js';
import { getInboxService } from '../src/inboxes/service.js';
import { createInboxSendPort } from '../src/mcp/send.js';
import { getChats } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let admin: { cookie: string; user: User };
let agent: { cookie: string; user: User };

beforeEach(async () => {
  t = await makeTestApp({ maxInboxes: 3 });
  admin = await createUserAndLogin(t, { role: 'admin' });
  agent = await createUserAndLogin(t, { role: 'agent' });
});
afterEach(async () => {
  await t.close();
});

const req = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) => t.app.inject({ method, url, headers: authHeaders(cookie), payload });

const status = (cookie = admin.cookie) => req('GET', '/api/new-chat', cookie);
const settings = (payload: Record<string, unknown>, cookie = admin.cookie) =>
  req('PUT', '/api/new-chat/settings', cookie, payload);
const check = (phone: string, cookie = admin.cookie, inboxId = 1) =>
  req('POST', `/api/inboxes/${inboxId}/new-chat/check`, cookie, { phone });
const start = (
  phone: string,
  cookie = admin.cookie,
  inboxId = 1,
  extra: Record<string, unknown> = {},
) =>
  req('POST', `/api/inboxes/${inboxId}/new-chat`, cookie, {
    phone,
    clientRequestId: randomUUID(),
    ...extra,
  });

const audits = (action: string) =>
  (
    t.ctx.db
      .prepare('SELECT user_id, meta FROM audit_log WHERE action = ? ORDER BY id')
      .all(action) as Array<{
      user_id: number;
      meta: string;
    }>
  ).map((r) => ({ userId: r.user_id, meta: JSON.parse(r.meta) as Record<string, unknown> }));
const chatCount = (jid: string) =>
  (t.ctx.db.prepare('SELECT COUNT(*) AS n FROM chats WHERE jid = ?').get(jid) as { n: number }).n;

async function addInbox(type?: string): Promise<{ id: number; wa: FakeWaAdapter }> {
  const row = await getInboxService(t.ctx).create(
    { name: type ? 'Business API' : 'Catering', memberIds: [] },
    { userId: admin.user.id, ip: null },
    type ? { type } : undefined,
  );
  return { id: row.id, wa: t.inboxWa(row.id) };
}

describe('who may start a new chat', () => {
  it('admins always; agents only while the switch is on; the switch is audited', async () => {
    expect(NewChatStatus.parse((await status()).json())).toMatchObject({
      allowed: true,
      staffEnabled: false,
      dailyLimit: 20,
      perUserPerHour: 5,
      inboxes: [{ inboxId: 1, mode: 'check', usedToday: 0, countryCode: '60' }],
    });
    expect((await status(agent.cookie)).json()).toMatchObject({ allowed: false, inboxes: [] });
    const refused = await check('0123456789', agent.cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('new_chat_not_allowed');
    expect((await start('0123456789', agent.cookie)).statusCode).toBe(403);

    // Only admins change the settings.
    expect((await settings({ staffEnabled: true }, agent.cookie)).statusCode).toBe(403);
    expect((await settings({ staffEnabled: true })).json()).toMatchObject({ staffEnabled: true });
    // A build with several inboxes: an agent starts chats only from inboxes they belong to.
    t.ctx.inboxes.repo.setMembers(1, [agent.user.id]);
    expect((await status(agent.cookie)).json()).toMatchObject({ allowed: true });
    expect((await check('012-345 6780', agent.cookie)).json()).toEqual({
      next: 'check',
      phone: '60123456780',
    });
    // Saving the same value again writes no audit row.
    await settings({ staffEnabled: true });
    await settings({ staffEnabled: false });
    expect(audits('settings.new_chat_staff')).toEqual([
      { userId: admin.user.id, meta: { before: false, after: true } },
      { userId: admin.user.id, meta: { before: true, after: false } },
    ]);
    expect((await settings({ other: 1 })).statusCode).toBe(400);
  });

  it('never an agent limited to chosen chats, and an agent only from their own inboxes', async () => {
    const second = await addInbox();
    await settings({ staffEnabled: true });
    t.ctx.inboxes.repo.setMembers(1, [agent.user.id]);
    // An agent of inbox 1 only: inbox 2 does not exist for them.
    expect(
      (await status(agent.cookie)).json().inboxes.map((i: { inboxId: number }) => i.inboxId),
    ).toEqual([1]);
    expect((await check('0123456781', agent.cookie, second.id)).statusCode).toBe(404);
    expect((await check('0123456781', agent.cookie, 99)).statusCode).toBe(404);

    t.ctx.db.prepare("UPDATE users SET chat_scope = 'chosen' WHERE id = ?").run(agent.user.id);
    expect((await status(agent.cookie)).json()).toMatchObject({ allowed: false, inboxes: [] });
    expect((await check('0123456781', agent.cookie)).statusCode).toBe(403);
  });

  it('a removed inbox answers 409 and leaves the status list', async () => {
    const second = await addInbox();
    t.ctx.db.prepare('UPDATE inboxes SET removed_at = ? WHERE id = ?').run(Date.now(), second.id);
    expect((await status()).json().inboxes.map((i: { inboxId: number }) => i.inboxId)).toEqual([1]);
    const r = await check('0123456781', admin.cookie, second.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('inbox_removed');
  });
});

describe('linked phone', () => {
  it('checks the number, opens an empty chat assigned to the starter, saves the name, audits ids', async () => {
    const r = await start('012-888 7777', admin.cookie, 1, { name: 'Farah Ismail' });
    expect(r.statusCode).toBe(201);
    const jid = '60128887777@s.whatsapp.net';
    expect(r.json()).toEqual({ chatJid: jid, created: true });
    const chat = getChats(t.ctx).get(jid)!;
    expect(chat).toMatchObject({ assignedTo: admin.user.id, name: 'Farah Ismail' });
    expect(t.ctx.services.customers!.profile(jid).profile.name).toBe('Farah Ismail');
    expect(audits('chat.new_number')).toEqual([
      {
        userId: admin.user.id,
        meta: { inboxId: 1, chatJid: jid, userId: admin.user.id, via: 'app' },
      },
    ]);
    // Nothing was sent: the first message goes through the normal composer.
    expect(t.wa.sent.filter((s) => s.chatJid === jid)).toHaveLength(0);

    // The same number again: the existing chat, nothing new, not counted.
    expect((await check('+60 12-888 7777')).json()).toEqual({
      next: 'existing',
      phone: '60128887777',
      chatJid: jid,
    });
    const again = await start('60128887777');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ chatJid: jid, created: false });
    expect(audits('chat.new_number')).toHaveLength(1);
    expect((await status()).json().inboxes[0].usedToday).toBe(1);
  });

  it('finds the existing chat through its LID alias', async () => {
    const lid = '123456789012345@lid';
    getChats(t.ctx).upsertFromWa({ jid: lid, type: 'dm', name: 'Aminah' }, 1);
    getChats(t.ctx).upsertContactAliases([{ jid: '60129990000@s.whatsapp.net', alias: lid }]);
    expect((await check('0129990000')).json()).toMatchObject({ next: 'existing', chatJid: lid });
  });

  it('keeps a saved name and assignment of a chat that appeared while WhatsApp answered', async () => {
    const jid = '60128880001@s.whatsapp.net';
    const original = t.wa.checkNumber.bind(t.wa);
    t.wa.checkNumber = async (phone: string) => {
      getChats(t.ctx).upsertFromWa({ jid, type: 'dm', name: 'Raced' }, 1);
      return original(phone);
    };
    const r = await start('0128880001', admin.cookie, 1, { name: 'Other' });
    expect(r.json()).toEqual({ chatJid: jid, created: false });
    expect(getChats(t.ctx).get(jid)?.assignedTo).toBeNull();
    expect(audits('chat.new_number')).toHaveLength(0);
  });

  it('refuses a bad number, the own number, a number without WhatsApp and an offline phone', async () => {
    const bad = await check('12345');
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'invalid_number']);
    const own = await check('+60 00000 0000');
    expect([own.statusCode, own.json().error.code]).toEqual([400, 'own_number']);

    t.wa.setNotOnWhatsApp('60128880002');
    const none = await start('0128880002');
    expect([none.statusCode, none.json().error.code]).toEqual([404, 'not_on_whatsapp']);
    expect(chatCount('60128880002@s.whatsapp.net')).toBe(0);
    // A number without WhatsApp still counts (WhatsApp was asked about it).
    expect((await status()).json().inboxes[0].usedToday).toBe(1);

    const template = await start('0128880003', admin.cookie, 1, {
      template: { name: 'x', language: 'en' },
    });
    expect(template.statusCode).toBe(400);

    t.wa.setConnected(false);
    const offline = await check('0128880003');
    expect([offline.statusCode, offline.json().error.code]).toEqual([503, 'wa_disconnected']);
    expect((await start('0128880003')).statusCode).toBe(503);
  });

  it('answers 503 when the check itself fails', async () => {
    t.wa.checkNumber = async () => {
      throw new Error('socket closed');
    };
    const r = await start('0128880004');
    expect([r.statusCode, r.json().error.code]).toEqual([503, 'wa_disconnected']);
  });
});

describe('limits', () => {
  it('the admin sets the daily limit (audited, applied at once; 0 = no limit), shared with MCP', async () => {
    expect((await settings({ dailyLimit: 1001 })).statusCode).toBe(400);
    expect((await settings({ dailyLimit: 2 })).json()).toMatchObject({ dailyLimit: 2 });
    expect(audits('settings.new_chat_daily_limit')).toEqual([
      { userId: admin.user.id, meta: { before: 20, after: 2 } },
    ]);

    // One through the app, one through an AI assistant: the third is refused on either path.
    expect((await start('0128881001')).statusCode).toBe(201);
    const port = createInboxSendPort(t.ctx);
    const principal: ApiPrincipal = {
      tokenId: 7,
      user: admin.user,
      scopes: new Set(['inbox:send', 'inbox:send_new']) as ApiPrincipal['scopes'],
    };
    await port.sendToNewNumber(principal, {
      phone: '60128881002',
      text: 'Hello',
      requestId: 'req-shared-budget-1',
    });
    const refused = await start('0128881003');
    expect([refused.statusCode, refused.json().error.code]).toEqual([429, 'new_chat_daily_limit']);
    await expect(
      port.sendToNewNumber(principal, {
        phone: '60128881004',
        text: 'Hello',
        requestId: 'req-shared-budget-2',
      }),
    ).rejects.toThrow(/started 2 new chats today; the team's daily limit/);
    expect(chatCount('60128881003@s.whatsapp.net')).toBe(0);

    await settings({ dailyLimit: 0 });
    expect((await start('0128881003')).statusCode).toBe(201);
  });

  it('allows 5 new numbers an hour per person', async () => {
    await settings({ dailyLimit: 0 });
    for (let i = 0; i < 5; i++) expect((await start(`012888200${i}`)).statusCode).toBe(201);
    const r = await start('0128882009');
    expect([r.statusCode, r.json().error.code]).toEqual([429, 'new_chat_hourly_limit']);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('a daily window ends after 24 hours (service clock)', async () => {
    let now = Date.parse('2026-11-06T08:00:00Z');
    const service = createNewChatService(t.ctx, { now: () => now });
    t.ctx.settings.set('new_chat_daily_limit', 1);
    const body = (phone: string) => ({ phone, clientRequestId: randomUUID() });
    await service.start(admin.user, 1, body('0128883001'), null);
    await expect(service.start(admin.user, 1, body('0128883002'), null)).rejects.toMatchObject({
      code: 'new_chat_daily_limit',
    });
    now += 24 * 3_600_000;
    expect(service.status(admin.user).inboxes[0]!.usedToday).toBe(0);
    expect((await service.start(admin.user, 1, body('0128883002'), null)).created).toBe(true);
  });

  it('a retry with the same request id answers the first result and counts once', async () => {
    const id = randomUUID();
    const first = req('POST', '/api/inboxes/1/new-chat', admin.cookie, {
      phone: '0128884001',
      clientRequestId: id,
    });
    const second = req('POST', '/api/inboxes/1/new-chat', admin.cookie, {
      phone: '0128884001',
      clientRequestId: id,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.json()).toEqual(b.json());
    expect((await status()).json().inboxes[0].usedToday).toBe(1);
    // A failed start may be retried with the same id.
    t.wa.setNotOnWhatsApp('60128884002');
    const failed = randomUUID();
    const x = await req('POST', '/api/inboxes/1/new-chat', admin.cookie, {
      phone: '0128884002',
      clientRequestId: failed,
    });
    expect(x.statusCode).toBe(404);
    const y = await req('POST', '/api/inboxes/1/new-chat', admin.cookie, {
      phone: '0128884002',
      clientRequestId: failed,
    });
    expect(y.statusCode).toBe(404);
  });
});

describe('Business API (template first)', () => {
  it('needs a template, never checks the number, and creates the chat only once WhatsApp took it', async () => {
    const api = await addInbox(FAKE_API_TYPE);
    expect((await status()).json().inboxes).toContainEqual({
      inboxId: api.id,
      mode: 'template',
      usedToday: 0,
      countryCode: '60',
    });
    expect((await check('0128885001', admin.cookie, api.id)).json()).toEqual({
      next: 'template',
      phone: '60128885001',
    });
    const missing = await start('0128885001', admin.cookie, api.id);
    expect([missing.statusCode, missing.json().error.code]).toEqual([400, 'template_required']);
    const params = await start('0128885001', admin.cookie, api.id, {
      template: { name: 'order_update', language: 'en', params: ['Ravi'] },
    });
    expect([params.statusCode, params.json().error.code]).toEqual([400, 'template_params']);

    let checks = 0;
    api.wa.checkNumber = async () => {
      checks++;
      return null;
    };
    api.wa.failNextSend(new Error('Meta refused it'));
    const refused = await start('0128885001', admin.cookie, api.id, {
      template: { name: 'order_update', language: 'en', params: ['Ravi', '#1042'] },
    });
    expect([refused.statusCode, refused.json().error.code]).toEqual([502, 'template_failed']);
    const key = `60128885001@s.whatsapp.net#${api.id}`;
    expect(chatCount(key)).toBe(0);
    expect(audits('chat.new_number')).toHaveLength(0);

    const ok = await start('0128885001', admin.cookie, api.id, {
      name: 'Ravi Kumar',
      template: { name: 'order_update', language: 'en', params: ['Ravi', '#1042'] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ chatJid: key, created: true });
    expect(checks).toBe(0);
    expect(api.wa.templateSends.at(-1)).toMatchObject({
      chatJid: '60128885001@s.whatsapp.net',
      template: { name: 'order_update', params: ['Ravi', '#1042'] },
    });
    const chat = getChats(t.ctx).get(key)!;
    expect(chat).toMatchObject({
      assignedTo: admin.user.id,
      name: 'Ravi Kumar',
      lastInboundAt: null,
    });
    const msg = t.ctx.db
      .prepare('SELECT status, from_me, template_name, body FROM messages WHERE chat_jid = ?')
      .get(key) as Record<string, unknown>;
    expect(msg).toMatchObject({ status: 'sent', from_me: 1, template_name: 'order_update' });
    expect(audits('chat.new_number')[0]!.meta).toEqual({
      inboxId: api.id,
      chatJid: key,
      userId: admin.user.id,
      via: 'app',
    });
    // Free text stays locked until the customer replies.
    const text = await req('POST', `/api/chats/${encodeURIComponent(key)}/messages`, admin.cookie, {
      text: 'Hi',
      clientId: randomUUID(),
    });
    expect(text.statusCode).toBe(409);
  });

  it('answers 503 when the Business API number is offline', async () => {
    const api = await addInbox(FAKE_API_TYPE);
    api.wa.setConnected(false);
    const r = await check('0128885002', admin.cookie, api.id);
    expect([r.statusCode, r.json().error.code]).toEqual([503, 'wa_disconnected']);
  });
});

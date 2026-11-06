// send_to_new_number through the real /mcp route (real tokens and message service, fake WhatsApp), plus
// the port's daily new-number limit with a controllable clock. Rules: docs/features/mcp-send-message.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@ezychat/shared';
import type { ApiPrincipal } from '../src/api-tokens/index.js';
import { setMcpEnabled } from '../src/mcp/settings.js';
import { createInboxSendPort, NEW_NUMBER_WARNING, SEND_LIMITS } from '../src/mcp/send.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { data, mcpClient, rpc, waitFor } from './mcp-helpers.js';

const EXISTING = '60123456789@s.whatsapp.net';

let t: TestApp;
let admin: User;
let sender: string;
let newNumbers: string;
let newNumbersId: number;
let adminCookie: string;

const mcp = mcpClient(() => t);
const { post, count } = mcp;
const call = (name: string, args: Record<string, unknown>, token = newNumbers) =>
  mcp.call(name, args, token);
const chatCount = (jid: string) => count('SELECT COUNT(*) AS n FROM chats WHERE jid = ?', jid);

let n = 0;
const requestId = () => `req-new-${++n}-abcdef`;

beforeAll(async () => {
  t = await makeTestApp({ listen: true });
  const auth = t.ctx.services.auth!;
  admin = auth.createUser({
    username: 'owner',
    displayName: 'Owner',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  adminCookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 't' })}`;
  const tokens = t.ctx.services.apiTokens!;
  sender = tokens.create(
    admin.id,
    { name: 'sender', expiresInDays: 90, canSend: true },
    'ip',
  ).secret;
  const created = tokens.create(
    admin.id,
    { name: 'new numbers', expiresInDays: 90, canSend: true, canMessageNewNumbers: true },
    'ip',
  );
  newNumbers = created.secret;
  newNumbersId = created.token.id;
  setMcpEnabled(t.ctx, true);
  t.wa.simulateIncoming({ chatJid: EXISTING, body: 'Hi there', senderName: 'Aminah' });
  await waitFor(() => chatCount(EXISTING) === 1);
});
afterAll(async () => {
  await t.close();
});

describe('who can message new numbers', () => {
  it('lists send_to_new_number only for a token created with "new numbers", with the warning first', async () => {
    const tools = async (token: string) =>
      (await post(rpc('tools/list'), token)).json().result.tools as Array<{
        name: string;
        description: string;
        annotations: Record<string, boolean>;
      }>;
    expect((await tools(sender)).map((x) => x.name)).not.toContain('send_to_new_number');
    const tool = (await tools(newNumbers)).find((x) => x.name === 'send_to_new_number');
    expect(tool?.description).toMatch(/^WARNING: WhatsApp can ban a number/);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it('a token that can only send cannot call it, and nothing is created', async () => {
    const r = await call(
      'send_to_new_number',
      { phone: '60111000001', text: 'Hello', requestId: requestId() },
      sender,
    );
    expect(r.isError).toBe(true);
    expect(chatCount('60111000001@s.whatsapp.net')).toBe(0);
  });

  it('the HTTP create route needs "can send" for new numbers and reports both flags', async () => {
    const create = (payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url: '/api/integrations/tokens',
        remoteAddress: '127.0.0.1',
        headers: { host: 'localhost', origin: 'http://localhost', cookie: adminCookie },
        payload,
      });
    const refused = await create({ name: 'bad', canMessageNewNumbers: true });
    expect(refused.statusCode).toBe(400);
    const ok = await create({ name: 'both', canSend: true, canMessageNewNumbers: true });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().token).toMatchObject({ canSend: true, canMessageNewNumbers: true });
    const plain = await create({ name: 'plain', canSend: true });
    expect(plain.json().token).toMatchObject({ canSend: true, canMessageNewNumbers: false });
  });

  it('send_message points a new-number token at send_to_new_number for an unknown number', async () => {
    const r = await call('send_message', {
      jid: '60111000002@s.whatsapp.net',
      text: 'Hello',
      requestId: requestId(),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/use send_to_new_number/);
  });
});

describe('starting a chat', () => {
  it('checks the number, starts the chat, sends as the token owner and audits both', async () => {
    const id = requestId();
    const r = await call('send_to_new_number', {
      phone: '+60 12-888 7777',
      text: 'Hello from Anchor Sprint, as you asked at the fair.',
      requestId: id,
    });
    expect(r.isError).toBeFalsy();
    const jid = '60128887777@s.whatsapp.net';
    expect(data(r)).toMatchObject({
      chatJid: jid,
      newChat: true,
      duplicate: false,
      warning: NEW_NUMBER_WARNING,
    });
    expect(chatCount(jid)).toBe(1);
    await waitFor(() => t.wa.sent.some((s) => s.chatJid === jid));
    const row = t.ctx.db
      .prepare('SELECT sent_by_user_id AS userId FROM messages WHERE chat_jid = ? AND from_me = 1')
      .get(jid) as { userId: number };
    expect(row.userId).toBe(admin.id);
    const audits = t.ctx.db
      .prepare(
        "SELECT action, meta FROM audit_log WHERE action IN ('chat.new_number', 'mcp.send') AND meta LIKE ?",
      )
      .all(`%${jid}%`) as Array<{ action: string; meta: string }>;
    // The New chat service records the chat (via mcp, with the token); MCP records its send.
    expect(audits.map((a) => a.action).sort()).toEqual(['chat.new_number', 'mcp.send']);
    for (const a of audits) {
      expect(JSON.parse(a.meta)).toMatchObject({ tokenId: newNumbersId, chatJid: jid });
      expect(a.meta).not.toContain('fair');
    }
    expect(JSON.parse(audits.find((a) => a.action === 'chat.new_number')!.meta)).toEqual({
      inboxId: 1,
      chatJid: jid,
      userId: admin.id,
      via: 'mcp',
      tokenId: newNumbersId,
    });

    // A retry sends nothing again; the same requestId for another number is refused.
    const again = await call('send_to_new_number', {
      phone: '60128887777',
      text: 'Hello from Anchor Sprint, as you asked at the fair.',
      requestId: id,
    });
    expect(data(again)).toMatchObject({ duplicate: true, newChat: false });
    expect(t.wa.sent.filter((s) => s.chatJid === jid)).toHaveLength(1);
    const reused = await call('send_to_new_number', {
      phone: '60128887778',
      text: 'Hello',
      requestId: id,
    });
    expect(reused.isError).toBe(true);
    expect(chatCount('60128887778@s.whatsapp.net')).toBe(0);
  });

  it('a number that already has a chat gets an ordinary reply in that chat', async () => {
    const chatsBefore = count('SELECT COUNT(*) AS n FROM chats');
    const r = await call('send_to_new_number', {
      phone: '60123456789',
      text: 'Following up on your question.',
      requestId: requestId(),
    });
    expect(data(r)).toMatchObject({ chatJid: EXISTING, newChat: false });
    expect(count('SELECT COUNT(*) AS n FROM chats')).toBe(chatsBefore);
  });

  it('refuses a number without WhatsApp, a bad number and the linked number itself', async () => {
    t.wa.setNotOnWhatsApp('60111000003');
    const cases: Array<[string, RegExp]> = [
      ['60111000003', /does not have WhatsApp/],
      ['+1 234 56', /Not a phone number/],
      ['0123456789', /Not a phone number/],
      ['60000000000', /linked WhatsApp number/],
    ];
    for (const [phone, message] of cases) {
      const r = await call('send_to_new_number', { phone, text: 'Hi', requestId: requestId() });
      expect(r.isError, phone).toBe(true);
      expect(r.content[0]!.text).toMatch(message);
    }
    expect(chatCount('60111000003@s.whatsapp.net')).toBe(0);
  });

  it('cannot check a number while WhatsApp is offline, and creates nothing', async () => {
    t.wa.setConnected(false);
    try {
      const r = await call('send_to_new_number', {
        phone: '60111000004',
        text: 'Hi',
        requestId: requestId(),
      });
      expect(r.content[0]!.text).toMatch(/not connected/);
      expect(chatCount('60111000004@s.whatsapp.net')).toBe(0);
    } finally {
      t.wa.setConnected(true);
    }
  });
});

describe('new-number limit', () => {
  it(`allows ${SEND_LIMITS.newNumbersPerDay.max} number checks a day per token`, async () => {
    // The inbox's own daily budget (shared with the app, new-chat.test.ts) off: only the token cap.
    t.ctx.settings.set('new_chat_daily_limit', 0);
    let now = Date.parse('2026-10-20T08:00:00Z');
    const port = createInboxSendPort(t.ctx, { now: () => now });
    const principal: ApiPrincipal = {
      tokenId: 99,
      user: admin,
      scopes: new Set(['inbox:send', 'inbox:send_new']) as ApiPrincipal['scopes'],
    };
    const send = (i: number) =>
      port.sendToNewNumber(principal, {
        phone: `6017${String(i).padStart(7, '0')}`,
        text: `hello ${i}`,
        requestId: `req-limit-${i}-x`,
      });
    for (let i = 0; i < SEND_LIMITS.newNumbersPerDay.max; i++) {
      if (i > 0 && i % SEND_LIMITS.perMinute.max === 0) now += SEND_LIMITS.perMinute.windowMs;
      await send(i);
    }
    now += SEND_LIMITS.perMinute.windowMs;
    await expect(send(500)).rejects.toThrow(/new numbers from this token in a day/);
    expect(chatCount('60170000500@s.whatsapp.net')).toBe(0);
    now += SEND_LIMITS.newNumbersPerDay.windowMs;
    expect((await send(501)).newChat).toBe(true);
  });
});

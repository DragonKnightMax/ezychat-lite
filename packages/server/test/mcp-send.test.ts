// send_message through the real /mcp route: real tokens (with and without scope inbox:send), the real
// message service and send queue, fake WhatsApp. Covers the rules in docs/features/mcp-send-message.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@ezychat/shared';
import { sendClientId } from '../src/mcp/send.js';
import { productTitle } from '../src/mcp/server.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { data, mcpClient, rpc, waitFor, type ToolResult, sendTokens } from './mcp-helpers.js';

const LID = '9001@lid';
const PN = '60123456789@s.whatsapp.net';

let t: TestApp;
let admin: User;
let readOnly: string;
let sender: string;
let senderId: number;
let adminCookie: string;

const mcp = mcpClient(() => t);
const { post, count } = mcp;
const call = (name: string, args: Record<string, unknown>, token = sender) =>
  mcp.call(name, args, token);

let n = 0;
const requestId = () => `req-test-${++n}-abcdef`;

beforeAll(async () => {
  t = await makeTestApp({ listen: true });
  ({ admin, adminCookie, readOnly, sender, senderId } = sendTokens(t));
  t.wa.simulateIncoming({
    chatJid: LID,
    chatJidAlt: PN,
    body: 'Is the blue one in stock?',
    senderName: 'Aminah',
  });
  await waitFor(() => count('SELECT COUNT(*) AS n FROM messages') === 1);
});
afterAll(async () => {
  await t.close();
});

describe('who can send', () => {
  it('lists send_message only for a token created with "can send"', async () => {
    const names = async (token: string) =>
      ((await post(rpc('tools/list'), token)).json().result.tools as Array<{ name: string }>).map(
        (x) => x.name,
      );
    expect(await names(readOnly)).not.toContain('send_message');
    const tools = (await post(rpc('tools/list'), sender)).json().result.tools as Array<{
      name: string;
      annotations: Record<string, boolean>;
    }>;
    const send = tools.find((x) => x.name === 'send_message');
    // Clients ask the user before a tool that is not read-only and reaches the outside world.
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it('a read-only token cannot call it', async () => {
    const r = await call('send_message', { jid: PN, text: 'hi', requestId: requestId() }, readOnly);
    expect(r.isError).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE from_me = 1')).toBe(0);
  });

  it('the token list and the HTTP create route report and grant canSend', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/integrations/tokens',
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: adminCookie },
      payload: { name: 'via http', expiresInDays: 30, canSend: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token.canSend).toBe(true);
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/integrations/tokens',
      headers: { host: 'localhost', cookie: adminCookie },
    });
    const byName = Object.fromEntries(
      (list.json().tokens as Array<{ name: string; canSend: boolean }>).map((x) => [
        x.name,
        x.canSend,
      ]),
    );
    expect(byName).toMatchObject({ reader: false, sender: true, 'via http': true });
  });
});

describe('sending', () => {
  it('sends a text reply into an existing chat as the token owner, through the inbox', async () => {
    const id = requestId();
    const r = await call('send_message', { jid: PN, text: 'Yes, 3 left in stock.', requestId: id });
    expect(r.isError).toBeUndefined();
    const sent = data(r);
    expect(sent).toMatchObject({ chatJid: LID, duplicate: false });
    const row = t.ctx.db
      .prepare(
        'SELECT chat_jid, from_me, sent_by_user_id, body, client_id FROM messages WHERE client_id = ?',
      )
      .get(sendClientId(senderId, id)) as Record<string, unknown>;
    expect(row).toEqual({
      chat_jid: LID,
      from_me: 1,
      sent_by_user_id: admin.id,
      body: 'Yes, 3 left in stock.',
      client_id: sendClientId(senderId, id),
    });
    await waitFor(() => t.wa.sent.some((m) => m.text === 'Yes, 3 left in stock.'));
  });

  it('marks assistant messages "via AI assistant" for the inbox; a reply typed in the inbox is not', async () => {
    const text = 'Your parcel ships tomorrow.';
    await call('send_message', { jid: PN, text, requestId: requestId() });
    const typed = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${encodeURIComponent(LID)}/messages`,
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: adminCookie },
      payload: { text: 'Typed by a person', clientId: 'typed-in-the-inbox-1' },
    });
    expect(typed.statusCode).toBeLessThan(300);
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/chats/${encodeURIComponent(LID)}/messages`,
      headers: { host: 'localhost', cookie: adminCookie },
    });
    const messages = list.json().messages as Array<{ body: string; viaAssistant?: boolean }>;
    expect(messages.find((m) => m.body === text)?.viaAssistant).toBe(true);
    expect(messages.find((m) => m.body === 'Typed by a person')?.viaAssistant).toBeUndefined();
  });

  it('a repeated requestId sends nothing again; reusing it for other text is refused', async () => {
    const id = requestId();
    const first = data(
      await call('send_message', { jid: LID, text: 'Ships tomorrow.', requestId: id }),
    );
    const again = data(
      await call('send_message', { jid: LID, text: 'Ships tomorrow.', requestId: id }),
    );
    expect(again).toMatchObject({ messageId: first.messageId, duplicate: true });
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE body = ?', 'Ships tomorrow.')).toBe(1);
    const other = await call('send_message', { jid: LID, text: 'Something else', requestId: id });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toMatch(/already used/);
  });

  it('never opens a new chat: an unknown number is refused and nothing is sent', async () => {
    const before = count('SELECT COUNT(*) AS n FROM messages');
    const r = await call('send_message', {
      jid: '60999999999@s.whatsapp.net',
      text: 'Hello stranger',
      requestId: requestId(),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Only existing chats/);
    expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(before);
    expect(
      count('SELECT COUNT(*) AS n FROM chats WHERE jid = ?', '60999999999@s.whatsapp.net'),
    ).toBe(0);
  });

  it('a quote must be a message of the same chat', async () => {
    const r = await call('send_message', {
      jid: LID,
      text: 'Quoting',
      requestId: requestId(),
      quotedMessageId: 'not-a-message',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not in this chat/);
  });

  it('rejects empty text and a bad requestId before anything happens', async () => {
    for (const args of [
      { jid: LID, text: '   ', requestId: requestId() },
      { jid: LID, text: 'ok', requestId: 'short' },
    ]) {
      const r = await call('send_message', args);
      expect(r.isError).toBe(true);
    }
  });

  it('audits every send without the text', async () => {
    const rows = t.ctx.db
      .prepare("SELECT user_id, meta FROM audit_log WHERE action = 'mcp.send'")
      .all() as Array<{ user_id: number; meta: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.user_id).toBe(admin.id);
      const meta = JSON.parse(row.meta);
      expect(Object.keys(meta).sort()).toEqual(['chatJid', 'messageId', 'tokenId']);
      expect(meta.tokenId).toBe(senderId);
      expect(row.meta).not.toMatch(/stock|tomorrow/);
    }
  });
});

describe('limits', () => {
  it('stops a token after 10 messages a minute, with the wait in the message', async () => {
    const tokens = t.ctx.services.apiTokens!;
    const busy = tokens.create(
      admin.id,
      { name: 'busy', expiresInDays: 30, canSend: true },
      'ip',
    ).secret;
    const results: ToolResult[] = [];
    for (let i = 0; i < 11; i++)
      results.push(
        await call('send_message', { jid: LID, text: `msg ${i}`, requestId: requestId() }, busy),
      );
    expect(results.slice(0, 10).every((r) => !r.isError)).toBe(true);
    expect(results[10]!.isError).toBe(true);
    expect(results[10]!.content[0]!.text).toMatch(
      /Too many messages .* a minute; try again in \d+ s/,
    );
    // The other token is not affected.
    const other = await call('send_message', {
      jid: LID,
      text: 'still fine',
      requestId: requestId(),
    });
    expect(other.isError).toBeUndefined();
  });
});

describe('editions', () => {
  it('a closed access gate (e.g. an Enterprise licence lock) refuses /mcp and sends nothing', async () => {
    const before = count('SELECT COUNT(*) AS n FROM messages');
    t.ctx.access.close({ code: 'license_locked' });
    try {
      const res = await post(
        rpc('tools/call', {
          name: 'send_message',
          arguments: { jid: LID, text: 'while locked', requestId: requestId() },
        }),
        sender,
      );
      expect(res.statusCode).toBe(403);
      expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(before);
    } finally {
      t.ctx.access.open();
    }
  });
});

describe('server identity', () => {
  it('names the edition to MCP clients (EzyChat Lite here, EzyChat Enterprise there)', async () => {
    const res = await post(
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
      sender,
    );
    expect(res.json().result.serverInfo).toMatchObject({
      name: 'ezychat-lite',
      title: 'EzyChat Lite',
    });
    expect(productTitle('enterprise')).toBe('EzyChat Enterprise');
  });
});

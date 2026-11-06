// get_message_file through the real /mcp route (real tokens, message service, fake WhatsApp, real
// document worker), plus the port for what a token owner cannot reach through the route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@ezychat/shared';
import { MCP_FILE_MAX_IMAGE_BYTES, MCP_FILE_MAX_TEXT_CHARS } from '@ezychat/shared';
import { createMessageFilePort, FILE_LIMITS } from '../src/mcp/file.js';
import { ToolError } from '../src/mcp/tools.js';
import { readFileSync } from 'node:fs';
import { pdfFixture, wordFixture } from './ai-fixtures.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { data, mcpClient, sendTokens, waitFor } from './mcp-helpers.js';

const CHAT = '60123450001@s.whatsapp.net';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

let t: TestApp;
let admin: User;
let token: string;
let tokenId: number;
const mcp = mcpClient(() => t);
const call = (args: Record<string, unknown>, secret = token) =>
  mcp.call('get_message_file', args, secret);
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

let n = 0;
/** One inbound media message whose file is stored; resolves with its id. */
async function incoming(
  type: 'image' | 'document' | 'audio' | 'video' | 'sticker',
  bytes: Buffer,
  mime: string,
  fileName: string | null = null,
): Promise<string> {
  const id = `FILE-${++n}`;
  t.wa.simulateIncoming({
    id,
    chatJid: CHAT,
    body: '',
    type,
    media: { mime, fileName, download: async () => bytes },
  });
  await waitFor(() => {
    const row = t.ctx.db.prepare('SELECT media_status FROM messages WHERE id = ?').get(id) as
      { media_status: string } | undefined;
    return row?.media_status === 'ok';
  });
  return id;
}

beforeAll(async () => {
  t = await makeTestApp({ listen: true });
  ({ admin, readOnly: token } = sendTokens(t));
  tokenId = t.ctx.db.prepare("SELECT id FROM api_tokens WHERE name = 'reader'").get() as never;
  tokenId = (tokenId as unknown as { id: number }).id;
  t.wa.simulateIncoming({ id: 'TEXT-1', chatJid: CHAT, body: 'Here are the files' });
  await waitFor(() => mcp.count('SELECT COUNT(*) AS n FROM messages') === 1);
});
afterAll(async () => {
  await t.close();
});

describe('get_message_file over /mcp', () => {
  it('is a read tool listed for a read-only token', async () => {
    const res = await mcp.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token);
    const tool = (
      res.json().result.tools as Array<{ name: string; annotations: Record<string, boolean> }>
    ).find((x) => x.name === 'get_message_file');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('returns a photo as MCP image content with its metadata, logged and audited without content', async () => {
    const id = await incoming('image', PNG, 'image/png', 'receipt.png');
    const r = (await call({ messageId: id })) as unknown as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text!)).toEqual({
      kind: 'image',
      messageId: id,
      mime: 'image/png',
      size: PNG.length,
    });
    expect(r.content[1]).toEqual({
      type: 'image',
      data: PNG.toString('base64'),
      mimeType: 'image/png',
    });
    expect(JSON.stringify(r)).not.toContain('receipt.png');
    const row = t.ctx.db
      .prepare(
        "SELECT user_id, meta FROM audit_log WHERE action = 'mcp.read_file' ORDER BY id DESC",
      )
      .get() as { user_id: number; meta: string };
    expect(row.user_id).toBe(admin.id);
    expect(JSON.parse(row.meta)).toEqual({
      tokenId,
      messageId: id,
      kind: 'image',
      size: PNG.length,
    });
  });

  it('reads a photo sent as a document, typed from its bytes', async () => {
    const id = await incoming('document', JPEG, 'application/octet-stream', 'photo.bin');
    const r = await call({ messageId: id });
    expect(JSON.parse(text(r))).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
  });

  it('returns the text of a PDF and of a Word file', async () => {
    const pdf = await incoming(
      'document',
      pdfFixture('Invoice INV-77 total RM 120'),
      'application/pdf',
      'inv.pdf',
    );
    expect(data(await call({ messageId: pdf }))).toMatchObject({
      kind: 'pdf',
      truncated: false,
      text: expect.stringContaining('Invoice INV-77 total RM 120'),
    });
    const docx = await incoming(
      'document',
      await wordFixture('Order 12 blue chairs'),
      'application/octet-stream',
      'order.docx',
    );
    expect(data(await call({ messageId: docx }))).toMatchObject({
      kind: 'docx',
      text: expect.stringContaining('Order 12 blue chairs'),
    });
  }, 30_000);

  it('says when a PDF has no text (a scan)', async () => {
    const id = await incoming('document', pdfFixture(''), 'application/pdf', 'scan.pdf');
    expect(data(await call({ messageId: id }))).toMatchObject({ kind: 'pdf', text: null });
  }, 30_000);

  it('answers "not supported" with the metadata for voice, video and other files', async () => {
    const ogg = readFileSync(new URL('./fixtures/tone-1s.ogg', import.meta.url));
    const voice = await incoming('audio', ogg, 'audio/ogg; codecs=opus');
    expect(data(await call({ messageId: voice }))).toMatchObject({
      kind: 'unsupported',
      type: 'audio',
      mime: 'audio/ogg; codecs=opus',
    });
    const txt = await incoming('document', Buffer.from('price list'), 'text/plain', 'prices.txt');
    expect(data(await call({ messageId: txt }))).toMatchObject({
      kind: 'unsupported',
      type: 'document',
      mime: 'text/plain',
    });
    // Declared as a PDF, but the bytes are not one.
    const fake = await incoming('document', Buffer.from('hello'), 'application/pdf', 'x.pdf');
    expect(data(await call({ messageId: fake }))).toMatchObject({ kind: 'unsupported' });
    expect(
      mcp.count(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mcp.read_file' AND meta LIKE ?",
        `%"${voice}"%`,
      ),
    ).toBe(0);
  });

  it('downloads a history file that is still pending, then reads it', async () => {
    const id = await incoming('image', PNG, 'image/png');
    t.ctx.db
      .prepare("UPDATE messages SET media_status = 'pending', media_path = NULL WHERE id = ?")
      .run(id);
    t.wa.setMedia(id, JPEG);
    const r = await call({ messageId: id });
    expect(JSON.parse(text(r))).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    const gone = await incoming('image', PNG, 'image/png');
    t.ctx.db
      .prepare("UPDATE messages SET media_status = 'pending', media_path = NULL WHERE id = ?")
      .run(gone);
    const failed = await call({ messageId: gone });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(/could not be downloaded/);
  });

  it('never returns a file WhatsApp Safety rated High, even to an admin', async () => {
    const id = await incoming(
      'document',
      pdfFixture('looks fine'),
      'application/pdf',
      'invoice\u202efdp.exe',
    );
    expect(t.ctx.services.safety!.levelOf(id)).toBe('high');
    const r = await call({ messageId: id });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/locked by WhatsApp Safety/);
  });

  it('refuses a ZIP WhatsApp Safety cannot inspect', async () => {
    const id = await incoming('document', Buffer.from('PK\u0003\u0004 broken'), 'application/zip');
    const r = await call({ messageId: id });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/WhatsApp Safety/);
  });

  it('refuses a flagged file whose AI check has not answered', async () => {
    const id = await incoming('image', PNG, 'image/png');
    t.ctx.db
      .prepare(
        `INSERT INTO safety_items (message_id, chat_jid, inbox_id, rules, score, rule_level, critical, level,
           status, existing_customer, has_file, created_at, updated_at)
         VALUES (?, ?, 1, '[]', 30, 'warning', 0, 'warning', 'open', 1, 1, 0, 0)`,
      )
      .run(id, CHAT);
    const r = await call({ messageId: id });
    expect(text(r)).toMatch(/not finished checking/);
  });

  it('refuses unknown, hidden, deleted and text messages, and files that are too large', async () => {
    expect(text(await call({ messageId: 'NOPE' }))).toMatch(/No message found/);
    expect(text(await call({ messageId: 'TEXT-1' }))).toMatch(/has no file/);
    const hidden = await incoming('image', PNG, 'image/png');
    t.ctx.db.prepare('UPDATE messages SET hidden_at = 1 WHERE id = ?').run(hidden);
    expect(text(await call({ messageId: hidden }))).toMatch(/No message found/);
    const deleted = await incoming('image', PNG, 'image/png');
    t.ctx.db.prepare('UPDATE messages SET deleted_at = 1 WHERE id = ?').run(deleted);
    expect(text(await call({ messageId: deleted }))).toMatch(/deleted/);
    const big = Buffer.concat([PNG, Buffer.alloc(MCP_FILE_MAX_IMAGE_BYTES)]);
    const bigId = await incoming('image', big, 'image/png');
    expect(text(await call({ messageId: bigId }))).toMatch(/too large to return/);
  });
});

describe('message file port', () => {
  const principal = (user: User, id = 999) => ({ tokenId: id, user, scopes: new Set<never>() });

  it('caps long text, maps extraction failures, and limits reads per token', async () => {
    let clock = 0;
    const long = 'x'.repeat(MCP_FILE_MAX_TEXT_CHARS + 5);
    let fail = false;
    const port = createMessageFilePort(t.ctx, {
      now: () => clock,
      extract: async () => {
        if (fail) throw new Error('bad');
        return `\r\n${long}\0`;
      },
    });
    const id = await incoming('document', pdfFixture('a'), 'application/pdf');
    const got = await port.read(principal(admin), id);
    expect(got).toMatchObject({ kind: 'pdf', truncated: true });
    expect((got as { text: string }).text).toHaveLength(MCP_FILE_MAX_TEXT_CHARS);
    fail = true;
    await expect(port.read(principal(admin), id)).rejects.toThrow(/PDF could not be read/);
    for (let i = 2; i < FILE_LIMITS.perMinute.max; i++)
      await port.read(principal(admin), 'TEXT-1').catch(() => undefined);
    await expect(port.read(principal(admin), id)).rejects.toThrow(/Too many file reads/);
    // Another token has its own count; a new minute starts afresh.
    await expect(port.read(principal(admin, 1000), id)).rejects.toThrow(ToolError);
    clock += FILE_LIMITS.perMinute.windowMs;
    await expect(port.read(principal(admin), id)).rejects.toThrow(/could not be read/);
  });

  it('rejects a source file over the limit before reading it', async () => {
    const id = await incoming('document', Buffer.from('%PDF-1.4\n'), 'application/pdf');
    const { path } = t.ctx.services.messages!.mediaPath(id)!;
    const { truncateSync } = await import('node:fs');
    truncateSync(path, 26 * 1024 * 1024);
    const port = createMessageFilePort(t.ctx);
    await expect(port.read(principal(admin), id)).rejects.toThrow(/too large to read/);
  });
});

describe('inbox scope', () => {
  let m: TestApp;
  beforeAll(async () => {
    m = await makeTestApp({ maxInboxes: 2, inboxes: 2 });
  });
  afterAll(async () => {
    await m.close();
  });

  it('a message outside the reader’s inboxes is "not found"', async () => {
    m.wa.simulateIncoming({
      id: 'SCOPE-1',
      chatJid: CHAT,
      body: '',
      type: 'image',
      media: { mime: 'image/png', fileName: null, download: async () => PNG },
    });
    await waitFor(
      () =>
        (
          m.ctx.db.prepare('SELECT media_status FROM messages WHERE id = ?').get('SCOPE-1') as
            { media_status: string } | undefined
        )?.media_status === 'ok',
    );
    const member = m.ctx.services.auth!.createUser({
      username: 'mem',
      displayName: 'Mem',
      role: 'agent',
      password: 'password123',
      mustChangePassword: false,
    });
    const port = createMessageFilePort(m.ctx);
    const reader = { tokenId: 5, user: member, scopes: new Set<never>() };
    await expect(port.read(reader, 'SCOPE-1')).rejects.toThrow(/No message found/);
  });
});

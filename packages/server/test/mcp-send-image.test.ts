// send_image through the real /mcp route (real tokens, message service, send queue, fake WhatsApp),
// the port with an injected image download, and the guarded download against a local https server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@ezychat/shared';
import { MCP_SEND_MAX_IMAGE_BYTES } from '@ezychat/shared';
import {
  createInboxSendPort,
  decodeImageBase64,
  guardedImageFetcher,
  SendError,
} from '../src/mcp/send.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { data, mcpClient, waitFor, sendTokens } from './mcp-helpers.js';
import {
  httpsFixture,
  lastSendAudit,
  listedTools,
  principalOf,
  sentRow,
  bytesOf,
  testUploadStore,
} from './mcp-send-media-helpers.js';

const LID = '9101@lid';
const PN = '60123450000@s.whatsapp.net';
// A 1x1 PNG: file-type reads the real type from these bytes.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

let t: TestApp;
let admin: User;
let readOnly: string;
let sender: string;
let senderId: number;

const mcp = mcpClient(() => t);
const { post, count } = mcp;
const call = (name: string, args: Record<string, unknown>, token = sender) =>
  mcp.call(name, args, token);

let n = 0;
const requestId = () => `img-test-${++n}-abcdef`;

beforeAll(async () => {
  t = await makeTestApp({ listen: true });
  ({ admin, readOnly, sender, senderId } = sendTokens(t));
  t.wa.simulateIncoming({ chatJid: LID, chatJidAlt: PN, body: 'Photo please', senderName: 'Mei' });
  await waitFor(() => count('SELECT COUNT(*) AS n FROM messages') === 1);
});
afterAll(async () => {
  await t.close();
});

const row = (id: string) => sentRow(t, senderId, id);

describe('send_image over /mcp', () => {
  it('is listed only for a token that can send, and is not read-only', async () => {
    const tools = (token: string) => listedTools(post, token);
    expect((await tools(readOnly)).map((x) => x.name)).not.toContain('send_image');
    const tool = (await tools(sender)).find((x) => x.name === 'send_image');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const r = await call(
      'send_image',
      { jid: LID, imageBase64: PNG_B64, requestId: requestId() },
      readOnly,
    );
    expect(r.isError).toBe(true);
  });

  it('sends a base64 image with a caption as the token owner, via the assistant, and audits it', async () => {
    const id = requestId();
    const r = await call('send_image', {
      jid: PN,
      imageBase64: `data:image/png;base64,${PNG_B64}`,
      caption: 'The blue one',
      fileName: 'blue.jpg',
      requestId: id,
    });
    expect(r.isError).toBeUndefined();
    expect(data(r)).toMatchObject({ chatJid: LID, duplicate: false });
    // The name takes the real type's extension, never the one passed.
    expect(row(id)).toEqual({
      chat_jid: LID,
      type: 'image',
      body: 'The blue one',
      media_mime: 'image/png',
      media_name: 'blue.png',
      sent_by_user_id: admin.id,
      sent_via_token_id: senderId,
    });
    await waitFor(() => t.wa.sent.some((m) => m.file?.caption === 'The blue one'));
    const audit = lastSendAudit(t);
    expect(audit.meta).toMatchObject({ tokenId: senderId, chatJid: LID, type: 'image' });
    expect(audit.raw).not.toContain('blue');
  });

  it('a repeated requestId sends nothing again; reusing it for another caption is refused', async () => {
    const id = requestId();
    const args = { jid: LID, imageBase64: PNG_B64, caption: 'Again', requestId: id };
    const first = data(await call('send_image', args));
    const again = data(await call('send_image', args));
    expect(again).toMatchObject({ messageId: first.messageId, duplicate: true });
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE body = ?', 'Again')).toBe(1);
    const other = await call('send_image', { ...args, caption: 'Other' });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toMatch(/already used/);
    // A text requestId reused for an image is a different message too.
    const textId = requestId();
    await call('send_message', { jid: LID, text: 'text first', requestId: textId });
    const mixed = await call('send_image', { jid: LID, imageBase64: PNG_B64, requestId: textId });
    expect(mixed.content[0]!.text).toMatch(/already used/);
  });

  it('refuses a file that is not a JPEG, PNG or WebP image, whatever its name', async () => {
    const before = count('SELECT COUNT(*) AS n FROM messages');
    const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n').toString('base64');
    for (const b64 of [pdf, Buffer.from('just some text').toString('base64')]) {
      const r = await call('send_image', {
        jid: LID,
        imageBase64: b64,
        fileName: 'photo.png',
        requestId: requestId(),
      });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Only JPEG, PNG or WebP/);
    }
    expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(before);
  });

  it('needs exactly one image source, valid base64 and an existing chat', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ jid: LID }, /imageUrl, imageBase64 or uploadId/],
      [
        { jid: LID, imageBase64: PNG_B64, imageUrl: 'https://example.com/a.png' },
        /imageUrl, imageBase64 or uploadId/,
      ],
      [{ jid: LID, imageBase64: '***not base64***' }, /not valid base64/],
      [{ jid: '60999999999@s.whatsapp.net', imageBase64: PNG_B64 }, /Only existing chats/],
      [{ jid: LID, imageBase64: PNG_B64, quotedMessageId: 'nope' }, /not in this chat/],
    ];
    for (const [args, message] of cases) {
      const r = await call('send_image', { ...args, requestId: requestId() });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(message);
    }
  });

  it('accepts a body above the app-wide 1 MB limit (a large base64 image)', async () => {
    // About 1.5 MB of base64: a JPEG header and padding, accepted by the /mcp body limit.
    const big = Buffer.concat([JPEG, Buffer.alloc(1_100_000)]).toString('base64');
    const id = requestId();
    const r = await call('send_image', { jid: LID, imageBase64: big, requestId: id });
    expect(r.isError).toBeUndefined();
    expect(row(id)?.media_mime).toBe('image/jpeg');
  });
});

describe('the send port with an image link', () => {
  it('downloads the link it was given and sends that image', async () => {
    const urls: string[] = [];
    const port = createInboxSendPort(t.ctx, {
      fetchImage: async (url) => {
        urls.push(url);
        return JPEG;
      },
    });
    const principal = { principal: principalOf(t, sender) };
    const id = requestId();
    const sent = await port.sendImage(principal.principal, {
      jid: LID,
      imageUrl: 'https://cdn.example.com/p/1.jpg',
      requestId: id,
    });
    expect(urls).toEqual(['https://cdn.example.com/p/1.jpg']);
    expect(sent.duplicate).toBe(false);
    expect(row(id)).toMatchObject({ type: 'image', media_mime: 'image/jpeg', body: null });
    // A retry downloads nothing.
    await port.sendImage(principal.principal, {
      jid: LID,
      imageUrl: 'https://cdn.example.com/p/1.jpg',
      requestId: id,
    });
    expect(urls).toHaveLength(1);
  });

  it('an empty download is refused', async () => {
    const port = createInboxSendPort(t.ctx, { fetchImage: async () => Buffer.alloc(0) });
    const principal = { principal: principalOf(t, sender) };
    await expect(
      port.sendImage(principal.principal, {
        jid: LID,
        imageUrl: 'https://cdn.example.com/empty.jpg',
        requestId: requestId(),
      }),
    ).rejects.toThrow(/empty/);
  });
});

describe('decodeImageBase64', () => {
  it('reads plain base64, a data: URL and line breaks; refuses too large', () => {
    expect(decodeImageBase64(PNG_B64)).toEqual(PNG);
    expect(
      decodeImageBase64(`data:image/png;base64,${PNG_B64.slice(0, 40)}\n${PNG_B64.slice(40)}`),
    ).toEqual(PNG);
    expect(() => decodeImageBase64('')).toThrow(SendError);
    const tooBig = Buffer.alloc(MCP_SEND_MAX_IMAGE_BYTES + 3).toString('base64');
    expect(() => decodeImageBase64(tooBig)).toThrow(
      /larger than 5.9 MB\. Send a larger image with uploadId/,
    );
  });
});

describe('guardedImageFetcher', () => {
  const { store } = testUploadStore();
  let site: Awaited<ReturnType<typeof httpsFixture>>;
  let origin: string;
  let ca: string;

  beforeAll(async () => {
    site = await httpsFixture({ '/photo.png': PNG }, MCP_SEND_MAX_IMAGE_BYTES + 1024);
    ({ origin, ca } = site);
  });
  afterAll(() => site.close());

  it('downloads an image (loopback only allowed in tests)', async () => {
    const get = guardedImageFetcher(store, { allowLoopback: true, ca });
    expect(bytesOf(await get(`${origin}/photo.png`, 1))).toEqual(PNG);
    await expect(get(`${origin}/missing`, 1)).rejects.toThrow(/answered 404/);
    await expect(get(`${origin}/big`, 1, 5 * 1024 * 1024)).rejects.toThrow(
      /too_large_for_whatsapp: .*up to 5 MB/,
    );
  });

  it('never reaches this computer, a private network or plain http', async () => {
    const get = guardedImageFetcher(store);
    await expect(get(`${origin}/photo.png`, 1)).rejects.toThrow(/public internet address/);
    await expect(get('https://10.0.0.5/a.png', 1)).rejects.toThrow(/public internet address/);
    await expect(get('http://example.com/a.png', 1)).rejects.toThrow(/https:\/\//);
    await expect(get('https://unreachable.invalid/a.png', 1)).rejects.toThrow(
      /could not be downloaded/,
    );
  });
});

// send_file through the real /mcp route (real tokens, message service, send queue, fake WhatsApp),
// the port with an injected file download, and the guarded download against a local https server.
import { ZipArchive } from 'archiver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@ezychat/shared';
import { MCP_SEND_MAX_FILE_BYTES } from '@ezychat/shared';
import {
  createInboxSendPort,
  decodeFileBase64,
  guardedFileFetcher,
  SendError,
} from '../src/mcp/send.js';
import { pdfFixture } from './ai-fixtures.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { data, mcpClient, waitFor, sendTokens } from './mcp-helpers.js';
import {
  httpsFixture,
  lastSendAudit,
  listedTools,
  principalOf,
  sentRow,
} from './mcp-send-media-helpers.js';
import { makeZip } from './safety-helpers.js';

const LID = '9102@lid';
const PN = '60123450001@s.whatsapp.net';
const PDF = pdfFixture('Quotation 1042: 2 bags of house blend, RM136');
const PDF_B64 = PDF.toString('base64');
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
let DOCX: Buffer;

/** A Word file as Word writes it: the content types name the main document part. */
function docxFixture(text: string): Promise<Buffer> {
  const zip = new ZipArchive({ zlib: { level: 1 } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);
  });
  zip.append(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}.main+xml"/></Types>`,
    { name: '[Content_Types].xml' },
  );
  zip.append(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    { name: 'word/document.xml' },
  );
  void zip.finalize();
  return done;
}

let t: TestApp;
let admin: User;
let readOnly: string;
let sender: string;
let senderId: number;

const mcp = mcpClient(() => t);
const call = (name: string, args: Record<string, unknown>, token = sender) =>
  mcp.call(name, args, token);
const row = (id: string) => sentRow(t, senderId, id);

let n = 0;
const requestId = () => `file-test-${++n}-abcdef`;

beforeAll(async () => {
  DOCX = await docxFixture('Terms and conditions');
  t = await makeTestApp({ listen: true });
  ({ admin, readOnly, sender, senderId } = sendTokens(t));
  t.wa.simulateIncoming({
    chatJid: LID,
    chatJidAlt: PN,
    body: 'Send the quote',
    senderName: 'Aina',
  });
  await waitFor(() => mcp.count('SELECT COUNT(*) AS n FROM messages') === 1);
});
afterAll(async () => {
  await t.close();
});

describe('send_file over /mcp', () => {
  it('is offered only to a token that can send, as a write tool', async () => {
    expect((await listedTools(mcp.post, readOnly)).map((x) => x.name)).not.toContain('send_file');
    const tool = (await listedTools(mcp.post, sender)).find((x) => x.name === 'send_file');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const refused = await call(
      'send_file',
      { jid: LID, fileBase64: PDF_B64, fileName: 'q.pdf', requestId: requestId() },
      readOnly,
    );
    expect(refused.isError).toBe(true);
  });

  it('sends a PDF as a document with its name and caption, as the token owner, and audits it', async () => {
    const id = requestId();
    const r = await call('send_file', {
      jid: PN,
      fileBase64: `data:application/pdf;base64,${PDF_B64}`,
      fileName: 'Quotation-1042.doc',
      caption: 'Your quotation',
      requestId: id,
    });
    expect(data(r).duplicate).toBe(false);
    // Stored in the customer's chat as a document; the extension comes from the real type.
    const sent = row(id);
    expect([sent?.chat_jid, sent?.type, sent?.media_mime]).toEqual([
      LID,
      'document',
      'application/pdf',
    ]);
    expect([sent?.media_name, sent?.body]).toEqual(['Quotation-1042.pdf', 'Your quotation']);
    expect([sent?.sent_by_user_id, sent?.sent_via_token_id]).toEqual([admin.id, senderId]);
    await waitFor(() => t.wa.sent.some((m) => m.file?.fileName === 'Quotation-1042.pdf'));
    const audit = lastSendAudit(t);
    expect([audit.meta.type, audit.meta.tokenId]).toEqual(['document', senderId]);
    expect(audit.raw).not.toContain('quotation');
  });

  it('sends a Word .docx file, named from fileName', async () => {
    const id = requestId();
    const r = await call('send_file', {
      jid: LID,
      fileBase64: DOCX.toString('base64'),
      fileName: 'Terms',
      requestId: id,
    });
    expect(r.isError).toBeUndefined();
    expect(row(id)).toMatchObject({ media_mime: DOCX_MIME, media_name: 'Terms.docx', body: null });
  });

  it('refuses a photo, a plain ZIP or text, whatever the name says', async () => {
    const before = mcp.count('SELECT COUNT(*) AS n FROM messages');
    const others = [PNG_B64, makeZip([{ name: 'invoice.exe' }]), Buffer.from('just some text')];
    for (const other of others) {
      const fileBase64 = typeof other === 'string' ? other : other.toString('base64');
      const r = await call('send_file', {
        jid: LID,
        fileBase64,
        fileName: 'invoice.pdf',
        requestId: requestId(),
      });
      expect(r.content[0]!.text).toMatch(/Only PDF or Word \(\.docx\)/);
    }
    expect(mcp.count('SELECT COUNT(*) AS n FROM messages')).toBe(before);
  });

  it('a repeated requestId sends nothing again; an image requestId is a different message', async () => {
    const args = { jid: LID, fileBase64: PDF_B64, fileName: 'a.pdf', caption: 'Twice' };
    const id = requestId();
    const first = data(await call('send_file', { ...args, requestId: id }));
    const again = data(await call('send_file', { ...args, requestId: id }));
    expect(again).toMatchObject({ messageId: first.messageId, duplicate: true });
    expect(mcp.count('SELECT COUNT(*) AS n FROM messages WHERE body = ?', 'Twice')).toBe(1);
    const imageId = requestId();
    await call('send_image', { jid: LID, imageBase64: PNG_B64, requestId: imageId });
    const mixed = await call('send_file', { ...args, caption: undefined, requestId: imageId });
    expect(mixed.content[0]!.text).toMatch(/already used/);
  });

  it('needs exactly one file source, a name, valid base64 and an existing chat', async () => {
    const pdf = { fileName: 'a.pdf', fileBase64: PDF_B64 };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ jid: LID, fileName: 'a.pdf' }, /fileUrl or fileBase64/],
      [{ jid: LID, ...pdf, fileUrl: 'https://example.com/a.pdf' }, /fileUrl or fileBase64/],
      [{ jid: LID, fileBase64: PDF_B64 }, /fileName/],
      [{ jid: LID, fileName: 'a.pdf', fileBase64: '***' }, /fileBase64 is not valid/],
      [{ jid: '60999999999@s.whatsapp.net', ...pdf }, /Only existing chats/],
    ];
    for (const [args, message] of cases) {
      const r = await call('send_file', { ...args, requestId: requestId() });
      expect(r.content[0]!.text).toMatch(message);
    }
  });
});

describe('send_file with a link (the port, download injected)', () => {
  it('downloads the link once and sends that file; a retry downloads nothing', async () => {
    const urls: string[] = [];
    const port = createInboxSendPort(t.ctx, {
      fetchFile: async (url) => (urls.push(url), PDF),
    });
    const input = {
      jid: LID,
      fileUrl: 'https://cdn.example.com/q.pdf',
      fileName: 'Q',
      requestId: requestId(),
    };
    expect((await port.sendFile(principalOf(t, sender), input)).duplicate).toBe(false);
    expect(row(input.requestId)).toMatchObject({ type: 'document', media_name: 'Q.pdf' });
    expect((await port.sendFile(principalOf(t, sender), input)).duplicate).toBe(true);
    expect(urls).toEqual(['https://cdn.example.com/q.pdf']);
  });

  it('refuses an empty download', async () => {
    const port = createInboxSendPort(t.ctx, { fetchFile: async () => Buffer.alloc(0) });
    const input = {
      jid: LID,
      fileUrl: 'https://cdn.example.com/e.pdf',
      fileName: 'e',
      requestId: requestId(),
    };
    await expect(port.sendFile(principalOf(t, sender), input)).rejects.toThrow(/The file is empty/);
  });
});

describe('decodeFileBase64', () => {
  it('reads plain base64 and a data: URL; refuses bad and too large input', () => {
    expect(decodeFileBase64(PDF_B64)).toEqual(PDF);
    expect(decodeFileBase64(`data:application/pdf;base64,${PDF_B64}`)).toEqual(PDF);
    expect(() => decodeFileBase64('')).toThrow(SendError);
    const tooBig = Buffer.alloc(MCP_SEND_MAX_FILE_BYTES + 3).toString('base64');
    expect(() => decodeFileBase64(tooBig)).toThrow(/file is larger than 5 MB/);
  });
});

describe('guardedFileFetcher', () => {
  let site: Awaited<ReturnType<typeof httpsFixture>>;
  beforeAll(async () => {
    site = await httpsFixture({ '/q.pdf': PDF }, MCP_SEND_MAX_FILE_BYTES + 1024);
  });
  afterAll(() => site.close());

  it('downloads a file, with file wording in its refusals', async () => {
    const get = guardedFileFetcher({ allowLoopback: true, ca: site.ca });
    expect(await get(`${site.origin}/q.pdf`)).toEqual(PDF);
    await expect(get(`${site.origin}/missing`)).rejects.toThrow(/file link answered 404/);
    await expect(get(`${site.origin}/big`)).rejects.toThrow(/file is larger than 5 MB/);
    await expect(guardedFileFetcher()(`${site.origin}/q.pdf`)).rejects.toThrow(
      /file link must be a public internet address/,
    );
    await expect(guardedFileFetcher()('http://example.com/a.pdf')).rejects.toThrow(/https:\/\//);
  });
});

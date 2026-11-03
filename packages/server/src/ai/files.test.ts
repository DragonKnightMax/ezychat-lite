import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Message } from '@ezychat/shared';
import {
  AI_MAX_PDF_BYTES,
  collectPromptFiles,
  countPdfPages,
  isPdf,
  pdfName,
  promptFilesLog,
  readPromptFile,
  skippedFilesNote,
  type PromptFileDeps,
} from './files.js';
import { AI_LIVE_MEDIA_MS, AI_MAX_IMAGE_BYTES } from './images.js';

const dir = mkdtempSync(join(tmpdir(), 'ai-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal valid PDF with `pages` pages, each showing `text` (uncompressed, with an xref table). */
function makePdf(pages: number, text = 'Invoice INV-1042 total RM 1,250.00'): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let index = 0; index < pages; index++) {
    // No text: a scanned page (an empty content stream here).
    const content = text ? `BT /F1 12 Tf 72 720 Td (${text} p${index + 1}) Tj ET` : 'q Q';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PDF whose page objects live only in a compressed object stream (PDF 1.5 style). */
function makeCompressedPdf(pages: number): Buffer {
  const dicts = [
    `<< /Type /Pages /Kids [] /Count ${pages} /Resources << /ProcSet [/PDF] >> >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R >>'),
  ].join('\n');
  const data = deflateSync(Buffer.from(dicts, 'latin1'));
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N ${pages + 1} /First 0 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
      'latin1',
    ),
    data,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
/** A ZIP whose first entry is word/document.xml: what a .docx looks like from its bytes. */
const DOCX = (() => {
  const name = Buffer.from('[Content_Types].xml');
  const body = Buffer.from(
    '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  const name2 = Buffer.from('word/document.xml');
  const header2 = Buffer.from(header);
  header2.writeUInt16LE(name2.length, 26);
  return Buffer.concat([header, name, body, header2, name2, body]);
})();

let seq = 0;
function file(bytes: Buffer): string {
  const path = join(dir, `f${seq++}`);
  writeFileSync(path, bytes);
  return path;
}

interface Stored {
  bytes?: Buffer;
  pending?: boolean;
  safety?: string | null;
}
function setup(entries: Record<string, Stored>) {
  const paths = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [id, entry.bytes ? file(entry.bytes) : null]),
  );
  const waited: string[] = [];
  const deps: PromptFileDeps = {
    waitForMedia: async (id) => {
      waited.push(id);
    },
    mediaPending: (id) => entries[id]?.pending ?? false,
    mediaPath: (id) => (paths[id] ? { path: paths[id] } : null),
    safetyLevel: (id) => entries[id]?.safety ?? null,
  };
  return { deps, waited };
}
const message = (id: string, type: Message['type'], extra: Partial<Message> = {}): Message =>
  ({
    id,
    type,
    fromMe: false,
    timestamp: Date.now(),
    mediaName: null,
    mediaMime: null,
    ...extra,
  }) as Message;
const signal = () => new AbortController().signal;
const noText = async () => null;

describe('countPdfPages', () => {
  it('reads the page tree count of a plain PDF', () => {
    expect(countPdfPages(makePdf(1))).toBe(1);
    expect(countPdfPages(makePdf(7))).toBe(7);
  });

  it('reads pages hidden in a compressed object stream', () => {
    expect(countPdfPages(makeCompressedPdf(25))).toBe(25);
  });

  it('counts page objects when no page tree count is found', () => {
    const leaves = Buffer.from(
      '%PDF-1.4\n<< /Type /Page >>\n<< /Type/Page /X 1 >>\n<< /Type /Pages /Kids [] >>',
      'latin1',
    );
    expect(countPdfPages(leaves)).toBe(2);
  });

  it('gives up on an encrypted PDF or one without pages', () => {
    expect(countPdfPages(Buffer.from('%PDF-1.4\ntrailer << /Encrypt 5 0 R >>'))).toBeNull();
    expect(countPdfPages(Buffer.from('%PDF-1.4\nnothing here'))).toBeNull();
  });

  it('skips a broken compressed stream instead of failing', () => {
    const broken = Buffer.from(
      '%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\nnot zlib\nendstream\n<< /Type /Page >>',
      'latin1',
    );
    expect(countPdfPages(broken)).toBe(1);
  });
});

describe('readPromptFile', () => {
  it('decides the type from the bytes, never the name', async () => {
    expect(isPdf(makePdf(1))).toBe(true);
    expect(isPdf(Buffer.from('%PD'))).toBe(false);
    expect(await readPromptFile(file(makePdf(2)))).toMatchObject({ kind: 'pdf', pages: 2 });
    expect(await readPromptFile(file(PNG))).toMatchObject({
      kind: 'image',
      image: { mime: 'image/png' },
    });
    expect(await readPromptFile(file(DOCX))).toEqual({ reason: 'type', kind: 'Word' });
    expect(await readPromptFile(file(Buffer.from('plain text file')))).toEqual({
      reason: 'type',
      kind: 'file',
    });
  });

  it('refuses PDFs over 10 MB or 20 pages, and empty or missing files', async () => {
    const big = Buffer.concat([makePdf(1), Buffer.alloc(AI_MAX_PDF_BYTES)]);
    expect(await readPromptFile(file(big))).toEqual({ reason: 'size', kind: 'PDF' });
    expect(await readPromptFile(file(makePdf(21)))).toEqual({ reason: 'pages', kind: 'PDF' });
    expect(await readPromptFile(file(makePdf(20)))).toMatchObject({ kind: 'pdf', pages: 20 });
    expect(await readPromptFile(file(Buffer.from('%PDF-1.4 no pages')))).toEqual({
      reason: 'unreadable',
      kind: 'PDF',
    });
    expect(await readPromptFile(file(Buffer.alloc(0)))).toEqual({ reason: 'unreadable' });
    expect(await readPromptFile(join(dir, 'missing'))).toEqual({ reason: 'unreadable' });
    const bigPhoto = Buffer.concat([JPEG, Buffer.alloc(AI_MAX_IMAGE_BYTES)]);
    expect(await readPromptFile(file(bigPhoto))).toEqual({ reason: 'size', kind: 'photo' });
  });
});

describe('collectPromptFiles', () => {
  it('collects photos and PDFs oldest first, with the text layer when asked', async () => {
    const { deps, waited } = setup({
      a: { bytes: JPEG },
      b: { bytes: makePdf(2) },
      c: { bytes: PNG },
    });
    const extract = vi.fn(async (buffer: Buffer) => `text of ${buffer.length} bytes`);
    const files = await collectPromptFiles(
      [
        message('a', 'image'),
        message('b', 'document', { mediaName: 'INV-1042\n.pdf', mediaMime: 'application/x' }),
        message('t', 'text'),
        message('c', 'document', { mediaName: 'photo.pdf' }),
        message('me', 'document', { fromMe: true }),
      ],
      deps,
      { signal: signal(), extractText: extract },
    );
    expect(files.images.map((image) => image.mime)).toEqual(['image/jpeg', 'image/png']);
    expect(files.pdfs).toHaveLength(1);
    expect(files.pdfs[0]).toMatchObject({ name: 'INV-1042 .pdf', pages: 2 });
    expect(Buffer.from(files.pdfs[0]!.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect(files.pdfs[0]!.text).toMatch(/^text of \d+ bytes$/);
    expect(files.skipped).toEqual([]);
    expect(waited).toEqual(['c', 'b', 'a']);
    expect(promptFilesLog(files)).toEqual({
      images: 2,
      pdfs: 1,
      pdfPages: 2,
      pdfText: 1,
      skipped: 0,
      skippedTypes: [],
    });
  });

  it('reads at most 3 PDFs (the newest) and lists the rest', async () => {
    const entries = Object.fromEntries(
      ['p1', 'p2', 'p3', 'p4'].map((id) => [id, { bytes: makePdf(1) }]),
    );
    const { deps } = setup(entries);
    const files = await collectPromptFiles(
      ['p1', 'p2', 'p3', 'p4'].map((id) => message(id, 'document', { mediaName: `${id}.pdf` })),
      deps,
      { signal: signal(), extractText: noText, maxPdfs: 9 },
    );
    expect(files.pdfs.map((pdf) => pdf.name)).toEqual(['p2.pdf', 'p3.pdf', 'p4.pdf']);
    expect(files.pdfs.every((pdf) => pdf.text === null)).toBe(true);
    expect(files.skipped).toEqual([{ messageId: 'p1', reason: 'limit', kind: 'PDF' }]);
  });

  it('takes 3 photos by default and 10 for a record agent', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `i${index}`);
    const { deps, waited } = setup(Object.fromEntries(ids.map((id) => [id, { bytes: JPEG }])));
    const batch = ids.map((id) => message(id, 'image'));
    const three = await collectPromptFiles(batch, deps, { signal: signal() });
    expect(three.images).toHaveLength(3);
    expect(three.skipped).toHaveLength(9);
    expect(three.skipped[0]).toEqual({ messageId: 'i0', reason: 'limit', kind: 'photo' });
    // Photos over the limit are not waited for.
    expect(waited).toHaveLength(3);
    const ten = await collectPromptFiles(batch, deps, { signal: signal(), maxImages: 10 });
    expect(ten.images).toHaveLength(10);
    expect(ten.skipped.map((skip) => skip.messageId)).toEqual(['i0', 'i1']);
  });

  it('never opens a High-risk file, skips Word, and never waits for imported history', async () => {
    const { deps, waited } = setup({
      risky: { bytes: makePdf(1), safety: 'high' },
      word: { bytes: DOCX },
      old: { pending: true },
      gone: {},
      fine: { bytes: makePdf(1), safety: 'warning' },
    });
    const files = await collectPromptFiles(
      [
        message('risky', 'document'),
        message('word', 'document', { mediaName: 'claim.pdf' }),
        message('old', 'document', { timestamp: Date.now() - AI_LIVE_MEDIA_MS - 1000 }),
        message('gone', 'image'),
        message('fine', 'document'),
      ],
      deps,
      { signal: signal(), textLayer: false, extractText: vi.fn() },
    );
    expect(files.pdfs.map((pdf) => pdf.name)).toEqual(['document.pdf']);
    expect(files.skipped).toEqual([
      { messageId: 'risky', reason: 'safety' },
      { messageId: 'word', reason: 'type', kind: 'Word' },
      { messageId: 'gone', reason: 'unreadable' },
    ]);
    expect(waited).not.toContain('risky');
    expect(waited).not.toContain('old');
    expect(promptFilesLog(files).skippedTypes).toEqual(['safety', 'unreadable', 'Word']);
  });

  it('stops on abort and gives no text layer once aborted', async () => {
    const controller = new AbortController();
    const { deps } = setup({ a: { bytes: makePdf(1) }, b: { bytes: makePdf(1) } });
    const extract = vi.fn(() => {
      controller.abort();
      return new Promise<string>(() => {});
    });
    const files = await collectPromptFiles(
      [message('a', 'document'), message('b', 'document')],
      deps,
      { signal: controller.signal, extractText: extract },
    );
    expect(files.pdfs).toHaveLength(2);
    expect(files.pdfs.every((pdf) => pdf.text === null)).toBe(true);
    const aborted = await collectPromptFiles([message('a', 'document')], deps, {
      signal: controller.signal,
    });
    expect(aborted.pdfs).toEqual([]);
  });

  it('reads the real text layer through the document worker; a scanned PDF has none', async () => {
    const { deps } = setup({
      typed: { bytes: makePdf(2) },
      scanned: { bytes: makePdf(1, '') },
    });
    const files = await collectPromptFiles(
      [message('typed', 'document'), message('scanned', 'document')],
      deps,
      { signal: signal() },
    );
    expect(files.pdfs[0]!.text).toContain('INV-1042');
    expect(files.pdfs[1]!.text).toBeNull();
  }, 30_000);
});

describe('skippedFilesNote and pdfName', () => {
  it('names the kind of file, never its name', () => {
    expect(skippedFilesNote([])).toBeNull();
    expect(
      skippedFilesNote([
        { messageId: 'a', reason: 'type', kind: 'Excel' },
        { messageId: 'b', reason: 'type', kind: 'Word' },
      ]),
    ).toBe('The person sent a file the AI cannot open (Word, Excel). Ask for a PDF or a photo.');
    expect(skippedFilesNote([{ messageId: 'a', reason: 'type' }])).toContain(
      '(not a photo or PDF)',
    );
    const all = skippedFilesNote([
      { messageId: 'a', reason: 'size' },
      { messageId: 'b', reason: 'pages' },
      { messageId: 'c', reason: 'unreadable' },
      { messageId: 'd', reason: 'safety' },
      { messageId: 'e', reason: 'limit' },
      { messageId: 'f', reason: 'limit' },
    ])!;
    expect(all).toContain('too large');
    expect(all).toContain('more than 20 pages');
    expect(all).toContain('could not be read');
    expect(all).toContain('flagged');
    expect(all).toContain('2 more files from the person were not read');
    expect(skippedFilesNote([{ messageId: 'e', reason: 'limit' }])).toContain('1 more file from');
  });

  it('keeps one bounded plain line for the file name', () => {
    expect(pdfName(null)).toBe('document.pdf');
    expect(pdfName(' \u0007 ')).toBe('document.pdf');
    expect(pdfName('a'.repeat(300))).toHaveLength(120);
  });
});

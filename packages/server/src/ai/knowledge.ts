import { extname } from 'node:path';
import mammoth from 'mammoth';
import yauzl from 'yauzl';
import { getDocumentProxy } from 'unpdf';
import { errors } from '../http/errors.js';

export const AI_UPLOAD_BYTES = 10 * 1024 * 1024;
export const AI_DOCUMENT_CHARACTERS = 100_000;
export const AI_KNOWLEDGE_CHARACTERS = 500_000;
/** The error of a document with no text (a scanned PDF); MCP `get_message_file` answers `text: null`. */
export const NO_READABLE_TEXT = 'No readable text found. Scanned documents need OCR before upload.';

/** Bound Word archive expansion before the document parser allocates its entries. */
function checkWordArchive(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(errors.validation('Invalid Word document'));
      let total = 0;
      let entries = 0;
      let hasDocument = false;
      zip.on('error', () => reject(errors.validation('Invalid Word document')));
      zip.on('entry', (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        entries++;
        hasDocument ||= entry.fileName === 'word/document.xml';
        if (total > 20 * 1024 * 1024 || entries > 2000 || entry.generalPurposeBitFlag & 1) {
          zip.close();
          return reject(errors.validation('Word document is too large or encrypted'));
        }
        zip.readEntry();
      });
      zip.on('end', () =>
        hasDocument ? resolve() : reject(errors.validation('Invalid Word document')),
      );
      zip.readEntry();
    });
  });
}

export async function extractKnowledge(name: string, buffer: Buffer): Promise<string> {
  if (!buffer.length || buffer.length > AI_UPLOAD_BYTES)
    throw errors.validation('Upload a nonempty document up to 10 MB');
  const extension = extname(name).toLowerCase();
  let text: string;
  if (['.md', '.txt'].includes(extension)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw errors.validation('Text documents must use UTF-8 encoding');
    }
    if (text.includes('\0')) throw errors.validation('Invalid text document');
  } else if (extension === '.docx') {
    await checkWordArchive(buffer);
    try {
      text = (await mammoth.extractRawText({ buffer })).value;
    } catch {
      throw errors.validation('Cannot read this Word document');
    }
  } else if (extension === '.pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw errors.validation('Invalid PDF document');
    try {
      const document = await getDocumentProxy(new Uint8Array(buffer), {
        useSystemFonts: false,
        disableFontFace: true,
      });
      try {
        if (document.numPages > 100)
          throw errors.validation('PDF documents can contain at most 100 pages');
        const pages: string[] = [];
        let characters = 0;
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
          characters += pageText.length;
          if (characters > AI_DOCUMENT_CHARACTERS)
            throw errors.validation('Document text exceeds 100,000 characters');
          pages.push(pageText);
          page.cleanup();
        }
        text = pages.join('\n\n');
      } finally {
        await document.loadingTask.destroy();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'HttpError') throw error;
      throw errors.validation(
        'Cannot read this PDF. Use an unencrypted PDF containing selectable text.',
      );
    }
  } else
    throw errors.validation('Upload a PDF, Word (.docx), Markdown (.md) or text (.txt) document');
  text = text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw errors.validation(NO_READABLE_TEXT);
  if (text.length > AI_DOCUMENT_CHARACTERS)
    throw errors.validation('Document text exceeds 100,000 characters');
  return text;
}

export interface KnowledgeSource {
  name: string;
  text: string;
  /** Always send this source's first chunk (the overview: the oldest text item) when selecting. */
  pinFirst?: boolean;
}

/** Knowledge up to this size is sent whole, in source order, without relevance selection. */
export const AI_FULL_CONTEXT_CHARACTERS = 40_000;
const CHUNK_CHARACTERS = 1500;
const CHUNK_STRIDE = 1200;
const SELECTED_CHUNKS = 14;
const SELECTED_CHARACTERS = 24_000;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'your',
  'are',
  'is',
  'ada',
  'yang',
  'untuk',
  'di',
  'ke',
  'dan',
]);

/** Query terms: Latin/other words (≥2 characters) plus overlapping bigrams of CJK runs, which have no spaces. */
export function knowledgeTerms(text: string): string[] {
  const lower = text.toLocaleLowerCase();
  const terms = new Set<string>();
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  }
  for (const word of lower.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    if (!STOP_WORDS.has(word)) terms.add(word);
  return [...terms];
}

/** Packs blank-line-separated paragraphs (so a Q/A stays together) into bounded chunks. */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    if (!paragraph.trim()) continue;
    if (paragraph.length > CHUNK_CHARACTERS) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += CHUNK_STRIDE) {
        chunks.push(paragraph.slice(offset, offset + CHUNK_CHARACTERS));
        if (offset + CHUNK_CHARACTERS >= paragraph.length) break;
      }
    } else if (current && current.length + 2 + paragraph.length > CHUNK_CHARACTERS) {
      flush();
      current = paragraph;
    } else current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

/**
 * Local retrieval, no hosted index: small knowledge is sent whole; above
 * AI_FULL_CONTEXT_CHARACTERS the best-matching chunks are sent within a bounded budget.
 */
export function relevantKnowledge(sources: KnowledgeSource[], query: string): string {
  const present = sources.filter((source) => source.text.trim());
  const total = present.reduce((sum, source) => sum + source.text.length, 0);
  if (total <= AI_FULL_CONTEXT_CHARACTERS)
    return present.map((source) => `[${source.name}]\n${source.text}`).join('\n\n');
  const terms = knowledgeTerms(query).slice(0, 200);
  let order = 0;
  const pinned: string[] = [];
  const chunks = present.flatMap((source) =>
    chunkText(source.text).flatMap((text, index) => {
      const labelled = `[${source.name}]\n${text}`;
      if (source.pinFirst && index === 0) {
        pinned.push(labelled);
        return [];
      }
      const lower = text.toLocaleLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      return [{ text: labelled, score, index, order: order++ }];
    }),
  );
  chunks.sort((a, b) => b.score - a.score || a.index - b.index || a.order - b.order);
  return [...pinned, ...chunks.map((chunk) => chunk.text)]
    .slice(0, SELECTED_CHUNKS)
    .join('\n\n')
    .slice(0, SELECTED_CHARACTERS);
}

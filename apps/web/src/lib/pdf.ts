/**
 * Shows PDF attachments inside the app (pdf.js, loaded on first use), so a teammate can read a
 * customer's PDF without saving it first. The bytes are fetched from our own media route and drawn on
 * canvases: the PDF never becomes a document on our origin, its scripts never run, and no plugin or
 * external viewer is involved.
 */

export interface PdfPage {
  /** Size in CSS pixels at scale 1. */
  width: number;
  height: number;
  /** Draws the page on `canvas` at `scale` (CSS pixels) × `pixelRatio`. Rejects when cancelled. */
  render(
    canvas: HTMLCanvasElement,
    scale: number,
    pixelRatio: number,
  ): { promise: Promise<void>; cancel(): void };
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): void;
}

/** PDFs larger than this are not opened in the app (download instead): parsing runs in the browser. */
export const PDF_VIEW_MAX_BYTES = 50 * 1024 * 1024;

export class PdfLoadError extends Error {
  constructor(readonly reason: 'too_large' | 'not_pdf' | 'failed') {
    super(`pdf ${reason}`);
    this.name = 'PdfLoadError';
  }
}

/** True for the files the in-app viewer opens. */
export function isPdfMime(mime: string | null | undefined): boolean {
  return (mime ?? '').split(';')[0]?.trim().toLowerCase() === 'application/pdf';
}

/** Checks the first bytes: only a real PDF goes to the parser. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF-" may follow a little junk; readers accept it within the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** Downloads the media file and opens it with pdf.js. */
export async function loadPdf(url: string, signal: AbortSignal): Promise<PdfDocument> {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new PdfLoadError('failed');
  const size = Number(res.headers.get('content-length') ?? 0);
  if (size > PDF_VIEW_MAX_BYTES) throw new PdfLoadError('too_large');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > PDF_VIEW_MAX_BYTES) throw new PdfLoadError('too_large');
  if (!looksLikePdf(bytes)) throw new PdfLoadError('not_pdf');

  const [pdfjs, { default: workerSrc }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const task = pdfjs.getDocument({
    data: bytes,
    // Never fetch anything else (fonts, maps, wasm) and never render XFA forms (HTML).
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    useSystemFonts: true,
  });
  const onAbort = () => void task.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  let doc;
  try {
    doc = await task.promise;
  } catch {
    throw new PdfLoadError('failed');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return {
    numPages: doc.numPages,
    async getPage(n) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      return {
        width: base.width,
        height: base.height,
        render(canvas, scale, pixelRatio) {
          const viewport = page.getViewport({ scale: scale * pixelRatio });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const job = page.render({ canvas, viewport });
          return { promise: job.promise, cancel: () => job.cancel() };
        },
      };
    },
    destroy: () => void task.destroy(),
  };
}

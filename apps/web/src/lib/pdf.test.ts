import { afterEach, describe, expect, it, vi } from 'vitest';

const getDocument = vi.fn();
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.js' }));

import { isPdfMime, loadPdf, looksLikePdf, PDF_VIEW_MAX_BYTES, PdfLoadError } from './pdf';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%…');

function respond(body: BodyInit, headers: Record<string, string> = {}, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  getDocument.mockReset();
});

describe('isPdfMime / looksLikePdf', () => {
  it('accepts application/pdf with parameters, nothing else', () => {
    expect(isPdfMime('application/pdf')).toBe(true);
    expect(isPdfMime('Application/PDF; name=a.pdf')).toBe(true);
    expect(isPdfMime('application/octet-stream')).toBe(false);
    expect(isPdfMime(null)).toBe(false);
  });

  it('checks the PDF signature in the first bytes', () => {
    expect(looksLikePdf(PDF_BYTES)).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('<html><script>'))).toBe(false);
  });
});

describe('loadPdf', () => {
  it('refuses a file that is not really a PDF before parsing it', async () => {
    respond('<html>hi</html>');
    await expect(loadPdf('/api/media/x', new AbortController().signal)).rejects.toMatchObject({
      reason: 'not_pdf',
    });
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('refuses a file larger than the limit from its length header', async () => {
    respond(PDF_BYTES, { 'content-length': String(PDF_VIEW_MAX_BYTES + 1) });
    await expect(loadPdf('/api/media/x', new AbortController().signal)).rejects.toBeInstanceOf(
      PdfLoadError,
    );
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('reports a failed download', async () => {
    respond('nope', {}, 403);
    await expect(loadPdf('/api/media/x', new AbortController().signal)).rejects.toMatchObject({
      reason: 'failed',
    });
  });

  it('opens the bytes with pdf.js without fetching anything else and draws pages', async () => {
    respond(PDF_BYTES);
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render,
    };
    const destroy = vi.fn();
    getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage: vi.fn(async () => page) }),
      destroy,
    });
    const doc = await loadPdf('/api/media/x', new AbortController().signal);
    const opts = getDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts).toMatchObject({ enableXfa: false, disableAutoFetch: true, disableStream: true });
    expect(opts.data).toBeInstanceOf(Uint8Array);
    expect(doc.numPages).toBe(2);
    const p = await doc.getPage(1);
    expect([p.width, p.height]).toEqual([600, 800]);
    const canvas = document.createElement('canvas');
    await p.render(canvas, 1.5, 2).promise;
    expect([canvas.width, canvas.height]).toEqual([1800, 2400]);
    doc.destroy();
    expect(destroy).toHaveBeenCalled();
  });

  it('turns a parser failure into a load error', async () => {
    respond(PDF_BYTES);
    getDocument.mockReturnValue({
      promise: Promise.reject(new Error('bad xref')),
      destroy: vi.fn(),
    });
    await expect(loadPdf('/api/media/x', new AbortController().signal)).rejects.toMatchObject({
      reason: 'failed',
    });
  });
});

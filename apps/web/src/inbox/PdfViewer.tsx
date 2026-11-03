import { useEffect, useRef, useState, type RefObject } from 'react';
import { Download, Loader2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { loadPdf, PdfLoadError, type PdfDocument, type PdfPage } from '@/lib/pdf';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
/** At 100 % a page fits the window width, but never wider than this many CSS pixels per PDF point. */
const MAX_FIT_SCALE = 1.5;
const PAGE_GAP = 12;

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: PdfDocument; pages: PdfPage[] }
  | { kind: 'error'; reason: 'too_large' | 'not_pdf' | 'failed' };

export interface PdfViewerProps {
  url: string;
  name: string;
  downloadName: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** Full-screen in-app PDF reader: the same frame as the image preview, with zoom and Download. */
export function PdfViewer({ url, name, downloadName, open, onOpenChange }: PdfViewerProps) {
  const { t } = useTranslation(['inbox', 'common']);
  const [zoomIndex, setZoomIndex] = useState(ZOOMS.indexOf(1));
  const zoom = ZOOMS[zoomIndex] ?? 1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-label={t('media.pdfPreview')}
        className="safe-top safe-bottom safe-x flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 sm:max-w-none translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 top-0 left-0"
      >
        <DialogTitle className="sr-only">{t('media.pdfPreview')}</DialogTitle>
        <DialogDescription className="sr-only">{name}</DialogDescription>
        <div className="flex items-center gap-1 border-b bg-card p-2">
          <p className="min-w-0 flex-1 truncate px-2 text-sm font-medium" title={name}>
            {name}
          </p>
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={t('media.zoomOut')}
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
          >
            <ZoomOut aria-hidden="true" />
          </Button>
          <span className="hidden w-12 text-center text-sm tabular-nums text-muted-foreground sm:inline">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={t('media.zoomIn')}
            disabled={zoomIndex === ZOOMS.length - 1}
            onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))}
          >
            <ZoomIn aria-hidden="true" />
          </Button>
          <Button asChild variant="ghost" size="touch">
            <a href={url} download={downloadName}>
              <Download aria-hidden="true" />
              <span className="hidden sm:inline">{t('media.download')}</span>
            </a>
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-touch" aria-label={t('common:actions.close')}>
              <X className="size-6" aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>
        {open && <PdfBody url={url} downloadName={downloadName} zoom={zoom} />}
      </DialogContent>
    </Dialog>
  );
}

function PdfBody({ url, downloadName, zoom }: { url: string; downloadName: string; zoom: number }) {
  const { t } = useTranslation('inbox');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useWidth(scrollRef, state.kind === 'ready');

  useEffect(() => {
    const ac = new AbortController();
    let opened: PdfDocument | null = null;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const doc = await loadPdf(url, ac.signal);
        opened = doc;
        const pages: PdfPage[] = [];
        for (let n = 1; n <= doc.numPages; n++) pages.push(await doc.getPage(n));
        if (!ac.signal.aborted) setState({ kind: 'ready', doc, pages });
      } catch (err) {
        if (ac.signal.aborted) return;
        setState({ kind: 'error', reason: err instanceof PdfLoadError ? err.reason : 'failed' });
      }
    })();
    return () => {
      ac.abort();
      opened?.destroy();
    };
  }, [url]);

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        <span role="status">{t('media.pdfLoading')}</span>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p role="alert" className="max-w-sm text-sm text-muted-foreground">
          {t(state.reason === 'too_large' ? 'media.pdfTooLarge' : 'media.pdfFailed')}
        </p>
        <Button asChild>
          <a href={url} download={downloadName}>
            <Download aria-hidden="true" />
            {t('media.download')}
          </a>
        </Button>
      </div>
    );
  }

  const widest = Math.max(...state.pages.map((p) => p.width), 1);
  const fit = width > 0 ? Math.min((width - 2 * PAGE_GAP) / widest, MAX_FIT_SCALE) : 1;
  const scale = Math.max(fit, 0.1) * zoom;
  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto"
      data-testid="pdf-pages"
      style={{ padding: PAGE_GAP }}
    >
      <div className="mx-auto flex w-max flex-col items-center" style={{ gap: PAGE_GAP }}>
        {state.pages.map((page, i) => (
          <PdfPageView
            key={i}
            page={page}
            scale={scale}
            label={t('media.pdfPage', { page: i + 1, total: state.pages.length })}
          />
        ))}
      </div>
    </div>
  );
}

/** One page: drawn only while it is near the screen, so long PDFs stay light on memory. */
function PdfPageView({ page, scale, label }: { page: PdfPage; scale: number; label: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const near = useNearScreen(boxRef);
  const w = Math.floor(page.width * scale);
  const h = Math.floor(page.height * scale);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !canvas) return;
    const job = page.render(canvas, scale, Math.min(window.devicePixelRatio || 1, 2));
    job.promise.catch(() => {});
    return () => {
      job.cancel();
      // Free the bitmap of pages scrolled far away.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [near, page, scale]);

  return (
    <div
      ref={boxRef}
      role="img"
      aria-label={label}
      className="shrink-0 bg-card shadow-sm ring-1 ring-border"
      style={{ width: w, height: h }}
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}

function useWidth(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return width;
}

function useNearScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), {
      rootMargin: '100% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

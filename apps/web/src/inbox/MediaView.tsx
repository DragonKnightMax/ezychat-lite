import type React from 'react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Copy, Download, FileText, ImageIcon, Loader2, RotateCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Message } from '@ezychat/shared';
import { api } from '../api/client';
import { mediaUrlFor, upsertMessageInCache } from '../api/queries';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { canCopyImage, copyImageFromUrl } from '@/lib/clipboard';
import { setDownloadDrag } from '@/lib/file-transfer';
import { isPdfMime } from '@/lib/pdf';
import { PdfViewer } from './PdfViewer';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

export interface MediaViewProps {
  message: Message;
  /** Fired when an image/video finishes loading (lets the list keep its scroll anchored). */
  onLoad?(): void;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

/** Image files sent as documents that the server serves inline, so the image preview can show them. */
const VIEWABLE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** The file name a media file gets when dragged or saved out of the app. */
export function mediaFileName(m: Pick<Message, 'id' | 'type' | 'mediaName' | 'mediaMime'>): string {
  if (m.mediaName) return m.mediaName;
  const mime = (m.mediaMime ?? '').split(';')[0]?.trim() ?? '';
  const ext = MIME_EXT[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? '';
  const id = m.id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'file';
  const suffix = ext ? `.${ext}` : '';
  return `whatsapp-${m.type}-${id}${suffix}`;
}

/** Dragging this media out of the window saves it as a file (Chromium browsers, desktop app). */
function dragOut(m: Message, url: string) {
  return (e: React.DragEvent) =>
    setDownloadDrag(e.dataTransfer, { url, name: mediaFileName(m), mime: m.mediaMime ?? null });
}

function useRedownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<Message>(`/media/${encodeURIComponent(id)}/redownload`, { method: 'POST' }),
    onSuccess: (m) => {
      if (m && typeof m === 'object' && 'id' in m) upsertMessageInCache(qc, m);
    },
  });
}

function Lightbox({
  src,
  alt,
  open,
  onOpenChange,
  downloadName,
}: {
  src: string;
  alt: string;
  downloadName?: string;
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const { t } = useTranslation(['inbox', 'common']);
  const [copyable] = useState(canCopyImage);
  const [loaded, setLoaded] = useState(false);
  const backdrop = useRef<HTMLDivElement>(null);
  async function copyImage() {
    try {
      await copyImageFromUrl(src);
      toast.success(t('message.copy.imageDone'));
    } catch {
      toast.error(t('message.copy.imageFailed'));
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-label={t('media.preview')}
        // A click on the empty space around the photo closes it, as on WhatsApp; keyboard users
        // have Esc and the Close button. One handler on the dialog, none on plain elements.
        onClick={(e) => {
          if (e.target === backdrop.current) onOpenChange(false);
        }}
        className="safe-top safe-bottom safe-x flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 sm:max-w-none translate-y-0 flex-col gap-0 rounded-none border-0 bg-background/95 p-0 top-0 left-0"
      >
        <DialogTitle className="sr-only">{t('media.preview')}</DialogTitle>
        <DialogDescription className="sr-only">{alt}</DialogDescription>
        <div className="flex justify-end gap-1 p-2">
          {copyable && (
            <Button variant="ghost" size="touch" onClick={() => void copyImage()}>
              <Copy aria-hidden="true" />
              {t('message.copy.image')}
            </Button>
          )}
          <Button asChild variant="ghost" size="touch">
            <a href={src} download={downloadName ?? true}>
              <Download aria-hidden="true" />
              {t('media.download')}
            </a>
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-touch" aria-label={t('common:actions.close')}>
              <X className="size-6" aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>
        <div ref={backdrop} className="flex min-h-0 flex-1 items-center justify-center p-2">
          {!loaded && (
            <Loader2
              className="size-6 shrink-0 animate-spin text-muted-foreground"
              role="img"
              aria-label={t('media.loading')}
            />
          )}
          <img
            src={src}
            alt={alt}
            onLoad={() => setLoaded(true)}
            onError={() => setLoaded(true)}
            className={loaded ? 'max-h-full max-w-full object-contain' : 'sr-only'}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

const IMAGE_MAX_WIDTH = 320;
const IMAGE_MAX_HEIGHT = 288;
const THUMB_WITHOUT_SIZE: CSSProperties = { width: 256, maxWidth: '100%' };

/** The space an image takes in the chat, so nothing moves when its file arrives; undefined when its size is not known. */
export function imageBox(
  width: number | null | undefined,
  height: number | null | undefined,
): CSSProperties | undefined {
  if (!width || !height) return undefined;
  const w = Math.min(width, IMAGE_MAX_WIDTH);
  const h = Math.min(Math.round((w * height) / width), IMAGE_MAX_HEIGHT);
  return { width: w, maxWidth: '100%', aspectRatio: `${w} / ${h}` };
}

/**
 * Calls `onNear` once when the returned element is within 300 px of the chat's visible part, so a chat
 * full of images downloads only what the reader reaches. Without IntersectionObserver: at once.
 */
function useWhenNear(enabled: boolean, onNear: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      onNear();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        onNear();
      },
      { root: el.closest('[data-chat-scroll]'), rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, onNear]);
  return ref;
}

/** Renders the media part of a message (image, sticker, video, audio, document). */
export function MediaView({ message: m, onLoad }: MediaViewProps) {
  const { t } = useTranslation(['inbox', 'common']);
  const [open, setOpen] = useState(false);
  const redownload = useRedownload();
  const label = m.mediaName ?? t(`media.types.${m.type}`);
  // History media (received, or sent from the phone) is imported without downloading it: status 'pending'
  // on a real WhatsApp id. Only app-sent messages still uploading carry a temporary 'local-' id.
  const onDemand = m.mediaStatus === 'pending' && !m.id.startsWith('local-');
  // An image with WhatsApp's preview shows that in the chat: its real file loads only when it is opened.
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbUrl =
    m.type === 'image' && !thumbFailed && m.mediaStatus !== 'failed' && !m.id.startsWith('local-')
      ? m.mediaThumbUrl
      : null;
  const autoLoad = onDemand && !thumbUrl && (m.type === 'image' || m.type === 'sticker');
  const { mutate: fetchMedia, isIdle } = redownload;
  const box = m.type === 'image' ? imageBox(m.mediaWidth, m.mediaHeight) : undefined;

  // Small media loads when the reader reaches it; large media waits for a tap.
  const fetchThis = useCallback(() => fetchMedia(m.id), [fetchMedia, m.id]);
  const nearRef = useWhenNear(autoLoad && isIdle, fetchThis);

  if (thumbUrl) {
    return (
      <>
        <Button
          variant="ghost"
          onClick={() => setOpen(true)}
          className="block h-auto overflow-hidden rounded-lg p-0 hover:bg-transparent"
          aria-label={t('media.openImage')}
        >
          <img
            src={thumbUrl}
            alt={m.body ?? m.mediaName ?? t('media.imageAlt')}
            loading="lazy"
            onLoad={onLoad}
            onError={() => setThumbFailed(true)}
            style={box ?? THUMB_WITHOUT_SIZE}
            className="object-cover"
          />
        </Button>
        {open && (
          <Lightbox
            src={m.mediaUrl ?? mediaUrlFor(m.id)}
            alt={m.body ?? t('media.imageAlt')}
            downloadName={mediaFileName(m)}
            open={open}
            onOpenChange={setOpen}
          />
        )}
      </>
    );
  }

  if (onDemand && !autoLoad && !redownload.isPending) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Button
          variant="ghost"
          size="touch"
          className="text-primary"
          onClick={() => fetchMedia(m.id)}
        >
          <Download aria-hidden="true" />
          {redownload.isError ? t('common:actions.retry') : t('media.tapToLoad')}
        </Button>
      </div>
    );
  }

  if (
    (m.mediaStatus === 'pending' && !redownload.isError) ||
    (!m.mediaUrl && m.status === 'pending')
  ) {
    return (
      <div
        ref={nearRef}
        style={box}
        className="flex min-h-14 items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
      >
        <Loader2
          className="size-4 shrink-0 animate-spin"
          role="img"
          aria-label={t('media.loading')}
        />
        <span className="truncate">
          {m.fromMe ? t('media.uploading', { label }) : t('media.downloading', { label })}
        </span>
      </div>
    );
  }

  if (m.mediaStatus === 'failed' || !m.mediaUrl) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate">
          {m.mediaStatus === 'failed' || redownload.isError
            ? t('media.loadFailed', { label })
            : t('media.unavailable', { label })}
        </span>
        {!m.id.startsWith('local-') && (
          <Button
            variant="ghost"
            size="touch"
            onClick={() => redownload.mutate(m.id)}
            disabled={redownload.isPending}
            className="text-primary"
          >
            <RotateCw
              className={redownload.isPending ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
            {redownload.isPending ? t('retrying') : t('media.retryDownload')}
          </Button>
        )}
      </div>
    );
  }

  const url = m.mediaUrl;

  switch (m.type) {
    case 'image':
    case 'sticker':
      return (
        <>
          <Button
            variant="ghost"
            onClick={() => setOpen(true)}
            className="block h-auto overflow-hidden rounded-lg p-0 hover:bg-transparent"
            aria-label={m.type === 'sticker' ? t('media.openSticker') : t('media.openImage')}
          >
            <img
              src={url}
              alt={m.body ?? m.mediaName ?? t('media.imageAlt')}
              loading="lazy"
              onLoad={onLoad}
              onDragStart={dragOut(m, url)}
              style={box}
              className={
                m.type === 'sticker'
                  ? 'size-32 object-contain'
                  : box
                    ? 'object-cover'
                    : 'max-h-72 w-full max-w-full object-cover sm:max-w-xs'
              }
            />
          </Button>
          <Lightbox
            src={url}
            alt={m.body ?? t('media.imageAlt')}
            downloadName={mediaFileName(m)}
            open={open}
            onOpenChange={setOpen}
          />
        </>
      );
    case 'video':
      return (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={onLoad}
          className="max-h-72 w-full max-w-full rounded-lg bg-muted sm:max-w-xs"
        />
      );
    case 'audio':
      return <audio src={url} controls preload="metadata" className="w-64 max-w-full" />;
    default: {
      const mime = (m.mediaMime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const viewer = isPdfMime(mime) ? 'pdf' : VIEWABLE_IMAGE.has(mime) ? 'image' : null;
      if (!viewer) {
        return (
          <a
            href={url}
            download={m.mediaName ?? true}
            onDragStart={dragOut(m, url)}
            className="flex min-h-14 max-w-full items-center gap-3 rounded-lg border bg-muted/60 px-3 py-2 hover:bg-muted"
          >
            <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {m.mediaName ?? t('media.document')}
              </span>
              <span className="block truncate text-xs opacity-70">
                {t('media.fileDownload', { type: m.mediaMime ?? t('media.file') })}
              </span>
            </span>
          </a>
        );
      }
      const name = m.mediaName ?? t('media.document');
      const downloadName = mediaFileName(m);
      return (
        <>
          <div className="flex min-h-14 max-w-full items-center gap-1 rounded-lg border bg-muted/60 pr-1 hover:bg-muted">
            <Button
              variant="ghost"
              onClick={() => setOpen(true)}
              onDragStart={dragOut(m, url)}
              draggable
              aria-label={t('media.openFile', { name })}
              className="h-auto min-h-14 min-w-0 flex-1 justify-start gap-3 rounded-lg px-3 py-2 text-left font-normal hover:bg-transparent"
            >
              {viewer === 'pdf' ? (
                <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : (
                <ImageIcon className="size-8 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-xs opacity-70">
                  {t('media.fileOpen', { type: viewer === 'pdf' ? 'PDF' : mime })}
                </span>
              </span>
            </Button>
            <Button asChild variant="ghost" size="icon-touch">
              <a
                href={url}
                download={downloadName}
                onDragStart={dragOut(m, url)}
                aria-label={t('media.downloadFile', { name })}
              >
                <Download aria-hidden="true" />
              </a>
            </Button>
          </div>
          {viewer === 'pdf' ? (
            <PdfViewer
              url={url}
              name={name}
              downloadName={downloadName}
              open={open}
              onOpenChange={setOpen}
            />
          ) : (
            <Lightbox
              src={url}
              alt={name}
              downloadName={downloadName}
              open={open}
              onOpenChange={setOpen}
            />
          )}
        </>
      );
    }
  }
}

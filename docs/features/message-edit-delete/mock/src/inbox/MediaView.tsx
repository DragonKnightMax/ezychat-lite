import { useEffect, useState } from 'react';
import { Download, FileText, Loader2, RotateCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Message } from '@ezychat/shared';
import { api } from '../api/client';
import { upsertMessageInCache } from '../api/queries';
import { Button } from '@/components/ui/button';
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
}: {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const { t } = useTranslation(['inbox', 'common']);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-label={t('media.preview')}
        className="safe-top safe-bottom safe-x flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 sm:max-w-none translate-y-0 flex-col gap-0 rounded-none border-0 bg-background/95 p-0 top-0 left-0"
      >
        <DialogTitle className="sr-only">{t('media.preview')}</DialogTitle>
        <DialogDescription className="sr-only">{alt}</DialogDescription>
        <div className="flex justify-end gap-1 p-2">
          <Button asChild variant="ghost" size="touch">
            <a href={src} download>
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
        <div
          className="flex min-h-0 flex-1 items-center justify-center p-2"
          onClick={() => onOpenChange(false)}
        >
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
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
  const autoLoad = onDemand && (m.type === 'image' || m.type === 'sticker');
  const { mutate: fetchMedia, isIdle } = redownload;

  // Small media loads as soon as it is shown; large media waits for a tap.
  useEffect(() => {
    if (autoLoad && isIdle) fetchMedia(m.id);
  }, [autoLoad, isIdle, fetchMedia, m.id]);

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
      <div className="flex min-h-14 items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
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
              className={
                m.type === 'sticker'
                  ? 'size-32 object-contain'
                  : 'max-h-72 w-full max-w-full object-cover sm:max-w-xs'
              }
            />
          </Button>
          <Lightbox
            src={url}
            alt={m.body ?? t('media.imageAlt')}
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
    default:
      return (
        <a
          href={url}
          download={m.mediaName ?? true}
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
}

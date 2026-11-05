import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthProvider';
import { useDesktopUpdates } from '@/lib/desktop-updates';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Banner, ResponsiveDialog } from './index';

export function DesktopUpdatePanel() {
  const { t } = useTranslation('app');
  const { state, error, check, open, install, cancelDownload } = useDesktopUpdates();
  if (!state?.isHost) return null;
  const checking = state.status === 'checking';
  const release = state.release;
  const transfer = state.transfer;
  const downloading = transfer?.status === 'downloading';
  const installing = transfer?.status === 'installing';
  const ready = transfer?.status === 'ready';
  const managed = state.canInstall !== false && !!window.watiUpdates?.installUpdate;
  const verifiedMetadata = !!release?.assetSha256 && !!release.assetSize;
  const percentage = transfer?.totalBytes
    ? Math.min(100, Math.max(0, Math.round((transfer.downloadedBytes / transfer.totalBytes) * 100)))
    : 0;
  return (
    <section
      aria-label={t('updates.title')}
      className="w-full space-y-3 rounded-lg border p-3 text-left"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('updates.title')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('updates.installed', { version: state.currentVersion })}
        </span>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {checking
          ? t('updates.checkingGitHub')
          : state.status === 'current'
            ? t('updates.current')
            : release
              ? t('updates.available', { version: release.version })
              : state.status === 'error'
                ? t('updates.checkFailed')
                : t('updates.automatic')}
      </p>
      {(error || transfer?.error || state.error) && (
        <Banner tone="warning">{error ?? transfer?.error ?? state.error}</Banner>
      )}
      {state.lastInstall && (
        <Banner tone={state.lastInstall.status === 'success' ? 'info' : 'warning'}>
          {state.lastInstall.message}
        </Banner>
      )}
      {(downloading || ready || installing) && (
        <div className="space-y-2" aria-live="polite">
          <p className="text-sm font-medium">
            {downloading
              ? t('updates.downloading', { percent: percentage })
              : ready
                ? t('updates.downloaded', { version: transfer.version })
                : t('updates.preparing')}
          </p>
          {downloading && (
            <>
              <div
                role="progressbar"
                aria-label={t('updates.progressLabel')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percentage}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${percentage}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('updates.keepsWorking')}</p>
            </>
          )}
        </div>
      )}
      {release && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 font-medium [overflow-wrap:anywhere]">{release.name}</p>
            {release.prerelease && <Badge variant="secondary">{t('updates.preview')}</Badge>}
          </div>
          {release.notes && (
            <div className="max-h-44 overflow-y-auto rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
              {release.notes}
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {managed && release.downloadUrl
              ? t('updates.howManaged')
              : release.downloadUrl
                ? t('updates.howManual')
                : t('updates.noInstaller')}
          </p>
          <p className="text-xs text-muted-foreground">
            {managed ? t('updates.interrupt') : t('updates.interruptManual')}
          </p>
          {state.installUnavailableReason && (
            <p className="text-sm text-muted-foreground">{state.installUnavailableReason}</p>
          )}
          {managed && !verifiedMetadata && release.downloadUrl && (
            <Banner tone="info">{t('updates.unverified')}</Banner>
          )}
          <div className="flex flex-wrap gap-2">
            {ready && managed ? (
              <Button size="touch" onClick={() => void install()}>
                <RefreshCw aria-hidden /> {t('updates.restart')}
              </Button>
            ) : (
              release.downloadUrl && (
                <Button
                  size="touch"
                  disabled={downloading || installing || (managed && !verifiedMetadata)}
                  onClick={() => void open('download')}
                >
                  <Download aria-hidden /> {t('updates.download', { version: release.version })}
                </Button>
              )
            )}
            {downloading && (
              <Button variant="outline" size="touch" onClick={() => void cancelDownload()}>
                {t('updates.cancelDownload')}
              </Button>
            )}
            <Button
              variant="outline"
              size="touch"
              disabled={installing}
              onClick={() => void open('release')}
            >
              {t('updates.releaseOnGitHub')} <ExternalLink aria-hidden />
            </Button>
          </div>
        </>
      )}
      <Button
        variant="outline"
        size="touch"
        disabled={checking || downloading || ready || installing}
        onClick={() => void check()}
      >
        <RefreshCw aria-hidden className={checking ? 'animate-spin' : undefined} />
        {checking ? t('updates.checking') : t('updates.check')}
      </Button>
      {state.checkedAt && (
        <p className="text-xs text-muted-foreground">
          {t('updates.lastChecked', { time: formatDateTime(Date.parse(state.checkedAt)) })}
        </p>
      )}
    </section>
  );
}

/** A suggestion, never an automatic installation or interruption of a conversation. */
export function DesktopUpdateNotice() {
  const { t } = useTranslation('app');
  const { user } = useAuth();
  const { state } = useDesktopUpdates();
  const shown = useRef<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!user || !state?.isHost) {
      setSuggestion(null);
      return;
    }
    if (!state.release || (state.status !== 'available' && state.transfer?.status !== 'ready'))
      return;
    const version = state.release.version;
    const ready = state.transfer?.status === 'ready';
    const key = `${ready ? 'ready' : 'available'}:${version}`;
    if (shown.current === key) return;
    shown.current = key;
    if (ready) {
      setSuggestion(null);
      // The About/update dialog already presents the ready action; avoid stacking another modal.
      if (!document.querySelector('[role="dialog"]')) setOpen(true);
      return;
    }
    setSuggestion(version);
  }, [user, state]);
  if (!user || !state?.isHost) return null;
  return (
    <>
      {suggestion === state.release?.version && !open && (
        <aside
          aria-label={t('updates.notice.label')}
          aria-live="polite"
          className="fixed inset-x-3 top-3 z-40 mx-auto max-w-md space-y-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold [overflow-wrap:anywhere]">
                {t('updates.notice.title', { version: suggestion })}
              </p>
              <p className="text-sm text-muted-foreground">
                {state.release?.prerelease
                  ? t('updates.notice.preview')
                  : t('updates.notice.release')}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('updates.notice.dismiss')}
              onClick={() => setSuggestion(null)}
            >
              <X aria-hidden />
            </Button>
          </div>
          <Button
            size="touch"
            onClick={() => {
              setSuggestion(null);
              setOpen(true);
            }}
          >
            {t('updates.notice.review')}
          </Button>
        </aside>
      )}
      <ResponsiveDialog open={open} onOpenChange={setOpen} title={t('updates.dialogTitle')}>
        <DesktopUpdatePanel />
      </ResponsiveDialog>
    </>
  );
}

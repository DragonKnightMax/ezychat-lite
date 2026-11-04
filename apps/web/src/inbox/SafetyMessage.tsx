import { useState } from 'react';
import { Ban, Copy, FileWarning, Lock, ShieldAlert, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Message, MessageSafety } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { useSafetyAction, useSafetyChat } from '../api/safety';
import { useAuth } from '../auth/AuthProvider';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * WhatsApp Safety in the chat (docs/features/whatsapp-safety/design.md): a short banner on a flagged
 * message, its file behind a check before download (locked for agents when the risk is high), and a
 * bar on top of the chat for a reported, blocked or possibly hacked number.
 */

/** The banner shows only while the finding matters (not after "Mark safe"). */
export function showsSafety(m: Message): m is Message & { safety: MessageSafety } {
  return !m.fromMe && !!m.safety && m.safety.status !== 'safe';
}

/** At most two reasons; the rest are on Admin → Safety. "First file" alone says little. */
function topReasons(s: MessageSafety) {
  return s.rules.filter((r) => r !== 'firstFile').slice(0, 2);
}

export function SafetyNotice({ safety, hasFile }: { safety: MessageSafety; hasFile: boolean }) {
  const { t } = useTranslation('inbox');
  const high = safety.level === 'high';
  return (
    <div
      role="note"
      data-testid="safety-notice"
      data-level={safety.level}
      className={cn(
        'mb-1.5 flex gap-2 rounded-md border px-2.5 py-2 text-xs',
        high ? 'border-danger/40 bg-danger/10' : 'border-warning/50 bg-warning/10',
      )}
    >
      <ShieldAlert
        className={cn('mt-0.5 size-4 shrink-0', high ? 'text-danger' : 'text-warning')}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="font-semibold">
          {high
            ? hasFile
              ? t('safety.title.highFile')
              : t('safety.title.highText')
            : hasFile
              ? t('safety.title.warningFile')
              : t('safety.title.warningText')}
        </p>
        {topReasons(safety).length > 0 && (
          <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
            {topReasons(safety).map((r) => (
              <li key={r}>{t(`safety.rule.${r}`)}</li>
            ))}
          </ul>
        )}
        {safety.aiReason && (
          <p className="mt-1 flex gap-1 text-muted-foreground">
            <Sparkles className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="[overflow-wrap:anywhere]">{safety.aiReason}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** Fetches the file first so a refusal (locked) is a message, not a saved error page. */
async function saveFile(messageId: string, name: string): Promise<'ok' | 'locked'> {
  // `no-store` skips the service worker's file cache: the server must check the lock and record
  // every download of a flagged file.
  const res = await fetch(`/api/media/${encodeURIComponent(messageId)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 403) return 'locked';
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const href = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
  return 'ok';
}

/** The flagged file: checked before download, locked for agents while the risk is high. */
export function SafetyFile({ message, safety }: { message: Message; safety: MessageSafety }) {
  const { t } = useTranslation(['inbox', 'common']);
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = message.mediaName ?? t('media.document');
  const high = safety.level === 'high';

  if (safety.deletedBy !== null)
    return (
      <p
        data-testid="safety-file-deleted"
        className="flex min-h-14 items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
      >
        <FileWarning className="size-5 shrink-0" aria-hidden />
        {safety.deletedBy
          ? t('safety.file.deletedBy', { name: safety.deletedBy })
          : t('safety.file.deleted')}
      </p>
    );

  const lockedForMe = safety.locked && !admin;
  const save = async () => {
    setBusy(true);
    try {
      const result = await saveFile(message.id, name);
      setOpen(false);
      if (result === 'locked') toast.error(t('safety.file.lockedToast'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        data-testid="safety-file"
        data-locked={lockedForMe ? 'true' : 'false'}
        disabled={busy}
        onClick={() => (lockedForMe ? void save() : setOpen(true))}
        className="flex h-auto min-h-14 w-full max-w-full items-center justify-start gap-3 rounded-lg border bg-muted/60 px-3 py-2 text-left whitespace-normal hover:bg-muted"
      >
        {lockedForMe ? (
          <Lock className="size-7 shrink-0 text-danger" aria-hidden />
        ) : (
          <FileWarning
            className={cn('size-7 shrink-0', high ? 'text-danger' : 'text-warning')}
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {lockedForMe
              ? t('safety.file.locked')
              : safety.locked
                ? t('safety.file.lockedAdmin')
                : t('safety.file.check')}
          </span>
        </span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="safety-download-dialog">
          <DialogHeader>
            <DialogTitle>
              {high ? t('safety.download.highTitle') : t('safety.download.title')}
            </DialogTitle>
            <DialogDescription>
              {high ? t('safety.download.highBody') : t('safety.download.body')}
            </DialogDescription>
          </DialogHeader>
          <p className="truncate rounded-md bg-muted px-3 py-2 text-sm">{name}</p>
          <DialogFooter className="gap-2 sm:justify-between">
            {admin ? (
              <Button asChild variant="link" className="px-0">
                <Link to="/admin/safety">{t('safety.download.openReport')}</Link>
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" size="touch" onClick={() => setOpen(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button
                variant={high ? 'destructive' : 'default'}
                size="touch"
                disabled={busy}
                data-testid="safety-download-confirm"
                onClick={() => void save()}
              >
                {t('safety.download.confirm')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A bar on top of a direct chat: blocked, reported as scam, or a customer who may be hacked. */
export function SafetyChatBar({ jid }: { jid: string }) {
  const { t } = useTranslation('inbox');
  const { user } = useAuth();
  const { data } = useSafetyChat(jid);
  const action = useSafetyAction();
  if (!data?.enabled || (!data.blocked && !data.scam && !data.maybeHacked)) return null;
  const admin = user?.role === 'admin';

  if (data.maybeHacked && !data.blocked)
    return (
      <div
        data-testid="safety-chat-bar"
        data-kind="hacked"
        className="flex flex-wrap items-center gap-2 border-b border-warning/50 bg-warning/10 px-4 py-2 text-sm"
      >
        <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 flex-1">{t('safety.bar.hacked')}</span>
        <Button
          size="sm"
          variant="outline"
          className="pointer-coarse:min-h-11"
          onClick={() =>
            copyText(t('safety.bar.warnText')).then(
              () => toast.success(t('safety.bar.copied')),
              () => toast.error(t('safety.bar.copyFailed')),
            )
          }
        >
          <Copy aria-hidden />
          {t('safety.bar.copyWarning')}
        </Button>
      </div>
    );

  return (
    <div
      data-testid="safety-chat-bar"
      data-kind={data.blocked ? 'blocked' : 'scam'}
      className="flex flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm"
    >
      <Ban className="size-4 shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 flex-1">
        {data.blocked
          ? data.blocked.auto
            ? t('safety.bar.autoBlocked')
            : data.blocked.by
              ? t('safety.bar.blockedBy', { name: data.blocked.by })
              : t('safety.bar.blocked')
          : t('safety.bar.scam')}
      </span>
      {admin && data.blocked && data.itemId !== null && (
        <Button
          size="sm"
          variant="outline"
          className="pointer-coarse:min-h-11"
          disabled={action.isPending}
          onClick={() =>
            action.mutate(
              { id: data.itemId!, action: 'unblock' },
              {
                onSuccess: () => toast.success(t('safety.bar.unblocked')),
                onError: (e) => toast.error(errorMessage(e)),
              },
            )
          }
        >
          {t('safety.bar.unblock')}
        </Button>
      )}
    </div>
  );
}

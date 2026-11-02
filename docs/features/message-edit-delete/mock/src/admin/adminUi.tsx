import * as React from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

/** Props a Field hands to its control so label, hint and error are wired up for a11y. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/** Label + control + hint/error text. The control is rendered by `children(props)`. */
export function Field({
  label,
  hint,
  error,
  className,
  labelClassName,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  /** For example `sr-only` when a card title already shows the same words. */
  labelClassName?: string;
  children: (props: FieldControlProps) => React.ReactNode;
}) {
  const id = React.useId();
  const descId = `${id}-desc`;
  const hasDesc = Boolean(error || hint);
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={id} className={labelClassName}>
        {label}
      </Label>
      {children({
        id,
        'aria-describedby': hasDesc ? descId : undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {error ? (
        <p id={descId} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The one place Save lives on admin forms: right-aligned at the end of the form, full width on
 * phones, and pinned to the bottom of the screen with an "Unsaved" marker while there are edits.
 * `inset` matches the horizontal padding of the surface it sits in (page or card).
 */
export function SaveBar({
  dirty,
  inset = 'page',
  children,
}: {
  dirty: boolean;
  inset?: 'page' | 'card';
  children: React.ReactNode;
}) {
  const { t } = useTranslation('admin');
  return (
    <div
      data-dirty={dirty || undefined}
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3 [&>button]:w-full sm:[&>button]:w-auto',
        dirty && 'sticky bottom-0 z-10 border-t py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        dirty && (inset === 'card' ? '-mx-6 bg-card px-6' : '-mx-4 bg-background px-4'),
      )}
    >
      {dirty && (
        <Badge variant="outline" className="self-center">
          {t('ui.unsaved')}
        </Badge>
      )}
      {children}
    </div>
  );
}

/** Spinner shown inside a pending button. */
export function Pending({ show }: { show: boolean }) {
  return show ? <Loader2 className="animate-spin" aria-hidden /> : null;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copies `text` and confirms with a toast. */
export function CopyButton({
  text,
  label,
  variant = 'outline',
  className,
}: {
  text: string;
  label?: string;
  variant?: 'outline' | 'secondary' | 'default' | 'ghost';
  className?: string;
}) {
  const { t } = useTranslation(['admin', 'common']);
  return (
    <Button
      type="button"
      variant={variant}
      size="touch"
      className={cn('md:min-h-9', className)}
      onClick={async () => {
        if (await copyText(text)) toast.success(t('ui.copied'));
        else toast.error(t('ui.copyFailed'));
      }}
    >
      <Copy aria-hidden />
      {label ?? t('common:actions.copy')}
    </Button>
  );
}

/** AlertDialog confirmation for destructive / disruptive actions. Stays open while pending. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  loading = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !loading) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {children && (
            <AlertDialogDescription asChild>
              <div>{children}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error != null && <Banner tone="danger">{errorMessage(error)}</Banner>}
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={loading}>
            {t('actions.cancel')}
          </AlertDialogCancel>
          {/* Plain Button (not AlertDialogAction) so the dialog stays open until the mutation settles. */}
          <Button
            variant={danger ? 'destructive' : 'default'}
            className="min-h-11 sm:min-h-9"
            disabled={loading}
            onClick={onConfirm}
          >
            <Pending show={loading} />
            {confirmLabel ?? t('actions.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Generates a readable random password (no ambiguous characters). */
export function canGeneratePassword(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';
}

export function generatePassword(length = 14): string {
  // A browser without secure randomness must use a manually entered password.
  if (!canGeneratePassword()) return '';
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out: string[] = [];
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  for (let i = 0; i < length; i++) out.push(chars[(buf[i] ?? 0) % chars.length] ?? 'x');
  return out.join('');
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation(['admin', 'common']);
  return (
    <Banner
      tone="danger"
      title={t('ui.loadFailed')}
      action={
        onRetry && (
          <Button size="touch" variant="outline" className="md:min-h-8" onClick={onRetry}>
            {t('common:actions.retry')}
          </Button>
        )
      }
    >
      {errorMessage(error)}
    </Banner>
  );
}

/** Skeleton placeholder rows for lists/tables while loading. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={t('ui.loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InstallHint } from './InstallHint';
import { desktopNotificationsEnabled, isDesktopNotifications } from './desktop-notifications';
import {
  getCurrentSubscription,
  isPushSupported,
  needsInstallForPush,
  subscribePush,
  unsubscribePush,
} from './push';

type Status = 'checking' | 'unsupported' | 'install' | 'denied' | 'off' | 'on';

function initialStatus(): Status {
  if (isDesktopNotifications()) return desktopNotificationsEnabled() ? 'on' : 'off';
  if (needsInstallForPush()) return 'install';
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'checking';
}

/** The two parts of the toggle for a settings row: the switch, and what goes under the row. */
export interface PushToggleParts {
  /** Just the switch (null when this device cannot turn notifications on). */
  control: React.ReactNode;
  /** Hints and problems, shown under the whole row. */
  notes: React.ReactNode;
}

/**
 * Push-notification opt-in for the current device (place it in the user menu).
 * `compact` renders a single row suitable for menus / side bars. With `children`, it renders
 * nothing itself and hands the switch and its notes to a settings row (`labelledBy` names it).
 */
export function PushToggle({
  compact = false,
  className,
  labelledBy,
  children,
}: {
  compact?: boolean;
  className?: string;
  labelledBy?: string;
  children?: (parts: PushToggleParts) => React.ReactNode;
}) {
  const { t } = useTranslation('inbox');
  const id = useId();
  const [status, setStatus] = useState<Status>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'checking') return;
    let alive = true;
    getCurrentSubscription()
      .then(
        (sub) => alive && setStatus(sub && Notification.permission === 'granted' ? 'on' : 'off'),
      )
      .catch(() => alive && setStatus('off'));
    return () => {
      alive = false;
    };
  }, [status]);

  if (status === 'install') {
    const hint = <InstallHint className={className} force />;
    return children ? children({ control: null, notes: hint }) : hint;
  }

  if (status === 'unsupported') {
    const note = (
      <p className={cn('text-sm text-muted-foreground', className)}>{t('push.unsupported')}</p>
    );
    if (children) return children({ control: null, notes: note });
    return compact ? null : note;
  }

  const toggle = async () => {
    setError(null);
    setBusy(true);
    try {
      if (status === 'on') {
        await unsubscribePush();
        setStatus('off');
      } else {
        await subscribePush();
        setStatus('on');
      }
    } catch (e) {
      if (!isDesktopNotifications() && isPushSupported() && Notification.permission === 'denied')
        setStatus('denied');
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const on = status === 'on';
  const disabled = busy || status === 'checking' || status === 'denied';
  const Icon = on ? Bell : BellOff;

  const switchEl = (
    <Switch
      id={id}
      className="shrink-0"
      aria-label={compact ? t('push.labelDevice') : undefined}
      aria-labelledby={labelledBy}
      checked={on}
      disabled={disabled}
      aria-busy={busy || undefined}
      onCheckedChange={() => void toggle()}
      onClick={(e) => e.stopPropagation()}
      // Inside a DropdownMenu, keep Space/Enter from being treated as menu typeahead/select.
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
      }}
    />
  );
  const hasNotes = (isDesktopNotifications() && !compact) || status === 'denied' || !!error;
  const notes = hasNotes ? (
    <div className="flex flex-col gap-1.5">
      {isDesktopNotifications() && !compact && (
        <p className="text-xs text-muted-foreground">{t('push.desktopHint')}</p>
      )}
      {status === 'denied' && (
        <Banner tone="warning" className="text-xs">
          {t('push.blocked')}
        </Banner>
      )}
      {error && status !== 'denied' && (
        <Banner tone="danger" className="text-xs">
          {error}
        </Banner>
      )}
    </div>
  ) : null;

  if (children) {
    // The padded label gives the bare switch a 44 px touch target (the row heading is not clickable).
    const control = (
      <Label
        htmlFor={id}
        className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
      >
        {switchEl}
      </Label>
    );
    return children({ control, notes });
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div
        className={cn(
          'flex min-h-11 w-full items-center justify-between gap-3 rounded-md',
          !compact && 'px-1',
        )}
      >
        <Label
          htmlFor={id}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 text-sm font-medium"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{compact ? t('push.label') : t('push.labelDevice')}</span>
        </Label>
        {switchEl}
      </div>
      {notes}
    </div>
  );
}

export default PushToggle;

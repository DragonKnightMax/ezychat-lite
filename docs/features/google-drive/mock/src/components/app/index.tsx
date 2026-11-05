import * as React from 'react';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/use-media-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';

/* ---------- EmptyState ---------- */

export function EmptyState({
  illustration,
  title,
  description,
  action,
  className,
}: {
  illustration?: string;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-3 p-8 text-center', className)}
    >
      {illustration && (
        <img
          src={illustration}
          alt=""
          aria-hidden
          className="mb-1 h-32 w-auto max-w-full select-none object-contain"
        />
      )}
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

/* ---------- StatusDot ---------- */

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

const TONE_DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  muted: 'bg-muted-foreground',
};

export function StatusDot({
  tone,
  label,
  pulse,
  className,
}: {
  tone: StatusTone;
  label?: React.ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', className)}>
      <span className="relative flex size-2.5">
        {pulse && (
          <span
            className={cn(
              'absolute inline-flex size-full animate-ping rounded-full opacity-60',
              TONE_DOT[tone],
            )}
          />
        )}
        <span className={cn('relative inline-flex size-2.5 rounded-full', TONE_DOT[tone])} />
      </span>
      {label}
    </span>
  );
}

/** Maps WhatsApp / tunnel states to a tone so every screen colours them the same way. */
export function stateTone(state: string): StatusTone {
  switch (state) {
    case 'open':
    case 'running':
      return 'success';
    case 'connecting':
    case 'qr':
    case 'starting':
      return 'warning';
    case 'logged_out':
    case 'replaced':
    case 'blocked':
    case 'error':
      return 'danger';
    default:
      return 'muted';
  }
}

/* ---------- Banner ---------- */

const BANNER_TONE = {
  info: { cls: 'border-info/30 bg-info/10 text-foreground', Icon: Info, icon: 'text-info' },
  warning: {
    cls: 'border-warning/40 bg-warning/10 text-foreground',
    Icon: AlertTriangle,
    icon: 'text-warning',
  },
  danger: {
    cls: 'border-danger/30 bg-danger/10 text-foreground',
    Icon: OctagonAlert,
    icon: 'text-danger',
  },
} as const;

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof BANNER_TONE;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const t = BANNER_TONE[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm',
        t.cls,
        className,
      )}
    >
      <t.Icon className={cn('mt-0.5 size-4 shrink-0', t.icon)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'text-muted-foreground')}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* ---------- ResponsiveDialog: Dialog on >= sm, bottom Drawer on phones ---------- */

export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'default',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * `wide` gives long-form editing (documents, previews) room on desktop; `medium` suits side-by-side
   * text such as a before/after review. Phones always use the drawer.
   */
  size?: 'default' | 'medium' | 'wide';
}) {
  const desktop = useMediaQuery('(min-width: 640px)');
  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            size === 'wide' ? 'sm:max-w-4xl' : size === 'medium' ? 'sm:max-w-2xl' : undefined
          }
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {/* min-w-0: a grid item may otherwise grow to its content's width and scroll sideways. */}
          <div className="min-w-0">{children}</div>
          {footer && <DialogFooter>{footer}</DialogFooter>}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="safe-bottom">
        {/* Left-aligned like the desktop dialog (the drawer centres bottom sheets by default). */}
        <DrawerHeader className="text-left group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
          <DrawerTitle>{title}</DrawerTitle>
          {description && <DrawerDescription>{description}</DrawerDescription>}
        </DrawerHeader>
        <div className="max-h-[70dvh] overflow-y-auto px-4">{children}</div>
        {footer && <DrawerFooter>{footer}</DrawerFooter>}
      </DrawerContent>
    </Drawer>
  );
}

/* ---------- Credits / About (separate modules) ---------- */

export { AppCredits } from './AppCredits';
export { AboutDialog } from './AboutDialog';
export { SegmentedControl, type SegmentedOption } from './SegmentedControl';

/* ---------- PageHeader ---------- */

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-base leading-relaxed text-muted-foreground md:text-sm">
            {description}
          </p>
        )}
      </div>
      {/* Actions sit top-right beside the title on wider screens and wrap below it on phones. */}
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------- ResponsiveList: table on lg+, stacked cards below ---------- */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Hide this column in the stacked mobile card (e.g. redundant with the title). */
  hideOnMobile?: boolean;
  /** Hide this column in one row's mobile card, e.g. when that row has nothing to show. */
  hideOnMobileFor?: (row: T) => boolean;
  className?: string;
}

export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  empty,
  renderMobileRow,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  empty?: React.ReactNode;
  /** A compact feature-specific card; desktop columns stay unchanged. */
  renderMobileRow?: (row: T) => React.ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border bg-card lg:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={cn('px-3 py-2 font-medium', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-t">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn('[overflow-wrap:anywhere] px-3 py-2 align-middle', c.className)}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-2 lg:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="rounded-lg border bg-card p-3 text-sm">
            {renderMobileRow ? (
              renderMobileRow(r)
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                {columns
                  .filter((c) => !c.hideOnMobile && !c.hideOnMobileFor?.(r))
                  .map((c) => (
                    <React.Fragment key={c.key}>
                      <dt className="text-muted-foreground">{c.header}</dt>
                      <dd className="min-w-0 break-words">{c.cell(r)}</dd>
                    </React.Fragment>
                  ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// Visual building blocks of the Lite → Enterprise screens (confirmed mock, round 2: icon tiles, a
// Lite → Enterprise figure and short words).
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Circle,
  Loader2,
  Smartphone,
  XCircle,
} from 'lucide-react';
import type { LiteImportMode, LiteImportStep } from '@ezychat/shared';
import { cn } from '@/lib/utils';

export type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
type Tone = 'primary' | 'warning' | 'success';

export function IconBubble({ icon: I, tone = 'primary' }: { icon: Icon; tone?: Tone }) {
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full',
        tone === 'primary' && 'bg-primary/10 text-primary',
        tone === 'warning' && 'bg-warning/10 text-warning',
        tone === 'success' && 'bg-success/10 text-success',
      )}
    >
      <I className="size-5" aria-hidden />
    </span>
  );
}

export interface Tile {
  icon: Icon;
  value: ReactNode;
  label: string;
}

/** Icon tiles: one number or word each, with a short label under it. */
export function Tiles({ items }: { items: Tile[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map((x) => (
        <li
          key={x.label}
          className="flex min-w-0 flex-col items-start gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-3"
        >
          <IconBubble icon={x.icon} />
          <span className="flex max-w-full min-w-0 flex-col">
            <span className="font-semibold leading-tight break-all">{x.value}</span>
            <span className="text-xs break-words text-muted-foreground">{x.label}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One line with an icon in front. */
export function IconLine({
  icon: I,
  tone,
  children,
}: {
  icon: Icon;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-sm">
      <I className={cn('mt-0.5 size-4 shrink-0', tone ?? 'text-muted-foreground')} aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

/** The figure: EzyChat Lite → this product, with what happens to the number. */
export function MoveFigure({ number, mode }: { number: string | null; mode: LiteImportMode }) {
  const { t } = useTranslation('admin');
  const box = (icon: Icon, title: string, sub: string) => (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg border bg-card p-3 text-center">
      <IconBubble icon={icon} />
      <span className="font-semibold leading-tight">{title}</span>
      <span className="text-xs break-words text-muted-foreground">{sub}</span>
    </div>
  );
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="lite-figure">
      {box(Smartphone, t('liteImport.fig.lite'), number ?? t('liteImport.fig.noNumber'))}
      <ArrowRight className="size-5 shrink-0 text-primary" aria-hidden />
      {box(
        Building2,
        t('liteImport.fig.enterprise'),
        mode === 'merge' ? t('liteImport.fig.newInbox') : t('liteImport.fig.sameInbox'),
      )}
    </div>
  );
}

/** The import steps the desktop reports, each with its state. */
export function StepList({ steps }: { steps: LiteImportStep[] }) {
  const { t } = useTranslation('admin');
  return (
    <ul className="flex flex-col gap-2 text-sm" data-testid="lite-steps">
      {steps.map((s) => (
        <li key={s.id} className="flex min-w-0 items-start gap-2" data-state={s.state}>
          {s.state === 'done' && (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          {s.state === 'running' && (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden />
          )}
          {s.state === 'waiting' && (
            <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          {s.state === 'failed' && (
            <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          )}
          <span
            className={cn('min-w-0 break-words', s.state === 'waiting' && 'text-muted-foreground')}
          >
            {t(`liteImport.run.${s.id}`)}
            {s.state === 'running' && s.progress !== null && ` ${Math.round(s.progress * 100)}%`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 0..100 for the progress bar: finished steps plus the running copy's share. */
export function stepsPercent(steps: LiteImportStep[]): number {
  if (steps.length === 0) return 0;
  const done = steps.reduce(
    (n, s) => n + (s.state === 'done' ? 1 : s.state === 'running' ? (s.progress ?? 0) : 0),
    0,
  );
  return Math.round((done / steps.length) * 100);
}

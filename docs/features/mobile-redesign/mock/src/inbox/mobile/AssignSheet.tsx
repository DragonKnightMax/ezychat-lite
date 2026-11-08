// Proposed (mobile-redesign): choose who handles a chat from a bottom sheet (big rows, "You" first),
// instead of the narrow select that truncates "Unassigned" to "Unassig…" in the phone header.
import { useTranslation } from 'react-i18next';
import { Bot, Check, UserRound, UserX } from 'lucide-react';
import { ResponsiveDialog } from '@/components/app';
import { cn } from '@/lib/utils';
import type { Directory } from '../useDirectory';

export function AssignSheet({
  open,
  onOpenChange,
  directory,
  value,
  onAssign,
}: Readonly<{
  open: boolean;
  onOpenChange(open: boolean): void;
  directory: Directory;
  value: number | null;
  onAssign(userId: number | null): void;
}>) {
  const { t } = useTranslation('inbox');
  const me = directory.me?.id;
  const people = [...directory.assignable].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : 0));
  const row = (
    key: string,
    selected: boolean,
    icon: React.ReactNode,
    label: string,
    pick: () => void,
  ) => (
    <button
      key={key}
      type="button"
      aria-pressed={selected}
      onClick={() => {
        pick();
        onOpenChange(false);
      }}
      className={cn(
        'flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'bg-accent text-accent-foreground' : 'active:bg-muted',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Check
        aria-hidden
        className={cn('size-5 shrink-0 text-primary', selected ? 'visible' : 'invisible')}
      />
    </button>
  );
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={t('header.assignedTo')}>
      <div className="space-y-0.5 pb-3" data-testid="assign-sheet">
        {people.map((u) =>
          row(
            String(u.id),
            value === u.id,
            u.kind === 'ai' ? (
              <Bot className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <UserRound className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            ),
            u.id === me
              ? t('header.you', { name: u.displayName })
              : u.kind === 'ai'
                ? t('header.ai', { name: u.displayName })
                : u.displayName,
            () => onAssign(u.id),
          ),
        )}
        {row(
          'none',
          value == null,
          <UserX className="size-5 shrink-0 text-muted-foreground" aria-hidden />,
          t('header.unassigned'),
          () => onAssign(null),
        )}
      </div>
    </ResponsiveDialog>
  );
}

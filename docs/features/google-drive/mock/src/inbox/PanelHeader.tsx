import type React from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Header of the conversation side panels (Customer, Notes): icon + title, optional action, Close,
 * and the one-line description inside the same bordered block. Panels use `px-4` throughout.
 */
export function PanelHeader({
  icon,
  title,
  description,
  action,
  closeLabel,
  onClose,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
  closeLabel: string;
  onClose(): void;
}) {
  return (
    <div className="border-b pb-2.5 pl-4 pr-1.5 pt-1">
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-sm font-semibold">
          {icon}
          {title}
        </div>
        {action}
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label={closeLabel}
          onClick={onClose}
          className="shrink-0 text-muted-foreground"
        >
          <X className="size-5" aria-hidden="true" />
        </Button>
      </div>
      <div className="pr-2.5 text-xs text-muted-foreground">{description}</div>
    </div>
  );
}

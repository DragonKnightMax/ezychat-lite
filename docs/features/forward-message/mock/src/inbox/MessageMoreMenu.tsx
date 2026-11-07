import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EllipsisVertical, Forward, Loader2 } from 'lucide-react';
import { formatSize } from '../mock/forward';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Proposed (forward-message): the ⋮ button next to a message (hover or focus on desktop, like Reply;
 * touch screens reach Forward from the press-and-hold bar). This mock predates the app's ⋮ menu
 * (`MessageMoreMenu` in apps/web, with Edit and Delete): the app adds **Forward** as that menu's first
 * item and shows ⋮ for every message that can be forwarded.
 */
export function MessageMoreMenu({
  onForward,
  forwardDisabledReason,
}: Readonly<{ onForward(): void; forwardDisabledReason: string | null }>) {
  const { t } = useTranslation('inbox');
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('mockForward.more')}
          title={t('mockForward.more')}
          data-testid="message-more"
          className={cn(
            'size-8 shrink-0 rounded-full text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:not-focus-visible:sr-only',
            open && 'opacity-100',
          )}
        >
          <EllipsisVertical aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          disabled={!!forwardDisabledReason}
          onSelect={onForward}
          className="min-h-11 md:min-h-8"
          data-testid="message-forward"
        >
          <Forward aria-hidden="true" />
          <span className="flex flex-col">
            {t('mockForward.action')}
            {forwardDisabledReason && (
              <span className="text-xs text-muted-foreground">{forwardDisabledReason}</span>
            )}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Proposed (forward-message): the "Forwarded" line at the top of a bubble, as WhatsApp shows it. */
export function ForwardedLabel({ mark }: Readonly<{ mark: 'once' | 'many' }>) {
  const { t } = useTranslation('inbox');
  return (
    <p
      className="mb-0.5 flex items-center gap-1 text-xs italic text-muted-foreground"
      data-testid="forwarded-label"
    >
      <Forward className="size-3.5 shrink-0" aria-hidden="true" />
      {mark === 'many' ? t('mockForward.forwardedMany') : t('mockForward.forwarded')}
    </p>
  );
}

/** Proposed (forward-message): a large copy still uploading to WhatsApp (pending in the send queue). */
export function SendingLarge({ size }: Readonly<{ size: number }>) {
  const { t } = useTranslation('inbox');
  return (
    <p
      className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"
      role="status"
      data-testid="forward-sending-large"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
      {t('mockForward.sendingLarge', { size: formatSize(size) })}
    </p>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useMessageChanges, useMessageChangeSimulator } from './useMessageChanges';
import { setMockWaOffline } from './useSendReaction';

const ACTIONS = ['customerEdit', 'customerDelete', 'phoneEdit', 'phoneDelete'] as const;
const CLOCK = [
  [0, 'm0'],
  [20, 'm20'],
  [3 * 24 * 60, 'm4320'],
] as const;

/**
 * Proposed (message-edit-delete): mock-only panel. WhatsApp reports an edit or delete from the
 * customer or from the linked phone (Baileys `MESSAGE_EDIT` / `REVOKE`); the clock moves the mock
 * past the 15-minute edit and 2-day delete windows. The real app has no such panel.
 */
export function EditDeleteSimulator({ chatJid }: { chatJid: string }) {
  const { t } = useTranslation('inbox');
  const sim = useMessageChangeSimulator();
  const offset = useMessageChanges().data?.offsetMinutes ?? 0;
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const button = (key: string, label: string, fn: () => Promise<unknown>, pressed?: boolean) => (
    <Button
      key={key}
      variant="outline"
      size="sm"
      disabled={busy}
      aria-pressed={pressed}
      className="min-h-11 aria-pressed:bg-accent md:pointer-fine:min-h-8"
      onClick={() => void run(fn)}
    >
      {label}
    </Button>
  );
  return (
    <details
      className="mx-3 mt-3 rounded-lg border border-dashed px-3 py-2 text-sm md:mx-4"
      data-testid="mock-edit-delete"
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 md:pointer-fine:min-h-8">
        <Badge variant="outline">{t('mockEditDelete.proposed')}</Badge>
        <span className="font-medium">{t('mockEditDelete.title')}</span>
      </summary>
      <div className="space-y-2 pt-2">
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((a) =>
            button(a, t(`mockEditDelete.actions.${a}`), () => sim.simulate(chatJid, a)),
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('mockEditDelete.clock')}</p>
        <div className="flex flex-wrap gap-2">
          {CLOCK.map(([minutes, key]) =>
            button(
              `clock-${minutes}`,
              t(`mockEditDelete.clockOptions.${key}`),
              () => sim.clock(minutes),
              offset === minutes,
            ),
          )}
        </div>
        <div className="flex flex-wrap gap-2 border-t pt-2">
          {button('offline', t('mockEditDelete.phoneOffline'), () => setMockWaOffline(true))}
          {button('online', t('mockEditDelete.phoneOnline'), () => setMockWaOffline(false))}
          {button('reset', t('mockEditDelete.reset'), () => sim.reset())}
        </div>
      </div>
    </details>
  );
}

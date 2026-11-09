import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useSafetyChat, useSafetyChatAction } from '../api/safety';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

/**
 * Admins: block or unblock a direct chat's number on WhatsApp from the Customer panel, for any chat
 * (spam, harassment), not only one WhatsApp Safety flagged. Blocking can also mark the number as spam.
 */
export function BlockNumber({ jid }: { jid: string }) {
  const { t } = useTranslation('inbox');
  const { user } = useAuth();
  const { data } = useSafetyChat(jid);
  const action = useSafetyChatAction(jid);
  const [confirm, setConfirm] = useState(false);
  const [spam, setSpam] = useState(true);
  const spamId = useId();
  if (user?.role !== 'admin' || !data) return null;

  const run = (kind: 'block' | 'unblock') =>
    action.mutate(
      { action: kind, spam },
      {
        onSuccess: () => {
          setConfirm(false);
          toast.success(t(kind === 'block' ? 'block.done' : 'safety.bar.unblocked'));
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <section
      aria-label={t('block.title')}
      data-testid="block-number"
      className="space-y-2 rounded-lg border border-danger/30 px-3 py-2 text-sm"
    >
      {data.blocked ? (
        <>
          <p className="flex items-center gap-2 text-danger">
            <Ban className="size-4 shrink-0" aria-hidden="true" />
            {t('block.isBlocked')}
          </p>
          <Button
            variant="outline"
            size="touch"
            className="w-full md:min-h-9"
            disabled={action.isPending}
            onClick={() => run('unblock')}
          >
            {action.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('safety.bar.unblock')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('block.hint')}</p>
          <Button
            variant="outline"
            size="touch"
            className="w-full border-danger/40 text-danger hover:bg-danger/10 hover:text-danger md:min-h-9"
            disabled={!data.canBlock || action.isPending}
            onClick={() => setConfirm(true)}
          >
            <Ban aria-hidden="true" />
            {t('block.button')}
          </Button>
          {!data.canBlock && <p className="text-xs text-muted-foreground">{t('block.cannot')}</p>}
        </>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('block.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('block.confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start gap-3">
            <Checkbox
              id={spamId}
              checked={spam}
              className="mt-0.5 size-5"
              onCheckedChange={(v) => setSpam(v === true)}
            />
            <Label htmlFor={spamId} className="block font-normal leading-snug">
              {t('block.spam')}
              <span className="block text-xs text-muted-foreground">{t('block.spamHint')}</span>
            </Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.isPending}>
              {t('customer.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={action.isPending}
              onClick={(e) => {
                // Stay open until the server answers.
                e.preventDefault();
                run('block');
              }}
            >
              {action.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('block.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

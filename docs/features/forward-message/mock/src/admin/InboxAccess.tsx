import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { User } from '@ezychat/shared';
import { ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { InboxChip } from '../inbox/InboxChip';
import { setAccess, useMockInboxes } from '../mock/inboxes';

/**
 * Proposed (multi-inbox): which inboxes a member may open. Admins always see every inbox; an agent sees
 * only the chats (and notifications) of the inboxes ticked here.
 */
export function InboxAccessCell({ user }: Readonly<{ user: User }>) {
  const { t } = useTranslation('admin');
  const state = useMockInboxes();
  const [editing, setEditing] = useState(false);
  if (user.kind === 'ai') return <span className="text-sm text-muted-foreground">—</span>;
  if (user.role === 'admin')
    return <span className="text-sm text-muted-foreground">{t('mockInbox.membersAccessAll')}</span>;
  const ids = state.access[user.id];
  const mine = state.inboxes.filter((i) => Array.isArray(ids) && ids.includes(i.id));
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="inbox-access">
      {mine.length === 0 ? (
        <span className="text-sm text-warning">{t('mockInbox.membersAccessNone')}</span>
      ) : (
        mine.map((i) => <InboxChip key={i.id} inbox={i} />)
      )}
      <Button
        type="button"
        variant="ghost"
        size="touch"
        className="px-2 md:min-h-8"
        aria-label={t('mockInbox.membersAccessTitle', { name: user.displayName })}
        onClick={() => setEditing(true)}
      >
        {t('mockInbox.edit')}
      </Button>
      <InboxAccessDialog user={user} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}

function InboxAccessDialog({
  user,
  open,
  onClose,
}: Readonly<{ user: User; open: boolean; onClose: () => void }>) {
  const { t } = useTranslation(['admin', 'common']);
  const state = useMockInboxes();
  const current = state.access[user.id];
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (open) setPicked(Array.isArray(current) ? current : []);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => (on ? [...new Set([...p, id])] : p.filter((x) => x !== id)));
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('mockInbox.membersAccessTitle', { name: user.displayName })}
      description={t('mockInbox.membersAccessDescription')}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="sm:min-h-9"
            onClick={onClose}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            size="touch"
            className="sm:min-h-9"
            onClick={() => {
              setAccess(user.id, picked);
              toast.success(t('mockInbox.membersAccessSaved'));
              onClose();
            }}
          >
            {t('mockInbox.membersAccessSave')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-1">
        {state.inboxes.map((inbox) => {
          const id = `access-${user.id}-${inbox.id}`;
          return (
            <div key={inbox.id} className="flex items-center gap-3">
              <Checkbox
                id={id}
                checked={picked.includes(inbox.id)}
                onCheckedChange={(v) => toggle(inbox.id, v === true)}
              />
              <Label htmlFor={id} className="flex flex-wrap items-center gap-2 font-normal">
                <InboxChip inbox={inbox} />
                <span className="text-sm text-muted-foreground tabular-nums">{inbox.number}</span>
              </Label>
            </div>
          );
        })}
      </div>
    </ResponsiveDialog>
  );
}

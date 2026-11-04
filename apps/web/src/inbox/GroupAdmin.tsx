import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Link2,
  Loader2,
  Pencil,
  Settings2,
  ShieldCheck,
  ShieldOff,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  GroupAdminCaps,
  GroupAdminResponse,
  GroupInfoResponse,
  GroupMember,
} from '@ezychat/shared';
import {
  useGroupJoinRequest,
  useRemoveGroupMember,
  useSetGroupMemberAdmin,
} from '../api/group-admin';
import { Banner } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  AddMemberDialog,
  EditGroupDialog,
  GroupSettingsDialog,
  InviteLinkDialog,
} from './GroupAdminDialogs';
import { groupAdminErrorText, othersCount, useGroupAdminState } from './GroupAdminShared';

/**
 * Manage group (design docs/features/group-management/design.md): EzyChat admins change a WhatsApp
 * group from Group info, with only the actions this connection supports (`caps`, never a type
 * name) while the linked number is a group admin; agents and non-admin numbers see why they can't.
 */
export function GroupAdminBar({ data }: Readonly<{ data: GroupInfoResponse }>) {
  const { t } = useTranslation('inbox');
  const jid = data.group.jid;
  const { view, anyCap, block, can } = useGroupAdminState(jid);
  const [open, setOpen] = useState<null | 'edit' | 'add' | 'link' | 'settings'>(null);
  if (!view || !anyCap) return null;
  const { caps } = view;
  const others = othersCount(view, data.group.size);
  const full = caps.maxMembers !== null && others >= caps.maxMembers;
  const manager = view.canManage && block !== 'notAdmin';

  return (
    <section
      className="mx-4 mt-2 space-y-2"
      aria-label={t('groupAdmin.title')}
      data-testid="group-admin"
    >
      {block === 'agent' && (
        <p className="text-xs text-muted-foreground" data-testid="group-admin-readonly">
          {t('groupAdmin.agentOnly')}
        </p>
      )}
      {block === 'notAdmin' && (
        <Banner tone="warning" title={t('groupAdmin.notAdminTitle')}>
          {t('groupAdmin.notAdminBody')}
        </Banner>
      )}
      {block === 'offline' && <Banner tone="warning">{t('groupAdmin.offline')}</Banner>}
      {manager && caps.inviteOnly && (
        <p className="text-xs text-muted-foreground" data-testid="invite-only-note">
          {caps.maxMembers !== null
            ? t('groupAdmin.inviteOnly', { max: caps.maxMembers, n: others })
            : t('groupAdmin.inviteOnlyNoMax')}
        </p>
      )}
      {manager && (
        <div className="grid grid-cols-2 gap-1.5">
          {caps.editInfo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={!can}
              onClick={() => setOpen('edit')}
            >
              <Pencil aria-hidden="true" />
              {t('groupAdmin.edit')}
            </Button>
          )}
          {caps.addMembers && !caps.inviteOnly && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={!can}
              onClick={() => setOpen('add')}
            >
              <UserPlus aria-hidden="true" />
              {t('groupAdmin.add')}
            </Button>
          )}
          {caps.inviteLink && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={!can}
              onClick={() => setOpen('link')}
            >
              <Link2 aria-hidden="true" />
              {caps.inviteOnly ? t('groupAdmin.invite') : t('groupAdmin.link')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={!can}
            onClick={() => setOpen('settings')}
          >
            <Settings2 aria-hidden="true" />
            {t('groupAdmin.settings')}
          </Button>
        </div>
      )}
      {manager && full && can && (
        <p className="text-xs text-warning">
          {t('groupAdmin.full', { max: caps.maxMembers ?? 0 })}
        </p>
      )}
      {manager && caps.joinRequests && view.requests.length > 0 && (
        <JoinRequests jid={jid} view={view} disabled={!can || full} />
      )}
      {open === 'edit' && (
        <EditGroupDialog jid={jid} data={data} view={view} onClose={() => setOpen(null)} />
      )}
      {open === 'add' && <AddMemberDialog jid={jid} onClose={() => setOpen(null)} />}
      {open === 'link' && <InviteLinkDialog jid={jid} view={view} onClose={() => setOpen(null)} />}
      {open === 'settings' && (
        <GroupSettingsDialog jid={jid} view={view} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

function JoinRequests({
  jid,
  view,
  disabled,
}: Readonly<{
  jid: string;
  view: GroupAdminResponse;
  disabled: boolean;
}>) {
  const { t } = useTranslation('inbox');
  const decide = useGroupJoinRequest(jid);
  return (
    <section className="rounded-lg border bg-muted/40 px-3 py-2" data-testid="join-requests">
      <h4 className="text-xs font-semibold">
        {t('groupAdmin.requests', { count: view.requests.length })}
      </h4>
      <ul className="mt-1 divide-y">
        {view.requests.map((r) => {
          const number = r.phone ? `+${r.phone}` : null;
          const name = r.name ?? number ?? r.jid;
          return (
            <li key={r.jid} className="flex flex-wrap items-center gap-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p
                  className={
                    r.name
                      ? 'text-sm [overflow-wrap:anywhere]'
                      : 'text-sm whitespace-nowrap tabular-nums'
                  }
                >
                  {name}
                </p>
                {r.name && number && (
                  <p className="text-xs text-muted-foreground tabular-nums">{number}</p>
                )}
              </div>
              <div className="ml-auto flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  disabled={disabled || decide.isPending}
                  onClick={() =>
                    decide.mutate(
                      { member: r.jid, approve: true },
                      {
                        onSuccess: () => toast.success(t('groupAdmin.approved', { name })),
                        onError: (e) => toast.error(groupAdminErrorText(e, t)),
                      },
                    )
                  }
                >
                  {t('groupAdmin.approve')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11 sm:min-h-8"
                  disabled={disabled || decide.isPending}
                  onClick={() =>
                    decide.mutate(
                      { member: r.jid, approve: false },
                      { onError: (e) => toast.error(groupAdminErrorText(e, t)) },
                    )
                  }
                >
                  {t('groupAdmin.reject')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Member details: make / remove group admin and remove from the group. Never for me. */
export function MemberAdminActions({
  groupJid,
  member,
  label,
  onRemoved,
}: Readonly<{
  groupJid: string;
  member: GroupMember;
  label: string;
  onRemoved(): void;
}>) {
  const { t } = useTranslation('inbox');
  const { view, block, can } = useGroupAdminState(groupJid);
  const role = useSetGroupMemberAdmin(groupJid);
  const remove = useRemoveGroupMember(groupJid);
  const [confirm, setConfirm] = useState<null | 'remove' | 'demote'>(null);
  const headingId = useId();
  if (!view || member.isMe || (block !== null && block !== 'offline')) return null;
  const { caps } = view;
  if (!caps.admins && !caps.removeMembers) return null;
  const owner = member.role === 'superadmin';
  // The WhatsApp ID when known: a stale list must never act on a recycled number's new owner.
  const target = member.lid ?? member.jid;
  const busy = role.isPending || remove.isPending;

  const setAdmin = (admin: boolean) =>
    role.mutate(
      { member: target, admin },
      {
        onSuccess: () => {
          toast.success(t(admin ? 'groupAdmin.promoted' : 'groupAdmin.demoted', { name: label }));
          setConfirm(null);
        },
        onError: (e) => toast.error(groupAdminErrorText(e, t)),
      },
    );
  const removeMember = () =>
    remove.mutate(target, {
      onSuccess: () => {
        toast.success(t('groupAdmin.removed', { name: label }));
        setConfirm(null);
        onRemoved();
      },
      onError: (e) => toast.error(groupAdminErrorText(e, t)),
    });

  let confirmBody = t('groupAdmin.demoteBody');
  if (confirm === 'remove')
    confirmBody = t(caps.inviteOnly ? 'groupAdmin.removeBodyApi' : 'groupAdmin.removeBody');

  return (
    <section
      className="space-y-2 border-t pt-3"
      aria-labelledby={headingId}
      data-testid="member-admin"
    >
      <div className="flex items-center gap-1">
        <h4 id={headingId} className="text-xs font-semibold text-muted-foreground">
          {t('groupAdmin.memberActions')}
        </h4>
        <InfoTip title={t('groupAdmin.tipTitle')} body={t('groupAdmin.tipBody')} />
      </div>
      {owner ? (
        <p className="text-xs text-muted-foreground">{t('groupAdmin.ownerNote')}</p>
      ) : (
        <MemberActionButtons
          caps={caps}
          isMember={member.role === 'member'}
          disabled={!can || busy}
          promoting={role.isPending}
          onPromote={() => setAdmin(true)}
          onConfirm={setConfirm}
        />
      )}
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="[overflow-wrap:anywhere]">
              {confirm === 'remove'
                ? t('groupAdmin.removeTitle', { name: label })
                : t('groupAdmin.demoteTitle', { name: label })}
            </AlertDialogTitle>
            <AlertDialogDescription>{confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={busy}>
              {t('groupAdmin.cancel')}
            </AlertDialogCancel>
            <Button
              type="button"
              variant={confirm === 'remove' ? 'destructive' : 'default'}
              className="min-h-11 sm:min-h-9"
              disabled={busy}
              onClick={() => (confirm === 'remove' ? removeMember() : setAdmin(false))}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {confirm === 'remove' ? t('groupAdmin.removeConfirm') : t('groupAdmin.demoteConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** Make / remove group admin and Remove from group for one member (never the creator). */
function MemberActionButtons({
  caps,
  isMember,
  disabled,
  promoting,
  onPromote,
  onConfirm,
}: Readonly<{
  caps: GroupAdminCaps;
  isMember: boolean;
  disabled: boolean;
  promoting: boolean;
  onPromote(): void;
  onConfirm(kind: 'remove' | 'demote'): void;
}>) {
  const { t } = useTranslation('inbox');
  const roleIcon = promoting ? (
    <Loader2 className="animate-spin" aria-hidden="true" />
  ) : (
    <ShieldCheck aria-hidden="true" />
  );
  return (
    <>
      {caps.admins && isMember && (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="w-full"
          disabled={disabled}
          onClick={onPromote}
        >
          {roleIcon}
          {t('groupAdmin.makeAdmin')}
        </Button>
      )}
      {caps.admins && !isMember && (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="w-full"
          disabled={disabled}
          onClick={() => onConfirm('demote')}
        >
          <ShieldOff aria-hidden="true" />
          {t('groupAdmin.removeAdmin')}
        </Button>
      )}
      {caps.removeMembers && (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="w-full text-danger"
          disabled={disabled}
          onClick={() => onConfirm('remove')}
        >
          <UserMinus aria-hidden="true" />
          {t('groupAdmin.remove')}
        </Button>
      )}
    </>
  );
}

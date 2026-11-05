import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  History,
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
import type { GroupInfoResponse, GroupMember } from '@ezychat/shared';
import { ApiError, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Banner, SegmentedControl } from '@/components/app';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '../lib/format';
import {
  type GroupAdminView,
  type GroupSettings,
  useAddMember,
  useEditGroup,
  useGroupAdmin,
  useGroupSettings,
  useJoinRequest,
  useMockSwitch,
  useRemoveMember,
  useResetInvite,
  useSendInvite,
  useSetMemberAdmin,
} from '../mock/groupAdmin';

/**
 * Proposed (group-management): manage a WhatsApp group from Group info. Admins of EzyChat see the
 * actions the connection supports (`caps`, never a type name) while the linked number is a group
 * admin; agents and non-admin numbers see why they can't. Mock only: ../mock/groupAdmin.ts.
 */

type T = ReturnType<typeof useTranslation<'inbox'>>['t'];

/** Known refusals in plain words; anything else falls back to the app's own error text. */
function failText(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const known: Record<string, string> = {
      wa_unavailable: 'mockGroupAdmin.err.offline',
      not_group_admin: 'mockGroupAdmin.err.notAdmin',
      already_member: 'mockGroupAdmin.err.already',
      not_on_whatsapp: 'mockGroupAdmin.err.notOnWhatsApp',
      too_many_adds: 'mockGroupAdmin.err.tooMany',
      cannot_remove_owner: 'mockGroupAdmin.err.owner',
      not_supported: 'mockGroupAdmin.err.notSupported',
    };
    const k = known[err.code];
    if (k) return t(k as never);
  }
  return errorMessage(err);
}

/** Whether this user may change the group now, and if not, the one reason shown. */
export function useCanManage(jid: string) {
  const { isAdmin } = useAuth();
  const q = useGroupAdmin(jid);
  const v = q.data;
  const reason: 'agent' | 'notAdmin' | 'offline' | null = !v
    ? null
    : !isAdmin
      ? 'agent'
      : v.myRole === 'member'
        ? 'notAdmin'
        : v.offline
          ? 'offline'
          : null;
  return { view: v, isAdmin, can: !!v && reason === null, reason };
}

/** Group info header: the actions row, join requests and the reasons nothing can be changed. */
export function GroupAdminBar({ data }: { data: GroupInfoResponse }) {
  const { t } = useTranslation('inbox');
  const jid = data.group.jid;
  const { view, isAdmin, can, reason } = useCanManage(jid);
  const [open, setOpen] = useState<null | 'edit' | 'add' | 'link' | 'settings'>(null);
  if (!view) return null;
  const { caps } = view;
  const full = caps.maxMembers !== null && view.members >= caps.maxMembers;

  return (
    <section
      className="mx-4 mt-2 space-y-2"
      aria-label={t('mockGroupAdmin.title')}
      data-testid="group-admin"
    >
      {reason === 'agent' && (
        <p className="text-xs text-muted-foreground">{t('mockGroupAdmin.agentOnly')}</p>
      )}
      {reason === 'notAdmin' && (
        <Banner tone="warning" title={t('mockGroupAdmin.notAdminTitle')}>
          {t('mockGroupAdmin.notAdminBody')}
        </Banner>
      )}
      {reason === 'offline' && <Banner tone="warning">{t('mockGroupAdmin.offline')}</Banner>}
      {isAdmin && caps.inviteOnly && reason !== 'notAdmin' && (
        <p className="text-xs text-muted-foreground" data-testid="invite-only-note">
          {t('mockGroupAdmin.inviteOnly', { max: caps.maxMembers ?? 0, count: view.members })}
        </p>
      )}
      {isAdmin && reason !== 'notAdmin' && (
        <div className="grid grid-cols-2 gap-1.5">
          {caps.editInfo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!can}
              onClick={() => setOpen('edit')}
            >
              <Pencil aria-hidden="true" />
              {t('mockGroupAdmin.edit')}
            </Button>
          )}
          {caps.addMembers ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!can}
              onClick={() => setOpen('add')}
            >
              <UserPlus aria-hidden="true" />
              {t('mockGroupAdmin.add')}
            </Button>
          ) : null}
          {caps.inviteLink && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!can}
              onClick={() => setOpen('link')}
            >
              <Link2 aria-hidden="true" />
              {caps.inviteOnly ? t('mockGroupAdmin.invite') : t('mockGroupAdmin.link')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!can}
            onClick={() => setOpen('settings')}
          >
            <Settings2 aria-hidden="true" />
            {t('mockGroupAdmin.settings')}
          </Button>
        </div>
      )}
      {isAdmin && full && can && (
        <p className="text-xs text-warning">
          {t('mockGroupAdmin.full', { max: caps.maxMembers ?? 0 })}
        </p>
      )}
      {isAdmin && view.requests.length > 0 && reason !== 'notAdmin' && (
        <JoinRequests jid={jid} view={view} disabled={!can || full} />
      )}
      {open === 'edit' && (
        <EditDialog jid={jid} data={data} view={view} onClose={() => setOpen(null)} />
      )}
      {open === 'add' && <AddDialog jid={jid} onClose={() => setOpen(null)} />}
      {open === 'link' && <LinkDialog jid={jid} view={view} onClose={() => setOpen(null)} />}
      {open === 'settings' && (
        <SettingsDialog jid={jid} view={view} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

function JoinRequests({
  jid,
  view,
  disabled,
}: {
  jid: string;
  view: GroupAdminView;
  disabled: boolean;
}) {
  const { t } = useTranslation('inbox');
  const decide = useJoinRequest(jid);
  return (
    <section className="rounded-lg border bg-muted/40 px-3 py-2" data-testid="join-requests">
      <h4 className="text-xs font-semibold">
        {t('mockGroupAdmin.requests', { count: view.requests.length })}
      </h4>
      <ul className="mt-1 divide-y">
        {view.requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{r.name}</p>
              <p className="text-xs text-muted-foreground tabular-nums">+{r.phone}</p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={disabled || decide.isPending}
              onClick={() =>
                decide.mutate(
                  { id: r.id, approve: true },
                  {
                    onSuccess: () => toast.success(t('mockGroupAdmin.approved', { name: r.name })),
                    onError: (e) => toast.error(failText(e, t)),
                  },
                )
              }
            >
              {t('mockGroupAdmin.approve')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || decide.isPending}
              onClick={() =>
                decide.mutate(
                  { id: r.id, approve: false },
                  { onError: (e) => toast.error(failText(e, t)) },
                )
              }
            >
              {t('mockGroupAdmin.reject')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EditDialog({
  jid,
  data,
  view,
  onClose,
}: {
  jid: string;
  data: GroupInfoResponse;
  view: GroupAdminView;
  onClose(): void;
}) {
  const { t } = useTranslation('inbox');
  const nameId = useId();
  const descId = useId();
  const edit = useEditGroup(jid);
  const [name, setName] = useState(data.group.name ?? '');
  const [desc, setDesc] = useState(data.group.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const max = view.caps.nameMax;
  const changed =
    name.trim() !== (data.group.name ?? '') || desc !== (data.group.description ?? '');

  function save() {
    const body: { name?: string; description?: string } = {};
    if (name.trim() !== (data.group.name ?? '')) body.name = name.trim();
    if (desc !== (data.group.description ?? '')) body.description = desc;
    edit.mutate(body, {
      onSuccess: () => {
        toast.success(t('mockGroupAdmin.saved'));
        onClose();
      },
      onError: (e) => setError(failText(e, t)),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !edit.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('mockGroupAdmin.editTitle')}</DialogTitle>
          <DialogDescription>{t('mockGroupAdmin.editHint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={nameId}>{t('mockGroupAdmin.name')}</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={max}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {name.length} / {max}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={descId}>{t('mockGroupAdmin.description')}</Label>
            <Textarea
              id={descId}
              value={desc}
              rows={4}
              maxLength={2048}
              placeholder={t('mockGroupAdmin.descriptionPlaceholder')}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 sm:min-h-9"
            onClick={onClose}
            disabled={edit.isPending}
          >
            {t('mockGroupAdmin.cancel')}
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            onClick={save}
            disabled={!changed || !name.trim() || edit.isPending}
          >
            {edit.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('mockGroupAdmin.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({ jid, onClose }: { jid: string; onClose(): void }) {
  const { t } = useTranslation('inbox');
  const id = useId();
  const add = useAddMember(jid);
  const invite = useSendInvite(jid);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'invite' | 'invited'>('form');
  const digits = phone.replace(/\D/g, '');
  const valid = digits.length >= 8 && digits.length <= 15;

  function submit() {
    setError(null);
    add.mutate(digits, {
      onSuccess: (r) => {
        if (r.result === 'added') {
          toast.success(t('mockGroupAdmin.addedToast', { phone: `+${digits}` }));
          onClose();
        } else setStep('invite');
      },
      onError: (e) => setError(failText(e, t)),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !add.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('mockGroupAdmin.addTitle')}</DialogTitle>
          <DialogDescription>{t('mockGroupAdmin.addHint')}</DialogDescription>
        </DialogHeader>
        {step === 'form' ? (
          <div className="space-y-2">
            <Label htmlFor={id}>{t('mockGroupAdmin.phone')}</Label>
            <Input
              id={id}
              inputMode="tel"
              autoComplete="off"
              placeholder="+60 12 345 6789"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <Banner tone="warning">{t('mockGroupAdmin.banRisk')}</Banner>
            {error && <Banner tone="danger">{error}</Banner>}
          </div>
        ) : step === 'invite' ? (
          <Banner tone="info" title={t('mockGroupAdmin.privacyTitle')}>
            {t('mockGroupAdmin.privacyBody', { phone: `+${digits}` })}
          </Banner>
        ) : (
          <Banner tone="info" title={t('mockGroupAdmin.invitedTitle')}>
            {t('mockGroupAdmin.invitedBody', { phone: `+${digits}` })}
          </Banner>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" onClick={onClose}>
            {step === 'invited' ? t('mockGroupAdmin.done') : t('mockGroupAdmin.cancel')}
          </Button>
          {step === 'form' && (
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              onClick={submit}
              disabled={!valid || add.isPending}
            >
              {add.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('mockGroupAdmin.addButton')}
            </Button>
          )}
          {step === 'invite' && (
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              disabled={invite.isPending}
              onClick={() =>
                invite.mutate(digits, {
                  onSuccess: () => setStep('invited'),
                  onError: (e) => toast.error(failText(e, t)),
                })
              }
            >
              {invite.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('mockGroupAdmin.sendInvite')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({
  jid,
  view,
  onClose,
}: {
  jid: string;
  view: GroupAdminView;
  onClose(): void;
}) {
  const { t } = useTranslation('inbox');
  const reset = useResetInvite(jid);
  const [confirm, setConfirm] = useState(false);
  const link = view.inviteLink ?? '';
  return (
    <>
      <Dialog open={!confirm} onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('mockGroupAdmin.linkTitle')}</DialogTitle>
            <DialogDescription>
              {view.caps.inviteOnly
                ? t('mockGroupAdmin.linkHintApi')
                : t('mockGroupAdmin.linkHint')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={link}
              aria-label={t('mockGroupAdmin.linkTitle')}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t('mockGroupAdmin.copy')}
              onClick={() => {
                void navigator.clipboard?.writeText(link).catch(() => undefined);
                toast.success(t('mockGroupAdmin.copied'));
              }}
            >
              <Copy aria-hidden="true" />
            </Button>
          </div>
          {view.settings.approval && (
            <p className="text-xs text-muted-foreground">{t('mockGroupAdmin.linkApproval')}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 text-danger sm:min-h-9"
              onClick={() => setConfirm(true)}
            >
              {t('mockGroupAdmin.reset')}
            </Button>
            <Button type="button" className="min-h-11 sm:min-h-9" onClick={onClose}>
              {t('mockGroupAdmin.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('mockGroupAdmin.resetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('mockGroupAdmin.resetBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9">
              {t('mockGroupAdmin.cancel')}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11 sm:min-h-9"
              disabled={reset.isPending}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('mockGroupAdmin.resetDone'));
                    setConfirm(false);
                  },
                  onError: (e) => toast.error(failText(e, t)),
                })
              }
            >
              {t('mockGroupAdmin.resetConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SettingsDialog({
  jid,
  view,
  onClose,
}: {
  jid: string;
  view: GroupAdminView;
  onClose(): void;
}) {
  const { t } = useTranslation('inbox');
  const set = useGroupSettings(jid);
  const allowed = view.caps.settings;
  const s = view.settings;
  const change = (body: Partial<GroupSettings>) =>
    set.mutate(body, { onError: (e) => toast.error(failText(e, t)) });
  const sw = (k: 'announce' | 'locked' | 'approval') => (
    <div className="flex items-start justify-between gap-3 py-2" key={k}>
      <div className="min-w-0">
        <Label htmlFor={`gs-${k}`}>{t(`mockGroupAdmin.set.${k}` as never)}</Label>
        <p className="text-xs text-muted-foreground">{t(`mockGroupAdmin.set.${k}Hint` as never)}</p>
      </div>
      <Switch
        id={`gs-${k}`}
        checked={s[k]}
        disabled={set.isPending}
        onCheckedChange={(v) => change({ [k]: v })}
      />
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('mockGroupAdmin.settingsTitle')}</DialogTitle>
          <DialogDescription>{t('mockGroupAdmin.settingsHint')}</DialogDescription>
        </DialogHeader>
        {allowed.length === 0 ? (
          <Banner tone="info">{t('mockGroupAdmin.settingsApi')}</Banner>
        ) : (
          <div className="divide-y">
            {allowed.includes('announce') && sw('announce')}
            {allowed.includes('locked') && sw('locked')}
            {allowed.includes('memberAdd') && (
              <div className="space-y-1.5 py-2">
                <p className="text-sm font-medium" id="gs-add">
                  {t('mockGroupAdmin.set.memberAdd')}
                </p>
                <SegmentedControl
                  aria-labelledby="gs-add"
                  value={s.memberAdd}
                  onValueChange={(v) => change({ memberAdd: v })}
                  options={[
                    { value: 'admins', label: t('mockGroupAdmin.set.onlyAdmins') },
                    { value: 'all', label: t('mockGroupAdmin.set.everyone') },
                  ]}
                />
              </div>
            )}
            {allowed.includes('approval') && sw('approval')}
          </div>
        )}
        <section
          aria-labelledby="gs-history"
          className="rounded-lg border bg-muted/40 px-3 py-2"
          data-testid="group-history"
        >
          <h4
            id="gs-history"
            className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"
          >
            <History className="size-3.5" aria-hidden="true" />
            {t('mockGroupAdmin.history')}
          </h4>
          <ul className="mt-1 space-y-1 text-xs">
            {view.log.map((c, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                {t(`mockGroupAdmin.log.${c.action}` as never, { by: c.by, target: c.target ?? '' })}{' '}
                <span className="text-muted-foreground">· {formatDate(c.at)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('mockGroupAdmin.historyNote')}
          </p>
        </section>
        <DialogFooter>
          <Button type="button" className="min-h-11 sm:min-h-9" onClick={onClose}>
            {t('mockGroupAdmin.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Member details: make / remove group admin and remove from the group. */
export function MemberAdminActions({
  groupJid,
  member,
  label,
  onRemoved,
}: {
  groupJid: string;
  member: GroupMember;
  label: string;
  onRemoved(): void;
}) {
  const { t } = useTranslation('inbox');
  const { view, can, isAdmin } = useCanManage(groupJid);
  const role = useSetMemberAdmin(groupJid);
  const remove = useRemoveMember(groupJid);
  const [confirm, setConfirm] = useState<null | 'remove' | 'demote'>(null);
  if (!view || !isAdmin || member.isMe || view.myRole === 'member') return null;
  const owner = member.role === 'superadmin';
  const target = member.lid ?? member.jid;
  const toggleAdmin = (admin: boolean) =>
    role.mutate(
      { member: target, admin },
      {
        onSuccess: () => {
          toast.success(
            t(admin ? 'mockGroupAdmin.promoted' : 'mockGroupAdmin.demoted', { name: label }),
          );
          setConfirm(null);
        },
        onError: (e) => toast.error(failText(e, t)),
      },
    );

  return (
    <section
      className="space-y-2 border-t pt-3"
      aria-label={t('mockGroupAdmin.memberActions')}
      data-testid="member-admin"
    >
      <h4 className="text-xs font-semibold text-muted-foreground">
        {t('mockGroupAdmin.memberActions')}
      </h4>
      {owner ? (
        <p className="text-xs text-muted-foreground">{t('mockGroupAdmin.ownerNote')}</p>
      ) : (
        <>
          {view.caps.admins &&
            (member.role === 'member' ? (
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="w-full"
                disabled={!can || role.isPending}
                onClick={() => toggleAdmin(true)}
              >
                <ShieldCheck aria-hidden="true" />
                {t('mockGroupAdmin.makeAdmin')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="w-full"
                disabled={!can || role.isPending}
                onClick={() => setConfirm('demote')}
              >
                <ShieldOff aria-hidden="true" />
                {t('mockGroupAdmin.removeAdmin')}
              </Button>
            ))}
          {view.caps.removeMembers && (
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="w-full text-danger"
              disabled={!can}
              onClick={() => setConfirm('remove')}
            >
              <UserMinus aria-hidden="true" />
              {t('mockGroupAdmin.remove')}
            </Button>
          )}
        </>
      )}
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="[overflow-wrap:anywhere]">
              {confirm === 'remove'
                ? t('mockGroupAdmin.removeTitle', { name: label })
                : t('mockGroupAdmin.demoteTitle', { name: label })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'remove'
                ? view.caps.inviteOnly
                  ? t('mockGroupAdmin.removeBodyApi')
                  : t('mockGroupAdmin.removeBody')
                : t('mockGroupAdmin.demoteBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9">
              {t('mockGroupAdmin.cancel')}
            </AlertDialogCancel>
            <Button
              type="button"
              variant={confirm === 'remove' ? 'destructive' : 'default'}
              className="min-h-11 sm:min-h-9"
              disabled={remove.isPending || role.isPending}
              onClick={() =>
                confirm === 'remove'
                  ? remove.mutate(target, {
                      onSuccess: () => {
                        toast.success(t('mockGroupAdmin.removed', { name: label }));
                        setConfirm(null);
                        onRemoved();
                      },
                      onError: (e) => toast.error(failText(e, t)),
                    })
                  : toggleAdmin(false)
              }
            >
              {(remove.isPending || role.isPending) && (
                <Loader2 className="animate-spin" aria-hidden="true" />
              )}
              {confirm === 'remove'
                ? t('mockGroupAdmin.removeConfirm')
                : t('mockGroupAdmin.demoteConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** The dashed Mock only box: which connection the inbox uses, and WhatsApp offline. */
export function GroupAdminMockBox({ jid }: { jid: string }) {
  const { view, isAdmin } = useCanManage(jid);
  const sw = useMockSwitch(jid);
  const { t } = useTranslation('inbox');
  if (!view || !isAdmin) return null;
  return (
    <section
      className="mx-4 my-3 space-y-2 rounded-lg border border-dashed px-3 py-2 text-xs"
      data-testid="group-admin-mock"
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <Badge variant="outline">{t('mockGroupAdmin.mock.badge')}</Badge>
        {t('mockGroupAdmin.mock.title')}
      </p>
      <SegmentedControl
        size="sm"
        value={view.connection}
        onValueChange={(v) => sw.mutate({ connection: v })}
        options={[
          { value: 'linked_phone', label: t('mockGroupAdmin.mock.phone') },
          { value: 'business_api', label: t('mockGroupAdmin.mock.api') },
        ]}
      />
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="mock-offline" className="text-xs">
          {t('mockGroupAdmin.mock.offline')}
        </Label>
        <Switch
          id="mock-offline"
          checked={view.offline}
          onCheckedChange={(v) => sw.mutate({ offline: v })}
        />
      </div>
      <p className="text-muted-foreground">{t('mockGroupAdmin.mock.numbers')}</p>
    </section>
  );
}

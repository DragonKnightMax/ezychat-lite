import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, History, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  GROUP_SETTING_KEYS,
  type GroupAdminResponse,
  type GroupChange,
  type GroupInfoResponse,
  type GroupSettings,
} from '@ezychat/shared';
import {
  useAddGroupMember,
  useEditGroup,
  useGroupSettings,
  useResetGroupInvite,
  useSendGroupInvite,
} from '../api/group-admin';
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
import { groupAdminErrorText, type T } from './GroupAdminShared';

/**
 * The dialogs of Manage group (design docs/features/group-management/design.md): edit info, add a
 * member (with the privacy → Send invite step), the invite link and WhatsApp's group settings.
 */

const FOOT_BUTTON = 'min-h-11 sm:min-h-9';

export function EditGroupDialog({
  jid,
  data,
  view,
  onClose,
}: Readonly<{
  jid: string;
  data: GroupInfoResponse;
  view: GroupAdminResponse;
  onClose(): void;
}>) {
  const { t } = useTranslation('inbox');
  const nameId = useId();
  const descId = useId();
  const edit = useEditGroup(jid);
  const oldName = data.group.name ?? '';
  const oldDesc = data.group.description ?? '';
  const [name, setName] = useState(oldName);
  const [desc, setDesc] = useState(oldDesc);
  const [error, setError] = useState<string | null>(null);
  const max = view.caps.nameMax;
  const nameChanged = name.trim() !== oldName;
  const descChanged = desc !== oldDesc;

  function save() {
    setError(null);
    edit.mutate(
      {
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(descChanged ? { description: desc } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t('groupAdmin.saved'));
          onClose();
        },
        onError: (e) => setError(groupAdminErrorText(e, t)),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !edit.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('groupAdmin.editTitle')}</DialogTitle>
          <DialogDescription>{t('groupAdmin.editHint')}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <Label htmlFor={nameId}>{t('groupAdmin.name')}</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={max}
              onChange={(e) => setName(e.target.value)}
            />
            <p
              className="text-right text-xs text-muted-foreground tabular-nums"
              data-testid="group-name-count"
            >
              {name.length} / {max}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={descId}>{t('groupAdmin.description')}</Label>
            <Textarea
              id={descId}
              value={desc}
              rows={4}
              maxLength={view.caps.descriptionMax}
              placeholder={t('groupAdmin.descriptionPlaceholder')}
              className="field-sizing-fixed max-h-60"
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className={FOOT_BUTTON}
            onClick={onClose}
            disabled={edit.isPending}
          >
            {t('groupAdmin.cancel')}
          </Button>
          <Button
            type="button"
            className={FOOT_BUTTON}
            onClick={save}
            disabled={(!nameChanged && !descChanged) || !name.trim() || edit.isPending}
          >
            {edit.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('groupAdmin.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddMemberDialog({ jid, onClose }: Readonly<{ jid: string; onClose(): void }>) {
  const { t } = useTranslation('inbox');
  const id = useId();
  const add = useAddGroupMember(jid);
  const invite = useSendGroupInvite(jid);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  // invite: WhatsApp refused the add (privacy); the admin may send a private invite instead.
  const [step, setStep] = useState<{ kind: 'form' | 'invite' | 'invited'; member?: string }>({
    kind: 'form',
  });
  const digits = phone.replace(/\D/g, '');
  const valid = digits.length >= 8 && digits.length <= 15;
  const shown = `+${digits}`;
  const busy = add.isPending || invite.isPending;

  function submit() {
    setError(null);
    add.mutate(digits, {
      onSuccess: (r) => {
        if (r.result === 'added') {
          toast.success(t('groupAdmin.addedToast', { phone: shown }));
          onClose();
        } else setStep({ kind: 'invite', member: r.memberJid });
      },
      onError: (e) => setError(groupAdminErrorText(e, t)),
    });
  }

  function sendInvite(member: string) {
    setError(null);
    invite.mutate(member, {
      onSuccess: () => setStep({ kind: 'invited' }),
      onError: (e) => setError(groupAdminErrorText(e, t)),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('groupAdmin.addTitle')}</DialogTitle>
          <DialogDescription>{t('groupAdmin.addHint')}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-2">
          {step.kind === 'form' && (
            <>
              <Label htmlFor={id}>{t('groupAdmin.phone')}</Label>
              <Input
                id={id}
                inputMode="tel"
                autoComplete="off"
                placeholder="+60 12 345 6789"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && valid && !busy) submit();
                }}
              />
              <Banner tone="warning">{t('groupAdmin.banRisk')}</Banner>
            </>
          )}
          {step.kind === 'invite' && (
            <Banner tone="info" title={t('groupAdmin.privacyTitle')}>
              {t('groupAdmin.privacyBody', { phone: shown })}
            </Banner>
          )}
          {step.kind === 'invited' && (
            <Banner tone="info" title={t('groupAdmin.invitedTitle')}>
              {t('groupAdmin.invitedBody', { phone: shown })}
            </Banner>
          )}
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className={FOOT_BUTTON}
            onClick={onClose}
            disabled={busy}
          >
            {step.kind === 'invited' ? t('groupAdmin.done') : t('groupAdmin.cancel')}
          </Button>
          {step.kind === 'form' && (
            <Button
              type="button"
              className={FOOT_BUTTON}
              onClick={submit}
              disabled={!valid || busy}
            >
              {add.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('groupAdmin.addButton')}
            </Button>
          )}
          {step.kind === 'invite' && step.member && (
            <Button
              type="button"
              className={FOOT_BUTTON}
              disabled={busy}
              onClick={() => sendInvite(step.member!)}
            >
              {invite.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('groupAdmin.sendInvite')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InviteLinkDialog({
  jid,
  view,
  onClose,
}: Readonly<{
  jid: string;
  view: GroupAdminResponse;
  onClose(): void;
}>) {
  const { t } = useTranslation('inbox');
  const reset = useResetGroupInvite(jid);
  const [confirm, setConfirm] = useState(false);
  const link = view.inviteLink;

  function copy(text: string) {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(t('groupAdmin.copied')))
      .catch(() => undefined);
  }

  return (
    <>
      <Dialog open={!confirm} onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('groupAdmin.linkTitle')}</DialogTitle>
            <DialogDescription>
              {view.caps.inviteOnly ? t('groupAdmin.linkHintApi') : t('groupAdmin.linkHint')}
            </DialogDescription>
          </DialogHeader>
          {link ? (
            <div className="flex min-w-0 items-center gap-2">
              <Input
                readOnly
                value={link}
                aria-label={t('groupAdmin.linkTitle')}
                className="min-w-0 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 shrink-0 sm:size-9"
                aria-label={t('groupAdmin.copy')}
                onClick={() => copy(link)}
              >
                <Copy aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <Banner tone="warning">{t('groupAdmin.linkUnavailable')}</Banner>
          )}
          {view.settings.approval && (
            <p className="text-xs text-muted-foreground">{t('groupAdmin.linkApproval')}</p>
          )}
          <DialogFooter>
            {view.caps.resetInviteLink && (
              <Button
                type="button"
                variant="ghost"
                className={`${FOOT_BUTTON} text-danger`}
                onClick={() => setConfirm(true)}
              >
                {t('groupAdmin.reset')}
              </Button>
            )}
            <Button type="button" className={FOOT_BUTTON} onClick={onClose}>
              {t('groupAdmin.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm} onOpenChange={(o) => !o && !reset.isPending && setConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('groupAdmin.resetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('groupAdmin.resetBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={FOOT_BUTTON} disabled={reset.isPending}>
              {t('groupAdmin.cancel')}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className={FOOT_BUTTON}
              disabled={reset.isPending}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('groupAdmin.resetDone'));
                    setConfirm(false);
                  },
                  onError: (e) => toast.error(groupAdminErrorText(e, t)),
                })
              }
            >
              {reset.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('groupAdmin.resetConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type SwitchKey = 'announce' | 'locked' | 'approval';

const LOG_KEYS = {
  rename: 'groupAdmin.log.name',
  description: 'groupAdmin.log.description',
  member_add: 'groupAdmin.log.added',
  member_invite: 'groupAdmin.log.invited',
  member_remove: 'groupAdmin.log.removed',
  admin_promote: 'groupAdmin.log.promoted',
  admin_demote: 'groupAdmin.log.demoted',
  invite_reset: 'groupAdmin.log.linkReset',
  join_approve: 'groupAdmin.log.approved',
  join_reject: 'groupAdmin.log.rejected',
} as const;

/** A member as Recent changes names them: the name resolved now, else the number. */
function changeTarget(c: GroupChange, t: T): string {
  if (c.memberName) return c.memberName;
  const digits = c.memberJid ? /^(\d+)@s\.whatsapp\.net$/.exec(c.memberJid)?.[1] : undefined;
  return digits ? `+${digits}` : t('groupAdmin.log.someMember');
}

export function changeLine(c: GroupChange, t: T): string {
  const by = c.byName ?? t('groupAdmin.log.someone');
  // The server always names the setting; an older row without one reads as the first.
  if (c.action === 'setting') return t(`groupAdmin.log.setting.${c.setting ?? 'announce'}`, { by });
  return t(LOG_KEYS[c.action], { by, target: changeTarget(c, t) });
}

export function GroupSettingsDialog({
  jid,
  view,
  onClose,
}: Readonly<{
  jid: string;
  view: GroupAdminResponse;
  onClose(): void;
}>) {
  const { t } = useTranslation('inbox');
  const ids = useId();
  const set = useGroupSettings(jid);
  const s = view.settings;
  // Only what this connection can change and WhatsApp reported (an unknown value is never shown).
  const allowed = GROUP_SETTING_KEYS.filter(
    (k) => view.caps.settings.includes(k) && s[k] !== undefined,
  );
  const change = (body: Partial<GroupSettings>) =>
    set.mutate(body, { onError: (e) => toast.error(groupAdminErrorText(e, t)) });

  const row = (k: SwitchKey) => (
    <div className="flex items-start justify-between gap-3 py-2" key={k}>
      <div className="min-w-0">
        <Label htmlFor={`${ids}-${k}`}>{t(`groupAdmin.set.${k}`)}</Label>
        <p className="text-xs text-muted-foreground">{t(`groupAdmin.set.${k}Hint`)}</p>
      </div>
      <Label htmlFor={`${ids}-${k}`} className="-m-2 min-h-11 min-w-11 shrink-0 justify-center p-2">
        <Switch
          id={`${ids}-${k}`}
          checked={s[k] ?? false}
          disabled={set.isPending}
          onCheckedChange={(v) => change({ [k]: v })}
        />
      </Label>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('groupAdmin.settingsTitle')}</DialogTitle>
          <DialogDescription>{t('groupAdmin.settingsHint')}</DialogDescription>
        </DialogHeader>
        {allowed.length === 0 ? (
          <Banner tone="info">
            {view.caps.inviteOnly ? t('groupAdmin.settingsApi') : t('groupAdmin.settingsNone')}
          </Banner>
        ) : (
          <div className="min-w-0 divide-y">
            {allowed.map((k) =>
              k !== 'memberAdd' ? (
                row(k)
              ) : (
                <div className="space-y-1.5 py-2" key={k}>
                  <p className="text-sm font-medium" id={`${ids}-add`}>
                    {t('groupAdmin.set.memberAdd')}
                  </p>
                  <SegmentedControl
                    aria-labelledby={`${ids}-add`}
                    value={s.memberAdd ?? 'admins'}
                    onValueChange={(v) => change({ memberAdd: v })}
                    options={[
                      { value: 'admins', label: t('groupAdmin.set.onlyAdmins') },
                      { value: 'all', label: t('groupAdmin.set.everyone') },
                    ]}
                  />
                </div>
              ),
            )}
          </div>
        )}
        <section
          aria-labelledby={`${ids}-history`}
          className="min-w-0 rounded-lg border bg-muted/40 px-3 py-2"
          data-testid="group-history"
        >
          <h4
            id={`${ids}-history`}
            className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"
          >
            <History className="size-3.5" aria-hidden="true" />
            {t('groupAdmin.history')}
          </h4>
          {view.changes.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">{t('groupAdmin.historyEmpty')}</p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs">
              {view.changes.map((c, i) => (
                <li key={`${c.at}-${i}`} className="[overflow-wrap:anywhere]">
                  {changeLine(c, t)}{' '}
                  <span className="whitespace-nowrap text-muted-foreground">
                    · {formatDate(c.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">{t('groupAdmin.historyNote')}</p>
        </section>
        <DialogFooter>
          <Button type="button" className={FOOT_BUTTON} onClick={onClose}>
            {t('groupAdmin.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

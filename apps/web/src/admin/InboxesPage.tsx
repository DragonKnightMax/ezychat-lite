import { useEffect, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Cable, Inbox as InboxIcon, Plus, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { AiAgentSummary, Inbox, User, WaStatus } from '@ezychat/shared';
import { refreshAgents, useAiAgents } from '../api/ai';
import { ApiError, errorMessage } from '../api/client';
import {
  useCreateInbox,
  useInboxWaAction,
  useRemoveInbox,
  useUpdateInbox,
} from '../api/inbox-mutations';
import { PRIMARY_INBOX_ID, qk, useInboxStatus, useInboxes, useUsers } from '../api/queries';
import {
  ExtensionBoundary,
  useExtensionTranslation,
  useInboxTypes,
  type WebExtensionInboxType,
} from '../extensions';
import { InboxChip } from '../inbox/InboxChip';
import { inboxCapabilities, inboxTypeOf } from '../inbox/reply-window';
import { PhoneLink } from '../wa/PhoneLink';
import { Banner, PageHeader, ResponsiveDialog, StatusDot } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog, ErrorState, Field, ListSkeleton } from './adminUi';
import { formatInboxNumber, inboxCardStatus } from './inbox-status';
import { cn } from '@/lib/utils';
import { LiteChecklistCard, LiteImportEntry } from '../lite-import/notice';

/** While a phone is being linked, ask for the status this often (the socket usually is faster). */
const LINK_POLL_MS = 5_000;
/** The AI agent select's value for "no AI agent". */
const NO_AGENT = 'none';
/** The core's own connection type: the WhatsApp app on a phone, linked by QR scan. */
const LINKED_PHONE = 'linked_phone';

/** The extension screens of an inbox's connection type; undefined for a linked phone. */
function typeOfInbox(
  types: readonly WebExtensionInboxType[],
  inbox: Inbox,
): WebExtensionInboxType | undefined {
  const type = inboxTypeOf(inbox);
  return type === LINKED_PHONE ? undefined : types.find((x) => x.type === type);
}

/** Invalidates what an extension's create/change can move: the inbox list, members and the audit. */
function refreshAfterExtension(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.inboxes }),
    qc.invalidateQueries({ queryKey: qk.wa }),
    qc.invalidateQueries({ queryKey: qk.users }),
    qc.invalidateQueries({ queryKey: qk.audit }),
  ]);
}

/** Every linked WhatsApp number (inbox), with who may open it. Admin only; shown when maxInboxes > 1. */
export function InboxesPage() {
  const { t } = useTranslation('admin');
  const inboxes = useInboxes();
  const users = useUsers();
  const agentList = useAiAgents();
  const qc = useQueryClient();
  const remove = useRemoveInbox();
  const types = useInboxTypes();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [removing, setRemoving] = useState<Inbox | null>(null);

  if (inboxes.isPending) return <ListSkeleton rows={2} />;
  if (inboxes.isError)
    return <ErrorState error={inboxes.error} onRetry={() => void inboxes.refetch()} />;

  const { maxInboxes, canAdd } = inboxes.data;
  // Removed inboxes keep their chats (read only); they are no longer managed here.
  const active = inboxes.data.inboxes.filter((i) => !i.removed);
  const people = (users.data ?? []).filter((u) => !u.disabled && u.kind !== 'ai');
  const whoCanOpen = (inbox: Inbox) =>
    people.filter((u) => u.role === 'admin' || (inbox.memberIds ?? []).includes(u.id));
  const agents = agentList.data?.agents ?? [];
  const agentOf = (inbox: Inbox) =>
    inbox.aiAgentId === null ? undefined : agents.find((a) => a.id === inbox.aiAgentId);
  const removingAgent = removing ? agentOf(removing) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('inboxes.title')}
        description={types.length > 0 ? t('inboxes.descriptionTypes') : t('inboxes.description')}
        actions={
          <>
            <LiteImportEntry maxInboxes={maxInboxes} />
            <Button
              type="button"
              size="touch"
              className="md:min-h-9"
              disabled={!canAdd}
              onClick={() => setEditing('new')}
            >
              <Plus aria-hidden />
              {t('inboxes.add')}
            </Button>
          </>
        }
      />
      <LiteChecklistCard />
      {!canAdd && (
        <p className="text-sm text-muted-foreground" data-testid="inbox-limit">
          {t('inboxes.limitReached', { max: maxInboxes })}
        </p>
      )}

      {active.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <InboxIcon className="size-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">{t('inboxes.emptyTitle')}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t('inboxes.emptyBody')}</p>
          </CardContent>
        </Card>
      )}

      {active.map((inbox) => (
        <InboxCard
          key={inbox.id}
          inbox={inbox}
          openers={whoCanOpen(inbox)}
          agent={agentOf(inbox)}
          type={typeOfInbox(types, inbox)}
          onEdit={() => setEditing(inbox.id)}
          onRemove={() => {
            remove.reset();
            setRemoving(inbox);
          }}
        />
      ))}

      <InboxDialog
        target={editing}
        inboxes={active}
        people={people}
        peopleReady={users.isSuccess}
        agents={agents}
        maxInboxes={maxInboxes}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title={t('inboxes.removeTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('inboxes.removeConfirm')}
        danger
        loading={remove.isPending}
        error={remove.error ?? undefined}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => {
              // Its agent no longer answers an inbox.
              refreshAgents(qc);
              toast.success(t('inboxes.removed'));
              setRemoving(null);
            },
          });
        }}
        onClose={() => setRemoving(null)}
      >
        {removing && !inboxCapabilities(removing).qrLink
          ? t('inboxes.removeBodyOther')
          : t('inboxes.removeBodyPhone')}
        {removingAgent && (
          <span className="mt-2 block">
            {t('inboxes.aiAgentRemove', { agent: removingAgent.displayName })}
          </span>
        )}
      </ConfirmDialog>
    </div>
  );
}

function InboxCard({
  inbox,
  openers,
  agent,
  type,
  onEdit,
  onRemove,
}: Readonly<{
  inbox: Inbox;
  openers: User[];
  /** The AI agent that answers this inbox, if any. */
  agent: AiAgentSummary | undefined;
  /** The extension connection type of this inbox; undefined for a linked phone. */
  type: WebExtensionInboxType | undefined;
  onEdit: () => void;
  onRemove: () => void;
}>) {
  const { t } = useTranslation('admin');
  const status = useInboxStatus(inbox.id) ?? inbox.status;
  const card = inboxCardStatus(status.state);
  const caps = inboxCapabilities(inbox);
  return (
    <Card className="gap-4" data-testid="inbox-card">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <InboxChip inbox={inbox} />
            <span className="text-base font-normal break-all text-muted-foreground tabular-nums">
              {formatInboxNumber(inbox.number) ?? (caps.qrLink ? t('inboxes.numberAfterScan') : '')}
            </span>
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5" data-testid="inbox-type">
            <InboxTypeLabel inbox={inbox} type={type} />
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="touch"
            className="px-2 md:min-h-8"
            aria-label={`${t('inboxes.edit')} · ${inbox.name}`}
            onClick={onEdit}
          >
            {t('inboxes.edit')}
          </Button>
          {/* The first number cannot be removed: it is the number linked before multi-inbox. */}
          {inbox.id !== PRIMARY_INBOX_ID && (
            <Button
              type="button"
              variant="ghost"
              size="touch"
              className="px-2 text-danger hover:bg-danger/10 hover:text-danger md:min-h-8"
              aria-label={`${t('inboxes.remove')} · ${inbox.name}`}
              onClick={onRemove}
            >
              {t('inboxes.remove')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid max-w-xl grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('inboxes.status')}</dt>
          <dd>
            <StatusDot
              tone={card.tone}
              pulse={status.state === 'connecting'}
              label={
                <span className="font-medium" data-testid="inbox-state">
                  {card.labelKey ? t(card.labelKey as never) : status.state}
                </span>
              }
            />
          </dd>
          <dt className="text-muted-foreground">{t('inboxes.aiAgent')}</dt>
          <dd data-testid="inbox-agent">
            {agent ? (
              <Link
                to={`/admin/members/ai/${agent.id}`}
                className="inline-flex items-center font-medium break-all text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11"
              >
                {agent.displayName}
              </Link>
            ) : (
              <span className="text-muted-foreground">{t('inboxes.aiAgentNone')}</span>
            )}
          </dd>
          <dt className="text-muted-foreground">{t('inboxes.whoCanOpen')}</dt>
          <dd className="flex min-w-0 flex-wrap gap-1.5">
            {openers.map((u) => (
              <Badge key={u.id} variant="outline" className="max-w-full truncate">
                {u.displayName}
                {u.role === 'admin' ? ` · ${t('inboxes.admin')}` : ''}
              </Badge>
            ))}
          </dd>
        </dl>
        {type?.CardDetails && (
          <ExtensionBoundary>
            <type.CardDetails inbox={inbox} />
          </ExtensionBoundary>
        )}
        {card.notice === 'scan' && caps.qrLink && (
          <Banner tone="warning" title={t('inboxes.scanTitle')}>
            {t('inboxes.scanBody')}
          </Banner>
        )}
        {card.notice === 'offline' && (
          <Banner tone="danger" title={t('inboxes.offlineTitle')}>
            {t('inboxes.offlineBody')}
          </Banner>
        )}
        {card.notice === 'replaced' && (
          <Banner tone="danger" title={t('whatsapp.replacedTitle')}>
            {t('whatsapp.replacedBody')}
          </Banner>
        )}
        {agent && caps.replyWindowHours !== null && (
          <p className="text-sm text-muted-foreground" data-testid="inbox-ai-window">
            {t('inboxes.aiWindowNote', { hours: caps.replyWindowHours })}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t('inboxes.accessHint')}</p>
      </CardContent>
    </Card>
  );
}

/** Icon and name of an inbox's connection type (an extension's type names itself). */
function InboxTypeLabel({
  inbox,
  type,
}: Readonly<{ inbox: Inbox; type: WebExtensionInboxType | undefined }>) {
  const { t } = useTranslation('admin');
  const tx = useExtensionTranslation();
  if (inboxTypeOf(inbox) === LINKED_PHONE)
    return (
      <>
        <Smartphone className="size-4 shrink-0" aria-hidden />
        {t('inboxes.typeLinkedPhone')}
      </>
    );
  const Icon = type?.icon ?? Cable;
  return (
    <>
      <Icon className="size-4 shrink-0" aria-hidden />
      {type ? tx(type.labelKey) : t('inboxes.typeOther')}
    </>
  );
}

const sameSet = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Add an inbox (name and who can open it, then the QR code) or edit one (rename, who can open it,
 * link the phone again).
 */
function InboxDialog({
  target,
  inboxes,
  people,
  peopleReady,
  agents: aiAgents,
  maxInboxes,
  onClose,
}: Readonly<{
  target: number | 'new' | null;
  inboxes: Inbox[];
  people: User[];
  /** False while the team list loads or failed: the tick boxes are then incomplete. */
  peopleReady: boolean;
  /** Every AI agent: one of them (or none) answers the inbox. */
  agents: AiAgentSummary[];
  maxInboxes: number;
  onClose: () => void;
}>) {
  const { t } = useTranslation(['admin', 'common']);
  const tx = useExtensionTranslation();
  const types = useInboxTypes();
  const create = useCreateInbox();
  const update = useUpdateInbox();
  const qc = useQueryClient();
  const isNew = target === 'new';
  /** Add inbox: the connection type chosen (linked phone unless an extension's type is picked). */
  const [newType, setNewType] = useState(LINKED_PHONE);
  /** An inbox an extension's CreateForm just created (until the list has it). */
  const [extCreated, setExtCreated] = useState<Inbox | null>(null);
  /** Edit of a linked phone: the type whose SwitchFromPhone flow is open. */
  const [switching, setSwitching] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<number[]>([]);
  /** True once the admin changed a tick box; only then does Save send memberIds. */
  const [membersTouched, setMembersTouched] = useState(false);
  /** The AI agent select: an agent id, or NO_AGENT. */
  const [agentChoice, setAgentChoice] = useState(NO_AGENT);
  const [submitted, setSubmitted] = useState(false);
  /** The inbox just created in this dialog (its QR code shows next). */
  const [createdId, setCreatedId] = useState<number | null>(null);

  const inboxId = isNew ? createdId : target;
  const inbox =
    inboxes.find((i) => i.id === inboxId) ??
    (create.data && create.data.id === inboxId ? create.data : undefined) ??
    (extCreated && extCreated.id === inboxId ? extCreated : undefined);
  const saved = isNew ? createdId !== null : true;
  const admins = people.filter((u) => u.role === 'admin');
  const agents = people.filter((u) => u.role !== 'admin');

  useEffect(() => {
    const current = typeof target === 'number' ? inboxes.find((i) => i.id === target) : undefined;
    setName(current?.name ?? '');
    setMembers(current?.memberIds ?? []);
    setMembersTouched(false);
    setAgentChoice(current?.aiAgentId == null ? NO_AGENT : String(current.aiAgentId));
    setSubmitted(false);
    setCreatedId(null);
    setNewType(LINKED_PHONE);
    setExtCreated(null);
    setSwitching(null);
    create.reset();
    update.reset();
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMember = (id: number, on: boolean) => {
    setMembersTouched(true);
    setMembers((m) => (on ? [...new Set([...m, id])] : m.filter((x) => x !== id)));
  };

  const nameError = submitted && name.trim() === '' ? t('inboxes.required') : undefined;
  const busy = create.isPending || update.isPending;
  // Without the team list the tick boxes are incomplete: a save could take access away.
  const canSave = !busy && peopleReady;
  const error = create.error ?? update.error;
  const inboxName = (id: number | null) => inboxes.find((i) => i.id === id)?.name ?? '';
  const chosenAgentId = agentChoice === NO_AGENT ? null : Number(agentChoice);
  const chosen = aiAgents.find((a) => a.id === chosenAgentId);
  const previous =
    inbox?.aiAgentId == null ? undefined : aiAgents.find((a) => a.id === inbox.aiAgentId);
  /** The chosen agent answers another inbox now: saving moves it here. */
  const movesFrom =
    chosen && chosen.inboxId !== null && chosen.inboxId !== inbox?.id
      ? inboxName(chosen.inboxId)
      : '';
  const refreshAgentQueries = () => refreshAgents(qc);

  // Only the agents shown can be ticked (admins always see every inbox). Members the dialog
  // cannot show (a disabled agent) keep their access.
  const shown = (id: number) => agents.some((u) => u.id === id);
  const hidden = isNew ? [] : (inbox?.memberIds ?? []).filter((id) => !shown(id));
  const memberIds = [...members.filter(shown), ...hidden];

  /** The extension type of the inbox (edit) or the one chosen for a new inbox. */
  const extType = inbox
    ? typeOfInbox(types, inbox)
    : isNew
      ? types.find((x) => x.type === newType)
      : undefined;
  /** A new inbox of an extension's type: its CreateForm creates it instead of Save. */
  const extCreating = isNew && !saved && extType !== undefined;
  const qrLink = inbox ? inboxCapabilities(inbox).qrLink : !extCreating;
  const switchTypes = types.filter((x) => x.SwitchFromPhone);
  const switchType = switchTypes.find((x) => x.type === switching);

  /** The core fields checked for a type's CreateForm (shows their errors). */
  const validate = () => {
    setSubmitted(true);
    return name.trim() !== '' && peopleReady;
  };
  const onExtCreated = (created: Inbox) => {
    setExtCreated(created);
    setCreatedId(created.id);
    void refreshAfterExtension(qc);
    if (chosenAgentId !== null) refreshAgentQueries();
    toast.success(t('inboxes.createdOther'));
  };
  const onExtChanged = () => {
    setSwitching(null);
    void refreshAfterExtension(qc);
    refreshAgentQueries();
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const trimmed = name.trim();
    if (!trimmed || !peopleReady) return;
    if (isNew) {
      create.mutate(
        {
          name: trimmed,
          memberIds,
          ...(chosenAgentId !== null ? { aiAgentId: chosenAgentId } : {}),
        },
        {
          onSuccess: (created) => {
            if (chosenAgentId !== null) refreshAgentQueries();
            setCreatedId(created.id);
            toast.success(t('inboxes.createdPhone'));
          },
        },
      );
      return;
    }
    if (!inbox) return;
    const body = {
      ...(trimmed !== inbox.name ? { name: trimmed } : {}),
      ...(membersTouched && !sameSet(memberIds, inbox.memberIds ?? []) ? { memberIds } : {}),
      ...(chosenAgentId !== (inbox.aiAgentId ?? null) ? { aiAgentId: chosenAgentId } : {}),
    };
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    update.mutate(
      { id: inbox.id, body },
      {
        onSuccess: () => {
          if ('aiAgentId' in body) refreshAgentQueries();
          toast.success(t('inboxes.saved'));
          onClose();
        },
      },
    );
  };

  const formId = 'inbox-form';
  return (
    <ResponsiveDialog
      open={target !== null}
      onOpenChange={(next) => !next && onClose()}
      title={
        isNew && !saved
          ? t('inboxes.addTitle')
          : t('inboxes.editTitle', { name: inbox?.name ?? name })
      }
      description={qrLink ? t('inboxes.dialogDescription') : t('inboxes.dialogDescriptionOther')}
      size="medium"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="sm:min-h-9"
            onClick={onClose}
          >
            {saved && isNew ? t('common:actions.done') : t('common:actions.cancel')}
          </Button>
          {/* After a new inbox is saved only Done remains: the next step is on the phone. */}
          {!(saved && isNew) && !extCreating && (
            <Button
              type="submit"
              form={formId}
              size="touch"
              className="sm:min-h-9"
              disabled={!canSave}
              aria-busy={busy}
            >
              {t('inboxes.save')}
            </Button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={save} noValidate className="flex min-w-0 flex-col gap-5 pb-1">
        {isNew && !saved && types.length > 0 && (
          <fieldset className="flex min-w-0 flex-col gap-2" data-testid="inbox-type-choice">
            <legend className="mb-1 text-sm font-medium">{t('inboxes.typeField')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <TypeChoice
                selected={newType === LINKED_PHONE}
                icon={Smartphone}
                label={t('inboxes.typeLinkedPhone')}
                description={t('inboxes.typePhoneHint')}
                onSelect={() => setNewType(LINKED_PHONE)}
              />
              {types.map((x) => (
                <TypeChoice
                  key={x.type}
                  selected={newType === x.type}
                  icon={x.icon ?? Cable}
                  label={tx(x.labelKey)}
                  description={tx(x.descriptionKey)}
                  onSelect={() => setNewType(x.type)}
                />
              ))}
            </div>
          </fieldset>
        )}
        <Field label={t('inboxes.name')} hint={t('inboxes.nameHint')} error={nameError}>
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={40}
              disabled={saved && isNew}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>

        {!(saved && isNew) && (
          <fieldset className="flex min-w-0 flex-col gap-3" data-testid="inbox-members">
            <legend className="mb-1 text-sm font-medium">{t('inboxes.membersField')}</legend>
            <p className="text-sm text-muted-foreground">{t('inboxes.membersFieldHint')}</p>
            {admins.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {admins.map((u) => (
                  <Badge key={u.id} variant="outline" className="max-w-full truncate">
                    {u.displayName} · {t('inboxes.admin')}
                  </Badge>
                ))}
              </div>
            )}
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('inboxes.membersFieldNoAgents')}</p>
            ) : (
              agents.map((u) => {
                const id = `inbox-member-${u.id}`;
                return (
                  <div key={u.id} className="flex min-h-11 items-center gap-3 md:min-h-8">
                    <Checkbox
                      id={id}
                      checked={members.includes(u.id)}
                      onCheckedChange={(v) => toggleMember(u.id, v === true)}
                    />
                    <Label htmlFor={id} className="min-w-0 font-normal break-words">
                      {u.displayName}
                    </Label>
                  </div>
                );
              })
            )}
            {agents.length > 0 && members.length === 0 && (
              <p className="text-sm text-warning">{t('inboxes.membersFieldNone')}</p>
            )}
          </fieldset>
        )}

        {!(saved && isNew) && (
          <div className="flex min-w-0 flex-col gap-2" data-testid="inbox-agent-field">
            <Label htmlFor="inbox-ai-agent">{t('inboxes.aiAgentField')}</Label>
            <Select value={agentChoice} onValueChange={setAgentChoice}>
              <SelectTrigger id="inbox-ai-agent" className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_AGENT} className="min-h-11 md:min-h-8">
                  {t('inboxes.aiAgentNone')}
                </SelectItem>
                {aiAgents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)} className="min-h-11 md:min-h-8">
                    {a.inboxId !== null && a.inboxId !== inbox?.id && inboxName(a.inboxId)
                      ? t('inboxes.aiAgentOption', {
                          agent: a.displayName,
                          inbox: inboxName(a.inboxId),
                        })
                      : a.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{t('inboxes.aiAgentFieldHint')}</p>
            {chosen && movesFrom && (
              <Banner tone="warning">
                {t('inboxes.aiAgentMove', { agent: chosen.displayName, inbox: movesFrom })}
              </Banner>
            )}
            {previous && previous.id !== chosenAgentId && (
              <Banner tone="warning">
                {t('inboxes.aiAgentReplace', { agent: previous.displayName })}
              </Banner>
            )}
          </div>
        )}

        {error && (
          <Banner tone="danger">
            {/* `inbox_limit`: another admin added an inbox meanwhile. */}
            {error instanceof ApiError && error.code === 'inbox_limit'
              ? t('inboxes.limitReached', { max: maxInboxes })
              : errorMessage(error)}
          </Banner>
        )}
      </form>

      {/* The link box and extension forms sit outside the core form: they hold forms of their own. */}
      {inbox && qrLink && (
        <div className="mt-5 min-w-0">
          <InboxLink inbox={inbox} justCreated={isNew} />
        </div>
      )}
      {extCreating && extType && (
        <section
          className="mt-5 flex min-w-0 flex-col gap-3 border-t pt-5"
          aria-labelledby="inbox-type-create"
          data-testid="inbox-type-create"
        >
          <h3 id="inbox-type-create" className="text-sm font-medium">
            {tx(extType.labelKey)}
          </h3>
          <ExtensionBoundary>
            <extType.CreateForm
              draft={{ name: name.trim(), memberIds, aiAgentId: chosenAgentId }}
              validate={validate}
              onCreated={onExtCreated}
            />
          </ExtensionBoundary>
        </section>
      )}
      {isNew && saved && inbox && extType?.CardDetails && (
        <div className="mt-5 min-w-0 border-t pt-5">
          <ExtensionBoundary>
            <extType.CardDetails inbox={inbox} />
          </ExtensionBoundary>
        </div>
      )}
      {!isNew && inbox && inboxTypeOf(inbox) === LINKED_PHONE && switchTypes.length > 0 && (
        <section
          className="mt-5 flex min-w-0 flex-col gap-3 border-t pt-5"
          aria-labelledby="inbox-connection-type"
          data-testid="inbox-connection-type"
        >
          <h3 id="inbox-connection-type" className="text-sm font-medium">
            {t('inboxes.connectionType')}
          </h3>
          {switchType?.SwitchFromPhone ? (
            <ExtensionBoundary>
              <switchType.SwitchFromPhone
                inbox={inbox}
                onChanged={onExtChanged}
                onCancel={() => setSwitching(null)}
              />
            </ExtensionBoundary>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Smartphone className="size-4 shrink-0" aria-hidden />
                {t('inboxes.typeLinkedPhone')}
              </span>
              <div className="flex flex-wrap gap-2">
                {switchTypes.map((x) => {
                  const Icon = x.icon ?? Cable;
                  return (
                    <Button
                      key={x.type}
                      type="button"
                      variant="outline"
                      size="touch"
                      className="md:min-h-9"
                      onClick={() => setSwitching(x.type)}
                    >
                      <Icon aria-hidden />
                      {t('inboxes.switchTo', { type: tx(x.labelKey) })}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}
      {!isNew && inbox && extType?.EditSection && (
        <section
          className="mt-5 flex min-w-0 flex-col gap-3 border-t pt-5"
          aria-labelledby="inbox-type-edit"
          data-testid="inbox-type-edit"
        >
          <h3 id="inbox-type-edit" className="text-sm font-medium">
            {tx(extType.labelKey)}
          </h3>
          <ExtensionBoundary>
            <extType.EditSection inbox={inbox} onChanged={onExtChanged} />
          </ExtensionBoundary>
        </section>
      )}
    </ResponsiveDialog>
  );
}

/** One card of the Add inbox type choice (pressed = chosen). */
function TypeChoice({
  selected,
  icon: Icon,
  label,
  description,
  onSelect,
}: Readonly<{
  selected: boolean;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  description: string;
  onSelect: () => void;
}>) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'h-auto min-h-11 min-w-0 flex-col items-start gap-1 px-3 py-2.5 text-left whitespace-normal',
        selected && 'border-primary bg-primary/5 ring-1 ring-primary',
      )}
    >
      <span className="flex min-w-0 items-center gap-2 font-medium break-words">
        <Icon className="size-4 shrink-0" aria-hidden />
        {label}
      </span>
      <span className="text-xs font-normal break-words text-muted-foreground">{description}</span>
    </Button>
  );
}

/** The phone side of one inbox: linked number and "Link the phone again", or the QR code. */
function InboxLink({ inbox, justCreated }: Readonly<{ inbox: Inbox; justCreated: boolean }>) {
  const { t } = useTranslation('admin');
  const status: WaStatus = useInboxStatus(inbox.id) ?? inbox.status;
  const action = useInboxWaAction(inbox.id);
  /** "Link the phone again" was pressed: the QR code shows until the phone is linked again. */
  const [relinking, setRelinking] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  const card = inboxCardStatus(status.state);
  const connected = status.state === 'open';

  useEffect(() => {
    if (!relinking) return;
    // The status may still say `open` for a moment after the relink; wait until it left `open`.
    if (!connected) setUnlinked(true);
    else if (unlinked) {
      setRelinking(false);
      setUnlinked(false);
    }
  }, [connected, relinking, unlinked]);

  const showQr = relinking || (!connected && (justCreated || card.needsLink));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {action.error && <Banner tone="danger">{errorMessage(action.error)}</Banner>}
      {!showQr && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusDot
            tone={card.tone}
            label={
              <span className="text-sm font-medium break-all">
                {connected && inbox.number
                  ? t('inboxes.linkedAs', { number: formatInboxNumber(inbox.number) })
                  : card.labelKey
                    ? t(card.labelKey as never)
                    : status.state}
              </span>
            }
          />
          <div className="flex flex-wrap gap-2">
            {status.state === 'replaced' && (
              <Button
                type="button"
                size="touch"
                className="md:min-h-9"
                disabled={action.isPending}
                onClick={() => action.mutate('takeover')}
              >
                {t('whatsapp.actions.takeover.label')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="md:min-h-9"
              disabled={action.isPending}
              onClick={() =>
                action.mutate('relink', {
                  onSuccess: () => setRelinking(true),
                })
              }
            >
              {t('inboxes.relink')}
            </Button>
          </div>
        </div>
      )}
      {showQr && <LinkPhone inboxId={inbox.id} status={status} />}
    </div>
  );
}

/** QR code from the inbox status, the phone steps, and the pairing code as the other way. */
function LinkPhone({ inboxId, status }: Readonly<{ inboxId: number; status: WaStatus }>) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();

  useEffect(() => {
    // Fallback while the phone links: the socket's `inbox:status` normally arrives first.
    const timer = setInterval(() => {
      void qc.invalidateQueries({ queryKey: inboxId === PRIMARY_INBOX_ID ? qk.wa : qk.inboxes });
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [qc, inboxId]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        className="flex min-w-0 flex-col items-center gap-3 rounded-lg border bg-muted/40 p-4 text-center"
        data-testid="inbox-qr"
      >
        <p className="font-medium">{t('inboxes.scanTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('inboxes.scanSteps')}</p>
        {status.state === 'qr' && status.qr ? (
          // QR codes need a light quiet zone to scan reliably, even in dark mode.
          <div className="rounded-lg border bg-card p-3 dark:bg-foreground">
            <QRCodeSVG
              value={status.qr}
              size={208}
              bgColor="transparent"
              fgColor="currentColor"
              className="h-auto w-full max-w-52 text-foreground dark:text-background"
              aria-label={t('whatsapp.qrLabel')}
            />
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground" data-testid="inbox-qr-waiting">
            {t('whatsapp.waitingQrTitle')}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm font-medium">{t('whatsapp.phoneTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('whatsapp.phoneHint')}</p>
        <PhoneLink inboxId={inboxId} />
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, Inbox as InboxIcon, Plus, RefreshCw, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import type { User } from '@ezychat/shared';
import { useUsers } from '../api/queries';
import { Banner, PageHeader, ResponsiveDialog, StatusDot, type StatusTone } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog, Field } from './adminUi';
import {
  addInbox,
  removeInbox,
  setInboxMembers,
  updateInbox,
  useMockInboxes,
  type InboxStatus,
  type MockApiConnection,
  type MockInbox,
} from '../mock/inboxes';
import { InboxChip } from '../inbox/InboxChip';
// Proposed (custom-agents): the AI agent that answers each inbox (one agent per inbox).
import { Link } from 'react-router-dom';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { agentOfInbox, setInboxAgent, useMockAgents } from '../mock/agents';
// Proposed (business-api): the Business API inbox type (Enterprise).
import { cn } from '@/lib/utils';
import { ApiNumberSummary, BusinessApiForm, WebhookStatus } from './BusinessApiForm';

const STATUS_TONE: Record<InboxStatus, StatusTone> = {
  connected: 'success',
  waiting_scan: 'warning',
  phone_offline: 'danger',
  token_invalid: 'danger',
};

/**
 * Proposed (multi-inbox): one inbox per WhatsApp number, each linked with the WhatsApp app on a phone
 * (QR scan, as the app works today). Admin only; agents never see this page.
 */
export function InboxesPage() {
  const { t } = useTranslation('admin');
  const state = useMockInboxes();
  const agentState = useMockAgents();
  const users = useUsers();
  const [editing, setEditing] = useState<MockInbox | 'new' | null>(null);
  const [removing, setRemoving] = useState<MockInbox | null>(null);

  const people = (users.data ?? []).filter((u) => !u.disabled && u.kind !== 'ai');
  const whoCanOpen = (inbox: MockInbox) =>
    people.filter((u) => {
      if (u.role === 'admin') return true;
      const a = state.access[u.id];
      return Array.isArray(a) && a.includes(inbox.id);
    });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('mockInbox.title')}
        description={t('mockApi.pageDescription')}
        actions={
          <Button
            type="button"
            size="touch"
            className="md:min-h-9"
            onClick={() => setEditing('new')}
          >
            <Plus aria-hidden />
            {t('mockInbox.add')}
          </Button>
        }
      />

      {state.inboxes.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <InboxIcon className="size-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">{t('mockInbox.emptyTitle')}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t('mockInbox.emptyBody')}</p>
          </CardContent>
        </Card>
      )}

      {state.inboxes.map((inbox) => (
        <Card key={inbox.id} className="gap-4" data-testid="inbox-card">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle className="flex flex-wrap items-center gap-2">
                <InboxChip inbox={inbox} />
                <span className="text-base font-normal text-muted-foreground tabular-nums">
                  {inbox.number ||
                    (inbox.type === 'business_api' ? '' : t('mockInbox.numberAfterScan'))}
                </span>
              </CardTitle>
              <CardDescription className="flex items-center gap-1.5">
                {inbox.type === 'business_api' ? (
                  <Cloud className="size-4" aria-hidden />
                ) : (
                  <Smartphone className="size-4" aria-hidden />
                )}
                {inbox.type === 'business_api'
                  ? t('mockApi.typeBusinessApi')
                  : t('mockInbox.typeLinkedPhone')}
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="touch"
                className="px-2 md:min-h-8"
                onClick={() => setEditing(inbox)}
              >
                {t('mockInbox.edit')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="touch"
                className="px-2 text-danger hover:bg-danger/10 hover:text-danger md:min-h-8"
                onClick={() => setRemoving(inbox)}
              >
                {t('mockInbox.remove')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="grid max-w-xl grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t('mockInbox.status')}</dt>
              <dd>
                <StatusDot
                  tone={STATUS_TONE[inbox.status]}
                  label={
                    <span className="font-medium">{t(`mockInbox.state.${inbox.status}`)}</span>
                  }
                />
              </dd>
              <dt className="text-muted-foreground">{t('mockAgents.inboxes.agent')}</dt>
              <dd data-testid="inbox-agent">
                {(() => {
                  const agent = agentOfInbox(agentState, inbox.id);
                  return agent ? (
                    <Link
                      to={`/admin/members/ai/${agent.id}`}
                      className="inline-flex items-center font-medium text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11"
                    >
                      {agent.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('mockAgents.inboxes.agentNone')}
                    </span>
                  );
                })()}
              </dd>
              {inbox.api && (
                <>
                  <dt className="text-muted-foreground">{t('mockApi.quality')}</dt>
                  <dd>
                    <StatusDot
                      tone={
                        inbox.api.quality === 'high'
                          ? 'success'
                          : inbox.api.quality === 'medium'
                            ? 'warning'
                            : 'danger'
                      }
                      label={t(`mockApi.qualityValue.${inbox.api.quality}`)}
                    />
                  </dd>
                  <dt className="text-muted-foreground">{t('mockApi.templates')}</dt>
                  <dd className="flex flex-wrap items-center gap-2" data-testid="inbox-templates">
                    <span>{t('mockApi.templatesCount', { count: state.templates.length })}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="touch"
                      className="px-2 md:min-h-8"
                      onClick={() => toast.success(t('mockApi.templatesSynced'))}
                    >
                      <RefreshCw aria-hidden />
                      {t('mockApi.templatesSync')}
                    </Button>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('mockInbox.whoCanOpen')}</dt>
              <dd className="flex flex-wrap gap-1.5">
                {whoCanOpen(inbox).map((u) => (
                  <Badge key={u.id} variant="outline">
                    {u.displayName}
                    {u.role === 'admin' ? ` · ${t('mockInbox.admin')}` : ''}
                  </Badge>
                ))}
              </dd>
            </dl>
            {inbox.status === 'waiting_scan' && (
              <Banner tone="warning" title={t('mockInbox.scanTitle')}>
                {t('mockInbox.scanBody')}
              </Banner>
            )}
            {inbox.status === 'token_invalid' && (
              <Banner tone="danger" title={t('mockApi.tokenInvalidTitle')}>
                {t('mockApi.tokenInvalidBody')}
              </Banner>
            )}
            {inbox.type === 'business_api' && inbox.status === 'connected' && (
              <WebhookStatus failing={inbox.api?.webhookFailing} />
            )}
            {inbox.status === 'phone_offline' && (
              <Banner tone="danger" title={t('mockInbox.offlineTitle')}>
                {t('mockInbox.offlineBody')}
              </Banner>
            )}
            {inbox.type === 'business_api' && agentOfInbox(agentState, inbox.id) && (
              <p className="text-sm text-muted-foreground">{t('mockApi.aiWindowNote')}</p>
            )}
            <p className="text-sm text-muted-foreground">{t('mockInbox.accessHint')}</p>
          </CardContent>
        </Card>
      ))}

      <InboxDialog inbox={editing} people={people} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={removing !== null}
        title={t('mockInbox.removeTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('mockInbox.removeConfirm')}
        danger
        onConfirm={() => {
          if (removing) {
            setInboxAgent(removing.id, null);
            removeInbox(removing.id);
          }
          toast.success(t('mockInbox.removed'));
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      >
        {removing?.type === 'business_api'
          ? t('mockApi.removeBody')
          : t('mockInbox.removeBodyPhone')}
        {removing && agentOfInbox(agentState, removing.id) && (
          <span className="mt-2 block">
            {t('mockAgents.inboxes.removeAgent', {
              agent: agentOfInbox(agentState, removing.id)!.name,
            })}
          </span>
        )}
      </ConfirmDialog>
    </div>
  );
}

/**
 * Add an inbox (name and members, then the QR code) or edit one (rename, members, link the phone again).
 */
function InboxDialog({
  inbox,
  people,
  onClose,
}: Readonly<{ inbox: MockInbox | 'new' | null; people: User[]; onClose: () => void }>) {
  const { t } = useTranslation(['admin', 'common']);
  const state = useMockInboxes();
  const agentState = useMockAgents();
  const isNew = inbox === 'new';
  const current = inbox !== null && inbox !== 'new' ? inbox : null;
  const [name, setName] = useState('');
  const [members, setMembers] = useState<number[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState<MockInbox | null>(null);
  const [relink, setRelink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState('none');
  // Proposed (business-api): the type of a new inbox, and Replace token on an existing one.
  const [type, setType] = useState<MockInbox['type']>('linked_phone');
  const [replacingToken, setReplacingToken] = useState(false);
  // Proposed (business-api, owner 2026-10-25): move an existing inbox between the two types.
  const [switching, setSwitching] = useState(false);

  const admins = people.filter((u) => u.role === 'admin');
  const agents = people.filter((u) => u.role !== 'admin');

  useEffect(() => {
    setName(current?.name ?? '');
    setMembers(
      current
        ? agents
            .filter((u) => {
              const a = state.access[u.id];
              return Array.isArray(a) && a.includes(current.id);
            })
            .map((u) => u.id)
        : [],
    );
    setSubmitted(false);
    setAgentId((current && agentOfInbox(agentState, current.id)?.id) ?? 'none');
    setSaved(current);
    setRelink(false);
    setType(current?.type ?? 'linked_phone');
    setReplacingToken(false);
    setSwitching(false);
  }, [inbox]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMember = (id: number, on: boolean) =>
    setMembers((m) => (on ? [...new Set([...m, id])] : m.filter((x) => x !== id)));

  const nameError = submitted && name.trim() === '' ? t('mockInbox.required') : undefined;

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim()) return;
    const agentIds = agents.map((u) => u.id);
    const agent = agentId === 'none' ? null : agentId;
    if (current) {
      updateInbox(current.id, { name: name.trim() });
      setInboxMembers(current.id, agentIds, members);
      setInboxAgent(current.id, agent);
      setSaved({ ...current, name: name.trim() });
      toast.success(t('mockInbox.saved'));
      onClose();
    } else {
      const created = addInbox(name.trim());
      setInboxMembers(created.id, agentIds, members);
      setInboxAgent(created.id, agent);
      setSaved(created);
      toast.success(t('mockInbox.createdPhone'));
    }
  };

  /** Mock: the phone scans the code after a moment, and WhatsApp tells the number. */
  const simulate = () => {
    if (!saved) return;
    setBusy(true);
    setTimeout(() => {
      const patch: Partial<MockInbox> = {
        status: 'connected',
        number: saved.number || '+60 11-2233 4455',
      };
      updateInbox(saved.id, patch);
      setSaved({ ...saved, ...patch });
      setRelink(false);
      setBusy(false);
      toast.success(t('mockInbox.scanOk'));
    }, 900);
  };

  const isApi = (saved?.type ?? type) === 'business_api';
  const showQr = !isApi && !!saved && (saved.status !== 'connected' || relink);
  /** A Business API number is added by Check and connect, after its details are checked. */
  const connectApi = ({ api, number }: { api: MockApiConnection; number: string }) => {
    setSubmitted(true);
    if (!name.trim()) return;
    const created = addInbox(name.trim(), api, number);
    setInboxMembers(
      created.id,
      agents.map((u) => u.id),
      members,
    );
    setInboxAgent(created.id, agentId === 'none' ? null : agentId);
    setSaved(created);
    toast.success(t('mockApi.created'));
  };
  const replaceToken = ({ api }: { api: MockApiConnection }) => {
    if (!saved) return;
    const patch: Partial<MockInbox> = { api: { ...api }, status: 'connected' };
    updateInbox(saved.id, patch);
    setSaved({ ...saved, ...patch });
    setReplacingToken(false);
    toast.success(t('mockApi.tokenReplaced'));
  };
  /** Linked phone → Business API: same inbox, same number; chats, notes and assignments stay. */
  const switchToApi = ({ api }: { api: MockApiConnection }) => {
    if (!saved) return;
    const patch: Partial<MockInbox> = { type: 'business_api', api, status: 'connected' };
    updateInbox(saved.id, patch);
    setSaved({ ...saved, ...patch });
    setSwitching(false);
    toast.success(t('mockApi.switchedToApi'));
  };
  /** Business API → linked phone: the inbox waits for a QR scan of the same number. */
  const switchToPhone = () => {
    if (!saved) return;
    const patch: Partial<MockInbox> = {
      type: 'linked_phone',
      api: undefined,
      status: 'waiting_scan',
    };
    updateInbox(saved.id, patch);
    setSaved({ ...saved, ...patch });
    setSwitching(false);
    toast.success(t('mockApi.switchedToPhone'));
  };
  const inboxName = (id: string | null) => state.inboxes.find((i) => i.id === id)?.name ?? '';
  const chosen = agentState.agents.find((a) => a.id === agentId);
  const previous = current ? agentOfInbox(agentState, current.id) : undefined;
  const formId = 'mock-inbox-form';
  return (
    <ResponsiveDialog
      open={inbox !== null}
      onOpenChange={(next) => !next && onClose()}
      title={
        isNew && !saved
          ? t('mockInbox.addTitle')
          : t('mockInbox.editTitle', { name: saved?.name ?? name })
      }
      description={isApi ? t('mockApi.dialogDescription') : t('mockInbox.dialogDescription')}
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
          {/* A new Business API inbox is saved by Check and connect, after the details are checked. */}
          {!(saved && isNew) && !(isNew && isApi) && (
            <Button type="submit" form={formId} size="touch" className="sm:min-h-9">
              {t('mockInbox.save')}
            </Button>
          )}
        </>
      }
    >
      {isNew && !saved && (
        <fieldset className="mb-5 flex min-w-0 flex-col gap-2" data-testid="inbox-type">
          <legend className="mb-1 text-sm font-medium">{t('mockApi.typeField')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['linked_phone', 'business_api'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant="outline"
                aria-pressed={type === value}
                onClick={() => setType(value)}
                className={cn(
                  'h-auto min-h-11 flex-col items-start gap-1 px-3 py-2.5 text-left whitespace-normal',
                  type === value && 'border-primary bg-primary/5 ring-1 ring-primary',
                )}
              >
                <span className="flex items-center gap-2 font-medium">
                  {value === 'business_api' ? (
                    <Cloud className="size-4" aria-hidden />
                  ) : (
                    <Smartphone className="size-4" aria-hidden />
                  )}
                  {value === 'business_api'
                    ? t('mockApi.typeBusinessApi')
                    : t('mockInbox.typeLinkedPhone')}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {value === 'business_api' ? t('mockApi.typeApiHint') : t('mockApi.typePhoneHint')}
                </span>
              </Button>
            ))}
          </div>
        </fieldset>
      )}
      <form id={formId} onSubmit={save} noValidate className="flex min-w-0 flex-col gap-5 pb-1">
        <Field label={t('mockInbox.name')} hint={t('mockInbox.nameHint')} error={nameError}>
          {(p) => (
            <Input {...p} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>

        {!(saved && isNew) && (
          <fieldset className="flex min-w-0 flex-col gap-3" data-testid="inbox-members">
            <legend className="mb-1 text-sm font-medium">{t('mockInbox.membersField')}</legend>
            <p className="text-sm text-muted-foreground">{t('mockInbox.membersFieldHint')}</p>
            {admins.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {admins.map((u) => (
                  <Badge key={u.id} variant="outline">
                    {u.displayName} · {t('mockInbox.admin')}
                  </Badge>
                ))}
              </div>
            )}
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('mockInbox.membersFieldNoAgents')}</p>
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
                    <Label htmlFor={id} className="font-normal">
                      {u.displayName}
                    </Label>
                  </div>
                );
              })
            )}
            {agents.length > 0 && members.length === 0 && (
              <p className="text-sm text-warning">{t('mockInbox.membersFieldNone')}</p>
            )}
          </fieldset>
        )}

        {!(saved && isNew) && (
          <div className="flex min-w-0 flex-col gap-2" data-testid="inbox-agent-field">
            <Label htmlFor="mock-inbox-agent">{t('mockAgents.inboxes.agentField')}</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger id="mock-inbox-agent" className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="min-h-11 md:min-h-8">
                  {t('mockAgents.inboxes.agentNone')}
                </SelectItem>
                {agentState.agents.map((a) => (
                  <SelectItem key={a.id} value={a.id} className="min-h-11 md:min-h-8">
                    {a.inboxId && a.inboxId !== current?.id && inboxName(a.inboxId)
                      ? t('mockAgents.inboxes.agentOption', {
                          agent: a.name,
                          inbox: inboxName(a.inboxId),
                        })
                      : a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {t('mockAgents.inboxes.agentFieldHint')}
            </p>
            {chosen?.inboxId && chosen.inboxId !== current?.id && inboxName(chosen.inboxId) && (
              <Banner tone="warning">
                {t('mockAgents.inboxes.agentMove', {
                  agent: chosen.name,
                  inbox: inboxName(chosen.inboxId),
                })}
              </Banner>
            )}
            {previous && previous.id !== agentId && (
              <Banner tone="warning">
                {t('mockAgents.inboxes.agentReplace', { agent: previous.name })}
              </Banner>
            )}
          </div>
        )}

        {!isApi && saved && saved.status === 'connected' && !relink && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StatusDot
              tone="success"
              label={
                <span className="text-sm font-medium">
                  {t('mockInbox.linkedAs', { number: saved.number })}
                </span>
              }
            />
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="md:min-h-9"
              onClick={() => setRelink(true)}
            >
              {t('mockInbox.relink')}
            </Button>
          </div>
        )}

        {showQr && (
          <div
            className="flex min-w-0 flex-col items-center gap-3 rounded-lg border bg-muted/40 p-4 text-center"
            data-testid="inbox-qr"
          >
            <p className="font-medium">{t('mockInbox.scanTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('mockInbox.scanSteps')}</p>
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG value={`mock-link-${saved.id}`} size={176} />
            </div>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="md:min-h-9"
              disabled={busy}
              onClick={simulate}
            >
              {busy ? t('mockInbox.scanning') : t('mockInbox.simulateScan')}
            </Button>
          </div>
        )}
      </form>

      {!isApi && !isNew && saved && (
        <section
          className="mt-5 flex min-w-0 flex-col gap-3 border-t pt-5"
          aria-labelledby="switch-type"
          data-testid="switch-to-api"
        >
          <h3 id="switch-type" className="text-sm font-medium">
            {t('mockApi.switchTitle')}
          </h3>
          {!switching ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Smartphone className="size-4" aria-hidden />
                {t('mockInbox.typeLinkedPhone')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="md:min-h-9"
                onClick={() => setSwitching(true)}
              >
                <Cloud aria-hidden />
                {t('mockApi.switchToApi')}
              </Button>
            </div>
          ) : (
            <>
              <Banner tone="warning" title={t('mockApi.switchToApiTitle')}>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>{t('mockApi.switchToApi1')}</li>
                  <li>{t('mockApi.switchToApi2')}</li>
                  <li>{t('mockApi.switchToApi3')}</li>
                </ol>
              </Banner>
              <BusinessApiForm
                expectNumber={saved.number || undefined}
                submitLabel={t('mockApi.switchCheck')}
                onConnected={switchToApi}
              />
              <Button
                type="button"
                variant="ghost"
                size="touch"
                className="self-start md:min-h-9"
                onClick={() => setSwitching(false)}
              >
                {t('common:actions.cancel')}
              </Button>
            </>
          )}
        </section>
      )}
      {isApi && isNew && !saved && (
        <section
          className="mt-5 flex min-w-0 flex-col gap-3 border-t pt-5"
          aria-labelledby="api-connect"
        >
          <h3 id="api-connect" className="text-sm font-medium">
            {t('mockApi.connectTitle')}
          </h3>
          <BusinessApiForm onConnected={connectApi} />
        </section>
      )}
      {isApi && saved?.api && (
        <section
          className="mt-5 flex min-w-0 flex-col gap-3 border-t pt-5"
          aria-labelledby="api-meta"
          data-testid="api-connection"
        >
          <h3 id="api-meta" className="text-sm font-medium">
            {t('mockApi.metaTitle')}
          </h3>
          <ApiNumberSummary api={saved.api} number={saved.number} />
          <WebhookStatus failing={saved.api.webhookFailing} />
          {!isNew && !replacingToken && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                {t('mockApi.tokenSaved', { end: saved.api.tokenEnd })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="md:min-h-9"
                onClick={() => setReplacingToken(true)}
              >
                {t('mockApi.replaceToken')}
              </Button>
            </div>
          )}
          {!isNew && replacingToken && (
            <BusinessApiForm
              replacing={saved.api}
              submitLabel={t('mockApi.replaceCheck')}
              onConnected={replaceToken}
            />
          )}
          {!isNew && !switching && (
            <Button
              type="button"
              variant="ghost"
              size="touch"
              className="self-start px-0 md:min-h-9"
              onClick={() => setSwitching(true)}
            >
              <Smartphone aria-hidden />
              {t('mockApi.switchToPhone')}
            </Button>
          )}
          {!isNew && switching && (
            <Banner tone="warning" title={t('mockApi.switchToPhoneTitle')}>
              <span className="flex flex-col gap-2">
                <span>{t('mockApi.switchToPhoneBody')}</span>
                <span className="flex flex-wrap gap-2">
                  <Button type="button" size="touch" className="md:min-h-9" onClick={switchToPhone}>
                    {t('mockApi.switchToPhoneConfirm')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="md:min-h-9"
                    onClick={() => setSwitching(false)}
                  >
                    {t('common:actions.cancel')}
                  </Button>
                </span>
              </span>
            </Banner>
          )}
          {!isNew && (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
              <p className="text-xs font-medium text-muted-foreground">{t('mockApi.mockOnly')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    updateInbox(saved.id, { status: 'token_invalid' });
                    setSaved({ ...saved, status: 'token_invalid' });
                  }}
                >
                  {t('mockApi.simulateTokenInvalid')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const api = { ...saved.api!, webhookFailing: !saved.api!.webhookFailing };
                    updateInbox(saved.id, { api });
                    setSaved({ ...saved, api });
                  }}
                >
                  {t('mockApi.simulateWebhookFail')}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </ResponsiveDialog>
  );
}

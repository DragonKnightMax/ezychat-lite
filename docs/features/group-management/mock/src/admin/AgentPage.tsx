import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Lock,
  MessageCircleQuestionMark,
  PencilLine,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { AiEditField, type AiMemberStatus } from '@ezychat/shared';
import { useAiMember } from '../api/ai';
import { errorMessage } from '../api/client';
import { Banner, EmptyState, PageHeader, StatusDot } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  AGENT_HANDOFF_CHARACTERS,
  AGENT_INSTRUCTIONS_CHARACTERS,
  AGENT_PRESETS,
  PRESET_TEXTS,
  createAgent,
  deleteAgent,
  maxAgents,
  type AgentDraft,
  type AgentPreset,
  type MockAgent,
} from '../mock/agents';
import { EditionSwitch } from '../mock/EditionSwitch';
// Proposed (upgrade-enterprise)
import { UpgradeButton } from '@/components/app/UpgradeEnterprise';
import { useMockInboxes } from '../mock/inboxes';
import { useSaveAgentMember, useShownAgents } from '../mock/useAgents';
import { InboxChip } from '../inbox/InboxChip';
import { AgentContextPanel } from './AgentContextPanel';
import { AgentTryIt } from './AgentTryIt';
import { AgentConnectorsCard } from './AgentConnectorsCard';
import { AgentGroupsCard } from './AgentGroupsCard';
import { AgentResolutionCard } from './AgentResolutionCard';
import { AiConnectionBanner } from './AiConnectionBanner';
import { AiEditDialog } from './AiEditDialog';
import { AiQuickConnect } from './AiQuickConnect';
import { connectionReady } from './ai-status';
import { ConfirmDialog, ErrorState, Field, ListSkeleton, Pending, SaveBar } from './adminUi';
// Proposed (claude-provider): the connection line names the Claude key while that mode is saved.
import { useMockClaude } from '../mock/claude';
import { InfoTip } from '@/components/app/InfoTip';

const PRESET_ICON: Record<AgentPreset, LucideIcon> = {
  sales: ShoppingBag,
  faq: MessageCircleQuestionMark,
  custom: PencilLine,
};
const PILL_TONE = {
  on: 'success',
  off: 'muted',
  needsConnection: 'danger',
  needsKnowledge: 'warning',
} as const;
export type AgentPill = keyof typeof PILL_TONE;
/** One status for the agent page and Members (round 2): connection first, then Business context. */
export function agentPill(ready: boolean, agent: Pick<MockAgent, 'items' | 'enabled'>): AgentPill {
  if (!ready) return 'needsConnection';
  if (!agent.items.some((i) => i.text.trim().length > 0)) return 'needsKnowledge';
  return agent.enabled ? 'on' : 'off';
}
const SECTION_CONTEXT = 'agent-context-section';
const SECTION_TRY = 'agent-try-section';
/** Brings a section into view and moves focus there (Next steps links). */
function showSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}
/** A title with Edit with AI beside it: one centred row (the card grid would put the title higher). */
const EDIT_HEADER = 'flex flex-wrap items-center justify-between gap-2';
const isPreset = (value: unknown): value is AgentPreset =>
  typeof value === 'string' && (AGENT_PRESETS as readonly string[]).includes(value);

/** `/admin/members/ai` (spec): Lite → its only agent, or the create page; Enterprise → Members. */
export function AgentRedirect() {
  const { shown, lite } = useShownAgents();
  if (!lite) return <Navigate to="/admin/members" replace />;
  const first = shown[0];
  return (
    <Navigate to={first ? `/admin/members/ai/${first.id}` : '/admin/members/ai/new'} replace />
  );
}

// Unsaved edits survive leaving the page, as on the AI Sales Agent page (the router cannot block
// navigation). Mock key per agent (or per create preset); a draft of another shape is dropped.
interface StoredDraft {
  preset: AgentPreset;
  draft: AgentDraft;
}
const draftKey = (id: string) => `mock.customAgents.draft.${id}`;
function readStoredDraft(key: string): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as { preset?: unknown; draft?: Record<string, unknown> };
    const d = value.draft;
    if (
      !isPreset(value.preset) ||
      !d ||
      typeof d.name !== 'string' ||
      typeof d.instructions !== 'string' ||
      typeof d.handoffRules !== 'string' ||
      (d.inboxId !== null && typeof d.inboxId !== 'string')
    )
      return null;
    return {
      preset: value.preset,
      draft: {
        name: d.name,
        instructions: d.instructions,
        handoffRules: d.handoffRules,
        inboxId: d.inboxId,
      },
    };
  } catch {
    return null;
  }
}
function writeStoredDraft(key: string, stored: StoredDraft | null) {
  try {
    if (stored) sessionStorage.setItem(key, JSON.stringify(stored));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable: edits just are not restored */
  }
}

/**
 * Proposed (custom-agents): `/admin/members/ai/:agentId` and `/admin/members/ai/new?preset=…`. Built
 * from the AI Sales Agent page (`AiMemberPage.tsx`: header with the knowledge-required Turn on, the
 * inline connect card, Business context, Try it, the Advanced texts, draft store and leave warning),
 * plus the agent parts: preset, Inbox select (Enterprise), safety rules, Internal items and Delete.
 */
export function AgentPage() {
  const { t } = useTranslation('admin');
  const query = useAiMember();
  const { agentId = '' } = useParams();
  const [params] = useSearchParams();
  const { shown: list, lite } = useShownAgents();
  const { inboxes } = useMockInboxes();
  const isNew = agentId === 'new';
  const agent = isNew ? undefined : list.find((a) => a.id === agentId);
  const presetParam = params.get('preset');
  const preset = isPreset(presetParam) ? presetParam : 'sales';

  if (!query.data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <ListSkeleton />
    );
  if (!isNew && !agent)
    return (
      <div className="flex flex-col gap-4">
        <EditionSwitch />
        <EmptyState
          title={t('mockAgents.page.notFoundTitle')}
          description={t('mockAgents.page.notFoundBody')}
          action={
            <Button asChild variant="outline" size="touch">
              <Link to="/admin/members">{t('mockAgents.page.backToMembers')}</Link>
            </Button>
          }
        />
      </div>
    );
  if (isNew && list.length >= maxAgents(lite, inboxes.length))
    return (
      <div className="flex flex-col gap-4">
        <EditionSwitch />
        <EmptyState
          title={t('mockAgents.page.limitTitle')}
          description={lite ? t('mockAgents.page.limitBodyLite') : t('mockAgents.page.limitBody')}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {/* Proposed (upgrade-enterprise): Lite only (the button hides itself in Enterprise). */}
              <UpgradeButton />
              <Button asChild variant="outline" size="touch">
                <Link to="/admin/members">{t('mockAgents.page.backToMembers')}</Link>
              </Button>
            </div>
          }
        />
      </div>
    );
  return (
    <AgentEditor
      key={isNew ? `new-${preset}` : agentId}
      agent={agent}
      initialPreset={preset}
      status={query.data}
      refreshError={query.isError ? query.error : null}
    />
  );
}

function AgentEditor({
  agent,
  initialPreset,
  status,
  refreshError,
}: Readonly<{
  agent: MockAgent | undefined;
  initialPreset: AgentPreset;
  status: AiMemberStatus;
  refreshError: unknown;
}>) {
  const { t } = useTranslation(['admin', 'common']);
  const navigate = useNavigate();
  const location = useLocation();
  const topRef = useRef<HTMLDivElement>(null);
  const ready = connectionReady(status);
  const { agents, firstInboxId, lite } = useShownAgents();
  const member = useSaveAgentMember();
  const { inboxes } = useMockInboxes();
  const inboxId = useId();
  const pickId = useId();
  const reasonId = useId();
  const editReasonId = useId();
  const isNew = !agent;
  const storeKey = draftKey(agent ? agent.id : `new-${initialPreset}`);

  const freeInbox = inboxes.find((i) => !agents.some((a) => a.inboxId === i.id))?.id ?? null;
  const fromAgent = (a: MockAgent): AgentDraft => ({
    name: a.name,
    instructions: a.instructions,
    handoffRules: a.handoffRules,
    inboxId: a.inboxId,
  });
  const blank = (p: AgentPreset): AgentDraft => ({
    name: '',
    ...PRESET_TEXTS[p],
    // Lite: the only agent always answers the only inbox.
    inboxId: lite ? firstInboxId : freeInbox,
  });
  const [initial] = useState<StoredDraft | null>(() => readStoredDraft(storeKey));
  const [preset, setPreset] = useState<AgentPreset>(
    initial?.preset ?? agent?.preset ?? initialPreset,
  );
  const [draft, setDraft] = useState<AgentDraft>(
    () => initial?.draft ?? (agent ? fromAgent(agent) : blank(initialPreset)),
  );
  const [saved, setSaved] = useState<AgentDraft>(() =>
    agent ? fromAgent(agent) : blank(initialPreset),
  );
  const [submitted, setSubmitted] = useState(false);
  const [templateFor, setTemplateFor] = useState<AgentPreset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // The field stays set while the dialog closes so its content doesn't vanish mid-animation.
  const [editField, setEditField] = useState<AiEditField>('instructions');
  const [editOpen, setEditOpen] = useState(false);
  // Round 2: Advanced starts collapsed, also on the short create page; a restored draft opens it.
  const [advancedOpen] = useState(() => Boolean(initial));
  // Next steps 2: done after a Try it answer in this page session.
  const [tried, setTried] = useState(false);

  // Round 2: after Create agent, show the new page from its top (name, status, next steps).
  useEffect(() => {
    if (!(location.state as { created?: boolean } | null)?.created) return;
    window.scrollTo({ top: 0 });
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [location.state]);

  // Keep the saved copy in step when another screen (Admin → Inboxes) re-binds this agent.
  useEffect(() => {
    if (!agent || agent.inboxId === saved.inboxId) return;
    setSaved((old) => ({ ...old, inboxId: agent.inboxId }));
    setDraft((old) => (old.inboxId === saved.inboxId ? { ...old, inboxId: agent.inboxId } : old));
  }, [agent?.inboxId]); // Only a re-bind from another screen; the draft itself is never a trigger.

  const changed =
    JSON.stringify(draft) !== JSON.stringify(saved) || preset !== (agent?.preset ?? initialPreset);
  useEffect(() => {
    writeStoredDraft(storeKey, changed ? { preset, draft } : null);
  }, [changed, draft, preset, storeKey]);
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);

  const dirty = isNew || changed;
  const template = PRESET_TEXTS[preset];
  const onTemplate =
    draft.instructions === template.instructions && draft.handoffRules === template.handoffRules;
  const usingStartText = preset !== 'custom' && draft.instructions === template.instructions;
  const presetName = (p: AgentPreset) => t(`mockAgents.preset.${p}`);
  const nameError = submitted && !draft.name.trim() ? t('mockAgents.page.nameRequired') : undefined;
  const title = draft.name.trim() || (isNew ? t('mockAgents.page.newTitle') : agent.name);
  const items = agent?.items ?? [];
  const otherOnInbox = draft.inboxId
    ? agents.find((a) => a.inboxId === draft.inboxId && a.id !== agent?.id)
    : undefined;
  const inboxName = (id: string | null) => inboxes.find((i) => i.id === id)?.name ?? '';
  const showInboxUi = !lite && inboxes.length > 0;
  // Round 2: every inbox already has another agent: say how to give this one its own number.
  const noFreeInbox = inboxes.every((i) =>
    agents.some((a) => a.inboxId === i.id && a.id !== agent?.id),
  );

  // As on the AI Sales Agent page: Turn on needs a ready connection AND Business context.
  const knowledge = items.some((i) => i.text.trim().length > 0);
  const canTurnOn = ready && knowledge;
  const enabled = Boolean(agent?.enabled);
  const pill = agentPill(ready, { items, enabled });
  const pillLabels = {
    on: t('ai.page.pill.on'),
    off: t('ai.page.pill.off'),
    needsConnection: t('ai.page.pill.needsConnection'),
    needsKnowledge: t('ai.page.pill.needsKnowledge'),
  };
  // Round 2: no reason line when the status already says "Needs business context".
  const reason = ready ? null : t('mockSetup.agent.connectFirst');
  const showReason = Boolean(agent && !enabled && !canTurnOn && reason);
  const stateLabels: Record<AiMemberStatus['connection']['state'], string> = {
    unavailable: t('ai.state.unavailable'),
    signed_out: t('ai.state.signed_out'),
    signing_in: t('ai.state.signing_in'),
    connected: t('ai.state.connected'),
    error: t('ai.state.error'),
    expired: t('ai.state.expired'),
  };
  const claude = useMockClaude();
  const connectionText = claude.active
    ? t('mockClaude.keySaved')
    : status.settings.mode === 'api'
      ? status.hasApiKey
        ? t('ai.keySaved')
        : t('ai.keyMissing')
      : t('ai.chatgptState', { state: stateLabels[status.connection.state] });

  const applyTemplate = (p: AgentPreset) => {
    setPreset(p);
    setDraft((old) => ({ ...old, ...PRESET_TEXTS[p] }));
  };
  /** Picking a starting point replaces the texts directly while they are unedited; else it asks. */
  const choosePreset = (p: AgentPreset) => {
    if (p === preset) return;
    if (onTemplate) applyTemplate(p);
    else if (isNew) setTemplateFor(p);
    else setPreset(p);
  };
  const [typeOpen, setTypeOpen] = useState(false);
  const presetPicker = () => (
    <RadioGroup
      aria-labelledby={pickId}
      value={preset}
      onValueChange={(v) => choosePreset(v as AgentPreset)}
      className="grid gap-3 sm:grid-cols-3"
    >
      {AGENT_PRESETS.map((p) => {
        const Icon = PRESET_ICON[p];
        const id = `${pickId}-${p}`;
        return (
          <Label
            key={p}
            htmlFor={id}
            className={cn(
              'flex min-h-11 cursor-pointer flex-col items-start gap-2 rounded-lg border bg-card p-4 font-normal transition-colors',
              'hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5',
              'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
            )}
          >
            <span className="flex w-full items-center gap-2">
              <Icon aria-hidden className="size-4 text-primary" />
              <span className="font-medium">{presetName(p)}</span>
              <RadioGroupItem id={id} value={p} className="ml-auto" />
            </span>
            <span className="text-sm text-muted-foreground">
              {t(`mockAgents.preset.${p}Description`)}
            </span>
          </Label>
        );
      })}
    </RadioGroup>
  );

  /** Agent on inbox 1: the server's AI member gets the name and on/off first (useAgents.ts). */
  const persist = async (target: MockAgent, patch: Partial<Omit<MockAgent, 'id' | 'items'>>) => {
    setLocalError(null);
    try {
      await member.save(
        target,
        patch.inboxId !== undefined ? patch.inboxId : target.inboxId,
        patch,
      );
      return true;
    } catch (error) {
      setLocalError(errorMessage(error));
      return false;
    }
  };

  const toggle = async () => {
    if (!agent) return;
    const next = !enabled;
    // Lite: the shown agent is always on inbox 1; turning it on stores that binding too.
    const ok = await persist(agent, { enabled: next, ...(lite ? { inboxId: firstInboxId } : {}) });
    if (ok) toast.success(next ? t('ai.page.turnedOn') : t('ai.page.turnedOff'));
  };

  const save = async () => {
    setSubmitted(true);
    const name = draft.name.trim();
    if (!name) return;
    const next = { ...draft, name, ...(lite ? { inboxId: firstInboxId } : {}) };
    if (isNew) {
      const created = createAgent(preset, next);
      if (created.inboxId && created.inboxId === firstInboxId) await persist(created, { name });
      writeStoredDraft(storeKey, null);
      toast.success(t('mockAgents.page.created', { name }));
      navigate(`/admin/members/ai/${created.id}`, { replace: true, state: { created: true } });
      return;
    }
    if (!(await persist(agent, { ...next, preset }))) return;
    setSaved(next);
    setDraft(next);
    toast.success(t('mockAgents.page.saved'));
  };

  const editWithAi = (field: AiEditField) => (
    // Centred on the title row; compact on desktop, a 44 px target on touch screens.
    <CardAction className="self-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:min-h-11"
        disabled={!ready || member.isPending}
        title={ready ? undefined : t('ai.edit.unavailable')}
        aria-describedby={ready ? undefined : editReasonId}
        onClick={() => {
          setEditField(field);
          setEditOpen(true);
        }}
      >
        <Sparkles aria-hidden />
        {t('ai.edit.open')}
      </Button>
    </CardAction>
  );

  return (
    <div ref={topRef} className="flex flex-col gap-4 pb-4" data-testid="agent-page">
      <EditionSwitch />
      <nav aria-label={t('ai.page.breadcrumb')} className="flex items-center gap-1 text-sm">
        <Link
          to="/admin/members"
          className="inline-flex items-center text-muted-foreground underline-offset-4 hover:text-foreground hover:underline pointer-coarse:min-h-11"
        >
          {t('nav.members')}
        </Link>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
      </nav>
      <PageHeader
        className="pb-0"
        title={<span className="[overflow-wrap:anywhere]">{title}</span>}
        description={isNew ? t('mockAgents.page.newDescription') : t('mockAgents.page.description')}
        actions={
          agent && (
            <div className="flex flex-wrap items-center gap-3">
              <StatusDot tone={PILL_TONE[pill]} label={pillLabels[pill]} />
              {enabled ? (
                <Button
                  variant="outline"
                  size="touch"
                  disabled={member.isPending}
                  onClick={() => void toggle()}
                >
                  {t('ai.page.turnOff')}
                </Button>
              ) : (
                <Button
                  size="touch"
                  disabled={member.isPending || !canTurnOn}
                  aria-describedby={showReason ? reasonId : undefined}
                  onClick={() => void toggle()}
                >
                  <Pending show={member.isPending} />
                  {t('ai.page.turnOn')}
                </Button>
              )}
            </div>
          )
        }
      />
      {showReason && (
        <p id={reasonId} className="text-sm text-muted-foreground" data-testid="turn-on-reason">
          {reason}
        </p>
      )}
      {!isNew && (
        <div className="flex flex-wrap items-center gap-2">
          <PresetBadge preset={preset} />
          {showInboxUi &&
            (agent.inboxId && inboxes.some((i) => i.id === agent.inboxId) ? (
              <InboxChip inbox={inboxes.find((i) => i.id === agent.inboxId)!} />
            ) : (
              <span className="text-sm text-warning">{t('mockAgents.members.noInbox')}</span>
            ))}
        </div>
      )}
      {agent && !enabled && (
        <NextSteps
          hasContext={knowledge}
          tried={tried}
          canTurnOn={canTurnOn}
          pending={member.isPending}
          onTurnOn={() => void toggle()}
        />
      )}
      <AiConnectionBanner
        status={status}
        action={
          <Button asChild size="touch" variant="outline">
            <Link to="/admin/settings/ai">{t('ai.page.openSettings')}</Link>
          </Button>
        }
      />

      {!ready && !isNew && (
        <Card className="gap-4 border-primary/40" data-testid="agent-connect">
          <CardHeader className={EDIT_HEADER}>
            <CardTitle>{t('mockSetup.connect.title')}</CardTitle>
            <Badge variant="outline">{t('mockSetup.proposed')}</Badge>
          </CardHeader>
          <CardContent>
            <AiQuickConnect status={status} />
          </CardContent>
        </Card>
      )}

      {!isNew && (
        <Card className="gap-4" data-testid="agent-type">
          <CardHeader className={EDIT_HEADER}>
            <div className="flex min-w-0 flex-col gap-1.5">
              <CardTitle id={pickId}>{t('mockAgents.page.typeTitle')}</CardTitle>
              <CardDescription>{t('mockAgents.page.typeHint')}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="md:min-h-9"
                aria-expanded={typeOpen}
                onClick={() => setTypeOpen((open) => !open)}
              >
                {t('mockAgents.page.typeChange')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="md:min-h-9"
                onClick={() => {
                  setEditField('instructions');
                  setEditOpen(true);
                }}
              >
                <Sparkles aria-hidden />
                {t('mockAgents.page.typeEditRole')}
              </Button>
            </div>
          </CardHeader>
          {(typeOpen || (!onTemplate && preset !== 'custom')) && (
            <CardContent className="flex flex-col gap-3">
              {typeOpen && presetPicker()}
              {!onTemplate && preset !== 'custom' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm text-muted-foreground">
                    {t('mockAgents.page.typeOwnTexts')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="md:min-h-9"
                    onClick={() => setTemplateFor(preset)}
                  >
                    {t('mockAgents.page.useTemplate', { preset: presetName(preset) })}
                  </Button>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {isNew && (
        <Card className="gap-4" data-testid="preset-picker">
          <CardHeader>
            <CardTitle id={pickId}>{t('mockAgents.page.pickTitle')}</CardTitle>
            <CardDescription>{t('mockAgents.page.pickHint')}</CardDescription>
          </CardHeader>
          <CardContent>{presetPicker()}</CardContent>
        </Card>
      )}

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{t('mockAgents.page.nameTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field
            label={t('mockAgents.page.nameLabel')}
            hint={t('mockAgents.page.nameHint')}
            error={nameError}
          >
            {(p) => (
              <Input
                {...p}
                value={draft.name}
                maxLength={64}
                disabled={member.isPending}
                onChange={(e) => setDraft((old) => ({ ...old, name: e.target.value }))}
              />
            )}
          </Field>
          {showInboxUi && (
            <div className="flex flex-col gap-2" data-testid="agent-inbox">
              <Label htmlFor={inboxId}>{t('mockAgents.page.inboxLabel')}</Label>
              <Select
                value={draft.inboxId ?? 'none'}
                onValueChange={(v) =>
                  setDraft((old) => ({ ...old, inboxId: v === 'none' ? null : v }))
                }
              >
                <SelectTrigger id={inboxId} className="min-h-11 w-full sm:max-w-sm md:min-h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="min-h-11 md:min-h-8">
                    {t('mockAgents.page.inboxNone')}
                  </SelectItem>
                  {inboxes.map((inbox) => {
                    const other = agents.find((a) => a.inboxId === inbox.id && a.id !== agent?.id);
                    return (
                      <SelectItem key={inbox.id} value={inbox.id} className="min-h-11 md:min-h-8">
                        {other
                          ? t('mockAgents.page.inboxHas', { inbox: inbox.name, agent: other.name })
                          : inbox.name}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">{t('mockAgents.page.inboxHint')}</p>
              {noFreeInbox && (
                <p className="text-sm text-muted-foreground" data-testid="agent-no-free-inbox">
                  {t('mockAgents.page.inboxAllTaken')}{' '}
                  <Link
                    to="/admin/inboxes"
                    className="inline-flex items-center font-medium text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11"
                  >
                    {t('mockAgents.page.addInbox')}
                  </Link>
                </p>
              )}
              {otherOnInbox && (
                <Banner tone="warning">
                  {t('mockAgents.page.inboxMove', {
                    agent: otherOnInbox.name,
                    inbox: inboxName(draft.inboxId),
                  })}
                </Banner>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Round 2: the create page is short; Business context and Try it come after Create. */}
      {agent && (
        <div id={SECTION_CONTEXT} tabIndex={-1} className="scroll-mt-4 outline-none">
          <AgentContextPanel agentId={agent.id} items={items} />
        </div>
      )}

      {/* Proposed (google-calendar): this agent's connectors; settings live on each connector's page. */}
      {agent && <AgentConnectorsCard agentId={agent.id} name={draft.name.trim() || title} />}

      {/* Proposed (ai-handoff-rules): the resolution question and closing chats, per agent. */}
      {agent && <AgentResolutionCard agent={agent} name={draft.name.trim() || title} />}

      {/* Proposed (ai-groups): answer in WhatsApp groups when mentioned, and in which groups. */}
      {agent && <AgentGroupsCard agent={agent} name={draft.name.trim() || title} />}

      {agent && (
        <Card id={SECTION_TRY} tabIndex={-1} className="scroll-mt-4 gap-4 outline-none">
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle>{t('mockAgents.page.tryTitle')}</CardTitle>
              <InfoTip topic="tryIt" />
            </div>
          </CardHeader>
          <CardContent>
            <AgentTryIt
              agentId={agent.id}
              name={draft.name.trim() || title}
              preset={preset}
              instructions={draft.instructions}
              handoffRules={draft.handoffRules}
              items={items}
              onAnswered={() => setTried(true)}
            />
          </CardContent>
        </Card>
      )}

      <details
        className="group rounded-lg border bg-card"
        open={advancedOpen}
        data-testid="agent-advanced"
      >
        <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">{t('mockAgents.page.advanced')}</span>
          <span className="text-sm text-muted-foreground">
            {preset === 'custom' && !draft.instructions.trim()
              ? t('mockAgents.page.advancedBlank')
              : onTemplate
                ? t('mockSetup.agent.recommended')
                : t('mockSetup.agent.customised')}
          </span>
          <Badge variant="outline" className="ml-auto">
            {t('mockSetup.proposed')}
          </Badge>
        </summary>
        <div className="flex flex-col gap-4 border-t p-4">
          <Card className="gap-4">
            <CardHeader className={EDIT_HEADER}>
              <div className="flex items-center gap-1.5">
                <CardTitle>{t('mockAgents.page.roleTitle')}</CardTitle>
                <InfoTip topic="instructions" />
              </div>
              {editWithAi(AiEditField.enum.instructions)}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {usingStartText && (
                <p className="inline-flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {t('mockAgents.page.usingTemplate', { preset: presetName(preset) })}
                </p>
              )}
              <Field label={t('mockAgents.page.roleLabel')} hint={t('mockAgents.page.roleHint')}>
                {(p) => (
                  <Textarea
                    {...p}
                    value={draft.instructions}
                    maxLength={AGENT_INSTRUCTIONS_CHARACTERS}
                    // Fixed, modest height: the long starting text scrolls inside the box.
                    className="field-sizing-fixed h-48 max-h-[70dvh] resize-y overflow-y-auto text-base leading-6 md:h-56 md:text-sm"
                    placeholder={t('mockAgents.page.rolePlaceholder')}
                    disabled={member.isPending}
                    onChange={(e) => setDraft((old) => ({ ...old, instructions: e.target.value }))}
                  />
                )}
              </Field>
              {isNew && !onTemplate && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="self-start md:min-h-9"
                    disabled={member.isPending}
                    onClick={() => setTemplateFor(preset)}
                  >
                    {t('mockAgents.page.useTemplate', { preset: presetName(preset) })}
                  </Button>
                  {preset === 'custom' && (
                    <span className="text-sm text-muted-foreground">
                      {t('mockAgents.page.customTemplateNote')}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="gap-4">
            <CardHeader className={EDIT_HEADER}>
              <div className="flex items-center gap-1.5">
                <CardTitle>{t('mockAgents.page.handoffTitle')}</CardTitle>
                <InfoTip topic="handoff" />
              </div>
              {editWithAi(AiEditField.enum.handoffRules)}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Banner tone="info">{t('ai.page.handoffSystem')}</Banner>
              <Field
                label={t('mockAgents.page.handoffTitle')}
                labelClassName="sr-only"
                hint={t('mockAgents.page.handoffHint')}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    value={draft.handoffRules}
                    maxLength={AGENT_HANDOFF_CHARACTERS}
                    className="field-sizing-fixed h-40 resize-y overflow-y-auto text-base leading-6 md:text-sm"
                    placeholder={t('mockAgents.page.handoffPlaceholder')}
                    disabled={member.isPending}
                    onChange={(e) => setDraft((old) => ({ ...old, handoffRules: e.target.value }))}
                  />
                )}
              </Field>
            </CardContent>
          </Card>
        </div>
      </details>

      {agent && (
        <>
          <SafetyRules />

          <details className="rounded-lg border bg-card px-4">
            <summary className="flex min-h-11 cursor-pointer items-center font-medium">
              {t('ai.page.howItWorks')}
            </summary>
            <p className="pb-4 text-sm leading-relaxed text-muted-foreground">{t('ai.behavior')}</p>
          </details>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>{t('ai.page.connectionLine', { state: connectionText })}</span>
            <Link
              to="/admin/settings/ai"
              className="inline-flex items-center font-medium text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11"
            >
              {t('ai.page.openSettings')}
            </Link>
          </p>
        </>
      )}

      {isNew && (
        <p className="text-sm text-muted-foreground" data-testid="agent-create-note">
          {t('mockAgents.page.createNote')}
        </p>
      )}

      {agent && !lite && (
        <Card className="gap-3 border-danger/40" data-testid="agent-delete">
          <CardHeader>
            <CardTitle>{t('mockAgents.page.deleteTitle')}</CardTitle>
            <CardDescription>{t('mockAgents.page.deleteHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="touch"
              className="text-danger hover:bg-danger/10 hover:text-danger md:min-h-9"
              onClick={() => setDeleting(true)}
            >
              <Trash2 aria-hidden />
              {t('mockAgents.page.delete')}
            </Button>
          </CardContent>
        </Card>
      )}

      {Boolean(refreshError) && (
        <Banner tone="danger">{t('ai.refreshError', { error: errorMessage(refreshError) })}</Banner>
      )}
      {localError && <Banner tone="danger">{localError}</Banner>}

      {!ready && (
        <span id={editReasonId} className="sr-only">
          {t('ai.edit.unavailable')}
        </span>
      )}

      <SaveBar dirty={dirty}>
        <Button size="touch" disabled={!dirty || member.isPending} onClick={() => void save()}>
          <Pending show={member.isPending} />
          {isNew ? t('mockAgents.page.create') : t('mockAgents.page.save')}
        </Button>
      </SaveBar>

      <ConfirmDialog
        open={templateFor !== null}
        title={t('mockAgents.page.templateTitle', { preset: presetName(templateFor ?? preset) })}
        confirmLabel={t('mockAgents.page.templateConfirm')}
        onConfirm={() => {
          if (templateFor) applyTemplate(templateFor);
          setTemplateFor(null);
          toast.success(t('mockAgents.page.templateApplied'));
        }}
        onClose={() => setTemplateFor(null)}
      >
        {t('mockAgents.page.templateBody', { preset: presetName(templateFor ?? preset) })}
      </ConfirmDialog>
      {agent && (
        <ConfirmDialog
          open={deleting}
          danger
          title={t('mockAgents.page.deleteConfirmTitle', { name: agent.name })}
          confirmLabel={t('mockAgents.page.delete')}
          onConfirm={() => {
            deleteAgent(agent.id);
            writeStoredDraft(storeKey, null);
            toast.success(t('mockAgents.page.deleted', { name: agent.name }));
            navigate('/admin/members', { replace: true });
          }}
          onClose={() => setDeleting(false)}
        >
          {t('mockAgents.page.deleteConfirmBody', { name: agent.name, count: items.length })}
        </ConfirmDialog>
      )}
      <AiEditDialog
        field={editField}
        current={draft[editField]}
        open={editOpen}
        onOpenChange={setEditOpen}
        onApply={(text) => {
          setDraft((old) => ({ ...old, [editField]: text }));
          toast.success(t('ai.edit.applied'));
        }}
      />
    </div>
  );
}

/**
 * Round 2: while an agent is off, the three steps to a working agent (Business context, a test
 * question, Turn on). Each text brings its section into view; Turn on follows the header's rules.
 */
function NextSteps({
  hasContext,
  tried,
  canTurnOn,
  pending,
  onTurnOn,
}: Readonly<{
  hasContext: boolean;
  tried: boolean;
  canTurnOn: boolean;
  pending: boolean;
  onTurnOn: () => void;
}>) {
  const { t } = useTranslation('admin');
  const titleId = useId();
  const marker = (done: boolean, n: number) =>
    done ? (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check aria-hidden className="size-3.5" />
        <span className="sr-only">{t('mockAgents.nextSteps.done')}</span>
      </span>
    ) : (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-muted-foreground">
        <span aria-hidden>{n}</span>
        <span className="sr-only">{t('mockAgents.nextSteps.todo', { step: n })}</span>
      </span>
    );
  const linkClass = (done: boolean) =>
    cn(
      'h-auto min-h-11 justify-start px-0 py-1 text-left whitespace-normal md:min-h-8',
      done ? 'text-muted-foreground line-through' : 'text-foreground',
    );
  return (
    <Card className="gap-3 border-primary/40" data-testid="agent-next-steps">
      <CardHeader>
        <CardTitle id={titleId}>{t('mockAgents.nextSteps.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol aria-labelledby={titleId} className="flex flex-col gap-1">
          <li className="flex items-center gap-3" data-done={hasContext}>
            {marker(hasContext, 1)}
            <Button
              variant="link"
              className={linkClass(hasContext)}
              onClick={() => showSection(SECTION_CONTEXT)}
            >
              {t('mockAgents.nextSteps.context')}
            </Button>
          </li>
          <li className="flex items-center gap-3" data-done={tried}>
            {marker(tried, 2)}
            <Button
              variant="link"
              className={linkClass(tried)}
              onClick={() => showSection(SECTION_TRY)}
            >
              {t('mockAgents.nextSteps.try')}
            </Button>
          </li>
          <li className="flex flex-wrap items-center gap-3">
            {marker(false, 3)}
            <Button
              size="touch"
              className="md:min-h-9"
              disabled={pending || !canTurnOn}
              onClick={onTurnOn}
            >
              <Pending show={pending} />
              {t('mockAgents.nextSteps.turnOn')}
            </Button>
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

/** "Sales agent", "FAQ agent", "Custom agent". */
export function PresetBadge({ preset }: Readonly<{ preset: AgentPreset }>) {
  const { t } = useTranslation('admin');
  const Icon = PRESET_ICON[preset];
  return (
    <Badge variant="outline" className="gap-1" data-testid="preset-badge">
      <Icon aria-hidden className="size-3" />
      {t('mockAgents.preset.badge', { preset: t(`mockAgents.preset.${preset}`) })}
    </Badge>
  );
}

/** The fixed guardrails every agent gets first in its prompt: shown, never editable. */
function SafetyRules() {
  const { t } = useTranslation('admin');
  const rules = [
    t('mockAgents.page.safety1'),
    t('mockAgents.page.safety2'),
    t('mockAgents.page.safety3'),
    t('mockAgents.page.safety4'),
  ];
  // Closed by default (like Advanced): the rules never change, so they need not take page space.
  return (
    <details className="group rounded-lg border bg-muted/40" data-testid="agent-safety">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <ShieldCheck aria-hidden className="size-4 text-success" />
        <span className="font-medium">{t('mockAgents.page.safetyTitle')}</span>
        <Badge variant="outline" className="gap-1">
          <Lock aria-hidden className="size-3" />
          {t('mockAgents.page.safetyBadge')}
        </Badge>
      </summary>
      <div className="flex flex-col gap-2 border-t p-4">
        <p className="text-sm text-muted-foreground">{t('mockAgents.page.safetyIntro')}</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

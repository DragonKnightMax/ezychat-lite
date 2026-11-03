import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Lock,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  AI_AGENT_PRESETS,
  AI_HANDOFF_RULES_CHARACTERS,
  AI_INSTRUCTIONS_CHARACTERS,
  AiAgentBody,
  AiAgentPreset,
  AiEditField,
  type AiAgentStatus,
  type AiContextTextBody,
  type AiMemberStatus,
} from '@ezychat/shared';
import {
  useAddAgentText,
  useAiAgent,
  useAiAgentAction,
  useAiAgents,
  useAiMember,
  type AiAgentList,
} from '../api/ai';
import { ApiError, errorMessage } from '../api/client';
import { useInboxes } from '../api/queries';
import { Banner, EmptyState, PageHeader, StatusDot } from '@/components/app';
import { UpgradeButton } from '@/components/app/UpgradeEnterprise';
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
import { InboxChip } from '../inbox/InboxChip';
import { AiConnectionBanner } from './AiConnectionBanner';
import { PRESET_ICON, PresetBadge } from './PresetBadge';
import { AiContextPanel, agentErrorMessage } from './AiContextPanel';
import { AiQuickConnect } from './AiQuickConnect';
import { AiEditDialog } from './AiEditDialog';
import { AiTryIt } from './AiTryIt';
import { AgentConnectorsCard } from './connectors/AgentConnectorsCard';
import { AgentDirectCard } from './AgentDirectCard';
import { AgentGroupsCard, LITE_INBOX_NAME } from './AgentGroupsCard';
import { AgentResolutionCard } from './AgentResolutionCard';
import { BusinessTemplateCard } from './BusinessTemplateCard';
import { businessTemplate, type BusinessTemplateId } from './business-templates';
import { connectionReady, hasKnowledge, presetDefaults, type PresetTexts } from './ai-status';
import { ConfirmDialog, ErrorState, Field, ListSkeleton, Pending, SaveBar } from './adminUi';
import {
  AgentSectionProvider,
  ExtensionBoundary,
  useWebExtensions,
  type AgentSectionInfo,
} from '../extensions';
import { InfoTip } from '@/components/app/InfoTip';

const PILL_TONE = {
  on: 'success',
  off: 'muted',
  needsConnection: 'danger',
  needsKnowledge: 'warning',
} as const;
/** A title with Edit with AI beside it: one centred row (the card grid would put the title higher). */
const EDIT_HEADER = 'flex flex-wrap items-center justify-between gap-2';
const TEXT_PRESETS = ['sales', 'faq'] as const;

const AgentDraft = z
  .object({
    displayName: z.string().max(64),
    instructions: z.string().max(AI_INSTRUCTIONS_CHARACTERS),
    handoffRules: z.string().max(AI_HANDOFF_RULES_CHARACTERS),
    inboxId: z.number().int().positive().nullable(),
  })
  .strict();
type AgentDraft = z.infer<typeof AgentDraft>;
/** Unsaved edits of one agent (or of a create page per preset), kept in session storage. */
const StoredDraft = z.object({ preset: AiAgentPreset, draft: AgentDraft }).strict();
type StoredDraft = z.infer<typeof StoredDraft>;

const draftKey = (agentId: number | null, preset: AiAgentPreset) =>
  `wati.ai-draft.${agentId ?? `new-${preset}`}`;
/**
 * Unsaved edits survive leaving the page (the app's router cannot block navigation). A draft
 * stored in another shape (an older AI member draft) fails to parse and is dropped.
 */
function readStoredDraft(key: string): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = StoredDraft.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
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
const same = (a: AgentDraft, b: AgentDraft) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Members ▸ AI agent: `/admin/members/ai/:agentId` edits one agent; `/admin/members/ai/new?preset=`
 * creates one. Name, starting point, Business context (with Internal items), Try it, the role and
 * hand-over rules, the fixed safety rules, and in an edition with several inboxes the inbox and
 * Delete.
 */
export function AiMemberPage() {
  const { t } = useTranslation('admin');
  const { agentId: param } = useParams();
  const [params] = useSearchParams();
  const agentId = param === undefined ? null : Number(param);
  const presetParam = AiAgentPreset.safeParse(params.get('preset'));
  const preset = presetParam.success ? presetParam.data : 'sales';
  const status = useAiMember();
  const agents = useAiAgents();
  const agent = useAiAgent(agentId);

  const back = (
    <Button asChild variant="outline" size="touch">
      <Link to="/admin/members">{t('ai.agents.backToMembers')}</Link>
    </Button>
  );
  if (agentId !== null && agent.error instanceof ApiError && agent.error.status === 404)
    return (
      <EmptyState
        title={t('ai.agents.notFoundTitle')}
        description={t('ai.agents.notFoundBody')}
        action={back}
      />
    );
  for (const query of [status, agents, agent])
    if (query.isError && !query.data)
      return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!status.data || !agents.data || (agentId !== null && !agent.data)) return <ListSkeleton />;
  const list = agents.data;
  if (agentId === null && list.agents.length >= list.maxAgents)
    return (
      <EmptyState
        title={t('ai.agents.limitTitle')}
        description={list.maxAgents <= 1 ? t('ai.agents.limitBodyLite') : t('ai.agents.limitBody')}
        action={
          list.maxAgents <= 1 ? (
            <div className="flex flex-wrap justify-center gap-2">
              <UpgradeButton />
              {back}
            </div>
          ) : (
            back
          )
        }
      />
    );
  const refreshError = status.isError ? status.error : agent.isError ? agent.error : null;
  return (
    <AgentEditor
      key={agentId ?? `new-${preset}`}
      agent={agent.data ?? null}
      initialPreset={preset}
      status={status.data}
      list={list}
      refreshError={refreshError}
    />
  );
}

function AgentEditor({
  agent,
  initialPreset,
  status,
  list,
  refreshError,
}: {
  agent: AiAgentStatus | null;
  initialPreset: AiAgentPreset;
  status: AiMemberStatus;
  list: AiAgentList;
  refreshError: unknown;
}) {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const pickId = useId();
  const inboxFieldId = useId();
  const reasonId = useId();
  const editReasonId = useId();
  const contextSectionId = useId();
  const trySectionId = useId();
  const id = agent?.agent.id ?? null;
  const isNew = id === null;
  const lite = list.maxAgents <= 1;
  const action = useAiAgentAction(id);
  const inboxQuery = useInboxes({ enabled: !lite });
  const inboxes = lite ? [] : (inboxQuery.data?.inboxes ?? []).filter((inbox) => !inbox.removed);
  const showInboxUi = !lite && inboxes.length > 0;
  const storeKey = draftKey(id, initialPreset);
  const ready = connectionReady(status);

  /** A never-edited starting text (stored in English by the server) in the admin's language. */
  const localize = (text: string, field: keyof PresetTexts) => {
    for (const p of TEXT_PRESETS)
      if (text === AI_AGENT_PRESETS[p][field]) return presetDefaults(p, t)[field];
    return text;
  };
  const fromAgent = (a: AiAgentStatus): AgentDraft => ({
    displayName: a.settings.displayName,
    instructions: localize(a.settings.instructions, 'instructions'),
    handoffRules:
      a.settings.handoffRules === undefined
        ? presetDefaults(a.agent.preset, t).handoffRules
        : localize(a.settings.handoffRules, 'handoffRules'),
    inboxId: a.agent.inboxId,
  });
  // A new agent starts on an inbox without an agent, else on the first one (it then works in groups there).
  const freeInbox = inboxes.find((inbox) => inbox.aiAgentId === null)?.id ?? inboxes[0]?.id ?? null;
  const blank = (p: AiAgentPreset): AgentDraft => ({
    displayName: '',
    ...presetDefaults(p, t),
    inboxId: lite ? null : freeInbox,
  });

  const [initial] = useState<StoredDraft | null>(() => readStoredDraft(storeKey));
  const [preset, setPreset] = useState<AiAgentPreset>(
    initial?.preset ?? agent?.agent.preset ?? initialPreset,
  );
  const [draft, setDraft] = useState<AgentDraft>(
    () => initial?.draft ?? (agent ? fromAgent(agent) : blank(initialPreset)),
  );
  const [saved, setSaved] = useState<AgentDraft>(() =>
    agent ? fromAgent(agent) : blank(initialPreset),
  );
  const [submitted, setSubmitted] = useState(false);
  const [templateFor, setTemplateFor] = useState<AiAgentPreset | null>(null);
  // A business template asks first when the texts are the admin's own; its Business context item
  // is added by the next successful Save (the agent may not exist yet).
  const [businessFor, setBusinessFor] = useState<BusinessTemplateId | null>(null);
  const [pendingItem, setPendingItem] = useState<AiContextTextBody | null>(null);
  const addText = useAddAgentText();
  const [deleting, setDeleting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // The field stays set while the dialog closes so its content doesn't vanish mid-animation.
  const [editField, setEditField] = useState<AiEditField>('instructions');
  const [editOpen, setEditOpen] = useState(false);
  // New agents (and a restored draft) open Advanced: the role is where a Custom agent starts.
  const [advancedOpen] = useState(() => isNew || Boolean(initial));
  // Next steps: a Try it answer in this page session counts as "tried".
  const [tried, setTried] = useState(false);

  // The inbox shown follows the server when it changes elsewhere (Admin → Inboxes) or, on a create
  // page, once the inbox list arrives; typed edits are kept.
  const serverInbox = agent ? agent.agent.inboxId : freeInbox;
  useEffect(() => {
    if (serverInbox === saved.inboxId) return;
    setSaved((old) => ({ ...old, inboxId: serverInbox }));
    setDraft((old) => (old.inboxId === saved.inboxId ? { ...old, inboxId: serverInbox } : old));
  }, [serverInbox]); // eslint-disable-line react-hooks/exhaustive-deps -- only a server change

  const changed =
    !same(draft, saved) ||
    preset !== (agent?.agent.preset ?? initialPreset) ||
    pendingItem !== null;
  useEffect(() => {
    writeStoredDraft(storeKey, changed ? { preset, draft } : null);
  }, [changed, draft, preset, storeKey]);
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);

  // Several agents may share an inbox; only one answers its direct chats (the server refuses a second).
  const otherOnInbox =
    !lite && draft.inboxId !== null && draft.inboxId !== saved.inboxId
      ? list.agents.find((a) => a.inboxId === draft.inboxId && a.id !== id && a.answerDirect)
      : undefined;
  const busy = action.isPending || addText.isPending;
  const dirty = isNew || changed;

  const template = presetDefaults(preset, t);
  const matches = (text: string, field: keyof PresetTexts) =>
    text === template[field] || (preset !== 'custom' && text === AI_AGENT_PRESETS[preset][field]);
  const onTemplate =
    matches(draft.instructions, 'instructions') && matches(draft.handoffRules, 'handoffRules');
  const usingStartText = preset !== 'custom' && matches(draft.instructions, 'instructions');
  const presetName = (p: AiAgentPreset) => t(`ai.presets.${p}`);
  const savedName = agent?.settings.displayName ?? '';
  const title = draft.displayName.trim() || (isNew ? t('ai.agents.newTitle') : savedName);
  const nameError =
    submitted && !draft.displayName.trim() ? t('ai.agents.nameRequired') : undefined;
  const inboxName = (inboxId: number | null) =>
    inboxes.find((inbox) => inbox.id === inboxId)?.name ?? '';
  /** The agent's inbox for the Direct chats and Groups cards; null = it answers no inbox. */
  const agentInboxName = (): string | null => {
    // Lite has one number and no inbox list: its inbox keeps the default name.
    if (lite) return LITE_INBOX_NAME;
    const inboxId = agent?.agent.inboxId ?? null;
    return inboxId === null ? null : inboxName(inboxId);
  };

  const documents = agent?.documents ?? [];
  const enabled = Boolean(agent?.agent.enabled);
  const knowledge = hasKnowledge(documents);
  const canTurnOn = ready && knowledge;
  const pill = !ready ? 'needsConnection' : !knowledge ? 'needsKnowledge' : enabled ? 'on' : 'off';
  const pillLabels = {
    on: t('ai.page.pill.on'),
    off: t('ai.page.pill.off'),
    needsConnection: t('ai.page.pill.needsConnection'),
    needsKnowledge: t('ai.page.pill.needsKnowledge'),
  };
  const reason = !ready ? t('ai.page.reasonConnection') : t('ai.page.reasonKnowledge');
  const stateLabels: Record<AiMemberStatus['connection']['state'], string> = {
    unavailable: t('ai.state.unavailable'),
    signed_out: t('ai.state.signed_out'),
    signing_in: t('ai.state.signing_in'),
    connected: t('ai.state.connected'),
    error: t('ai.state.error'),
    expired: t('ai.state.expired'),
  };
  const keyText = (saved: boolean, prefix: '' | 'claude.') =>
    saved ? t(`ai.${prefix}keySaved`) : t(`ai.${prefix}keyMissing`);
  const connectionText =
    status.settings.mode === 'api'
      ? keyText(status.hasApiKey, '')
      : status.settings.mode === 'claude'
        ? keyText(status.hasClaudeApiKey, 'claude.')
        : t('ai.chatgptState', { state: stateLabels[status.connection.state] });

  const applyTemplate = (p: AiAgentPreset) => {
    setPreset(p);
    setDraft((old) => ({ ...old, ...presetDefaults(p, t) }));
  };
  /**
   * Picking a starting point replaces the texts directly while they are unedited. Otherwise a new
   * agent asks first; an existing agent changes only its type and keeps the admin's own texts (the
   * Agent type card then offers that type's template).
   */
  const choosePreset = (p: AiAgentPreset) => {
    if (p === preset) return;
    if (onTemplate) applyTemplate(p);
    else if (isNew) setTemplateFor(p);
    else setPreset(p);
  };
  const applyBusiness = (templateId: BusinessTemplateId) => {
    const tpl = businessTemplate(templateId, t);
    setPreset(tpl.preset);
    setDraft((old) => ({
      ...old,
      displayName: old.displayName.trim() ? old.displayName : tpl.agentName,
      instructions: tpl.instructions,
      handoffRules: tpl.handoffRules,
    }));
    setPendingItem(tpl.contextItem);
    toast.success(
      t('ai.businessTemplates.applied', { name: t(`ai.businessTemplates.${templateId}.name`) }),
    );
  };
  /** Replaces unedited starting texts at once; the admin's own texts are replaced only after asking. */
  const chooseBusiness = (templateId: BusinessTemplateId) => {
    if (onTemplate || (!draft.instructions.trim() && !draft.handoffRules.trim()))
      applyBusiness(templateId);
    else setBusinessFor(templateId);
  };
  /** Adds the applied template's Business context item once the agent is saved. */
  const addPendingItem = async (agentId: number) => {
    if (!pendingItem) return;
    try {
      await addText.mutateAsync({ agentId, body: pendingItem });
      setPendingItem(null);
    } catch (error) {
      toast.error(agentErrorMessage(error, t));
    }
  };
  const [typeOpen, setTypeOpen] = useState(false);
  const presetPicker = (labelledBy: string) => (
    <RadioGroup
      aria-labelledby={labelledBy}
      value={preset}
      onValueChange={(value) => choosePreset(value as AiAgentPreset)}
      className="grid gap-3 sm:grid-cols-3"
    >
      {AiAgentPreset.options.map((p) => {
        const Icon = PRESET_ICON[p];
        const optionId = `${labelledBy}-${p}`;
        return (
          <Label
            key={p}
            htmlFor={optionId}
            className={cn(
              'flex min-h-11 cursor-pointer flex-col items-start gap-2 rounded-lg border bg-card p-4 font-normal transition-colors',
              'hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5',
              'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
            )}
          >
            <span className="flex w-full items-center gap-2">
              <Icon aria-hidden className="size-4 text-primary" />
              <span className="font-medium">{presetName(p)}</span>
              <RadioGroupItem id={optionId} value={p} className="ml-auto" />
            </span>
            <span className="text-sm text-muted-foreground">{t(`ai.presets.${p}Description`)}</span>
          </Label>
        );
      })}
    </RadioGroup>
  );

  /** Saves (or creates) the whole page with the given on/off state. */
  const save = async (nextEnabled: boolean, done: string) => {
    setSubmitted(true);
    setLocalError(null);
    const sent = draft;
    const name = sent.displayName.trim();
    if (!name) return;
    const parsed = AiAgentBody.safeParse({
      displayName: name,
      enabled: nextEnabled,
      preset,
      instructions: sent.instructions,
      handoffRules: sent.handoffRules,
      // Lite: the server keeps its one agent on the only inbox.
      ...(lite ? {} : { inboxId: sent.inboxId }),
    });
    if (!parsed.success) {
      setLocalError(t('ai.checkSettings'));
      return;
    }
    try {
      const result = await action.mutateAsync(
        isNew ? { kind: 'create', body: parsed.data } : { kind: 'save', body: parsed.data },
      );
      if (!('agent' in result)) return;
      await addPendingItem(result.agent.id);
      if (isNew) {
        writeStoredDraft(storeKey, null);
        toast.success(t('ai.agents.created', { name }));
        navigate(`/admin/members/ai/${result.agent.id}`, { replace: true });
        // The new agent page starts at the top: its name, status and Next steps.
        window.scrollTo({ top: 0, left: 0 });
        return;
      }
      const stored = fromAgent(result);
      setSaved(stored);
      // Adopt the stored values only if nothing was typed while saving.
      setDraft((current) => (same(current, sent) ? stored : current));
      toast.success(done);
    } catch (error) {
      setLocalError(agentErrorMessage(error, t));
    }
  };

  const remove = async () => {
    try {
      await action.mutateAsync({ kind: 'delete' });
      writeStoredDraft(storeKey, null);
      toast.success(t('ai.agents.deleted', { name: savedName }));
      navigate('/admin/members', { replace: true });
    } catch (error) {
      setDeleting(false);
      setLocalError(agentErrorMessage(error, t));
    }
  };

  const editWithAi = (field: AiEditField) => (
    // Centred on the title row; compact on desktop, a 44 px target on touch screens.
    <CardAction className="self-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:min-h-11"
        disabled={!ready || busy}
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
  const boundInbox = agent ? inboxes.find((inbox) => inbox.id === agent.agent.inboxId) : undefined;
  // Jump to a section and move focus there, so keyboard and screen-reader users land on it too.
  const scrollTo = (sectionId: string) => {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    section.focus({ preventScroll: true });
  };
  const turnOnButton = (className?: string) => (
    <Button
      size="touch"
      className={className}
      disabled={busy || !canTurnOn}
      aria-describedby={canTurnOn ? undefined : reasonId}
      onClick={() => void save(true, t('ai.page.turnedOn'))}
    >
      <Pending show={busy} />
      {t('ai.page.turnOn')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4 pb-4">
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
        description={isNew ? t('ai.agents.newDescription') : t('ai.agents.description')}
        actions={
          agent && (
            <div className="flex flex-wrap items-center gap-3">
              <StatusDot tone={PILL_TONE[pill]} label={pillLabels[pill]} />
              {enabled ? (
                <Button
                  variant="outline"
                  size="touch"
                  disabled={busy}
                  onClick={() => void save(false, t('ai.page.turnedOff'))}
                >
                  {t('ai.page.turnOff')}
                </Button>
              ) : (
                turnOnButton()
              )}
            </div>
          )
        }
      />
      {agent && !enabled && !canTurnOn && (
        // The status already says "Needs business context": the reason stays for screen readers only.
        <p
          id={reasonId}
          className={pill === 'needsKnowledge' ? 'sr-only' : 'text-sm text-muted-foreground'}
        >
          {reason}
        </p>
      )}
      {agent && (
        <div className="flex flex-wrap items-center gap-2">
          <PresetBadge preset={preset} />
          {showInboxUi &&
            (boundInbox ? (
              <InboxChip inbox={boundInbox} />
            ) : (
              <span className="text-sm text-warning">{t('ai.agents.noInbox')}</span>
            ))}
        </div>
      )}
      {agent && !enabled && (
        <NextSteps
          steps={[
            {
              key: 'context',
              label: t('ai.page.nextSteps.context'),
              done: knowledge,
              onGo: () => scrollTo(contextSectionId),
            },
            {
              key: 'try',
              label: t('ai.page.nextSteps.try'),
              done: tried,
              onGo: () => scrollTo(trySectionId),
            },
          ]}
          turnOn={turnOnButton('md:min-h-9')}
        />
      )}
      {!isNew && (
        <AiConnectionBanner
          status={status}
          action={
            <Button asChild size="touch" variant="outline">
              <Link to="/admin/settings/ai">{t('ai.page.openSettings')}</Link>
            </Button>
          }
        />
      )}

      {!ready && !isNew && (
        <Card className="gap-4 border-primary/40">
          <CardHeader>
            <CardTitle>{t('ai.connect.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <AiQuickConnect status={status} />
          </CardContent>
        </Card>
      )}

      <BusinessTemplateCard
        disabled={busy}
        pendingItem={pendingItem?.name ?? null}
        onApply={chooseBusiness}
      />

      {isNew && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle id={pickId}>{t('ai.agents.pickTitle')}</CardTitle>
            <CardDescription>{t('ai.agents.pickHint')}</CardDescription>
          </CardHeader>
          <CardContent>{presetPicker(pickId)}</CardContent>
        </Card>
      )}

      {!isNew && (
        <Card className="gap-4" data-testid="agent-type">
          <CardHeader className={EDIT_HEADER}>
            <div className="flex min-w-0 flex-col gap-1.5">
              <CardTitle id={pickId}>{t('ai.agents.typeTitle')}</CardTitle>
              <CardDescription>{t('ai.agents.typeHint')}</CardDescription>
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
                {t('ai.agents.typeChange')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="md:min-h-9"
                disabled={busy}
                onClick={() => {
                  setEditField('instructions');
                  setEditOpen(true);
                }}
              >
                <Sparkles aria-hidden />
                {t('ai.agents.typeEditRole')}
              </Button>
            </div>
          </CardHeader>
          {(typeOpen || (!onTemplate && preset !== 'custom')) && (
            <CardContent className="flex flex-col gap-3">
              {typeOpen && presetPicker(pickId)}
              {!onTemplate && preset !== 'custom' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm text-muted-foreground">
                    {t('ai.agents.typeOwnTexts')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="md:min-h-9"
                    disabled={busy}
                    onClick={() => setTemplateFor(preset)}
                  >
                    {t('ai.agents.useTemplate', { preset: presetName(preset) })}
                  </Button>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{t('ai.agents.nameTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label={t('ai.agents.nameLabel')} hint={t('ai.agents.nameHint')} error={nameError}>
            {(p) => (
              <Input
                {...p}
                value={draft.displayName}
                maxLength={64}
                disabled={busy}
                onChange={(e) => setDraft((old) => ({ ...old, displayName: e.target.value }))}
              />
            )}
          </Field>
          {showInboxUi && (
            <div className="flex flex-col gap-2" data-testid="agent-inbox">
              <Label htmlFor={inboxFieldId}>{t('ai.agents.inboxLabel')}</Label>
              <Select
                value={draft.inboxId === null ? 'none' : String(draft.inboxId)}
                disabled={busy}
                onValueChange={(value) =>
                  setDraft((old) => ({ ...old, inboxId: value === 'none' ? null : Number(value) }))
                }
              >
                <SelectTrigger id={inboxFieldId} className="min-h-11 w-full sm:max-w-sm md:min-h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="min-h-11 md:min-h-8">
                    {t('ai.agents.inboxNone')}
                  </SelectItem>
                  {inboxes.map((inbox) => {
                    const other = list.agents.find((a) => a.inboxId === inbox.id && a.id !== id);
                    return (
                      <SelectItem
                        key={inbox.id}
                        value={String(inbox.id)}
                        className="min-h-11 md:min-h-8"
                      >
                        {other
                          ? t('ai.agents.inboxHas', { inbox: inbox.name, agent: other.displayName })
                          : inbox.name}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">{t('ai.agents.inboxHint')}</p>
              {otherOnInbox && (
                <Banner tone="warning">
                  {t('ai.agents.inboxShared', {
                    agent: otherOnInbox.displayName,
                    inbox: inboxName(draft.inboxId),
                  })}
                </Banner>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* A new agent page stays short: context, extensions and Try it come once it exists. */}
      {agent && (
        <>
          {/* scroll-mt clears the phone's sticky admin bar. */}
          <div
            id={contextSectionId}
            tabIndex={-1}
            className="scroll-mt-16 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring md:scroll-mt-4"
          >
            <AiContextPanel agentId={agent.agent.id} documents={documents} disabled={busy} />
          </div>

          {/* Connectors this agent uses; their settings live on each connector's page. */}
          <AgentConnectorsCard
            agentId={agent.agent.id}
            name={agent.settings.displayName || t('ai.page.defaultTitle')}
          />

          {/* Resolution question and closing chats (off by default). */}
          <AgentResolutionCard
            agentId={agent.agent.id}
            name={agent.settings.displayName || t('ai.page.defaultTitle')}
            enabled={agent.agent.resolutionCheck ?? false}
          />

          {/* Direct chats: off with Answer in groups on = a group-only agent. */}
          <AgentDirectCard
            agentId={agent.agent.id}
            name={agent.settings.displayName || t('ai.page.defaultTitle')}
            inboxName={agentInboxName()}
          />

          {/* WhatsApp groups: answer when tagged or quoted, and in which groups. */}
          <AgentGroupsCard
            agentId={agent.agent.id}
            name={agent.settings.displayName || t('ai.page.defaultTitle')}
            agentEnabled={agent.agent.enabled}
            inboxName={agentInboxName()}
          />

          {/* Every agent is a customer-facing agent for extensions ('sales'). */}
          <AgentExtensionSections
            agent="sales"
            agentId={agent.agent.id}
            displayName={agent.settings.displayName}
            preset={agent.agent.preset}
          />

          <Card
            id={trySectionId}
            tabIndex={-1}
            className="scroll-mt-16 gap-4 outline-none focus-visible:ring-2 focus-visible:ring-ring md:scroll-mt-4"
          >
            <CardHeader>
              <div className="flex items-center gap-1.5">
                <CardTitle>{t('ai.agents.tryTitle')}</CardTitle>
                <InfoTip topic="tryIt" />
              </div>
            </CardHeader>
            <CardContent>
              <AiTryIt
                draft={draft}
                agentId={agent.agent.id}
                ready={ready}
                onAnswered={() => setTried(true)}
              />
            </CardContent>
          </Card>
        </>
      )}

      <details className="group rounded-lg border bg-card" open={advancedOpen}>
        <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">{t('ai.agents.advanced')}</span>
          <span className="text-sm text-muted-foreground">
            {preset === 'custom' && !draft.instructions.trim()
              ? t('ai.agents.advancedBlank')
              : onTemplate
                ? t('ai.page.advancedRecommended')
                : t('ai.page.advancedCustomised')}
          </span>
        </summary>
        <div className="flex flex-col gap-4 border-t p-4">
          <Card className="gap-4">
            <CardHeader className={EDIT_HEADER}>
              <div className="flex items-center gap-1.5">
                <CardTitle>{t('ai.agents.roleTitle')}</CardTitle>
                <InfoTip topic="instructions" />
              </div>
              {editWithAi(AiEditField.enum.instructions)}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {usingStartText && (
                <p className="inline-flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {t('ai.agents.usingTemplate', { preset: presetName(preset) })}
                </p>
              )}
              <Field label={t('ai.agents.roleLabel')} hint={t('ai.agents.roleHint')}>
                {(p) => (
                  <Textarea
                    {...p}
                    value={draft.instructions}
                    maxLength={AI_INSTRUCTIONS_CHARACTERS}
                    // Fixed, modest height: the long starting text scrolls inside the box.
                    className="field-sizing-fixed h-48 max-h-[70dvh] resize-y overflow-y-auto text-base leading-6 md:h-56 md:text-sm"
                    placeholder={t('ai.agents.rolePlaceholder')}
                    disabled={busy}
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
                    disabled={busy}
                    onClick={() => setTemplateFor(preset)}
                  >
                    {t('ai.agents.useTemplate', { preset: presetName(preset) })}
                  </Button>
                  {preset === 'custom' && (
                    <span className="text-sm text-muted-foreground">
                      {t('ai.agents.customTemplateNote')}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="gap-4">
            <CardHeader className={EDIT_HEADER}>
              <div className="flex items-center gap-1.5">
                <CardTitle>{t('ai.agents.handoffTitle')}</CardTitle>
                <InfoTip topic="handoff" />
              </div>
              {editWithAi(AiEditField.enum.handoffRules)}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Banner tone="info">{t('ai.page.handoffSystem')}</Banner>
              <Field
                label={t('ai.agents.handoffTitle')}
                labelClassName="sr-only"
                hint={t('ai.agents.handoffHint')}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    value={draft.handoffRules}
                    maxLength={AI_HANDOFF_RULES_CHARACTERS}
                    className="field-sizing-fixed h-40 resize-y overflow-y-auto text-base leading-6 md:text-sm"
                    placeholder={t('ai.agents.handoffPlaceholder')}
                    disabled={busy}
                    onChange={(e) => setDraft((old) => ({ ...old, handoffRules: e.target.value }))}
                  />
                )}
              </Field>
            </CardContent>
          </Card>
        </div>
      </details>

      {isNew ? (
        <p className="text-sm text-muted-foreground">{t('ai.agents.createNext')}</p>
      ) : (
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

      {agent && !lite && (
        <Card className="gap-3 border-danger/40">
          <CardHeader>
            <CardTitle>{t('ai.agents.deleteTitle')}</CardTitle>
            <CardDescription>{t('ai.agents.deleteHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="touch"
              className="text-danger hover:bg-danger/10 hover:text-danger md:min-h-9"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              <Trash2 aria-hidden />
              {t('ai.agents.delete')}
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
        <Button
          size="touch"
          disabled={!dirty || busy}
          onClick={() => void save(enabled, t('ai.agents.saved'))}
        >
          <Pending show={busy} />
          {isNew ? t('ai.agents.create') : t('ai.agents.save')}
        </Button>
      </SaveBar>

      <ConfirmDialog
        open={templateFor !== null}
        title={t('ai.agents.templateTitle', { preset: presetName(templateFor ?? preset) })}
        confirmLabel={t('ai.agents.templateConfirm')}
        onConfirm={() => {
          if (templateFor) applyTemplate(templateFor);
          setTemplateFor(null);
          toast.success(t('ai.agents.templateApplied'));
        }}
        onClose={() => setTemplateFor(null)}
      >
        {t('ai.agents.templateBody', { preset: presetName(templateFor ?? preset) })}
      </ConfirmDialog>
      <ConfirmDialog
        open={businessFor !== null}
        title={t('ai.businessTemplates.confirmTitle', {
          name: businessFor ? t(`ai.businessTemplates.${businessFor}.name`) : '',
        })}
        confirmLabel={t('ai.businessTemplates.apply')}
        onConfirm={() => {
          if (businessFor) applyBusiness(businessFor);
          setBusinessFor(null);
        }}
        onClose={() => setBusinessFor(null)}
      >
        {t('ai.businessTemplates.confirmBody')}
      </ConfirmDialog>
      {agent && (
        <ConfirmDialog
          open={deleting}
          danger
          title={t('ai.agents.deleteConfirmTitle', { name: savedName })}
          confirmLabel={t('ai.agents.delete')}
          loading={action.isPending}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(false)}
        >
          {t('ai.agents.deleteConfirmBody', { name: savedName, count: documents.length })}
        </ConfirmDialog>
      )}
      <AiEditDialog
        field={editField}
        current={draft[editField]}
        open={editOpen}
        onOpenChange={setEditOpen}
        agentId={id ?? undefined}
        preset={preset}
        onApply={(text) => {
          setDraft((old) => ({ ...old, [editField]: text }));
          toast.success(t('ai.edit.applied'));
        }}
      />
    </div>
  );
}

/** The fixed guardrails every agent gets first in its prompt: shown, never editable. */
function SafetyRules() {
  const { t } = useTranslation('admin');
  const rules = [
    t('ai.guardrails.rule1'),
    t('ai.guardrails.rule2'),
    t('ai.guardrails.rule3'),
    t('ai.guardrails.rule4'),
  ];
  // Closed by default (like Advanced): the rules never change, so they need not take page space.
  return (
    <details className="group rounded-lg border bg-muted/40" data-testid="safety-rules">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <ShieldCheck aria-hidden className="size-4 text-success" />
        <span className="font-medium">{t('ai.guardrails.title')}</span>
        <Badge variant="outline" className="gap-1">
          <Lock aria-hidden className="size-3" />
          {t('ai.guardrails.badge')}
        </Badge>
      </summary>
      <div className="flex flex-col gap-2 border-t p-4">
        <p className="text-sm text-muted-foreground">{t('ai.guardrails.intro')}</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * The "Next steps" card of an agent that is off: numbered rows that turn into checks, each jumping
 * to its section, and Turn on (same rules as the header button) last.
 */
function NextSteps({
  steps,
  turnOn,
}: {
  steps: { key: string; label: string; done: boolean; onGo: () => void }[];
  turnOn: ReactNode;
}) {
  const { t } = useTranslation('admin');
  const marker = (done: boolean, step: number) =>
    done ? (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check aria-hidden className="size-4" />
        <span className="sr-only">{t('ai.page.nextSteps.done')}</span>
      </span>
    ) : (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-muted-foreground">
        <span aria-hidden>{step}</span>
        <span className="sr-only">{t('ai.page.nextSteps.todo', { step })}</span>
      </span>
    );
  return (
    <Card className="gap-3" data-testid="next-steps">
      <CardHeader>
        <CardTitle>{t('ai.page.nextSteps.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-1">
          {steps.map((step, index) => (
            <li key={step.key} className="flex items-center gap-3" data-done={step.done}>
              {marker(step.done, index + 1)}
              <Button
                type="button"
                variant="link"
                className={cn(
                  'h-auto min-h-11 justify-start p-0 text-left whitespace-normal md:min-h-9',
                  step.done ? 'text-muted-foreground line-through' : 'text-foreground',
                )}
                onClick={step.onGo}
              >
                {step.label}
              </Button>
            </li>
          ))}
          <li className="flex flex-wrap items-center gap-3 pt-1">
            {marker(false, steps.length + 1)}
            {turnOn}
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

/** Extension rows for one agent (e.g. Connectors), right under Business context. */
function AgentExtensionSections({
  agent,
  agentId,
  displayName,
  preset,
}: { agent: 'sales' } & AgentSectionInfo) {
  // One stable value per agent, so extension rows do not re-render on every page keystroke.
  const info = useMemo<AgentSectionInfo>(
    () => ({ agentId, displayName, preset }),
    [agentId, displayName, preset],
  );
  const sections = useWebExtensions().flatMap((ext) =>
    (ext.agentSections ?? [])
      .filter((section) => section.agent === agent)
      .map((section) => ({ key: `${ext.name}:${section.id}`, element: section.element })),
  );
  if (!sections.length) return null;
  return (
    <AgentSectionProvider value={info}>
      <div className="flex flex-col gap-3" data-testid="agent-extension-sections">
        {sections.map((section) => (
          <div key={section.key} data-extension-section={section.key}>
            <ExtensionBoundary>{section.element}</ExtensionBoundary>
          </div>
        ))}
      </div>
    </AgentSectionProvider>
  );
}

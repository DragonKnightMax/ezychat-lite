import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, SlidersHorizontal, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import {
  AI_HANDOFF_RULES_CHARACTERS,
  AiMemberBody,
  DEFAULT_AI_HANDOFF_RULES,
  DEFAULT_AI_INSTRUCTIONS,
  AiEditField,
  type AiMemberStatus,
  type AiSettings,
} from '@ezychat/shared';
import { useAiMember, useAiMemberAction } from '../api/ai';
import { errorMessage } from '../api/client';
import { Banner, PageHeader, StatusDot } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AiConnectionBanner } from './AiConnectionBanner';
import { AiContextPanel } from './AiContextPanel';
import { AiQuickConnect } from './AiQuickConnect';
import { AiEditDialog } from './AiEditDialog';
import { AiTryIt } from './AiTryIt';
import { connectionReady, hasKnowledge, memberPill, type AiKnowledgeDraft } from './ai-status';
import { ErrorState, Field, ListSkeleton, Pending, SaveBar } from './adminUi';

const PILL_TONE = {
  on: 'success',
  off: 'muted',
  needsConnection: 'danger',
  needsKnowledge: 'warning',
} as const;
/** The defaults in the admin's language (catalog `ai.defaults.*`); the server keeps English ones. */
type LocalDefaults = Pick<AiKnowledgeDraft, 'instructions' | 'handoffRules'>;
/** A never-edited default (stored in English by the server) is shown in the admin's language. */
const draftFrom = (s: AiSettings, local: LocalDefaults): AiKnowledgeDraft => ({
  displayName: s.displayName,
  instructions: s.instructions === DEFAULT_AI_INSTRUCTIONS ? local.instructions : s.instructions,
  handoffRules:
    s.handoffRules === undefined || s.handoffRules === DEFAULT_AI_HANDOFF_RULES
      ? local.handoffRules
      : s.handoffRules,
});
const draftKey = (s: AiMemberStatus) => `wati.ai-draft.${s.member?.id ?? 'new'}`;
/**
 * Unsaved edits survive leaving the page (the app's router cannot block navigation). A draft
 * stored in an older shape (a Business context text, or notes + FAQs) fails to parse and is dropped.
 */
function readStoredDraft(key: string): AiKnowledgeDraft | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = AiMemberBody.pick({ displayName: true, instructions: true, handoffRules: true })
      .strict()
      .safeParse(JSON.parse(raw));
    // A draft saved before hand-off rules existed is dropped rather than half-restored.
    return parsed.success && typeof parsed.data.handoffRules === 'string'
      ? { ...parsed.data, handoffRules: parsed.data.handoffRules }
      : null;
  } catch {
    return null;
  }
}
function writeStoredDraft(key: string, draft: AiKnowledgeDraft | null) {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable: edits just are not restored */
  }
}
const same = (a: AiKnowledgeDraft, b: AiKnowledgeDraft) => JSON.stringify(a) === JSON.stringify(b);

/** Members ▸ AI Sales Agent: set up, test and turn on the AI member (replaces the popup). */
/** A title with Edit with AI beside it: one centred row (the card grid would put the title higher). */
const EDIT_HEADER = 'flex flex-wrap items-center justify-between gap-2';

export function AiMemberPage() {
  const query = useAiMember();
  if (!query.data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <ListSkeleton />
    );
  return <AiMemberEditor status={query.data} refreshError={query.isError ? query.error : null} />;
}

function AiMemberEditor({
  status,
  refreshError,
}: {
  status: AiMemberStatus;
  refreshError: unknown;
}) {
  const { t } = useTranslation('admin');
  const reasonId = useId();
  const editReasonId = useId();
  const action = useAiMemberAction();
  const local: LocalDefaults = {
    instructions: t('ai.defaults.instructions'),
    handoffRules: t('ai.defaults.handoffRules'),
  };
  /** Either language's default counts as "the default" (no Use default button). */
  const isDefaultInstructions = (text: string) =>
    text === local.instructions || text === DEFAULT_AI_INSTRUCTIONS;
  const isDefaultRules = (text: string) =>
    text === local.handoffRules || text === DEFAULT_AI_HANDOFF_RULES;
  // Polling and saves never replace what the admin is typing.
  const [draft, setDraft] = useState<AiKnowledgeDraft>(
    () => readStoredDraft(draftKey(status)) ?? draftFrom(status.settings, local),
  );
  const [saved, setSaved] = useState<AiKnowledgeDraft>(() => draftFrom(status.settings, local));
  const [localError, setLocalError] = useState<string | null>(null);
  // The field stays set while the dialog closes so its content doesn't vanish mid-animation.
  const [editField, setEditField] = useState<AiEditField>('instructions');
  const [editOpen, setEditOpen] = useState(false);
  const dirty = !same(draft, saved);
  const storeKey = draftKey(status);
  useEffect(() => {
    if (dirty) writeStoredDraft(storeKey, draft);
    else {
      writeStoredDraft(storeKey, null);
      writeStoredDraft('wati.ai-draft.new', null);
    }
  }, [dirty, draft, storeKey]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const enabled = Boolean(status.member && !status.member.disabled);
  const pill = memberPill(status);
  const ready = connectionReady(status);
  const knowledge = hasKnowledge(status.documents);
  const canTurnOn = ready && knowledge;
  const pillLabels = {
    on: t('ai.page.pill.on'),
    off: t('ai.page.pill.off'),
    needsConnection: t('ai.page.pill.needsConnection'),
    needsKnowledge: t('ai.page.pill.needsKnowledge'),
  };
  const stateLabels: Record<AiMemberStatus['connection']['state'], string> = {
    unavailable: t('ai.state.unavailable'),
    signed_out: t('ai.state.signed_out'),
    signing_in: t('ai.state.signing_in'),
    connected: t('ai.state.connected'),
    error: t('ai.state.error'),
    expired: t('ai.state.expired'),
  };
  const connectionText =
    status.settings.mode === 'api'
      ? status.hasApiKey
        ? t('ai.keySaved')
        : t('ai.keyMissing')
      : t('ai.chatgptState', { state: stateLabels[status.connection.state] });

  /** Saves the whole page (name + knowledge) with the given on/off state. */
  const save = async (nextEnabled: boolean, done: string): Promise<AiMemberStatus | null> => {
    setLocalError(null);
    const sent = draft;
    const parsed = AiMemberBody.safeParse({ ...sent, enabled: nextEnabled });
    if (!parsed.success) {
      setLocalError(t('ai.checkSettings'));
      return null;
    }
    try {
      const next = await action.mutateAsync({ kind: 'save', settings: parsed.data });
      const stored = draftFrom(next.settings, local);
      setSaved(stored);
      // Adopt the stored values only if nothing was typed while saving.
      setDraft((current) => (same(current, sent) ? stored : current));
      toast.success(done);
      return next;
    } catch {
      return null; // shown from action.error
    }
  };

  /** Context items belong to the AI member: the first one saves a disabled draft member. */
  const ensureMember = async () =>
    Boolean(status.member) || Boolean(await save(false, t('ai.page.draftSaved')));

  // PROPOSED: connect right here instead of being sent to Settings → AI.
  const reason = !ready ? t('mockSetup.agent.connectFirst') : t('ai.page.reasonKnowledge');
  const customised =
    !isDefaultInstructions(draft.instructions) || !isDefaultRules(draft.handoffRules);
  const editWithAi = (field: AiEditField) => (
    // Centred on the title row; compact on desktop, a 44 px target on touch screens.
    <CardAction className="self-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:min-h-11"
        disabled={!ready || action.isPending}
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
    <div className="flex flex-col gap-4 pb-4">
      <nav aria-label={t('ai.page.breadcrumb')} className="flex items-center gap-1 text-sm">
        <Link
          to="/admin/members"
          className="inline-flex items-center text-muted-foreground underline-offset-4 hover:text-foreground hover:underline pointer-coarse:min-h-11"
        >
          {t('nav.members')}
        </Link>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">
          {draft.displayName.trim() || t('ai.page.defaultTitle')}
        </span>
      </nav>
      <PageHeader
        className="pb-0"
        title={draft.displayName.trim() || t('ai.page.defaultTitle')}
        description={t('ai.page.description')}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <StatusDot tone={PILL_TONE[pill]} label={pillLabels[pill]} />
            {enabled ? (
              <Button
                variant="outline"
                size="touch"
                disabled={action.isPending}
                onClick={() => void save(false, t('ai.page.turnedOff'))}
              >
                {t('ai.page.turnOff')}
              </Button>
            ) : (
              <Button
                size="touch"
                disabled={action.isPending || !canTurnOn}
                aria-describedby={canTurnOn ? undefined : reasonId}
                onClick={() => void save(true, t('ai.page.turnedOn'))}
              >
                <Pending show={action.isPending} />
                {t('ai.page.turnOn')}
              </Button>
            )}
          </div>
        }
      />
      {!enabled && !canTurnOn && (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {reason}
        </p>
      )}
      <AiConnectionBanner
        status={status}
        action={
          <Button asChild size="touch" variant="outline">
            <Link to="/admin/settings/ai">{t('ai.page.openSettings')}</Link>
          </Button>
        }
      />

      {!ready && (
        <Card className="gap-4 border-primary/40">
          <CardHeader className={EDIT_HEADER}>
            <CardTitle>{t('mockSetup.connect.title')}</CardTitle>
            <Badge variant="outline">{t('mockSetup.proposed')}</Badge>
          </CardHeader>
          <CardContent>
            <AiQuickConnect status={status} />
          </CardContent>
        </Card>
      )}

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{t('ai.page.stepName')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field label={t('ai.memberName')}>
            {(p) => (
              <Input
                {...p}
                value={draft.displayName}
                maxLength={64}
                disabled={action.isPending}
                onChange={(e) => setDraft((old) => ({ ...old, displayName: e.target.value }))}
              />
            )}
          </Field>
          <p className="text-sm text-muted-foreground">{t('ai.roleDescription')}</p>
        </CardContent>
      </Card>

      <AiContextPanel
        documents={status.documents}
        ensureMember={ensureMember}
        disabled={action.isPending}
      />

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{t('ai.page.stepTry')}</CardTitle>
        </CardHeader>
        <CardContent>
          <AiTryIt draft={draft} />
        </CardContent>
      </Card>

      <details className="group rounded-lg border bg-card">
        <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">{t('mockSetup.agent.advanced')}</span>
          <span className="text-sm text-muted-foreground">
            {customised ? t('mockSetup.agent.customised') : t('mockSetup.agent.recommended')}
          </span>
          <Badge variant="outline" className="ml-auto">
            {t('mockSetup.proposed')}
          </Badge>
        </summary>
        <div className="flex flex-col gap-4 border-t p-4">
          <Card className="gap-4">
            <CardHeader className={EDIT_HEADER}>
              <CardTitle>{t('ai.page.stepInstructions')}</CardTitle>
              {editWithAi(AiEditField.enum.instructions)}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {isDefaultInstructions(draft.instructions) && (
                <p className="inline-flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {t('ai.page.usingRecommended')}
                </p>
              )}
              <Field
                label={t('ai.instructions')}
                labelClassName="sr-only"
                hint={t('ai.instructionsHint')}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    value={draft.instructions}
                    maxLength={8000}
                    // Fixed, modest height: the long default scrolls inside the box (drag to enlarge)
                    // so Business context, Hand-off rules and Try it stay close.
                    className="field-sizing-fixed h-48 max-h-[70dvh] resize-y overflow-y-auto text-base leading-6 md:h-56 md:text-sm"
                    placeholder={t('ai.page.instructionsPlaceholder')}
                    disabled={action.isPending}
                    onChange={(e) => setDraft((old) => ({ ...old, instructions: e.target.value }))}
                  />
                )}
              </Field>
              {!isDefaultInstructions(draft.instructions) && (
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="self-start"
                  disabled={action.isPending}
                  onClick={() => setDraft((old) => ({ ...old, instructions: local.instructions }))}
                >
                  {t('ai.page.useDefaultInstructions')}
                </Button>
              )}
            </CardContent>
          </Card>

          <Card className="gap-4">
            <CardHeader className={EDIT_HEADER}>
              <CardTitle>{t('ai.page.stepHandoff')}</CardTitle>
              {editWithAi(AiEditField.enum.handoffRules)}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Banner tone="info">{t('ai.page.handoffSystem')}</Banner>
              <Field
                label={t('ai.page.handoffLabel')}
                labelClassName="sr-only"
                hint={t('ai.page.handoffHint')}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    value={draft.handoffRules}
                    maxLength={AI_HANDOFF_RULES_CHARACTERS}
                    className="field-sizing-fixed h-40 resize-y overflow-y-auto text-base leading-6 md:text-sm"
                    placeholder={t('ai.page.handoffPlaceholder')}
                    disabled={action.isPending}
                    onChange={(e) => setDraft((old) => ({ ...old, handoffRules: e.target.value }))}
                  />
                )}
              </Field>
              {!isDefaultRules(draft.handoffRules) && (
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="self-start"
                  disabled={action.isPending}
                  onClick={() => setDraft((old) => ({ ...old, handoffRules: local.handoffRules }))}
                >
                  {t('ai.page.useDefaultHandoff')}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </details>

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

      {Boolean(refreshError) && (
        <Banner tone="danger">{t('ai.refreshError', { error: errorMessage(refreshError) })}</Banner>
      )}
      {(localError || action.error) && (
        <Banner tone="danger">{localError ?? errorMessage(action.error)}</Banner>
      )}

      {!ready && (
        <span id={editReasonId} className="sr-only">
          {t('ai.edit.unavailable')}
        </span>
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

      <SaveBar dirty={dirty}>
        <Button
          size="touch"
          disabled={action.isPending || (!dirty && Boolean(status.member))}
          onClick={() => void save(enabled, t('ai.memberSaved'))}
        >
          <Pending show={action.isPending} />
          {t('ai.page.save')}
        </Button>
      </SaveBar>
    </div>
  );
}

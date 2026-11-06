import { useId, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ChevronRight, ExternalLink, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import {
  AiConnectionBody,
  CHATGPT_FALLBACK_MODELS,
  type AiMemberStatus,
  type AiSettings,
} from '@ezychat/shared';
import { useAiMember, useAiMemberAction, useAiModels, useAiTest } from '../api/ai';
import { errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { AiConnectionBanner } from './AiConnectionBanner';
import { connectionReady, officialLoginUrl } from './ai-status';
import { useTestApiKey } from './AiQuickConnect';
import { ErrorState, Field, ListSkeleton, Pending, SaveBar } from './adminUi';
import { cn } from '@/lib/utils';
// Proposed (custom-agents round 2): the ready card links to the AI agent(s), not "the Sales Agent".
import { useShownAgents } from '../mock/useAgents';
// Proposed (claude-provider): a third connection, "Claude API key" (mock state: src/mock/claude.ts).
import {
  ANTHROPIC_CONSOLE_URL,
  MOCK_CLAUDE_DEFAULT_MODEL,
  MOCK_CLAUDE_MODELS,
  saveMockClaude,
  setMockClaude,
  shownHasOpenAiKey,
  shownMode,
  useMockClaude,
  useTestClaudeConnection,
  useTestClaudeKey,
  type MockClaudeState,
  type ShownMode,
} from '../mock/claude';
import { InfoTip } from '@/components/app/InfoTip';

/** Radix Select needs a non-empty value; '' (Auto) is what is stored. */
const AUTO_MODEL = 'auto';
type ConnectionDraft = { mode: ShownMode; model: string };
type ModeDrafts = { mode: ShownMode; api: string; chatgpt: string; claude: string };
const draftsFrom = (
  settings: Pick<AiSettings, 'mode' | 'model'>,
  claude: MockClaudeState,
): ModeDrafts => ({
  mode: claude.active ? 'claude' : settings.mode === 'chatgpt' ? 'chatgpt' : 'api',
  api: settings.mode === 'api' ? settings.model : '',
  chatgpt: settings.mode === 'chatgpt' ? settings.model : '',
  claude: claude.model,
});

/** Settings → AI: the inbox-wide AI connection, edited in place (no popup). */
export function AiConnectionSection() {
  const query = useAiMember();
  if (!query.data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <ListSkeleton rows={3} />
    );
  return <ConnectionForm status={query.data} refreshError={query.isError ? query.error : null} />;
}

function ConnectionForm({
  status,
  refreshError,
}: {
  status: AiMemberStatus;
  refreshError: unknown;
}) {
  const { t } = useTranslation('admin');
  const modeLabelId = useId();
  const { shown: agents } = useShownAgents();
  const onlyAgent = agents.length === 1 ? agents[0] : undefined;
  // 0–1 agents: straight to that agent (or the create page); 2+: the list on Members.
  const agentLink =
    agents.length > 1
      ? '/admin/members'
      : onlyAgent
        ? `/admin/members/ai/${onlyAgent.id}`
        : '/admin/members/ai/new';
  const stateLabels: Record<AiMemberStatus['connection']['state'], string> = {
    unavailable: t('ai.state.unavailable'),
    signed_out: t('ai.state.signed_out'),
    signing_in: t('ai.state.signing_in'),
    connected: t('ai.state.connected'),
    error: t('ai.state.error'),
    expired: t('ai.state.expired'),
  };
  // Status polling replaces `status`; the draft keeps what the admin has not saved yet.
  // One model per mode, so flipping API -> ChatGPT -> API keeps what was typed.
  const claude = useMockClaude();
  const [drafts, setDrafts] = useState<ModeDrafts>(() => draftsFrom(status.settings, claude));
  const draft: ConnectionDraft = { mode: drafts.mode, model: drafts[drafts.mode] };
  const setModel = (model: string) => setDrafts((old) => ({ ...old, [old.mode]: model }));
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [replacingKey, setReplacingKey] = useState(false);
  const apiModelId = useId();
  const [apiModelOpen, setApiModelOpen] = useState(false);
  // A custom model stays visible; the default ("leave blank") stays tucked away.
  const showApiModel = apiModelOpen || drafts.api !== '';
  const [pasted, setPasted] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const action = useAiMemberAction();
  const test = useAiTest();
  // PROPOSED: a new API key is tested before it is saved (the mock accepts keys starting "sk-").
  const testKey = useTestApiKey();
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const runKeyTest = async (key: string) => {
    const result = await testKey.mutateAsync(key);
    if (result.ok) setTestedKey(key);
    return result.ok;
  };
  // Claude key: its own field, test and "replace" state, so flipping modes never mixes the keys.
  const [claudeKey, setClaudeKey] = useState('');
  const [replacingClaudeKey, setReplacingClaudeKey] = useState(false);
  const testClaude = useTestClaudeKey();
  const [testedClaudeKey, setTestedClaudeKey] = useState<string | null>(null);
  const claudeConnTest = useTestClaudeConnection();
  const runClaudeTest = async (key: string) => {
    const result = await testClaude.mutateAsync(key);
    if (result.ok) setTestedClaudeKey(key);
    return result.ok;
  };
  const saved = status.settings;
  const conn = status.connection;
  const savedMode = shownMode(status, claude);
  const savedModel = savedMode === 'claude' ? claude.model : saved.model;
  const hasOpenAiKey = shownHasOpenAiKey(status, claude);
  const savedChatgpt = savedMode === 'chatgpt';
  const dirty =
    draft.mode !== savedMode ||
    draft.model !== savedModel ||
    (draft.mode === 'api' && apiKey.trim() !== '') ||
    (draft.mode === 'claude' && claudeKey.trim() !== '');
  const modeOptions: Array<{ value: ShownMode; label: string; hint: string; badge: boolean }> = [
    {
      value: 'chatgpt',
      label: t('mockClaude.modeChatgpt'),
      hint: t('mockClaude.modeChatgptHint'),
      badge: true,
    },
    {
      value: 'api',
      label: t('mockClaude.modeOpenAi'),
      hint: t('mockClaude.modeOpenAiHint'),
      badge: false,
    },
    {
      value: 'claude',
      label: t('mockClaude.modeClaude'),
      hint: t('mockClaude.modeClaudeHint'),
      badge: false,
    },
  ];
  const loginUrl = officialLoginUrl(conn.loginUrl);
  // Stored tokens exist: connected and expired always; a failed first sign-in has none.
  const hasTokens =
    savedChatgpt &&
    (conn.state === 'connected' ||
      conn.state === 'expired' ||
      (conn.state === 'error' && Boolean(conn.email)));
  const models = useAiModels(draft.mode === 'chatgpt', conn.state === 'connected');
  const modelOptions = (() => {
    const list = models.data?.models ?? CHATGPT_FALLBACK_MODELS.map((id) => ({ id, label: id }));
    return draft.model && !list.some((model) => model.id === draft.model)
      ? [...list, { id: draft.model, label: draft.model }]
      : list;
  })();

  /** EXPERIMENTAL one-click sign-in: save ChatGPT mode if needed, start sign-in, open the page. */
  const signIn = async () => {
    setLocalError(null);
    test.reset();
    setPopupBlocked(false);
    // Open the tab synchronously so the browser treats it as user-initiated.
    const tab = window.open('about:blank', '_blank');
    try {
      if (!savedChatgpt) {
        const parsed = AiConnectionBody.safeParse({ mode: 'chatgpt', model: draft.model });
        await action.mutateAsync({
          kind: 'connection',
          settings: parsed.success ? parsed.data : { mode: 'chatgpt', model: '' },
        });
        setMockClaude({ active: false }); // the Anthropic key stays saved
      }
      const next = await action.mutateAsync({ kind: 'login' });
      const url = officialLoginUrl(next.connection.loginUrl);
      if (tab && url) {
        tab.opener = null;
        tab.location.href = url;
      } else tab?.close();
      setPopupBlocked(!tab);
    } catch {
      // The mutation error is shown below the form.
      tab?.close();
    }
  };

  const finishPasted = () => {
    const url = pasted.trim();
    if (!url) return;
    action.mutate({ kind: 'callback', url }, { onSuccess: () => setPasted('') });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (draft.mode === 'claude') {
      const newKey = claudeKey.trim();
      if (!claude.hasKey && !newKey) {
        setLocalError(t('mockClaude.keyRequired'));
        return;
      }
      try {
        if (newKey && testedClaudeKey !== newKey && !(await runClaudeTest(newKey))) return;
        await saveMockClaude(
          status,
          (settings) => action.mutateAsync({ kind: 'connection', settings }),
          { model: draft.model, newKey: Boolean(newKey) },
        );
      } catch {
        return; // shown from testClaude.error / action.error
      }
      setClaudeKey('');
      setReplacingClaudeKey(false);
      setTestedClaudeKey(null);
      testClaude.reset();
      claudeConnTest.reset();
      toast.success(t('ai.connectionSaved'));
      return;
    }
    const key = apiKey.trim();
    // The mock keeps a stand-in OpenAI key under Claude; going back to OpenAI needs a real one.
    if (draft.mode === 'api' && !key && !hasOpenAiKey && claude.openAiStandIn) {
      setLocalError(t('mockClaude.openAiKeyRequired'));
      return;
    }
    if (draft.mode === 'api' && key && testedKey !== key) {
      try {
        if (!(await runKeyTest(key))) return;
      } catch {
        return; // shown from testKey.error
      }
    }
    const parsed = AiConnectionBody.safeParse({
      ...draft,
      ...(draft.mode === 'api' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    if (!parsed.success) {
      setLocalError(
        draft.mode === 'chatgpt' && parsed.error.issues[0]?.path[0] === 'model'
          ? t('ai.modelInvalid', {
              models: modelOptions.map((model) => model.id).join(t('ai.modelSeparator')),
            })
          : t('ai.checkSettings'),
      );
      return;
    }
    action.mutate(
      { kind: 'connection', settings: parsed.data },
      {
        onSuccess: (next) => {
          setMockClaude({
            active: false,
            ...(draft.mode === 'api' && key ? { openAiStandIn: false } : {}),
          });
          setDrafts(draftsFrom(next.settings, { ...claude, active: false }));
          setApiKey('');
          setReplacingKey(false);
          setTestedKey(null);
          testKey.reset();
          toast.success(t('ai.connectionSaved'));
        },
      },
    );
  };

  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>{t('ai.settingsTitle')}</CardTitle>
          <InfoTip topic="aiConnection" />
        </div>
        <CardDescription>{t('ai.settingsDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-5">
          <AiConnectionBanner status={status} />
          <div className="flex flex-col gap-2">
            <Label id={modeLabelId}>{t('ai.connectionMode')}</Label>
            {/* PROPOSED (claude-provider): three options do not fit one segmented row at 360 px,
                so the mode is a group of option cards (the Voice messages pattern). */}
            <RadioGroup
              aria-labelledby={modeLabelId}
              value={draft.mode}
              onValueChange={(mode) => setDrafts((old) => ({ ...old, mode: mode as ShownMode }))}
              disabled={action.isPending}
              className="grid gap-2 sm:grid-cols-3"
            >
              {modeOptions.map((option) => {
                const id = `ai-mode-${option.value}`;
                return (
                  <Label
                    key={option.value}
                    htmlFor={id}
                    className={cn(
                      'flex min-h-11 cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 leading-normal transition-colors hover:bg-accent',
                      draft.mode === option.value && 'border-primary bg-primary/5',
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      <RadioGroupItem id={id} value={option.value} />
                      {option.label}
                      {option.badge && (
                        <Badge variant="secondary" className="pointer-events-none">
                          {t('mockSetup.connect.recommended')}
                        </Badge>
                      )}
                    </span>
                    <span className="font-normal text-muted-foreground">{option.hint}</span>
                  </Label>
                );
              })}
            </RadioGroup>
          </div>

          {draft.mode === 'claude' ? (
            <div className="flex flex-col gap-3">
              {claude.hasKey && !replacingClaudeKey ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm leading-none font-medium">{t('mockClaude.keyLabel')}</p>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
                    <span className="inline-flex items-center gap-2 text-sm">
                      <KeyRound className="size-4 text-success" aria-hidden />
                      {t('mockClaude.keySaved')}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="touch"
                      className="md:pointer-fine:min-h-8"
                      disabled={action.isPending}
                      onClick={() => setReplacingClaudeKey(true)}
                    >
                      {t('ai.replaceKey')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Field
                    label={t('mockClaude.keyLabel')}
                    tip="claudeKey"
                    hint={claude.hasKey ? t('mockClaude.keepKeyHint') : t('mockClaude.keyHint')}
                    error={
                      testClaude.data && !testClaude.data.ok
                        ? (testClaude.data.error ?? t('mockSetup.connect.keyFailedFallback'))
                        : undefined
                    }
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="password"
                        value={claudeKey}
                        autoComplete="new-password"
                        spellCheck={false}
                        disabled={action.isPending || testClaude.isPending}
                        onChange={(e) => {
                          setClaudeKey(e.target.value);
                          testClaude.reset();
                        }}
                        placeholder="sk-ant-…"
                      />
                    )}
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="touch"
                      disabled={!claudeKey.trim() || testClaude.isPending || action.isPending}
                      onClick={() => void runClaudeTest(claudeKey.trim()).catch(() => undefined)}
                    >
                      <Pending show={testClaude.isPending} />
                      {t('mockSetup.connect.testKey')}
                    </Button>
                    {testClaude.data?.ok &&
                      testedClaudeKey === claudeKey.trim() &&
                      !testClaude.data.warning && (
                        <p role="status" className="inline-flex items-center gap-1.5 text-sm">
                          <CheckCircle2 className="size-4 text-success" aria-hidden />
                          {t('mockSetup.settings.keyOk')}
                        </p>
                      )}
                  </div>
                  {testClaude.data?.ok && testClaude.data.warning && (
                    <Banner tone="warning">{testClaude.data.warning}</Banner>
                  )}
                  {testClaude.error && (
                    <Banner tone="danger">{errorMessage(testClaude.error)}</Banner>
                  )}
                  {claude.hasKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="touch"
                      className="self-start"
                      disabled={action.isPending}
                      onClick={() => {
                        setClaudeKey('');
                        setReplacingClaudeKey(false);
                        setTestedClaudeKey(null);
                        testClaude.reset();
                      }}
                    >
                      {t('ai.keepKey')}
                    </Button>
                  )}
                </div>
              )}
              <Button
                asChild
                variant="link"
                size="touch"
                className="h-auto self-start px-0 text-left whitespace-normal"
              >
                <a href={ANTHROPIC_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden />
                  {t('mockClaude.getKey')}
                </a>
              </Button>
            </div>
          ) : draft.mode === 'api' ? (
            hasOpenAiKey && !replacingKey ? (
              // A saved key is never shown; say so plainly instead of an empty "hidden" field.
              <div className="flex flex-col gap-2">
                <p className="text-sm leading-none font-medium">{t('ai.apiKey')}</p>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
                  <span className="inline-flex items-center gap-2 text-sm">
                    <KeyRound className="size-4 text-success" aria-hidden />
                    {t('ai.keySaved')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="md:pointer-fine:min-h-8"
                    disabled={action.isPending}
                    onClick={() => setReplacingKey(true)}
                  >
                    {t('ai.replaceKey')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Field
                  label={t('ai.apiKey')}
                  tip="apiKey"
                  hint={hasOpenAiKey ? t('ai.keepKeyHint') : t('ai.apiKeyHint')}
                  error={
                    testKey.data && !testKey.data.ok
                      ? (testKey.data.error ?? t('mockSetup.connect.keyFailedFallback'))
                      : undefined
                  }
                >
                  {(p) => (
                    <Input
                      {...p}
                      type="password"
                      value={apiKey}
                      autoComplete="new-password"
                      disabled={action.isPending || testKey.isPending}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        testKey.reset();
                      }}
                      placeholder={t('ai.enterKey')}
                    />
                  )}
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={!apiKey.trim() || testKey.isPending || action.isPending}
                    onClick={() => void runKeyTest(apiKey.trim()).catch(() => undefined)}
                  >
                    <Pending show={testKey.isPending} />
                    {t('mockSetup.connect.testKey')}
                  </Button>
                  {testKey.data?.ok && testedKey === apiKey.trim() && (
                    <p role="status" className="inline-flex items-center gap-1.5 text-sm">
                      <CheckCircle2 className="size-4 text-success" aria-hidden />
                      {t('mockSetup.settings.keyOk')}
                    </p>
                  )}
                </div>
                {testKey.error && <Banner tone="danger">{errorMessage(testKey.error)}</Banner>}
                {hasOpenAiKey && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="touch"
                    className="self-start"
                    disabled={action.isPending}
                    onClick={() => {
                      setApiKey('');
                      setReplacingKey(false);
                    }}
                  >
                    {t('ai.keepKey')}
                  </Button>
                )}
              </div>
            )
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{t('mockSetup.connect.note')}</p>
              <p className="text-sm text-muted-foreground">
                {t('mockSetup.settings.remoteSignInHint')}
              </p>
              <p role="status" className="text-sm">
                {savedChatgpt && conn.state === 'connected'
                  ? conn.email
                    ? t('ai.signedInAs', { email: conn.email })
                    : t('ai.signedIn')
                  : savedChatgpt
                    ? t('ai.chatgptState', { state: stateLabels[conn.state] })
                    : t('ai.signInSavesMode')}
              </p>
              {savedChatgpt && conn.state === 'connected' && conn.error && (
                <Banner tone="danger">{conn.error}</Banner>
              )}
              <div className="flex flex-wrap gap-2">
                {savedChatgpt && conn.state === 'signing_in' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ kind: 'logout' })}
                  >
                    {t('ai.cancelLogin')}
                  </Button>
                ) : savedChatgpt && conn.state === 'connected' ? null : (
                  <Button
                    type="button"
                    size="touch"
                    disabled={action.isPending}
                    onClick={() => void signIn()}
                  >
                    {t('ai.signInWithChatgpt')}
                  </Button>
                )}
                {hasTokens && conn.state !== 'signing_in' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ kind: 'logout' })}
                  >
                    {t('ai.signOut')}
                  </Button>
                )}
                {savedChatgpt && loginUrl && (
                  <Button asChild variant="outline" size="touch">
                    <a href={loginUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink aria-hidden />
                      {t('ai.openLogin')}
                    </a>
                  </Button>
                )}
                {savedChatgpt && loginUrl && popupBlocked && (
                  <p className="self-center text-sm text-muted-foreground">
                    {t('ai.popupBlocked')}
                  </p>
                )}
              </div>
              {conn.loginUrl && !loginUrl && <Banner tone="danger">{t('ai.invalidLink')}</Banner>}
              {savedChatgpt && conn.state === 'signing_in' && (
                <div className="flex flex-col gap-2 rounded-lg border p-3">
                  <Field label={t('ai.pasteLabel')} hint={t('ai.pasteHint')}>
                    {(p) => (
                      <Input
                        {...p}
                        value={pasted}
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t('ai.pastePlaceholder')}
                        disabled={action.isPending}
                        onChange={(e) => setPasted(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            finishPasted();
                          }
                        }}
                      />
                    )}
                  </Field>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="self-start"
                    disabled={action.isPending || !pasted.trim()}
                    onClick={finishPasted}
                  >
                    {t('ai.pasteSubmit')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {draft.mode === 'chatgpt' ? (
            <Field
              label={t('ai.chatgptModel')}
              tip="aiModel"
              hint={models.data?.source === 'live' ? t('ai.modelsLive') : t('ai.modelsFallback')}
            >
              {(p) => (
                <Select
                  value={draft.model || AUTO_MODEL}
                  disabled={action.isPending}
                  onValueChange={(value) => setModel(value === AUTO_MODEL ? '' : value)}
                >
                  <SelectTrigger {...p} className="min-h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_MODEL}>{t('ai.modelAuto')}</SelectItem>
                    {modelOptions.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          ) : draft.mode === 'claude' ? (
            <div className="flex flex-col gap-3">
              <Field label={t('mockClaude.model')} hint={t('mockClaude.modelHint')} tip="aiModel">
                {(p) => (
                  <Select
                    value={draft.model || MOCK_CLAUDE_DEFAULT_MODEL}
                    disabled={action.isPending}
                    onValueChange={setModel}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MOCK_CLAUDE_MODELS.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {t(model.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <p className="text-sm text-muted-foreground">{t('mockClaude.voiceNote')}</p>
              {savedMode === 'claude' && claude.hasKey && (
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    className="self-start"
                    disabled={action.isPending || claudeConnTest.isPending || dirty}
                    onClick={() => claudeConnTest.mutate(claude.model)}
                  >
                    <Pending show={claudeConnTest.isPending} />
                    {t('ai.testConnection')}
                  </Button>
                  {dirty && (
                    <p className="text-sm text-muted-foreground">{t('ai.saveBeforeTest')}</p>
                  )}
                  {claudeConnTest.data && (
                    <p role="status" className="text-sm break-words">
                      {t('ai.testOk', {
                        model: claudeConnTest.data.model,
                        reply: claudeConnTest.data.reply,
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            // Most inboxes keep the default model, so the free-text model id sits behind Advanced.
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="ghost"
                size="touch"
                aria-expanded={showApiModel}
                aria-controls={apiModelId}
                className="justify-start self-start px-2 whitespace-normal text-left"
                onClick={() => setApiModelOpen((open) => !open)}
              >
                <ChevronRight
                  aria-hidden
                  className={cn('transition-transform', showApiModel && 'rotate-90')}
                />
                {t('ai.modelAdvanced')}
              </Button>
              <div id={apiModelId} hidden={!showApiModel}>
                <Field label={t('ai.model')} hint={t('ai.apiModelHint')} tip="aiModel">
                  {(p) => (
                    <Input
                      {...p}
                      value={draft.model}
                      maxLength={128}
                      disabled={action.isPending}
                      onChange={(e) => setModel(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </div>
          )}

          {draft.mode === 'chatgpt' &&
            hasTokens &&
            (conn.state === 'connected' || conn.state === 'error') && (
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="self-start"
                  disabled={action.isPending || test.isPending || dirty}
                  onClick={() => test.mutate()}
                >
                  <Pending show={test.isPending} />
                  {t('ai.testConnection')}
                </Button>
                {dirty && <p className="text-sm text-muted-foreground">{t('ai.saveBeforeTest')}</p>}
                {test.data &&
                  (test.data.ok ? (
                    <p role="status" className="text-sm break-words">
                      {t('ai.testOk', {
                        model: test.data.model ?? '',
                        reply: test.data.reply ?? '',
                      })}
                    </p>
                  ) : (
                    <Banner tone="danger">
                      {t('ai.testFailed', { error: test.data.error ?? '' })}
                    </Banner>
                  ))}
                {test.error && <Banner tone="danger">{errorMessage(test.error)}</Banner>}
              </div>
            )}

          {connectionReady(status) && !dirty && (
            <div className="flex flex-col gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p role="status" className="inline-flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                {t('mockSetup.settings.connectionReady')}
              </p>
              <Button asChild size="touch" variant="outline" className="sm:shrink-0">
                <Link to={agentLink} data-testid="settings-agent-link">
                  {agents.length > 1
                    ? t('mockSetup.settings.openAgents')
                    : t('mockSetup.settings.setupAgent')}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </div>
          )}
          {Boolean(refreshError) && (
            <Banner tone="danger">
              {t('ai.refreshError', { error: errorMessage(refreshError) })}
            </Banner>
          )}
          {(localError || action.error) && (
            <Banner tone="danger">{localError ?? errorMessage(action.error)}</Banner>
          )}
          <SaveBar dirty={dirty} inset="card">
            <Button
              type="submit"
              size="touch"
              disabled={action.isPending || testKey.isPending || testClaude.isPending || !dirty}
            >
              <Pending show={action.isPending || testKey.isPending || testClaude.isPending} />
              {t('ai.saveConnection')}
            </Button>
          </SaveBar>
        </form>
      </CardContent>
    </Card>
  );
}

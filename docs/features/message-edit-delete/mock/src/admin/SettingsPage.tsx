import { useState } from 'react';
import type React from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { SettingsPatchBody } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { usePatchSettings, useSettings } from '../api/queries';
import { PushToggle } from '../pwa/PushToggle';
import { Banner, PageHeader, SegmentedControl } from '@/components/app';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isLocale, SUPPORTED_LOCALES } from '@ezychat/shared';
import { useChangeLocale } from '@/i18n/use-change-locale';
import { THEME_OPTIONS, useTheme } from '@/lib/theme';
import { useTranslation } from 'react-i18next';
import { ErrorState, Field, Pending, SaveBar } from './adminUi';
import { ResolveAllChatsCard } from './ResolveAllChatsCard';
import { AiConnectionSection } from './AiConnectionSection';
import { ReplySuggestionsSection } from './ReplySuggestionsSection';
import { PhraseDictionarySection } from './PhraseDictionarySection';
import { CustomerEnrichmentSection } from './CustomerEnrichmentSection';
import { AiVoiceSection } from './AiVoiceSection';
import { IntegrationsSection } from './IntegrationsSection';

const TABS = ['general', 'ai', 'integrations', 'device', 'maintenance'] as const;
type SettingsTab = (typeof TABS)[number];
const TAB_LABEL_KEY = {
  general: 'settings.tabs.general',
  ai: 'settings.tabs.ai',
  integrations: 'settings.tabs.integrations',
  device: 'settings.tabs.device',
  maintenance: 'settings.tabs.maintenance',
} as const satisfies Record<SettingsTab, string>;

function isTab(value: string | undefined): value is SettingsTab {
  return TABS.some((tab) => tab === value);
}

/** One preference row: label (and hint) left, control right; stacked on narrow screens. */
function PreferenceRow({
  labelId,
  label,
  hintId,
  hint,
  children,
  below,
}: {
  labelId: string;
  label: string;
  hintId: string;
  hint: string;
  /** The control (switch, segmented control). Keep it small: long text belongs in `below`. */
  children: React.ReactNode;
  /** Notes under the whole row (full width), e.g. a hint or a warning about the control. */
  below?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h3 id={labelId} className="font-medium">
            {label}
          </h3>
          <p id={hintId} className="mt-0.5 text-sm text-muted-foreground">
            {hint}
          </p>
        </div>
        {children != null && <div className="shrink-0">{children}</div>}
      </div>
      {below}
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const { theme, setTheme } = useTheme();
  const { locale, changeLocale } = useChangeLocale();
  const navigate = useNavigate();
  const tab = useParams()['*'];
  const { t } = useTranslation(['admin', 'common']);

  const [portDraft, setPort] = useState<string>();
  const [lanDraft, setLanEnabled] = useState<boolean>();
  const [historyDraft, setHistoryDays] = useState<string>();
  const [restartRequired, setRestartRequired] = useState(false);

  if (!isTab(tab)) return <Navigate to="/admin/settings/general" replace />;

  if (settings.isPending)
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={t('ui.loading')}>
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;

  const cur = settings.data;
  const port = portDraft ?? String(cur.port);
  const lanEnabled = lanDraft ?? cur.lanEnabled;
  const historyDays = historyDraft ?? String(cur.historyDays);
  const portNum = Number(port);
  const daysNum = Number(historyDays);
  const portError =
    !Number.isInteger(portNum) || portNum < 1024 || portNum > 65535
      ? t('settings.portInvalid')
      : undefined;
  const daysError =
    !Number.isInteger(daysNum) || daysNum < 0 || daysNum > 365
      ? t('settings.historyInvalid')
      : undefined;

  const body: SettingsPatchBody = {};
  if (!portError && portNum !== cur.port) body.port = portNum;
  if (lanEnabled !== cur.lanEnabled) body.lanEnabled = lanEnabled;
  if (!daysError && daysNum !== cur.historyDays) body.historyDays = daysNum;
  const dirty = Object.keys(body).length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (portError || daysError || !dirty) return;
    const needsRestart = body.port !== undefined || body.lanEnabled !== undefined;
    patch.mutate(body, {
      onSuccess: (r) => {
        toast.success(t('settings.saved'));
        if (r.restartRequired || needsRestart) setRestartRequired(true);
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        className="pb-0"
        title={t('settings.title')}
        description={t('settings.description')}
      />

      <Tabs value={tab} onValueChange={(next) => navigate(`/admin/settings/${next}`)}>
        {/* Tabs scroll sideways on narrow phones (Malay labels are longest) instead of clipping. */}
        <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
          <TabsList variant="line" className="w-max justify-start">
            {TABS.map((id) => (
              <TabsTrigger key={id} value={id} className="flex-none px-3">
                {t(TAB_LABEL_KEY[id])}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="general" className="flex flex-col gap-4">
          {restartRequired && (
            <Banner tone="warning" title={t('settings.restartTitle')}>
              {t('settings.restartBody')}
            </Banner>
          )}

          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Card className="gap-4">
              <CardHeader>
                <CardTitle>{t('settings.network.title')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <Field
                  label={t('settings.network.port')}
                  error={portError}
                  hint={t('settings.network.portHint')}
                >
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      inputMode="numeric"
                      min={1024}
                      max={65535}
                      className="h-11 md:h-9 md:max-w-48"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                    />
                  )}
                </Field>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Label htmlFor="settings-lan" className="leading-normal">
                      {t('settings.network.lan')}
                    </Label>
                    <p id="settings-lan-desc" className="mt-0.5 text-sm text-muted-foreground">
                      {t('settings.network.lanHint')}
                    </p>
                  </div>
                  {/* Associate the padded target with the switch so its entire area is tappable. */}
                  <Label
                    htmlFor="settings-lan"
                    className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
                  >
                    <Switch
                      id="settings-lan"
                      aria-describedby="settings-lan-desc"
                      checked={lanEnabled}
                      onCheckedChange={setLanEnabled}
                    />
                  </Label>
                </div>
                {lanEnabled && (
                  <Banner tone="warning" title={t('settings.network.lanWarningTitle')}>
                    {t('settings.network.lanWarningBody')}
                  </Banner>
                )}
              </CardContent>
            </Card>

            <Card className="gap-4">
              <CardHeader>
                <CardTitle>{t('settings.history.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Field
                  label={t('settings.history.days')}
                  error={daysError}
                  hint={t('settings.history.daysHint')}
                >
                  {(p) => (
                    <div className="flex items-center gap-2">
                      <Input
                        {...p}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={365}
                        className="h-11 md:h-9 md:max-w-32"
                        value={historyDays}
                        onChange={(e) => setHistoryDays(e.target.value)}
                      />
                      <span className="text-sm text-muted-foreground">
                        {t('settings.history.unit')}
                      </span>
                    </div>
                  )}
                </Field>
              </CardContent>
            </Card>

            {patch.error && <Banner tone="danger">{errorMessage(patch.error)}</Banner>}

            <SaveBar dirty={dirty}>
              <Button
                type="submit"
                size="touch"
                className="md:min-h-9"
                disabled={patch.isPending || !dirty || !!portError || !!daysError}
              >
                <Pending show={patch.isPending} />
                {t('settings.save')}
              </Button>
            </SaveBar>
          </form>
        </TabsContent>

        <TabsContent value="ai" className="flex flex-col gap-6">
          <AiConnectionSection />
          {/* Proposed (ai-reply-suggestions): the team-wide switch. */}
          <ReplySuggestionsSection />
          {/* Proposed (ai-phrase-dictionary): the team's phrase list for instant grey text. */}
          <PhraseDictionarySection />
          {/* PROPOSED: optional features collapsed under one heading, closed by default. */}
          <details className="group rounded-lg border bg-card">
            <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <ChevronRight
                className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
                aria-hidden
              />
              <span className="font-medium">{t('mockSetup.settings.moreFeatures')}</span>
              <span className="text-sm text-muted-foreground">
                {t('mockSetup.settings.moreFeaturesHint')}
              </span>
              <Badge variant="outline" className="ml-auto">
                {t('mockSetup.proposed')}
              </Badge>
            </summary>
            <div className="flex flex-col gap-6 border-t p-4">
              <AiVoiceSection />
              <CustomerEnrichmentSection />
            </div>
          </details>
        </TabsContent>

        <TabsContent value="integrations" className="flex flex-col gap-4">
          {/* Proposed (google-calendar): ready connectors have their own gallery. */}
          <Banner tone="info" title={t('mockConnectors.settingsPointerTitle')}>
            <Link
              to="/admin/connectors"
              className="text-primary underline-offset-4 hover:underline"
            >
              {t('mockConnectors.settingsPointer')}
            </Link>
          </Banner>
          <IntegrationsSection />
        </TabsContent>

        <TabsContent value="device" className="flex flex-col gap-4">
          <Card className="gap-4">
            <CardHeader>
              <CardTitle>{t('settings.device.title')}</CardTitle>
              <CardDescription>{t('settings.device.description')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <PreferenceRow
                labelId="settings-theme-label"
                label={t('common:theme.label')}
                hintId="settings-theme-desc"
                hint={t('settings.device.themeHint')}
              >
                <SegmentedControl
                  aria-labelledby="settings-theme-label"
                  aria-describedby="settings-theme-desc"
                  value={theme}
                  onValueChange={setTheme}
                  options={THEME_OPTIONS.map((o) => ({
                    value: o.value,
                    label: t(`common:${o.labelKey}`),
                  }))}
                />
              </PreferenceRow>
              {/* PushToggle hands over just its switch (named by the row) and its notes, which go
                  under the row so a long desktop hint never squeezes the description. */}
              <PushToggle labelledBy="settings-notifications-label">
                {({ control, notes }) => (
                  <PreferenceRow
                    labelId="settings-notifications-label"
                    label={t('settings.device.notifications')}
                    hintId="settings-notifications-desc"
                    hint={t('settings.device.notificationsHint')}
                    below={notes}
                  >
                    {control}
                  </PreferenceRow>
                )}
              </PushToggle>
            </CardContent>
          </Card>

          <Card className="gap-4">
            <CardHeader>
              <CardTitle>{t('settings.account.title')}</CardTitle>
              <CardDescription>{t('settings.account.description')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <PreferenceRow
                labelId="settings-language-label"
                label={t('common:language.label')}
                hintId="settings-language-desc"
                hint={t('settings.device.languageHint')}
              >
                <SegmentedControl
                  aria-labelledby="settings-language-label"
                  aria-describedby="settings-language-desc"
                  value={locale}
                  onValueChange={(v) => isLocale(v) && changeLocale(v)}
                  options={SUPPORTED_LOCALES.map((l) => ({
                    value: l.code,
                    label: t(`settings.device.languageShort.${l.code}`),
                  }))}
                />
              </PreferenceRow>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Resolving every chat is reversible (chats can be reopened), so no danger styling. */}
        <TabsContent value="maintenance">
          <ResolveAllChatsCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

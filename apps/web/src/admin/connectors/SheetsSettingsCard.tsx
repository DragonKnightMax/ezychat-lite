import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, Table2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  SheetsAgentSettings,
  googleSheetUrl,
  type GoogleSheetsStatus,
  type SpreadsheetInfo,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import {
  useSaveSheetsSettings,
  useSheetsPicker,
  useSheetsPickerProgress,
  useSheetsSettings,
  useSpreadsheetLookup,
} from '../../api/connectors';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ErrorState,
  Field,
  ListSkeleton,
  Pending,
  SaveBar,
  type FieldControlProps,
} from '../adminUi';
import { ToolSwitchRow } from './connector-ui';

type FieldErrors = Partial<Record<'sheet' | 'lookupTab' | 'leadsTab', string>>;

interface Picking {
  requestId: string;
  url: string;
  /** The browser blocked the new window: the admin opens the link themselves. */
  blocked: boolean;
}
const RULES = ['rule1', 'rule2', 'rule3', 'rule4'] as const;
/** Test ids of the two tab choices. */
const TAB_TEST_IDS = { lookup: 'sheets-lookup-tab', leads: 'sheets-leads-tab' } as const;

/**
 * Connectors → Google Sheets → Settings, for one AI agent: the spreadsheet (picked in Google's
 * file picker), "Answer questions" with its tab (on by default) and "Save leads" with its tab (off until an
 * admin turns it on).
 */
export function SheetsSettingsCard({
  agentId,
  name,
  status,
  onConnect,
}: Readonly<{
  agentId: number;
  name: string;
  status: GoogleSheetsStatus;
  /** Shows the account card (Overview tab) to connect. */
  onConnect: () => void;
}>) {
  const { t } = useTranslation('admin');
  const connected = status.state !== 'disconnected' && status.state !== 'not_configured';
  const query = useSheetsSettings(agentId, connected);
  const save = useSaveSheetsSettings(agentId);
  const lookup = useSpreadsheetLookup();
  const [draft, setDraft] = useState<SheetsAgentSettings>();
  const picker = useSheetsPicker();
  const [picking, setPicking] = useState<Picking | null>(null);
  const [pickError, setPickError] = useState<'cancelled' | 'failed' | 'expired' | null>(null);
  const progress = useSheetsPickerProgress(picking?.requestId ?? null);
  const [info, setInfo] = useState<SpreadsheetInfo | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const ids = { read: useId(), leads: useId() };
  const saved = query.data;
  const value = draft ?? saved;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<SheetsAgentSettings>) => {
    if (value) setDraft({ ...value, ...patch });
  };

  // The saved spreadsheet's tabs, read once from Google (the tab choices need them).
  const savedId = saved?.spreadsheetId ?? null;
  const { mutate: find } = lookup;
  useEffect(() => {
    if (savedId && connected) find(savedId, { onSuccess: setInfo });
  }, [savedId, connected, find]);

  /** A sheet picked in Google's picker: its tabs, the first one to read, leads tab kept if there. */
  const apply = (found: SpreadsheetInfo) => {
    if (!value) return;
    setInfo(found);
    const has = (tab: string | null) => !!tab && found.tabs.some((x) => x.title === tab);
    set({
      spreadsheetId: found.id,
      spreadsheetName: found.name,
      lookupTab: has(value.lookupTab) ? value.lookupTab : (found.tabs[0]?.title ?? null),
      leadsTab: has(value.leadsTab) ? value.leadsTab : null,
    });
  };

  const pickStatus = progress.data?.status;
  const pickedSheet = progress.data?.sheet ?? null;
  useEffect(() => {
    if (!picking || !pickStatus || pickStatus === 'pending') return;
    setPicking(null);
    if (pickStatus === 'done' && pickedSheet) apply(pickedSheet);
    else setPickError(pickStatus === 'done' ? 'failed' : pickStatus);
    // apply reads the current draft; the poll result is what changes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, pickStatus, pickedSheet]);

  /** Opens Google's file picker in a new window (inside the click, so the browser allows it). */
  const choose = async () => {
    setPickError(null);
    setErrors({});
    const tab = window.open('about:blank', '_blank');
    try {
      const next = await picker.mutateAsync();
      if (tab) {
        tab.opener = null;
        tab.location.href = next.pickerUrl;
      }
      setPicking({ requestId: next.requestId, url: next.pickerUrl, blocked: !tab });
    } catch {
      tab?.close();
    }
  };

  const submit = () => {
    if (!value) return;
    const next: FieldErrors = {};
    if (value.spreadsheetId && value.lookup && !value.lookupTab)
      next.lookupTab = t('connectors.sheets.tabRequired');
    if (value.addLeads && !value.leadsTab) next.leadsTab = t('connectors.sheets.tabRequired');
    if (!value.spreadsheetId && value.addLeads) next.sheet = t('connectors.sheets.sheetRequired');
    setErrors(next);
    const parsed = SheetsAgentSettings.safeParse(value);
    if (Object.keys(next).length > 0 || !parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(undefined);
        toast.success(t('connectors.sheets.saved'));
      },
    });
  };

  const tabs = info && value && info.id === value.spreadsheetId ? info.tabs : [];
  const tabSelect = (
    current: string | null,
    onChange: (tab: string) => void,
    testId: string,
    p: FieldControlProps,
  ) => (
    <Select value={current ?? ''} onValueChange={onChange} disabled={tabs.length === 0}>
      <SelectTrigger
        {...p}
        className="min-h-11 w-full *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate"
        data-testid={testId}
      >
        <SelectValue placeholder={t('connectors.sheets.chooseTab')} />
      </SelectTrigger>
      <SelectContent>
        {/* A saved tab Google no longer lists stays visible until it is changed. */}
        {current && !tabs.some((x) => x.title === current) && (
          <SelectItem value={current}>{current}</SelectItem>
        )}
        {tabs.map((tab) => (
          <SelectItem key={tab.title} value={tab.title}>
            {tab.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Card className="gap-4" data-testid="agent-sheets">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Table2 className="size-5 text-muted-foreground" aria-hidden />
          {t('connectors.sheets.title')}
        </CardTitle>
        <CardDescription>{t('connectors.sheets.description', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!connected && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {status.state === 'not_configured'
                ? t('connectors.gc.notConfiguredBody')
                : t('connectors.sheets.notConnected')}
            </p>
            {status.state === 'disconnected' && (
              <Button size="touch" onClick={onConnect}>
                {t('connectors.gs.connect')}
              </Button>
            )}
          </div>
        )}
        {connected && query.isPending && <ListSkeleton rows={3} />}
        {connected && query.error && (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
        {connected && value && (
          <>
            {(status.state === 'expired' || status.state === 'unavailable') && (
              <Banner tone="warning" title={t(`connectors.sheets.paused.${status.state}`)}>
                {t('connectors.sheets.pausedBody', { name })}{' '}
                <Button variant="link" className="h-auto p-0 align-baseline" onClick={onConnect}>
                  {t('connectors.booking.openAccount')}
                </Button>
              </Banner>
            )}

            <div className="flex flex-col gap-3">
              {value.spreadsheetId && (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3"
                  data-testid="sheets-chosen"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-muted-foreground">
                      {t('connectors.sheets.spreadsheet')}
                    </span>
                    <span className="font-medium break-words">
                      {value.spreadsheetName ?? info?.name ?? value.spreadsheetId}
                    </span>
                  </div>
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="min-h-9 pointer-coarse:min-h-11"
                  >
                    <a
                      href={googleSheetUrl(value.spreadsheetId)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('connectors.sheets.open')}
                      <ExternalLink aria-hidden />
                    </a>
                  </Button>
                </div>
              )}
              {!picking && (
                <div className="flex flex-col items-start gap-2">
                  <Button
                    size="touch"
                    variant={value.spreadsheetId ? 'outline' : 'default'}
                    disabled={picker.isPending}
                    onClick={() => void choose()}
                    data-testid="sheets-choose"
                  >
                    <Pending show={picker.isPending} />
                    {value.spreadsheetId
                      ? t('connectors.sheets.chooseAnother')
                      : t('connectors.sheets.choose')}
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    {t('connectors.sheets.chooseHint')}
                  </p>
                  {errors.sheet && <p className="text-sm text-danger">{errors.sheet}</p>}
                </div>
              )}
              {picking && (
                <div
                  className="flex flex-col items-start gap-3 rounded-lg border px-3 py-3"
                  role="status"
                  data-testid="sheets-picking"
                >
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {t('connectors.sheets.picking')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {picking.blocked
                      ? t('connectors.sheets.pickBlocked')
                      : t('connectors.sheets.pickingHint')}
                  </p>
                  <Button asChild size="touch" variant={picking.blocked ? 'default' : 'outline'}>
                    <a href={picking.url} target="_blank" rel="noopener noreferrer">
                      {t('connectors.sheets.openPicker')}
                      <ExternalLink aria-hidden />
                    </a>
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    {t('connectors.sheets.pickSameComputer')}
                  </p>
                  <Button size="touch" variant="ghost" onClick={() => setPicking(null)}>
                    {t('connectors.gc.cancelSignIn')}
                  </Button>
                </div>
              )}
              {pickError && (
                <Banner tone="danger">{t(`connectors.sheets.pickError.${pickError}`)}</Banner>
              )}
              {picker.error && <Banner tone="danger">{errorMessage(picker.error)}</Banner>}
              {lookup.error && <Banner tone="danger">{errorMessage(lookup.error)}</Banner>}
              {lookup.error && <Banner tone="danger">{errorMessage(lookup.error)}</Banner>}
            </div>

            <div className="flex flex-col divide-y rounded-lg border">
              <ToolSwitchRow
                id={ids.read}
                label={t('connectors.tools.readRows')}
                hint={t('connectors.sheets.readHint')}
                checked={value.lookup}
                onCheckedChange={(lookupOn) => set({ lookup: lookupOn })}
              >
                {value.lookup && value.spreadsheetId && (
                  <Field label={t('connectors.sheets.lookupTab')} error={errors.lookupTab}>
                    {(p) =>
                      tabSelect(
                        value.lookupTab,
                        (lookupTab) => set({ lookupTab }),
                        TAB_TEST_IDS.lookup,
                        p,
                      )
                    }
                  </Field>
                )}
              </ToolSwitchRow>
              <ToolSwitchRow
                id={ids.leads}
                label={t('connectors.tools.addLead')}
                badge={t('connectors.sheets.changesSheet')}
                hint={t('connectors.sheets.leadsHint')}
                checked={value.addLeads}
                disabled={!value.spreadsheetId}
                onCheckedChange={(addLeads) => set({ addLeads })}
              >
                {value.addLeads && value.spreadsheetId && (
                  <Field
                    label={t('connectors.sheets.leadsTab')}
                    hint={t('connectors.sheets.leadsTabHint')}
                    error={errors.leadsTab}
                  >
                    {(p) =>
                      tabSelect(
                        value.leadsTab,
                        (leadsTab) => set({ leadsTab }),
                        TAB_TEST_IDS.leads,
                        p,
                      )
                    }
                  </Field>
                )}
              </ToolSwitchRow>
            </div>

            <div className="rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">
                {t('connectors.sheets.rulesTitle')}
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {RULES.map((key) => (
                  <li key={key}>{t(`connectors.sheets.${key}`)}</li>
                ))}
              </ul>
            </div>
            {save.error && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
            <SaveBar dirty={dirty} inset="card">
              <Button size="touch" disabled={!dirty || save.isPending} onClick={submit}>
                <Pending show={save.isPending} />
                {t('connectors.sheets.save')}
              </Button>
            </SaveBar>
          </>
        )}
      </CardContent>
    </Card>
  );
}

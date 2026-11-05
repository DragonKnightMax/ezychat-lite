import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, RefreshCw, Table2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  SHEETS_AUTO_COLUMNS,
  SheetsAgentSettings,
  googleSheetUrl,
  type GoogleSheetsStatus,
  type SheetTabAccess,
  type SpreadsheetInfo,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import {
  useRefreshSheetTabs,
  useSaveSheetsSettings,
  useSheetsPicker,
  useSheetsPickerProgress,
  useSheetsSettings,
  useSpreadsheetLookup,
} from '../../api/connectors';
import { Banner, SegmentedControl } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatRelative } from '../../lib/format';
import { ErrorState, ListSkeleton, Pending, SaveBar } from '../adminUi';
import { diffTabs, isAutoColumn, normalizeTabs, tabsToSave, type TabMarks } from './sheets-tabs';
import { PickerWaiting } from './connector-ui';

interface Picking {
  requestId: string;
  url: string;
  /** The browser blocked the new window: the admin opens the link themselves. */
  blocked: boolean;
}
const RULES = ['rule1', 'rule2', 'rule3', 'rule4', 'rule5', 'rule6'] as const;
const ACCESS = ['off', 'read', 'add'] as const satisfies readonly SheetTabAccess[];

/**
 * Connectors → Google Sheets → Settings, for one AI agent (design
 * docs/features/group-agents/design.md): the spreadsheet (picked in Google's file picker) and, per
 * tab, Off / Read / Add rows with the tab's column names. The agent's instructions say when to use
 * them. Refresh reads the tabs again and marks a new tab, changed columns and a tab Google no
 * longer lists (its access is dropped on Save). Opening the card reads them once.
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
  const refresh = useRefreshSheetTabs(agentId);
  const [draft, setDraft] = useState<SheetsAgentSettings>();
  const picker = useSheetsPicker();
  const [picking, setPicking] = useState<Picking | null>(null);
  const [pickError, setPickError] = useState<'cancelled' | 'failed' | 'expired' | null>(null);
  const progress = useSheetsPickerProgress(picking?.requestId ?? null);
  /** The spreadsheet's tabs as Google last listed them. */
  const [info, setInfo] = useState<SpreadsheetInfo | null>(null);
  /** The tabs before the admin pressed Refresh (marks what changed); null = nothing to compare. */
  const [before, setBefore] = useState<SpreadsheetInfo | null>(null);
  const headingId = useId();
  const saved = query.data;
  const value = draft ?? saved;
  const set = (patch: Partial<SheetsAgentSettings>) => {
    if (value) setDraft({ ...value, ...patch });
  };
  const sheetInfo = info && value && info.id === value.spreadsheetId ? info : null;
  const toSave = value ? tabsToSave(value.tabs, sheetInfo) : [];
  const dirty =
    !!value &&
    !!saved &&
    (value.spreadsheetId !== saved.spreadsheetId ||
      JSON.stringify(toSave) !== JSON.stringify(normalizeTabs(saved.tabs)));

  // Opening Settings reads the saved spreadsheet's tabs once from Google (Refresh, so the AI also
  // sees new columns); when Refresh is busy (one a 10 s), the plain look-up stands in.
  const savedId = saved?.spreadsheetId ?? null;
  const { mutate: find } = lookup;
  const { mutate: reread, reset: resetReread } = refresh;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!savedId || !connected || opened.current === savedId) return;
    opened.current = savedId;
    reread(undefined, {
      onSuccess: setInfo,
      onError: () => {
        resetReread();
        find(savedId, { onSuccess: setInfo });
      },
    });
  }, [savedId, connected, find, reread, resetReread]);

  /** A sheet picked in Google's picker: its tabs, all off unless it is the same sheet again. */
  const apply = (found: SpreadsheetInfo) => {
    if (!value) return;
    setInfo(found);
    setBefore(null);
    set({
      spreadsheetId: found.id,
      spreadsheetName: found.name,
      tabs: found.id === value.spreadsheetId ? value.tabs : [],
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

  /** Refresh: reads the tabs again and marks what changed since the last read. */
  const reload = () => {
    const id = value?.spreadsheetId;
    if (!id) return;
    const onSuccess = (found: SpreadsheetInfo) => {
      setBefore(sheetInfo);
      setInfo(found);
    };
    // A sheet picked but not saved yet: the server's Refresh reads only the saved one.
    if (id === savedId) refresh.mutate(undefined, { onSuccess });
    else lookup.mutate(id, { onSuccess });
  };

  const submit = () => {
    if (!value) return;
    const parsed = SheetsAgentSettings.safeParse({ ...value, tabs: toSave });
    if (!parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(undefined);
        toast.success(t('connectors.sheets.saved'));
      },
    });
  };

  const access = (title: string): SheetTabAccess =>
    value?.tabs.find((x) => x.title === title)?.access ?? 'off';
  const setAccess = (title: string, next: SheetTabAccess) => {
    if (!value) return;
    const rest = value.tabs.filter((x) => x.title !== title);
    set({ tabs: next === 'off' ? rest : [...rest, { title, access: next }] });
  };
  const marks = sheetInfo && before ? diffTabs(before, sheetInfo) : new Map<string, TabMarks>();
  const marked = [...marks.values()];
  const newTabs = marked.filter((m) => m.newTab).length;
  const changedTabs = marked.filter((m) => m.changed).length;
  /** Saved tabs Google no longer lists: shown flagged; Save drops their access. */
  const gone = sheetInfo
    ? (value?.tabs ?? []).filter(
        (x) => x.access !== 'off' && !sheetInfo.tabs.some((tab) => tab.title === x.title),
      )
    : [];
  const checked = sheetInfo?.checkedAt
    ? t('connectors.sheets.checked', { when: formatRelative(sheetInfo.checkedAt) })
    : null;
  const changes = !before
    ? null
    : newTabs + changedTabs === 0
      ? t('connectors.sheets.noChanges')
      : [
          newTabs > 0 && t('connectors.sheets.newTabs', { count: newTabs }),
          changedTabs > 0 && t('connectors.sheets.changedTabs', { count: changedTabs }),
        ]
          .filter(Boolean)
          .join(', ');
  const reading = refresh.isPending || lookup.isPending;

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
                </div>
              )}
              {picking && (
                <PickerWaiting
                  testId="sheets-picking"
                  title={t('connectors.sheets.picking')}
                  hint={t(
                    picking.blocked
                      ? 'connectors.sheets.pickBlocked'
                      : 'connectors.sheets.pickingHint',
                  )}
                  url={picking.url}
                  blocked={picking.blocked}
                  openLabel={t('connectors.sheets.openPicker')}
                  sameComputer={t('connectors.sheets.pickSameComputer')}
                  onCancel={() => setPicking(null)}
                />
              )}
              {pickError && (
                <Banner tone="danger">{t(`connectors.sheets.pickError.${pickError}`)}</Banner>
              )}
              {picker.error && <Banner tone="danger">{errorMessage(picker.error)}</Banner>}
              {lookup.error && <Banner tone="danger">{errorMessage(lookup.error)}</Banner>}
            </div>

            {value.spreadsheetId && (
              <section aria-labelledby={headingId} className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id={headingId} className="text-base font-semibold">
                    {t('connectors.sheets.tabsTitle')}
                  </h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {(checked || changes) && (
                      <span
                        className="text-sm text-muted-foreground"
                        role="status"
                        data-testid="sheets-checked"
                      >
                        {[checked, changes].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-9 pointer-coarse:min-h-11"
                      disabled={reading}
                      onClick={reload}
                      data-testid="sheets-refresh"
                    >
                      {reading ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <RefreshCw aria-hidden />
                      )}
                      {t('connectors.sheets.refresh')}
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{t('connectors.sheets.tabsHint')}</p>
                {refresh.error && <Banner tone="danger">{errorMessage(refresh.error)}</Banner>}
                {!sheetInfo ? (
                  reading ? (
                    <ListSkeleton rows={2} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('connectors.sheets.tabsUnknown')}
                    </p>
                  )
                ) : (
                  <ul className="flex flex-col gap-2" data-testid="sheets-tabs">
                    {sheetInfo.tabs.map((tab) => (
                      <TabRow
                        key={tab.title}
                        title={tab.title}
                        columns={tab.columns}
                        access={access(tab.title)}
                        marks={marks.get(tab.title)}
                        onChange={(next) => setAccess(tab.title, next)}
                      />
                    ))}
                    {gone.map((tab) => (
                      <li
                        key={tab.title}
                        className="flex flex-col gap-1 rounded-lg border border-warning/40 px-3 py-3"
                        data-testid="sheets-tab-gone"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium break-words">{tab.title}</span>
                          <Badge variant="outline" className="border-warning/40 text-warning">
                            {t('connectors.sheets.goneBadge')}
                          </Badge>
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t('connectors.sheets.goneHint')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <Banner tone="info">
                  {t('connectors.sheets.autoColumns', { columns: SHEETS_AUTO_COLUMNS.join(', ') })}
                </Banner>
              </section>
            )}

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

/** One tab of the spreadsheet: its column names (EzyChat's own tinted) and Off / Read / Add rows. */
function TabRow({
  title,
  columns,
  access,
  marks,
  onChange,
}: Readonly<{
  title: string;
  columns: readonly string[];
  access: SheetTabAccess;
  marks: TabMarks | undefined;
  onChange: (access: SheetTabAccess) => void;
}>) {
  const { t } = useTranslation('admin');
  const labelId = useId();
  // Add rows and Read need column names: a tab with an empty first row stays Off.
  const empty = columns.length === 0;
  const options = (empty ? (['off'] as const) : ACCESS).map((value) => ({
    value,
    label: t(`connectors.sheets.access.${value}`),
  }));
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
      data-testid="sheets-tab"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span id={labelId} className="font-medium break-words">
            {title}
          </span>
          {marks?.newTab && (
            <Badge variant="outline" className="border-warning/40 text-warning">
              {t('connectors.sheets.newTab')}
            </Badge>
          )}
          {marks?.changed && (
            <Badge variant="outline" className="border-warning/40 text-warning">
              {t('connectors.sheets.columnsChanged')}
            </Badge>
          )}
        </span>
        {empty ? (
          <Banner tone="warning">{t('connectors.sheets.emptyFirstRow')}</Banner>
        ) : (
          <ul
            className="flex flex-wrap gap-1.5"
            aria-label={t('connectors.sheets.columnsOf', { tab: title })}
          >
            {columns.map((column, i) => {
              const added = marks?.added.has(column) ?? false;
              const auto = isAutoColumn(column);
              return (
                <li
                  key={`${i}-${column}`}
                  className={cn(
                    'rounded-sm border border-transparent px-2 py-0.5 text-xs [overflow-wrap:anywhere]',
                    auto ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                    added && 'border-dashed border-warning/60 bg-warning/10 text-foreground',
                  )}
                  data-auto={auto || undefined}
                  data-added={added || undefined}
                >
                  {column}
                  {added && <span className="sr-only"> ({t('connectors.sheets.newColumn')})</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <SegmentedControl
        aria-labelledby={labelId}
        value={empty ? 'off' : access}
        onValueChange={onChange}
        options={options}
        className="shrink-0 self-start"
      />
    </li>
  );
}

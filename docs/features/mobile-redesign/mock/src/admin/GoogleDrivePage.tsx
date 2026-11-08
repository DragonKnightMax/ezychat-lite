import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ExternalLink,
  FileText,
  FolderOpen,
  HardDrive,
  Save,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { Banner, EmptyState, ResponsiveDialog, StatusDot } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';
import { CONNECTORS } from '@/mock/connectorCatalog';
import {
  DRIVE_ACCOUNT,
  MAX_READ_FILES,
  MAX_SAVE_MB,
  PICKER_FILES,
  PICKER_FOLDERS,
  driveActions,
  driveStatus,
  driveFolderUrl,
  driveSettingsFor,
  savedFileName,
  useGoogleDrive,
  type DriveAgentSettings,
  type DriveFile,
} from '@/mock/googleDrive';
import { AgentSettings, ConnectorBreadcrumb } from './ConnectorDetailPage';
import { ConnectorIcon, ConnectorStatusBadge } from './ConnectorsGalleryPage';
import { ConfirmDialog } from './adminUi';

const TABS = ['overview', 'settings', 'activity'] as const;
type Tab = (typeof TABS)[number];

/**
 * Proposed (google-drive): `/admin/connectors/google-drive`, built like the Google Sheets page:
 * Overview (what it does, Google account, your data), Settings (per AI agent: folder, Save files,
 * Read files) and Activity (who and when, never file contents).
 */
export function GoogleDrivePage() {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();
  const drive = useGoogleDrive();
  const c = CONNECTORS.find((x) => x.id === 'google-drive')!;
  const tabParam = params.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'overview';
  const setTab = (next: string) =>
    setParams(
      (p) => {
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  return (
    <div className="flex flex-col gap-4" data-testid="connector-page-google-drive">
      <ConnectorBreadcrumb name={t('mockDrive.name')} />
      <div className="flex items-start gap-4">
        <ConnectorIcon c={c} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words">
              {t('mockDrive.name')}
            </h1>
            <ConnectorStatusBadge status={driveStatus(drive.state)} />
            <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('mockConnectors.byCore')} · {t('mockConnectors.category.data')}
          </p>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
          <TabsList variant="line" className="w-max justify-start">
            {TABS.map((id) => (
              <TabsTrigger key={id} value={id} className="min-h-11 flex-none px-3 md:min-h-9">
                {t(`mockConnectors.tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="flex flex-col gap-4">
          <About />
          <AccountCard onOpenSettings={() => setTab('settings')} />
          <Card className="gap-3">
            <CardHeader>
              <CardTitle>{t('mockConnectors.privacyTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>{t('mockDrive.privacy1')}</p>
              <p>{t('mockDrive.privacy2')}</p>
              <p>{t('mockDrive.privacy3')}</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="settings" className="flex flex-col gap-4">
          {drive.state === 'disconnected' ? (
            <EmptyState
              title={t('mockDrive.settings.notConnected')}
              description={t('mockDrive.settings.notConnectedHint')}
              action={
                <Button size="touch" onClick={() => setTab('overview')}>
                  {t('mockDrive.connect')}
                </Button>
              }
            />
          ) : (
            <AgentSettings
              render={(agent) => (
                <DriveSettingsCard key={agent.id} agentId={agent.id} name={agent.name} />
              )}
            />
          )}
        </TabsContent>
        <TabsContent value="activity" className="flex flex-col gap-4">
          <Activity />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function About() {
  const { t } = useTranslation('admin');
  const tools = [
    { key: 'save', access: 'write' },
    { key: 'find', access: 'read' },
    { key: 'read', access: 'read' },
  ] as const;
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('mockConnectors.aboutTitle')}</CardTitle>
        <CardDescription>{t('mockDrive.long')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t('mockConnectors.aiCan')}</p>
        <ul className="flex flex-col divide-y rounded-lg border">
          {tools.map((tool) => (
            <li key={tool.key} className="flex flex-col gap-1 px-3 py-3">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`mockDrive.tools.${tool.key}`)}</span>
                <Badge variant="secondary">
                  {t(tool.access === 'read' ? 'mockConnectors.lookUp' : 'mockConnectors.changes')}
                </Badge>
              </span>
              <span className="text-sm text-muted-foreground">
                {t(`mockDrive.tools.${tool.key}Hint`)}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{t('mockConnectors.switchNote')}</p>
      </CardContent>
    </Card>
  );
}

/** The Google account card: connect (stand-in consent), state, expired / unreachable, disconnect. */
function AccountCard({ onOpenSettings }: Readonly<{ onOpenSettings: () => void }>) {
  const { t } = useTranslation('admin');
  const drive = useGoogleDrive();
  const mockId = useId();
  const [consent, setConsent] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const state = drive.state;
  const tone = state === 'connected' ? 'success' : state === 'disconnected' ? 'muted' : 'warning';
  const connect = () => {
    driveActions.connect();
    setConsent(false);
    toast.success(t('mockDrive.connected', { account: DRIVE_ACCOUNT }));
  };
  return (
    <Card data-testid="google-drive-account">
      <CardHeader>
        <CardTitle>{t('mockDrive.accountTitle')}</CardTitle>
        <CardDescription>{t('mockDrive.accountDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state === 'disconnected' ? (
          <>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {(['what1', 'what2', 'what3'] as const).map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {t(`mockDrive.${key}`)}
                </li>
              ))}
            </ul>
            <Button size="touch" className="self-start" onClick={() => setConsent(true)}>
              <HardDrive aria-hidden />
              {t('mockDrive.connect')}
            </Button>
            <p className="text-sm text-muted-foreground">{t('mockDrive.connectHint')}</p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-muted-foreground">{t('mockCalendar.account')}</span>
                <span className="font-medium break-all">{drive.account}</span>
              </div>
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={tone} />
                {t(`mockCalendar.state.${state}`)}
              </span>
            </div>
            {state === 'expired' && (
              <Banner tone="warning" title={t('mockDrive.expiredTitle')}>
                <span className="flex flex-col items-start gap-2">
                  {t('mockDrive.expiredBody')}
                  <Button size="touch" variant="outline" onClick={() => setConsent(true)}>
                    {t('mockCalendar.signInAgain')}
                  </Button>
                </span>
              </Banner>
            )}
            {state === 'unavailable' && (
              <Banner tone="warning" title={t('mockDrive.unavailableTitle')}>
                {t('mockDrive.unavailableBody')}
              </Banner>
            )}
            <p className="text-sm text-muted-foreground">
              {t('mockDrive.perAgent')}{' '}
              <Button variant="link" className="h-auto p-0 align-baseline" onClick={onOpenSettings}>
                {t('mockConnectors.gc.openSettings')}
              </Button>
            </p>
            <Button
              size="touch"
              variant="outline"
              className="self-start"
              onClick={() => setConfirmDisconnect(true)}
            >
              {t('mockCalendar.disconnect')}
            </Button>
            <div
              className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
              data-testid="mock-drive-controls"
            >
              <Badge variant="outline" className="self-start">
                {t('mockSuggest.mockControls')}
              </Badge>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span id={mockId} className="text-sm font-medium">
                  {t('mockDrive.mockGoogle')}
                </span>
                <span role="group" aria-labelledby={mockId} className="flex flex-wrap gap-2">
                  {(
                    [
                      ['connected', 'mockCalendar.mockOk'],
                      ['expired', 'mockCalendar.mockExpired'],
                      ['unavailable', 'mockCalendar.mockDown'],
                    ] as const
                  ).map(([value, key]) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={state === value ? 'default' : 'outline'}
                      aria-pressed={state === value}
                      className="min-h-9 pointer-coarse:min-h-11"
                      onClick={() => driveActions.setState(value)}
                    >
                      {t(key)}
                    </Button>
                  ))}
                </span>
              </div>
            </div>
          </>
        )}
      </CardContent>
      <ResponsiveDialog
        open={consent}
        onOpenChange={setConsent}
        title={t('mockDrive.consentTitle')}
        description={t('mockCalendar.consentMock')}
        footer={
          <>
            <Button size="touch" variant="outline" onClick={() => setConsent(false)}>
              {t('mockCalendar.consentCancel')}
            </Button>
            <Button size="touch" onClick={connect}>
              {t('mockCalendar.consentAllow')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pb-2 text-sm" data-testid="google-drive-consent">
          <p>
            {t('mockCalendar.consentAccount')}{' '}
            <span className="font-medium break-all">{DRIVE_ACCOUNT}</span>
          </p>
          <p className="font-medium">{t('mockCalendar.consentWants')}</p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t('mockDrive.scope')}
          </p>
        </div>
      </ResponsiveDialog>
      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title={t('mockDrive.disconnectTitle')}
        confirmLabel={t('mockCalendar.disconnect')}
        danger
        onConfirm={() => {
          driveActions.disconnect();
          setConfirmDisconnect(false);
        }}
      >
        <p className="text-sm text-muted-foreground">{t('mockDrive.disconnectBody')}</p>
      </ConfirmDialog>
    </Card>
  );
}

const FILE_ICON: Record<DriveFile['kind'], typeof FileText> = {
  doc: FileText,
  sheet: FileText,
  pdf: FileText,
  text: FileText,
  word: FileText,
};

/** Settings tab, one AI agent: the folder, Save files and Read files, with a Save bar. */
function DriveSettingsCard({ agentId, name }: Readonly<{ agentId: string; name: string }>) {
  const { t } = useTranslation('admin');
  const drive = useGoogleDrive();
  const saved = driveSettingsFor(drive, agentId);
  const [draft, setDraft] = useState<DriveAgentSettings>(saved);
  const [picker, setPicker] = useState<null | 'folder' | 'files'>(null);
  const [pickerState, setPickerState] = useState<'open' | 'blocked'>('open');
  const [picked, setPicked] = useState<string[]>([]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const paused = drive.state === 'expired' || drive.state === 'unavailable';
  const update = (next: Partial<DriveAgentSettings>) => setDraft((d) => ({ ...d, ...next }));
  const openPicker = (kind: 'folder' | 'files') => {
    setPicked([]);
    setPickerState('open');
    setPicker(kind);
  };
  const choosable = PICKER_FILES.filter((f) => !draft.files.some((x) => x.id === f.id));
  const fileHint = (f: DriveFile) =>
    f.characters === null
      ? t('mockDrive.read.noText')
      : t(`mockDrive.kind.${f.kind}`) +
        ' · ' +
        t('mockDrive.read.characters', { count: f.characters });
  return (
    <div className="flex flex-col gap-4" data-testid="drive-settings">
      {paused && (
        <Banner tone="warning" title={t('mockDrive.pausedTitle')}>
          {t(drive.state === 'expired' ? 'mockDrive.pausedExpired' : 'mockDrive.pausedDown', {
            name,
          })}
        </Banner>
      )}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{t('mockDrive.folder.title')}</CardTitle>
          <CardDescription>{t('mockDrive.folder.description', { name })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {draft.folder ? (
            <div className="flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 items-center gap-3">
                <FolderOpen className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-medium break-words">{draft.folder.name}</span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="min-h-9 pointer-coarse:min-h-11"
                >
                  <a href={driveFolderUrl(draft.folder)} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden />
                    {t('mockDrive.folder.open')}
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 pointer-coarse:min-h-11"
                  onClick={() => openPicker('folder')}
                >
                  {t('mockDrive.folder.change')}
                </Button>
              </span>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('mockDrive.folder.none')}</p>
              <Button size="touch" className="self-start" onClick={() => openPicker('folder')}>
                <FolderOpen aria-hidden />
                {t('mockDrive.folder.choose')}
              </Button>
            </>
          )}
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('mockDrive.folder.onlyChosen')}
            <InfoTip topic="driveFiles" />
          </p>
        </CardContent>
      </Card>

      <Card className="gap-4" data-testid="drive-save">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>
                <Label htmlFor={`save-${agentId}`}>{t('mockDrive.save.title')}</Label>
              </CardTitle>
              <CardDescription>{t('mockDrive.save.description', { name })}</CardDescription>
            </div>
            <Switch
              id={`save-${agentId}`}
              checked={draft.save}
              disabled={!draft.folder}
              onCheckedChange={(save) => update({ save })}
            />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!draft.folder && (
            <p className="text-sm text-muted-foreground">{t('mockDrive.needFolder')}</p>
          )}
          {draft.folder && draft.save && (
            <>
              <ul className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
                {(['rule1', 'rule2', 'rule3', 'rule4'] as const).map((key) => (
                  <li key={key} className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {t(`mockDrive.save.${key}`, { mb: MAX_SAVE_MB })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="gap-4" data-testid="drive-read">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>
                <Label htmlFor={`read-${agentId}`}>{t('mockDrive.read.title')}</Label>
              </CardTitle>
              <CardDescription>{t('mockDrive.read.description', { name })}</CardDescription>
            </div>
            <Switch
              id={`read-${agentId}`}
              checked={draft.read}
              disabled={!draft.folder}
              onCheckedChange={(read) => update({ read })}
            />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!draft.folder && (
            <p className="text-sm text-muted-foreground">{t('mockDrive.needFolder')}</p>
          )}
          {draft.folder && draft.read && (
            <>
              {draft.files.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('mockDrive.read.none', { name })}</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-lg border" data-testid="drive-files">
                  {draft.files.map((f) => {
                    const Icon = FILE_ICON[f.kind];
                    return (
                      <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                        {f.characters === null ? (
                          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
                        ) : (
                          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm font-medium break-words">{f.name}</span>
                          <span className="text-xs text-muted-foreground">{fileHint(f)}</span>
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11 shrink-0 md:size-9"
                          aria-label={t('mockDrive.read.remove', { file: f.name })}
                          onClick={() =>
                            update({ files: draft.files.filter((x) => x.id !== f.id) })
                          }
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Button
                variant="outline"
                size="touch"
                className="self-start"
                disabled={draft.files.length >= MAX_READ_FILES}
                onClick={() => openPicker('files')}
              >
                <FileText aria-hidden />
                {t('mockDrive.read.add')}
              </Button>
              <p className="text-sm text-muted-foreground">
                {t('mockDrive.read.hint', { max: MAX_READ_FILES })}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground" data-testid="drive-instructions-note">
        {t('mockDrive.when.note', { name })}{' '}
        <Link
          to={`/admin/members/ai/${agentId}`}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('mockDrive.when.open', { name })}
        </Link>
      </p>

      {draft.folder && <MockSimulator agentName={name} settings={saved} />}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
        {dirty && (
          <span className="mr-auto text-sm text-muted-foreground">{t('mockDrive.unsaved')}</span>
        )}
        <Button size="touch" variant="outline" disabled={!dirty} onClick={() => setDraft(saved)}>
          {t('mockDrive.discard')}
        </Button>
        <Button
          size="touch"
          disabled={!dirty}
          onClick={() => {
            driveActions.saveAgent(agentId, draft);
            toast.success(t('mockDrive.saved'));
          }}
        >
          <Save aria-hidden />
          {t('mockDrive.saveButton')}
        </Button>
      </div>

      <ResponsiveDialog
        open={picker !== null}
        onOpenChange={(open) => !open && setPicker(null)}
        title={t(
          picker === 'files' ? 'mockDrive.picker.filesTitle' : 'mockDrive.picker.folderTitle',
        )}
        description={t('mockDrive.picker.mock')}
        footer={
          pickerState === 'blocked' ? (
            <Button size="touch" variant="outline" onClick={() => setPicker(null)}>
              {t('mockCalendar.consentCancel')}
            </Button>
          ) : (
            <>
              <Button size="touch" variant="outline" onClick={() => setPicker(null)}>
                {t('mockCalendar.consentCancel')}
              </Button>
              <Button
                size="touch"
                disabled={picked.length === 0}
                onClick={() => {
                  if (picker === 'folder') {
                    const folder = PICKER_FOLDERS.find((f) => f.id === picked[0])!;
                    const changed = draft.folder && draft.folder.id !== folder.id;
                    update({ folder, ...(changed ? { files: [] } : {}) });
                  } else {
                    update({
                      files: [
                        ...draft.files,
                        ...PICKER_FILES.filter((f) => picked.includes(f.id)),
                      ].slice(0, MAX_READ_FILES),
                    });
                  }
                  setPicker(null);
                }}
              >
                {t('mockDrive.picker.select')}
              </Button>
            </>
          )
        }
      >
        <div className="flex flex-col gap-3 pb-2" data-testid="drive-picker">
          {pickerState === 'blocked' ? (
            <Banner tone="warning" title={t('mockDrive.picker.blockedTitle')}>
              {t('mockDrive.picker.blockedBody')}
            </Banner>
          ) : picker === 'folder' ? (
            <ul className="flex flex-col divide-y rounded-lg border">
              {PICKER_FOLDERS.map((f) => (
                <li key={f.id}>
                  <Label className="flex min-h-11 items-center gap-3 px-3 py-2 font-normal">
                    <input
                      type="radio"
                      name="drive-folder"
                      className="size-4 accent-primary"
                      checked={picked[0] === f.id}
                      onChange={() => setPicked([f.id])}
                    />
                    <FolderOpen className="size-4 text-muted-foreground" aria-hidden />
                    <span className="break-words">{f.name}</span>
                  </Label>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t('mockDrive.picker.inFolder', { folder: draft.folder?.name ?? '' })}
              </p>
              {choosable.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('mockDrive.picker.allAdded')}</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-lg border">
                  {choosable.map((f) => (
                    <li key={f.id}>
                      <Label className="flex min-h-11 items-center gap-3 px-3 py-2 font-normal">
                        <Checkbox
                          checked={picked.includes(f.id)}
                          onCheckedChange={(on) =>
                            setPicked((p) =>
                              on === true ? [...p, f.id] : p.filter((x) => x !== f.id),
                            )
                          }
                        />
                        <span className="break-words">{f.name}</span>
                      </Label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2">
            <Badge variant="outline">{t('mockSuggest.mockControls')}</Badge>
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => setPickerState((s) => (s === 'open' ? 'blocked' : 'open'))}
            >
              {t(
                pickerState === 'open' ? 'mockDrive.picker.mockBlock' : 'mockDrive.picker.mockOpen',
              )}
            </Button>
          </div>
        </div>
      </ResponsiveDialog>
    </div>
  );
}

/**
 * Mock only: what the agent does in a chat with the saved settings (no AI is called). A customer
 * sends a photo / a PDF / a file WhatsApp Safety locked / a 40 MB video, or asks a question.
 */
function MockSimulator({
  agentName,
  settings,
}: Readonly<{ agentName: string; settings: DriveAgentSettings }>) {
  const { t: typed } = useTranslation('admin');
  // Mock: keys built from the scenario (the app types each key).
  const t = typed as unknown as (key: string, options?: Record<string, unknown>) => string;
  const drive = useGoogleDrive();
  const [lines, setLines] = useState<Array<{ who: 'customer' | 'ai' | 'event'; text: string }>>([]);
  const paused = drive.state !== 'connected';
  const run = (kind: 'photo' | 'pdf' | 'locked' | 'big' | 'question') => {
    const customer = 'Jay Low';
    const next: typeof lines = [];
    const say = (who: 'customer' | 'ai' | 'event', key: string, extra?: Record<string, unknown>) =>
      next.push({ who, text: t(`mockDrive.sim.${key}`, { name: agentName, ...extra }) });
    say('customer', `${kind}Customer`);
    if (paused) {
      say('ai', 'handover');
      say('event', 'handoverLine');
      driveActions.addActivity({ at: Date.now(), kind: 'failed', agent: agentName, customer });
    } else if (kind === 'question') {
      const readable = settings.read ? settings.files.filter((f) => f.characters !== null) : [];
      if (readable.length) {
        say('event', 'readLine', { count: 1 });
        say('ai', 'answer', { file: readable[0]!.name });
        driveActions.addActivity({
          at: Date.now(),
          kind: 'read',
          agent: agentName,
          customer,
          count: 1,
        });
      } else say('ai', 'noFiles');
    } else if (!settings.save) say('ai', 'saveOff');
    else if (kind === 'locked') {
      say('ai', 'lockedReply');
      driveActions.addActivity({
        at: Date.now(),
        kind: 'skipped',
        agent: agentName,
        customer,
        reason: 'safety',
      });
    } else if (kind === 'big') {
      say('ai', 'bigReply', { mb: MAX_SAVE_MB });
      driveActions.addActivity({
        at: Date.now(),
        kind: 'skipped',
        agent: agentName,
        customer,
        reason: 'size',
      });
    } else {
      {
        const file = savedFileName(kind, new Date(), kind === 'photo' ? 'jpg' : 'pdf');
        say('event', 'savedLine', {
          file,
          folder: settings.folder?.name ?? '',
          customer,
        });
        say('ai', 'saved');
        driveActions.addActivity({ at: Date.now(), kind: 'saved', agent: agentName, customer });
      }
    }
    setLines(next);
  };
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
      data-testid="drive-simulator"
    >
      <Badge variant="outline" className="self-start">
        {t('mockSuggest.mockControls')}
      </Badge>
      <p className="text-sm text-muted-foreground">
        {t('mockDrive.sim.intro', { name: agentName })}
      </p>
      <div className="flex flex-wrap gap-2">
        {(['photo', 'pdf', 'question', 'locked', 'big'] as const).map((kind) => (
          <Button
            key={kind}
            variant="outline"
            size="sm"
            className="min-h-9 pointer-coarse:min-h-11"
            onClick={() => run(kind)}
          >
            {t(`mockDrive.sim.${kind}`)}
          </Button>
        ))}
      </div>
      {lines.length > 0 && (
        <ol className="flex flex-col gap-2" aria-live="polite">
          {lines.map((line, i) =>
            line.who === 'event' ? (
              <li key={i} className="text-center text-xs break-words text-muted-foreground">
                {line.text}
              </li>
            ) : (
              <li
                key={i}
                className={
                  line.who === 'customer'
                    ? 'max-w-[85%] self-start rounded-lg bg-muted px-3 py-2 text-sm break-words'
                    : 'max-w-[85%] self-end rounded-lg bg-primary/10 px-3 py-2 text-sm break-words'
                }
              >
                {line.text}
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

/** Activity tab: who and when only; never file names, contents or chat text. */
function Activity() {
  const { t } = useTranslation('admin');
  const drive = useGoogleDrive();
  const rows = drive.activity;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('mockConnectors.activityEmpty')}
        description={t('mockDrive.activityEmptyHint')}
      />
    );
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockConnectors.activityTitle')}</CardTitle>
        <CardDescription>{t('mockDrive.activityHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {rows.map((r) => {
            const Icon =
              r.kind === 'saved'
                ? Save
                : r.kind === 'read'
                  ? FileText
                  : r.kind === 'skipped'
                    ? ShieldCheck
                    : UserRound;
            return (
              <li key={`${r.at}-${r.kind}`} className="flex items-start gap-3 py-3 first:pt-0">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">
                    {t(
                      r.kind === 'skipped'
                        ? `mockDrive.act.skipped.${r.reason ?? 'safety'}`
                        : `mockDrive.act.${r.kind}`,
                      { agent: r.agent, customer: r.customer, count: r.count ?? 1 },
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatRelative(r.at)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

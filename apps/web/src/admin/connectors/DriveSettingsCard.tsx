import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ExternalLink,
  FileText,
  FolderOpen,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DRIVE_MAX_FILES,
  DRIVE_SAVE_MAX_BYTES,
  DriveAgentSettings,
  googleDriveFolderUrl,
  type DriveFile,
  type DrivePickerBody,
  type GoogleDriveStatus,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import {
  useDrivePicker,
  useDrivePickerProgress,
  useDriveSettings,
  useSaveDriveSettings,
} from '../../api/connectors';
import { Banner } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ErrorState, ListSkeleton, Pending, SaveBar } from '../adminUi';
import { PickerWaiting } from './connector-ui';

interface Picking {
  kind: DrivePickerBody['kind'];
  requestId: string;
  url: string;
  /** The browser blocked the new window: the admin opens the link themselves. */
  blocked: boolean;
}
/** What the waiting card says while Google's picker is open. */
const pickingHint = (picking: Picking) => {
  if (picking.blocked) return 'connectors.drive.pickBlocked';
  return picking.kind === 'folder'
    ? 'connectors.drive.pickingFolder'
    : 'connectors.drive.pickingFiles';
};
const SAVE_RULES = ['rule1', 'rule2', 'rule3', 'rule4'] as const;
const SAVE_MAX_MB = Math.round(DRIVE_SAVE_MAX_BYTES / (1024 * 1024));

/** What decides whether the settings changed (names come from Google and may differ). */
const fingerprint = (s: DriveAgentSettings) =>
  JSON.stringify({
    folder: s.folder?.id ?? null,
    save: s.save,
    read: s.read,
    files: s.files.map((f) => f.id),
  });

/** What the picker gave: a folder (another one clears the picked files) or files to add. */
function applyPicked(
  value: DriveAgentSettings,
  kind: Picking['kind'],
  folder: DriveAgentSettings['folder'],
  files: DriveFile[],
): DriveAgentSettings {
  if (kind === 'folder' && folder) {
    const changed = value.folder?.id !== folder.id;
    return { ...value, folder, ...(changed ? { files: [] } : {}) };
  }
  const known = new Set(value.files.map((f) => f.id));
  const added = files.filter((f) => !known.has(f.id));
  return { ...value, files: [...value.files, ...added].slice(0, DRIVE_MAX_FILES) };
}

/** A finished picker: `ok` with something picked, else why nothing was. */
function pickOutcome(
  kind: Picking['kind'],
  status: 'done' | 'cancelled' | 'failed' | 'expired',
  folder: DriveAgentSettings['folder'],
  files: DriveFile[],
): 'ok' | 'cancelled' | 'failed' | 'expired' {
  if (status !== 'done') return status;
  const got = kind === 'folder' ? !!folder : files.length > 0;
  return got ? 'ok' : 'cancelled';
}

/**
 * Connectors → Google Drive → Settings, for one AI agent (design
 * docs/features/google-drive/design.md): the folder (picked in Google's file picker), Save files,
 * Read files with the files the admin picked. The connector only grants access: what to save or
 * read, and when, is in the agent's instructions (docs/connector-design.md), linked at the end.
 */
export function DriveSettingsCard({
  agentId,
  name,
  status,
  onConnect,
}: Readonly<{
  agentId: number;
  name: string;
  status: GoogleDriveStatus;
  /** Shows the account card (Overview tab). */
  onConnect: () => void;
}>) {
  const { t } = useTranslation('admin');
  const query = useDriveSettings(agentId);
  const save = useSaveDriveSettings(agentId);
  const picker = useDrivePicker();
  const [draft, setDraft] = useState<DriveAgentSettings>();
  const [picking, setPicking] = useState<Picking | null>(null);
  const [pickError, setPickError] = useState<'cancelled' | 'failed' | 'expired' | null>(null);
  const progress = useDrivePickerProgress(picking?.requestId ?? null);
  const saved = query.data;
  const value = draft ?? saved;
  const set = (patch: Partial<DriveAgentSettings>) => {
    if (value) setDraft({ ...value, ...patch });
  };
  const dirty = !!value && !!saved && fingerprint(value) !== fingerprint(saved);

  const apply = (
    kind: Picking['kind'],
    folder: DriveAgentSettings['folder'],
    files: DriveFile[],
  ) => {
    if (value) setDraft(applyPicked(value, kind, folder, files));
  };

  const pickStatus = progress.data?.status;
  const pickedFolder = progress.data?.folder ?? null;
  const pickedFiles = progress.data?.files;
  useEffect(() => {
    if (!picking || !pickStatus || pickStatus === 'pending') return;
    setPicking(null);
    const outcome = pickOutcome(picking.kind, pickStatus, pickedFolder, pickedFiles ?? []);
    if (outcome === 'ok') apply(picking.kind, pickedFolder, pickedFiles ?? []);
    else setPickError(outcome);
    // apply reads the current draft; the poll result is what changes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, pickStatus, pickedFolder, pickedFiles]);

  /** Opens Google's file picker in a new window (inside the click, so the browser allows it). */
  const choose = async (kind: Picking['kind']) => {
    setPickError(null);
    const tab = window.open('about:blank', '_blank');
    try {
      const body: DrivePickerBody =
        kind === 'files' && value?.folder ? { kind, folderId: value.folder.id } : { kind };
      const next = await picker.mutateAsync(body);
      if (tab) {
        tab.opener = null;
        tab.location.href = next.pickerUrl;
      }
      setPicking({ kind, requestId: next.requestId, url: next.pickerUrl, blocked: !tab });
    } catch {
      tab?.close();
    }
  };

  const submit = () => {
    if (!value) return;
    const parsed = DriveAgentSettings.safeParse(value);
    if (!parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(undefined);
        toast.success(t('connectors.drive.saved'));
      },
    });
  };

  if (query.isPending) return <ListSkeleton rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!value) return null;
  const folder = value.folder;
  const busy = picker.isPending || picking !== null;
  const full = value.files.length >= DRIVE_MAX_FILES;

  return (
    <div className="flex flex-col gap-4" data-testid="drive-settings">
      {(status.state === 'expired' || status.state === 'unavailable') && (
        <Banner tone="warning" title={t(`connectors.drive.paused.${status.state}`)}>
          {t('connectors.drive.pausedBody', { name })}{' '}
          <Button variant="link" className="h-auto p-0 align-baseline" onClick={onConnect}>
            {t('connectors.booking.openAccount')}
          </Button>
        </Banner>
      )}

      <Card className="gap-4" data-testid="drive-folder">
        <CardHeader>
          <CardTitle>{t('connectors.drive.folder.title')}</CardTitle>
          <CardDescription>{t('connectors.drive.folder.description', { name })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {folder ? (
            <div
              className="flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="drive-folder-chosen"
            >
              <span className="flex min-w-0 items-center gap-3">
                <FolderOpen className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-medium break-words">{folder.name}</span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="min-h-9 pointer-coarse:min-h-11"
                >
                  <a
                    href={googleDriveFolderUrl(folder.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('connectors.drive.folder.open')}
                    <ExternalLink aria-hidden />
                  </a>
                </Button>
                {!picking && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-9 pointer-coarse:min-h-11"
                    disabled={busy}
                    onClick={() => void choose('folder')}
                    data-testid="drive-choose-folder"
                  >
                    <Pending show={picker.isPending} />
                    {t('connectors.drive.folder.change')}
                  </Button>
                )}
              </span>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('connectors.drive.folder.none')}</p>
              {!picking && (
                <Button
                  size="touch"
                  className="self-start"
                  disabled={busy}
                  onClick={() => void choose('folder')}
                  data-testid="drive-choose-folder"
                >
                  {picker.isPending ? <Pending show /> : <FolderOpen aria-hidden />}
                  {t('connectors.drive.folder.choose')}
                </Button>
              )}
            </>
          )}
          {folder && value.files.length > 0 && !picking && (
            <p className="text-sm text-muted-foreground">
              {t('connectors.drive.folder.changeHint')}
            </p>
          )}
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('connectors.drive.folder.onlyChosen')}
            <InfoTip topic="driveFiles" />
          </p>
          {picking && (
            <PickerWaiting
              testId="drive-picking"
              title={t('connectors.drive.picking')}
              hint={t(pickingHint(picking))}
              url={picking.url}
              blocked={picking.blocked}
              openLabel={t('connectors.drive.openPicker')}
              sameComputer={t('connectors.drive.pickSameComputer')}
              onCancel={() => setPicking(null)}
            />
          )}
          {pickError && (
            <Banner tone="danger">{t(`connectors.drive.pickError.${pickError}`)}</Banner>
          )}
          {picker.error && <Banner tone="danger">{errorMessage(picker.error)}</Banner>}
        </CardContent>
      </Card>

      <DriveSwitchCard
        testId="drive-save"
        id={`drive-save-${agentId}`}
        title={t('connectors.drive.save.title')}
        description={t('connectors.drive.save.description', { name })}
        checked={!!folder && value.save}
        disabled={!folder}
        onChange={(on) => set({ save: on })}
      >
        {(!folder || value.save) && (
          <CardContent className="flex flex-col gap-4">
            {!folder ? (
              <p className="text-sm text-muted-foreground">{t('connectors.drive.needFolder')}</p>
            ) : (
              <ul
                className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground"
                data-testid="drive-save-rules"
              >
                {SAVE_RULES.map((key) => (
                  <li key={key} className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {t(`connectors.drive.save.${key}`, { mb: SAVE_MAX_MB })}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        )}
      </DriveSwitchCard>

      <DriveSwitchCard
        testId="drive-read"
        id={`drive-read-${agentId}`}
        title={t('connectors.drive.read.title')}
        description={t('connectors.drive.read.description', { name })}
        checked={!!folder && value.read}
        disabled={!folder}
        onChange={(on) => set({ read: on })}
      >
        {(!folder || value.read) && (
          <CardContent className="flex flex-col gap-3">
            {!folder ? (
              <p className="text-sm text-muted-foreground">{t('connectors.drive.needFolder')}</p>
            ) : (
              <>
                {value.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('connectors.drive.read.none', { name })}
                  </p>
                ) : (
                  <DriveFileList
                    files={value.files}
                    onRemove={(id) => set({ files: value.files.filter((x) => x.id !== id) })}
                  />
                )}
                {!picking && (
                  <Button
                    variant="outline"
                    size="touch"
                    className="self-start"
                    disabled={busy || full}
                    onClick={() => void choose('files')}
                    data-testid="drive-add-files"
                  >
                    {picker.isPending ? <Pending show /> : <FileText aria-hidden />}
                    {t('connectors.drive.read.add')}
                  </Button>
                )}
                <p className="text-sm text-muted-foreground">
                  {t(full ? 'connectors.drive.read.full' : 'connectors.drive.read.hint', {
                    max: DRIVE_MAX_FILES,
                  })}
                </p>
              </>
            )}
          </CardContent>
        )}
      </DriveSwitchCard>

      <p className="text-sm text-muted-foreground" data-testid="drive-instructions-note">
        {t('connectors.drive.when.note', { name })}{' '}
        <Link
          to={`/admin/members/ai/${agentId}`}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('connectors.drive.when.open', { name })}
        </Link>
      </p>

      {save.error && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
      <SaveBar dirty={dirty}>
        <Button
          size="touch"
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => setDraft(undefined)}
        >
          {t('connectors.drive.discard')}
        </Button>
        <Button size="touch" disabled={!dirty || save.isPending} onClick={submit}>
          <Pending show={save.isPending} />
          {t('connectors.drive.saveButton')}
        </Button>
      </SaveBar>
    </div>
  );
}

/** A card whose title is a switch (Save files, Read files). */
function DriveSwitchCard({
  testId,
  id,
  title,
  description,
  checked,
  disabled,
  onChange,
  children,
}: Readonly<{
  testId: string;
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
}>) {
  return (
    <Card className="gap-4" data-testid={testId}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <Label htmlFor={id}>{title}</Label>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
        </div>
      </CardHeader>
      {children}
    </Card>
  );
}

/** The files the AI may read, each with its kind and a remove button. */
function DriveFileList({
  files,
  onRemove,
}: Readonly<{ files: DriveFile[]; onRemove: (id: string) => void }>) {
  const { t } = useTranslation('admin');
  return (
    <ul className="flex flex-col divide-y rounded-lg border" data-testid="drive-files">
      {files.map((f) => {
        const readable = f.kind !== 'other';
        const Icon = readable ? FileText : TriangleAlert;
        return (
          <li key={f.id} className="flex items-center gap-3 px-3 py-2">
            <Icon
              className={
                readable ? 'size-4 shrink-0 text-muted-foreground' : 'size-4 shrink-0 text-warning'
              }
              aria-hidden
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium break-words">{f.name}</span>
              <span className="text-xs text-muted-foreground">
                {f.kind === 'other'
                  ? t('connectors.drive.read.cantRead')
                  : t(`connectors.drive.kind.${f.kind}`)}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 md:size-9"
              aria-label={t('connectors.drive.read.remove', { file: f.name })}
              onClick={() => onRemove(f.id)}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

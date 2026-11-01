// Wizard steps shared by the setup wizard's "Bring from EzyChat Lite" path (copy) and
// Admin → Inboxes → Add a number from EzyChat Lite (merge). Everything acts through the desktop bridge.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  Download,
  Globe,
  HardDrive,
  Inbox,
  KeyRound,
  Loader2,
  LogIn,
  MessageSquare,
  PlugZap,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserPlus,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  DesktopLiteImportBridge,
  LiteCheckIssue,
  LiteImportMode,
  LiteImportState,
  LiteRole,
  LiteTeamChoice,
  LiteUser,
  User,
} from '@ezychat/shared';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatBytes, initials } from '@/lib/format';
import { IconBubble, IconLine, MoveFigure, StepList, Tiles, stepsPercent } from './ui';

export type Act = (call: () => Promise<LiteImportState>, failMessage: string) => Promise<boolean>;

interface StepProps {
  state: LiteImportState;
  bridge: DesktopLiteImportBridge;
  act: Act;
  busy: boolean;
}

function useFail() {
  const { t } = useTranslation('admin');
  return t('liteImport.actionFailed');
}

/**
 * Lite runs as an OS service and its data folder is locked to it (phase 'protected', confirmed mock
 * round 4): "Allow" frees it with one admin prompt (Lite's own "Remove service"), then the normal flow
 * starts at Found. Nothing of Lite's data is known here, so the figure shows no number.
 */
export function ProtectedStep({
  state,
  bridge,
  act,
  busy,
  mode,
  cancel,
}: StepProps & { mode: LiteImportMode; cancel: ReactNode }) {
  const { t } = useTranslation('admin');
  const fail = useFail();
  const unlock = state.unlock;
  const again = unlock === 'declined' || unlock === 'failed';
  return (
    <Card data-testid="lite-protected" data-unlock={unlock}>
      <CardHeader>
        <CardTitle className="text-lg">{t('liteImport.protected.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <MoveFigure number={null} service mode={mode} />
        {unlock === 'declined' && (
          <Banner tone="warning">{t('liteImport.protected.declined')}</Banner>
        )}
        {unlock === 'failed' && <Banner tone="danger">{t('liteImport.protected.failed')}</Banner>}
        {unlock === 'waiting' ? (
          <div className="flex min-w-0 items-start gap-3 rounded-lg border p-3" role="status">
            <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{t('liteImport.protected.waitingTitle')}</span>
              <span className="text-sm break-words text-muted-foreground">
                {t('liteImport.protected.waitingBody')}
              </span>
            </span>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              <IconLine icon={KeyRound} tone="text-primary">
                {t('liteImport.protected.ask')}
              </IconLine>
              <IconLine icon={Settings2} tone="text-primary">
                {t('liteImport.protected.moves')}
              </IconLine>
              <IconLine icon={ShieldCheck} tone="text-success">
                {t('liteImport.found.kept')}
              </IconLine>
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                size="touch"
                disabled={busy}
                onClick={() => void act(() => bridge.unlock(), fail)}
              >
                <ShieldCheck aria-hidden />
                {again ? t('liteImport.protected.allowAgain') : t('liteImport.protected.allow')}
              </Button>
              {cancel}
            </div>
          </>
        )}
        {again && (
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <span className="font-medium">{t('liteImport.protected.byHand')}</span>
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              <li>{t('liteImport.protected.step1')}</li>
              <li>{t('liteImport.protected.step2')}</li>
              <li>{t('liteImport.protected.step3')}</li>
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** What was found: the figure, summary tiles, and that Lite's data stays. */
export function FoundStep({
  state,
  onContinue,
  cancel,
}: {
  state: LiteImportState;
  onContinue: () => void;
  cancel: ReactNode;
}) {
  const { t } = useTranslation('admin');
  const lite = state.lite;
  if (!lite) return null;
  const merge = state.mode === 'merge';
  const agent = lite.aiAgents[0]?.name ?? '–';
  return (
    <Card data-testid="lite-found">
      <CardHeader>
        <CardTitle className="text-lg">
          {merge ? t('liteImport.found.titleMerge') : t('liteImport.found.titleCopy')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <MoveFigure number={lite.number} mode={state.mode ?? 'copy'} />
        <Tiles
          items={[
            { icon: MessageSquare, value: lite.chats, label: t('liteImport.tile.chats') },
            { icon: Users, value: lite.customers, label: t('liteImport.tile.customers') },
            { icon: UserPlus, value: lite.users.length, label: t('liteImport.tile.team') },
            { icon: Bot, value: agent, label: t('liteImport.tile.agent') },
            {
              icon: HardDrive,
              value: formatBytes(lite.totalBytes),
              label: t('liteImport.tile.size'),
            },
            ...(lite.address
              ? [{ icon: Globe, value: lite.address, label: t('liteImport.tile.address') }]
              : []),
          ]}
        />
        <ul className="flex flex-col gap-1">
          <IconLine icon={ShieldCheck} tone="text-success">
            {t('liteImport.found.kept')}
          </IconLine>
          <IconLine icon={Zap} tone="text-success">
            {t('liteImport.found.noQr')}
          </IconLine>
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button size="touch" onClick={onContinue}>
            {merge ? t('liteImport.found.continueMerge') : t('liteImport.found.continueCopy')}
            <ArrowRight aria-hidden />
          </Button>
          {cancel}
        </div>
      </CardContent>
    </Card>
  );
}

interface CheckRow {
  id: LiteCheckIssue;
  label: string;
  fix?: ReactNode;
}

/** The checks; each blocking one has one clear action. */
export function ChecksStep({
  state,
  bridge,
  act,
  busy,
  continueLabel,
  onContinue,
}: StepProps & { continueLabel: string; onContinue: () => void }) {
  const { t } = useTranslation('admin');
  const fail = useFail();
  const has = (i: LiteCheckIssue) => state.issues.includes(i);
  const again = (
    <Button
      variant="outline"
      size="touch"
      disabled={busy}
      onClick={() => void act(() => bridge.scan(), fail)}
    >
      {t('liteImport.check.again')}
    </Button>
  );
  const updates = typeof window !== 'undefined' ? window.watiUpdates : undefined;
  const rows: CheckRow[] = [
    {
      id: 'lite_running',
      label: has('lite_running')
        ? t('liteImport.check.liteRunning')
        : t('liteImport.check.liteStopped'),
      fix: again,
    },
  ];
  if (has('lite_service'))
    rows.push({ id: 'lite_service', label: t('liteImport.check.liteService'), fix: again });
  rows.push(
    {
      id: 'lite_newer',
      label: has('lite_newer') ? t('liteImport.check.liteNewer') : t('liteImport.check.versionOk'),
      fix: updates ? (
        <Button
          size="touch"
          onClick={() =>
            void updates.check().catch(() => toast.error(t('liteImport.check.updateFailed')))
          }
        >
          <Download aria-hidden />
          {t('liteImport.check.update')}
        </Button>
      ) : (
        again
      ),
    },
    {
      id: 'disk',
      label: has('disk')
        ? t('liteImport.check.diskLow', { need: formatBytes((state.lite?.totalBytes ?? 0) * 1.1) })
        : t('liteImport.check.diskOk'),
      fix: again,
    },
  );
  if (state.mode === 'merge') {
    rows.push(
      {
        id: 'same_number',
        label: has('same_number')
          ? t('liteImport.check.sameNumber')
          : t('liteImport.check.newNumber'),
      },
      {
        id: 'no_slot',
        label: has('no_slot')
          ? t('liteImport.check.noSlot')
          : t('liteImport.check.slotOk', {
              used: state.enterprise?.inboxes ?? 0,
              max: state.enterprise?.maxInboxes ?? 0,
            }),
        fix: (
          <Button asChild variant="outline" size="touch">
            <Link to="/admin/inboxes">{t('liteImport.check.openInboxes')}</Link>
          </Button>
        ),
      },
    );
  }
  const blocked = state.issues.length > 0 || state.phase !== 'found';
  return (
    <Card data-testid="lite-checks-card">
      <CardHeader>
        <CardTitle className="text-lg">{t('liteImport.check.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3" data-testid="lite-checks">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center"
              data-issue={has(r.id) || undefined}
            >
              <span className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                {has(r.id) ? (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                )}
                <span className="min-w-0 break-words">{r.label}</span>
              </span>
              {has(r.id) && r.fix && <div className="shrink-0">{r.fix}</div>}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button size="touch" disabled={blocked || busy} onClick={onContinue}>
            {continueLabel}
            <ArrowRight aria-hidden />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Default for each Lite user: the same username here → same person, else add with Lite's role. */
export function defaultTeam(liteUsers: LiteUser[], people: User[]): LiteTeamChoice[] {
  return liteUsers.map((u) => {
    const same = people.find((p) => p.username.toLowerCase() === u.username.toLowerCase());
    return same
      ? { liteUserId: u.id, action: 'match', matchUserId: same.id, role: u.role }
      : { liteUserId: u.id, action: 'add', matchUserId: null, role: u.role };
  });
}

/**
 * Merge review: what comes over, who is who, what stays Enterprise's, what to set up again.
 * `ownAddress`: this install already has its own address. Without one, Lite's app-managed address
 * comes over (server `merge-address.ts`) instead of being set up again.
 */
export function ReviewStep({
  state,
  bridge,
  act,
  busy,
  people,
  ownAddress,
}: StepProps & { people: User[]; ownAddress: boolean }) {
  const { t } = useTranslation('admin');
  const fail = useFail();
  const lite = state.lite!;
  const addressMoves = lite.remote === 'managed' && lite.address !== null && !ownAddress;
  const [team, setTeam] = useState<LiteTeamChoice[]>(() => defaultTeam(lite.users, people));
  const update = (id: number, patch: Partial<LiteTeamChoice>) =>
    setTeam((rows) => rows.map((r) => (r.liteUserId === id ? { ...r, ...patch } : r)));
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('liteImport.review.addedTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Tiles
            items={[
              {
                icon: Inbox,
                value: t('liteImport.review.inboxValue'),
                label: lite.number ?? t('liteImport.fig.noNumber'),
              },
              { icon: MessageSquare, value: lite.chats, label: t('liteImport.tile.chats') },
              { icon: Users, value: lite.customers, label: t('liteImport.tile.customers') },
              {
                icon: Bot,
                value: lite.aiAgents[0]?.name ?? '–',
                label: t('liteImport.tile.agent'),
              },
              {
                icon: Zap,
                value: lite.quickReplyShortcuts.length,
                label: t('liteImport.tile.quickReplies'),
              },
              {
                icon: Sparkles,
                value: t('liteImport.review.reportsValue'),
                label: t('liteImport.tile.reports'),
              },
              ...(addressMoves && lite.address
                ? [{ icon: Globe, value: lite.address, label: t('liteImport.tile.address') }]
                : []),
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('liteImport.review.teamTitle')}</CardTitle>
          <CardDescription>{t('liteImport.review.teamIntro')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y" data-testid="lite-team">
            {lite.users.map((u) => {
              const r = team.find((x) => x.liteUserId === u.id)!;
              const clash = people.some(
                (p) => p.username.toLowerCase() === u.username.toLowerCase(),
              );
              return (
                <li
                  key={u.id}
                  className="flex min-w-0 flex-col gap-3 py-3 md:flex-row"
                  data-testid="lite-team-row"
                >
                  <div className="flex min-w-0 items-center gap-3 md:w-48">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                      {initials(u.displayName)}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{u.displayName}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {t(`liteImport.role.${u.role}`)}
                      </span>
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <Select
                      value={r.action}
                      onValueChange={(v) =>
                        update(u.id, {
                          action: v as LiteTeamChoice['action'],
                          matchUserId:
                            v === 'match'
                              ? (r.matchUserId ?? people[0]?.id ?? null)
                              : r.matchUserId,
                        })
                      }
                    >
                      <SelectTrigger
                        className="min-h-11 w-full md:min-h-9 md:w-48"
                        aria-label={t('liteImport.review.actionLabel', { name: u.displayName })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="match" disabled={people.length === 0}>
                          {t('liteImport.review.match')}
                        </SelectItem>
                        <SelectItem value="add">{t('liteImport.review.add')}</SelectItem>
                        <SelectItem value="skip">{t('liteImport.review.skip')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {r.action === 'match' && (
                      <Select
                        value={r.matchUserId === null ? '' : String(r.matchUserId)}
                        onValueChange={(v) => update(u.id, { matchUserId: Number(v) })}
                      >
                        <SelectTrigger
                          className="min-h-11 w-full md:min-h-9 md:w-48"
                          aria-label={t('liteImport.review.matchLabel', { name: u.displayName })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {people.map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {r.action === 'add' && (
                      <Select
                        value={r.role}
                        onValueChange={(v) => update(u.id, { role: v as LiteRole })}
                      >
                        <SelectTrigger
                          className="min-h-11 w-full md:min-h-9 md:w-48"
                          aria-label={t('liteImport.review.roleLabel', { name: u.displayName })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">{t('liteImport.role.admin')}</SelectItem>
                          <SelectItem value="agent">{t('liteImport.role.agent')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {r.action === 'add' && r.role === 'admin' && (
                      <Badge variant="outline" className="border-warning/50 text-warning">
                        <TriangleAlert aria-hidden />
                        {t('liteImport.review.seesEveryInbox')}
                      </Badge>
                    )}
                    {r.action === 'add' && clash && (
                      <span className="text-xs text-muted-foreground">
                        {t('liteImport.review.renamed', { username: `${u.username}-lite` })}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border p-4">
          <p className="flex items-center gap-2 font-medium">
            <Settings2 className="size-4 text-primary" aria-hidden />
            {t('liteImport.review.staysTitle')}
          </p>
          <ul className="flex flex-col gap-1">
            <IconLine icon={Bot}>{t('liteImport.review.stays.aiConnection')}</IconLine>
            <IconLine icon={Clock}>{t('liteImport.review.stays.timezone')}</IconLine>
            {!addressMoves && (
              <IconLine icon={Globe}>{t('liteImport.review.stays.address')}</IconLine>
            )}
          </ul>
        </div>
        <div
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4"
          data-testid="lite-redo"
        >
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 text-warning" aria-hidden />
            {t('liteImport.review.redoTitle')}
          </p>
          <ul className="flex flex-col gap-1">
            {!addressMoves && (
              <IconLine icon={Globe}>{t('liteImport.review.redo.address')}</IconLine>
            )}
            <IconLine icon={LogIn}>{t('liteImport.review.redo.signIn')}</IconLine>
            <IconLine icon={PlugZap}>{t('liteImport.review.redo.mcp')}</IconLine>
          </ul>
          {lite.tokens.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label={t('liteImport.review.redo.tokens')}>
              {lite.tokens.map((x) => (
                <li key={`${x.kind}:${x.name}`}>
                  <Badge variant="outline">{x.name}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="touch"
          disabled={busy}
          onClick={() => void act(() => bridge.start({ team }), fail)}
        >
          {t('liteImport.review.merge')}
        </Button>
      </div>
    </div>
  );
}

export function RunningStep({ state }: { state: LiteImportState }) {
  const { t } = useTranslation('admin');
  return (
    <Card data-testid="lite-running">
      <CardHeader>
        <CardTitle className="text-lg">{t('liteImport.run.title')}</CardTitle>
        <CardDescription>{t('liteImport.run.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state.lite && <MoveFigure number={state.lite.number} mode={state.mode ?? 'copy'} />}
        <Progress value={stepsPercent(state.steps)} aria-label={t('liteImport.run.title')} />
        <StepList steps={state.steps} />
      </CardContent>
    </Card>
  );
}

const FAILURE_CODES = ['own_server_stop', 'summary_failed', 'no_lite_data'] as const;

/** Plain words for a failure code from the desktop (codes stay out of the screen). */
export function failureKey(code: string) {
  const known = (FAILURE_CODES as readonly string[]).includes(code)
    ? (code as (typeof FAILURE_CODES)[number])
    : 'other';
  return `liteImport.fail.codes.${known}` as const;
}

/** Back to a fresh scan after a failure or a blocked check. */
export async function rescan(bridge: DesktopLiteImportBridge): Promise<LiteImportState> {
  const next = await bridge.reset();
  return next.phase === 'idle' ? bridge.scan() : next;
}

export function FailedStep({
  state,
  bridge,
  act,
  busy,
  onRetry,
  extra,
}: StepProps & { onRetry?: () => void; extra?: ReactNode }) {
  const { t } = useTranslation('admin');
  const fail = useFail();
  return (
    <Card data-testid="lite-failed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <XCircle className="size-5 text-danger" aria-hidden />
          {t('liteImport.fail.title')}
        </CardTitle>
        {state.failure && <CardDescription>{t(failureKey(state.failure))}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1">
          <IconLine icon={ShieldCheck} tone="text-success">
            {t('liteImport.fail.safe')}
          </IconLine>
        </ul>
        <StepList steps={state.steps} />
        <div className="flex flex-wrap gap-2">
          <Button
            size="touch"
            disabled={busy}
            onClick={() =>
              void act(() => rescan(bridge), fail).then((ok) => {
                if (ok) onRetry?.();
              })
            }
          >
            {t('liteImport.fail.retry')}
          </Button>
          <Button
            variant="outline"
            size="touch"
            onClick={() =>
              void bridge.saveSupportFile().then(
                (saved) => {
                  if (saved) toast.success(t('liteImport.fail.saved'));
                },
                () => toast.error(fail),
              )
            }
          >
            {t('liteImport.fail.support')}
          </Button>
          {extra}
        </div>
      </CardContent>
    </Card>
  );
}

/** Sign in again: the server now runs on Lite's data, so Lite's accounts and passwords apply. */
export function SignInWithLite() {
  const { t } = useTranslation('admin');
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
      data-testid="lite-sign-in"
    >
      <IconBubble icon={LogIn} tone="success" />
      <span className="min-w-0 flex-1 text-sm">{t('liteImport.done.signInLite')}</span>
      <Button size="touch" onClick={() => window.location.assign('/login')}>
        {t('liteImport.done.signIn')}
      </Button>
    </div>
  );
}

export function DoneStep({ state }: { state: LiteImportState }) {
  const { t } = useTranslation('admin');
  const r = state.result;
  const merge = state.mode === 'merge';
  return (
    <Card data-testid="lite-done">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CheckCircle2 className="size-5 text-success" aria-hidden />
          {merge ? t('liteImport.done.titleMerge') : t('liteImport.done.titleCopy')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {r && (
          <Tiles
            items={[
              { icon: Inbox, value: r.inboxName, label: t('liteImport.tile.inbox') },
              { icon: MessageSquare, value: r.chats, label: t('liteImport.tile.chats') },
              {
                icon: UserPlus,
                value: r.usersAdded + r.usersMatched,
                label: t('liteImport.tile.team'),
              },
            ]}
          />
        )}
        {r && (r.agentOff || r.renamedShortcuts.length > 0) && (
          <ul className="flex flex-col gap-1">
            {r.agentOff && <IconLine icon={Bot}>{t('liteImport.done.agentOff')}</IconLine>}
            {r.renamedShortcuts.length > 0 && (
              <IconLine icon={Zap}>
                {t('liteImport.done.renamed', { shortcuts: r.renamedShortcuts.join(', ') })}
              </IconLine>
            )}
          </ul>
        )}
        {merge ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild size="touch">
              <Link to="/">{t('liteImport.done.openInbox')}</Link>
            </Button>
            <Button asChild variant="outline" size="touch">
              <Link to="/admin/inboxes">{t('liteImport.done.toInboxes')}</Link>
            </Button>
          </div>
        ) : (
          <SignInWithLite />
        )}
      </CardContent>
    </Card>
  );
}

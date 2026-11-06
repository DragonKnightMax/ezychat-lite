import { createContext, useContext, useState } from 'react';
import type React from 'react';
import {
  Bot,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  UserCheck,
  UserPlus,
  UserX,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Trans, useTranslation } from 'react-i18next';
import {
  intlTag,
  isLocale,
  type AiAgentSummary,
  type Inbox,
  type Role,
  type User,
} from '@ezychat/shared';
import { useAiAgents, useAiMember } from '../api/ai';
import { errorMessage } from '../api/client';
import {
  useCreateUser,
  useInboxes,
  useMemberChats,
  usePatchUser,
  useResetPassword,
  useRevokeSessions,
  useSetMemberChats,
  useUsers,
} from '../api/queries';
import type { MemberChat } from '@ezychat/shared';
import { MemberChatsField } from './MemberChatsField';
import { useAuth } from '../auth/AuthProvider';
import {
  Banner,
  EmptyState,
  PageHeader,
  ResponsiveDialog,
  ResponsiveTable,
  type Column,
} from '@/components/app';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SearchField } from '@/components/app/SearchField';
import { UpgradeNote } from '@/components/app/UpgradeEnterprise';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ConfirmDialog,
  CopyButton,
  ErrorState,
  Field,
  ListSkeleton,
  Pending,
  canGeneratePassword,
  generatePassword,
} from './adminUi';
import { InboxAccessCell } from './InboxAccess';
import { connectionReady } from './ai-status';
import { InboxChip } from '../inbox/InboxChip';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: User }
  | { kind: 'reset'; user: User }
  | { kind: 'revoke'; user: User }
  | { kind: 'disable'; user: User }
  | null;

/** AI agent id -> agent, for the AI rows (each AI team member is one agent). */
const AgentRows = createContext<ReadonlyMap<number, AiAgentSummary>>(new Map());
/**
 * What the AI rows need besides their agent: the inbox names (null in an edition with one number)
 * and whether the shared AI connection works (null while unknown).
 */
const AgentContext = createContext<{ connectionReady: boolean | null }>({ connectionReady: null });
const agentPath = (user: User) =>
  user.aiAgentId === undefined ? '/admin/members/ai' : `/admin/members/ai/${user.aiAgentId}`;

export function MembersPage() {
  const users = useUsers();
  const inboxList = useInboxes();
  const agentList = useAiAgents();
  const aiStatus = useAiMember();
  const { user: me } = useAuth();
  const { t, i18n } = useTranslation('admin');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [search, setSearch] = useState('');
  const close = () => setDialog(null);

  const all = users.data ?? [];
  const agents = agentList.data?.agents ?? [];
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  // Add AI agent: only once the list is known and while the edition allows another agent.
  const canAddAgent = agentList.data !== undefined && agents.length < agentList.data.maxAgents;
  const atAgentLimit = agentList.data !== undefined && !canAddAgent && agentList.data.maxAgents > 1;
  const liteAgentLimit = agentList.data !== undefined && agentList.data.maxAgents <= 1;
  const aiSearchText = (u: User) => {
    const agent = u.aiAgentId === undefined ? undefined : agentRows.get(u.aiAgentId);
    return `${t('ai.agents.aiBadge')} ${agent ? t(`ai.presets.${agent.preset}`) : ''}`;
  };
  const query = search.trim().toLocaleLowerCase();
  const list = all.filter((u) =>
    `${u.displayName} ${u.username} ${u.role} ${u.kind === 'ai' ? aiSearchText(u) : ''}`
      .toLocaleLowerCase()
      .includes(query),
  );

  // Inbox access shows only in an edition with several WhatsApp numbers (never in Lite).
  const multiInbox = (inboxList.data?.maxInboxes ?? 1) > 1;
  const inboxes = (inboxList.data?.inboxes ?? []).filter((i) => !i.removed);
  const agentContext = {
    connectionReady: aiStatus.data ? connectionReady(aiStatus.data) : null,
  };
  const memberInboxCell = (u: User) =>
    u.kind === 'ai' ? (
      <AgentInboxCell user={u} inboxes={inboxes} />
    ) : u.chatScope === 'chosen' ? (
      // the chosen chats decide, not inbox access, while an agent sees only chosen chats
      <span className="text-sm text-muted-foreground">—</span>
    ) : (
      <InboxAccessCell user={u} inboxes={inboxes} />
    );

  const columns: Column<User>[] = [
    {
      key: 'member',
      header: t('members.columns.member'),
      cell: (u) => <MemberIdentity user={u} isMe={u.id === me?.id} />,
    },
    {
      key: 'role',
      header: t('members.columns.role'),
      cell: (u) =>
        u.kind === 'ai' ? (
          <AiBadge />
        ) : (
          <span className="flex flex-col items-start gap-1">
            <RoleBadge role={u.role} />
            <ChosenChatsNote user={u} />
          </span>
        ),
    },
    { key: 'status', header: t('members.columns.status'), cell: (u) => <StatusBadges user={u} /> },
    ...(multiInbox
      ? [
          {
            key: 'inboxes',
            header: t('inboxes.membersAccess'),
            cell: memberInboxCell,
          },
        ]
      : []),
    {
      key: 'created',
      header: t('members.columns.created'),
      cell: (u) => (
        <time
          dateTime={new Date(u.createdAt).toISOString()}
          className="whitespace-nowrap text-muted-foreground"
        >
          {formatDate(u.createdAt, i18n.language)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only md:not-sr-only">{t('members.columns.actions')}</span>,
      className: 'md:text-right',
      cell: (u) => <RowActions user={u} isMe={u.id === me?.id} onAction={setDialog} />,
    },
  ];

  return (
    <AgentRows.Provider value={agentRows}>
      <AgentContext.Provider value={agentContext}>
        <div>
          <PageHeader
            title={t('members.title')}
            description={t('ai.membersDescription')}
            actions={
              <>
                {!users.isPending && !users.isError && canAddAgent && (
                  <Button asChild variant="outline" size="touch" className="md:min-h-9">
                    <Link to="/admin/members/ai/new">
                      <Bot aria-hidden />
                      {t('ai.agents.add')}
                    </Link>
                  </Button>
                )}
                <Button
                  size="touch"
                  className="md:min-h-9"
                  onClick={() => setDialog({ kind: 'create' })}
                >
                  <UserPlus aria-hidden />
                  {t('members.add')}
                </Button>
              </>
            }
          />
          {/* Why Add AI agent is missing: every inbox has its agent (editions with several numbers). */}
          {!users.isPending && !users.isError && atAgentLimit && (
            <p className="mb-4 text-sm text-muted-foreground" data-testid="agent-limit-hint">
              {t('ai.agents.limitHint')}
            </p>
          )}
          {/* Lite has one AI agent; the note hides itself when the product has no upgrade link. */}
          {!users.isPending && !users.isError && liteAgentLimit && (
            <UpgradeNote className="mb-4" reason="agents" />
          )}

          <div className="mb-4 space-y-2">
            <SearchField
              value={search}
              onChange={setSearch}
              label={t('members.searchLabel')}
              placeholder={t('members.searchPlaceholder')}
            />
            {!users.isPending && !users.isError && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('members.count', { shown: list.length, count: all.length })}
              </p>
            )}
          </div>
          {users.isPending ? (
            <ListSkeleton />
          ) : users.isError ? (
            <ErrorState error={users.error} onRetry={() => void users.refetch()} />
          ) : (
            <ResponsiveTable
              rows={list}
              columns={columns}
              rowKey={(u) => u.id}
              renderMobileRow={(u) => (
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <MemberIdentity user={u} isMe={u.id === me?.id} />
                    <RowActions user={u} isMe={u.id === me?.id} onAction={setDialog} compact />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 pl-11">
                    {u.kind === 'ai' ? <AiBadge /> : <RoleBadge role={u.role} />}
                    <StatusBadges user={u} />
                    {u.kind !== 'ai' && <ChosenChatsNote user={u} />}
                  </div>
                  {multiInbox && <div className="pl-11">{memberInboxCell(u)}</div>}
                  <p className="pl-11 text-xs text-muted-foreground">
                    <Trans
                      t={t}
                      i18nKey="members.added"
                      values={{ date: formatDate(u.createdAt, i18n.language) }}
                      components={{ time: <time dateTime={new Date(u.createdAt).toISOString()} /> }}
                    />
                  </p>
                </div>
              )}
              empty={
                query ? (
                  <EmptyState
                    title={t('members.empty.noMatchTitle')}
                    description={t('members.empty.noMatchBody')}
                    action={
                      <Button variant="outline" size="touch" onClick={() => setSearch('')}>
                        {t('members.empty.clearSearch')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    title={t('members.empty.noneTitle')}
                    description={t('members.empty.noneBody')}
                  />
                )
              }
            />
          )}

          {dialog?.kind === 'create' && (
            <CreateMemberDialog
              onClose={close}
              onCreated={(name) => {
                close();
                toast.success(t('members.create.done', { name }));
              }}
            />
          )}
          {dialog?.kind === 'edit' && (
            <EditMemberDialog user={dialog.user} isMe={dialog.user.id === me?.id} onClose={close} />
          )}
          {dialog?.kind === 'reset' && <ResetPasswordDialog user={dialog.user} onClose={close} />}
          {dialog?.kind === 'revoke' && (
            <RevokeSessionsDialog
              user={dialog.user}
              onClose={close}
              onDone={() => {
                close();
                toast.success(t('members.revoke.done', { name: dialog.user.displayName }));
              }}
            />
          )}
          {dialog?.kind === 'disable' && <DisableMemberDialog user={dialog.user} onClose={close} />}
        </div>
      </AgentContext.Provider>
    </AgentRows.Provider>
  );
}

function useAgentOf(user: User): AiAgentSummary | undefined {
  const rows = useContext(AgentRows);
  return user.aiAgentId === undefined ? undefined : rows.get(user.aiAgentId);
}

/** An AI agent's inbox: the one it answers, or "No inbox" (shown with two or more numbers). */
function AgentInboxCell({ user, inboxes }: Readonly<{ user: User; inboxes: Inbox[] }>) {
  const { t } = useTranslation('admin');
  const agent = useAgentOf(user);
  if (!agent) return <span className="text-sm text-muted-foreground">—</span>;
  const inbox = inboxes.find((i) => i.id === agent.inboxId);
  return inbox ? (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="agent-inbox-chip">
      <InboxChip inbox={inbox} />
    </span>
  ) : (
    <span className="text-sm text-warning">{t('ai.agents.noInbox')}</span>
  );
}

/** "7 Oct 2026" in the active language: when someone joined, the time of day adds nothing. */
function formatDate(ts: number, language: string) {
  return new Intl.DateTimeFormat(intlTag(isLocale(language) ? language : 'en'), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(ts);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (
      (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
    ).toUpperCase() || '?'
  );
}

/** The AI row's robot badge (the subtitle names the agent's preset). */
function AiBadge() {
  const { t } = useTranslation('admin');
  return (
    <Badge variant="secondary" className="gap-1">
      <Bot aria-hidden className="size-3" />
      {t('ai.agents.aiBadge')}
    </Badge>
  );
}

/** "Sales agent": the inbox has its own chip in the row, so the subtitle does not repeat it. */
function AiSubtitle({ user }: Readonly<{ user: User }>) {
  const { t } = useTranslation('admin');
  const agent = useAgentOf(user);
  if (!agent) return t('ai.assistant');
  return t('ai.presets.badge', { preset: t(`ai.presets.${agent.preset}`) });
}

const AGENT_STATUS_CLASS = {
  on: 'bg-success/15 text-success',
  off: undefined,
  needsConnection: 'bg-danger/15 text-danger',
  needsKnowledge: 'bg-warning/15 text-foreground',
} as const;

/** Same order as the agent page's pill: connection, then Business context, then on/off. */
function aiRowStatus(
  user: User,
  agent: AiAgentSummary | undefined,
  ready: boolean | null,
): keyof typeof AGENT_STATUS_CLASS {
  if (ready === false) return 'needsConnection';
  if (agent && agent.documentCount === 0) return 'needsKnowledge';
  const on = agent ? agent.enabled : !user.disabled;
  return on ? 'on' : 'off';
}

/** An AI agent's status in the agent page's words: On, Off, Needs business context / connection. */
function AiStatusBadge({ user }: Readonly<{ user: User }>) {
  const { t } = useTranslation('admin');
  const agent = useAgentOf(user);
  const { connectionReady: ready } = useContext(AgentContext);
  const status = aiRowStatus(user, agent, ready);
  return (
    <Badge
      variant={status === 'off' ? 'secondary' : 'default'}
      className={AGENT_STATUS_CLASS[status]}
      data-testid="ai-status"
    >
      {t(`ai.page.pill.${status}`)}
    </Badge>
  );
}

function MemberIdentity({ user, isMe }: { user: User; isMe: boolean }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar className="size-8 shrink-0">
        <AvatarFallback className="bg-muted text-xs font-medium text-muted-foreground">
          {initials(user.displayName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="font-medium [overflow-wrap:anywhere] md:truncate">
          {user.kind === 'ai' ? (
            <Link
              to={agentPath(user)}
              className="inline-flex items-center underline-offset-4 hover:underline pointer-coarse:min-h-11"
            >
              {user.displayName}
            </Link>
          ) : (
            user.displayName
          )}
          {isMe && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {t('members.you')}
            </span>
          )}
        </p>
        <p className="truncate text-sm text-muted-foreground">
          {user.kind === 'ai' ? <AiSubtitle user={user} /> : `@${user.username}`}
        </p>
      </div>
    </div>
  );
}

/** "Only 3 chosen chats" under an agent limited to chosen chats. */
function ChosenChatsNote({ user }: { user: User }) {
  const { t } = useTranslation('admin');
  if (user.role !== 'agent' || user.chatScope !== 'chosen') return null;
  return (
    <span className="text-xs text-warning" data-testid="chosen-chats-note">
      {t('limitedChats.note', { count: user.chatJids?.length ?? 0 })}
    </span>
  );
}

function RoleBadge({ role }: { role: Role }) {
  const { t } = useTranslation();
  return role === 'admin' ? (
    <Badge className="bg-info/15 text-info">{t('roles.admin')}</Badge>
  ) : (
    <Badge variant="secondary">{t('roles.agent')}</Badge>
  );
}

function StatusBadges({ user }: { user: User }) {
  const { t } = useTranslation('admin');
  return (
    <span className="inline-flex flex-wrap gap-1">
      {/* A switched-off account is a normal state, not an error: neutral, never red. */}
      {user.kind === 'ai' ? (
        <AiStatusBadge user={user} />
      ) : user.disabled ? (
        <Badge variant="secondary">{t('members.status.disabled')}</Badge>
      ) : (
        <Badge className="bg-success/15 text-success">{t('members.status.active')}</Badge>
      )}
      {user.mustChangePassword && (
        <Badge className="bg-warning/15 text-foreground">
          {t('members.status.mustChangePassword')}
        </Badge>
      )}
    </span>
  );
}

function RowActions({
  user,
  isMe,
  onAction,
  compact = false,
}: {
  user: User;
  isMe: boolean;
  onAction: (d: Dialog) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation(['admin', 'common']);
  // 44px targets on touch screens; compact 32px buttons only with a precise pointer.
  const editClass = compact ? undefined : 'md:pointer-fine:min-h-8';
  const menuClass = compact ? undefined : 'md:pointer-fine:size-8';
  return (
    <div className="flex shrink-0 items-center gap-1 md:justify-end">
      {user.kind === 'ai' ? (
        <Button
          asChild
          size={compact ? 'icon-touch' : 'touch'}
          variant={compact ? 'ghost' : 'outline'}
          className={editClass}
        >
          <Link
            to={agentPath(user)}
            aria-label={
              compact ? t('members.actions.editMember', { name: user.displayName }) : undefined
            }
          >
            <Pencil aria-hidden />
            {!compact && t('common:actions.edit')}
          </Link>
        </Button>
      ) : (
        <Button
          size={compact ? 'icon-touch' : 'touch'}
          variant={compact ? 'ghost' : 'outline'}
          className={editClass}
          aria-label={
            compact ? t('members.actions.editMember', { name: user.displayName }) : undefined
          }
          onClick={() => onAction({ kind: 'edit', user })}
        >
          <Pencil aria-hidden />
          {!compact && t('common:actions.edit')}
        </Button>
      )}
      {/* The AI row has no menu; keep its slot so every row's Edit lines up. */}
      {user.kind === 'ai' && <span aria-hidden className={cn('size-11 shrink-0', menuClass)} />}
      {user.kind !== 'ai' && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-touch"
              variant="ghost"
              className={menuClass}
              aria-label={t('members.actions.moreFor', { name: user.displayName })}
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="min-h-11 md:min-h-8"
              onSelect={() => onAction({ kind: 'reset', user })}
            >
              <KeyRound aria-hidden />
              {t('members.actions.resetPassword')}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 md:min-h-8"
              onSelect={() => onAction({ kind: 'revoke', user })}
            >
              <LogOut aria-hidden />
              {t('members.actions.signOutEverywhere')}
            </DropdownMenuItem>
            {!isMe && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="min-h-11 md:min-h-8"
                  variant={user.disabled ? 'default' : 'destructive'}
                  onSelect={() => onAction({ kind: 'disable', user })}
                >
                  {user.disabled ? <UserCheck aria-hidden /> : <UserX aria-hidden />}
                  {user.disabled ? t('members.actions.enable') : t('members.actions.disable')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  hint,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  const { t } = useTranslation(['admin', 'common']);
  return (
    <Field label={t('members.form.role')} hint={hint}>
      {(p) => (
        <Select value={value} onValueChange={(v) => onChange(v as Role)} disabled={disabled}>
          <SelectTrigger {...p} className="min-h-11 w-full md:min-h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="agent" className="min-h-11 md:min-h-8">
              {t('common:roles.agent')}
            </SelectItem>
            <SelectItem value="admin" className="min-h-11 md:min-h-8">
              {t('common:roles.admin')}
            </SelectItem>
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}

function DialogFooterButtons({
  onCancel,
  pending,
  formId,
  submitLabel,
}: {
  onCancel: () => void;
  pending: boolean;
  formId: string;
  submitLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="outline"
        size="touch"
        className="sm:min-h-9"
        onClick={onCancel}
        disabled={pending}
      >
        {t('actions.cancel')}
      </Button>
      <Button type="submit" form={formId} size="touch" className="sm:min-h-9" disabled={pending}>
        <Pending show={pending} />
        {submitLabel}
      </Button>
    </>
  );
}

function CreateMemberDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const create = useCreateUser();
  const { t } = useTranslation(['admin', 'common']);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const secureGeneration = canGeneratePassword();
  const [password, setPassword] = useState(() => generatePassword());
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (username.trim().length < 3) {
      setLocalError(t('members.form.usernameTooShort'));
      return;
    }
    if (password.length < 8) {
      setLocalError(t('members.form.passTooShort'));
      return;
    }
    create.mutate(
      { username: username.trim(), displayName: displayName.trim(), role, password },
      { onSuccess: () => onCreated(displayName.trim() || username.trim()) },
    );
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && !create.isPending && onClose()}
      title={t('members.create.title')}
      footer={
        <DialogFooterButtons
          onCancel={onClose}
          pending={create.isPending}
          formId="create-member-form"
          submitLabel={t('members.create.submit')}
        />
      }
    >
      <form
        id="create-member-form"
        onSubmit={submit}
        className="flex flex-col gap-4 pb-1"
        noValidate
      >
        <Field label={t('members.form.username')}>
          {(p) => (
            <Input
              {...p}
              className="h-11 md:h-9"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              required
            />
          )}
        </Field>
        <Field label={t('members.form.displayName')}>
          {(p) => (
            <Input
              {...p}
              className="h-11 md:h-9"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          )}
        </Field>
        <RoleSelect value={role} onChange={setRole} />
        <Field
          label={t('members.form.tempPass')}
          hint={
            secureGeneration
              ? t('members.form.tempPasswordHint')
              : t('members.form.tempPasswordManualHint')
          }
        >
          {(p) => (
            <Input
              {...p}
              className="h-11 font-mono md:h-9"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="touch"
            variant="outline"
            className="md:min-h-9"
            disabled={!secureGeneration}
            onClick={() => setPassword(generatePassword())}
          >
            <RefreshCw aria-hidden />
            {t('members.form.generate')}
          </Button>
          <CopyButton text={password} />
        </div>
        {(localError || create.error) && (
          <Banner tone="danger">{localError ?? errorMessage(create.error)}</Banner>
        )}
      </form>
    </ResponsiveDialog>
  );
}

function EditMemberDialog({
  user,
  isMe,
  onClose,
}: {
  user: User;
  isMe: boolean;
  onClose: () => void;
}) {
  const patch = usePatchUser();
  const { t } = useTranslation(['admin', 'common']);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<Role>(user.role);
  // "Chats this member can see" (agents): the saved choice until the admin changes it here.
  const human = user.kind !== 'ai';
  const saved = useMemberChats(user.id, { enabled: human });
  const setChats = useSetMemberChats();
  const [draft, setDraft] = useState<{ scope: 'all' | 'chosen'; chats: MemberChat[] } | null>(null);
  const chatChoice = draft ?? saved.data ?? { scope: 'all' as const, chats: [] };
  const pending = patch.isPending || setChats.isPending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: { displayName?: string; role?: Role } = {};
    if (displayName.trim() && displayName.trim() !== user.displayName)
      body.displayName = displayName.trim();
    if (role !== user.role) body.role = role;
    // an admin sees every chat: the server clears the choice when the role becomes admin
    const chats = human && role === 'agent' ? draft : null;
    if (Object.keys(body).length === 0 && !chats) return onClose();
    try {
      if (Object.keys(body).length > 0) await patch.mutateAsync({ id: user.id, patch: body });
      if (chats)
        await setChats.mutateAsync({
          userId: user.id,
          body: { scope: chats.scope, chats: chats.chats.map((c) => c.jid) },
        });
      toast.success(t('members.edit.done'));
      onClose();
    } catch {
      /* the error shows in the dialog */
    }
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && !pending && onClose()}
      title={t('members.edit.title', { name: user.displayName })}
      footer={
        <DialogFooterButtons
          onCancel={onClose}
          pending={pending}
          formId="edit-member-form"
          submitLabel={t('common:actions.save')}
        />
      }
    >
      <form
        id="edit-member-form"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4 pb-1"
      >
        <Field label={t('members.form.displayName')}>
          {(p) => (
            <Input
              {...p}
              className="h-11 md:h-9"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
        </Field>
        <RoleSelect
          value={role}
          onChange={setRole}
          disabled={isMe}
          hint={isMe ? t('members.form.ownRoleHint') : undefined}
        />
        {human && role === 'agent' && (
          <MemberChatsField
            scope={chatChoice.scope}
            chats={chatChoice.chats}
            onChange={(scope, chats) => setDraft({ scope, chats })}
          />
        )}
        {(patch.error || setChats.error) && (
          <Banner tone="danger">{errorMessage(patch.error ?? setChats.error)}</Banner>
        )}
      </form>
    </ResponsiveDialog>
  );
}

function DisableMemberDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const patch = usePatchUser();
  const { t } = useTranslation('admin');
  const enabling = user.disabled;
  return (
    <ConfirmDialog
      open
      title={
        enabling
          ? t('members.disable.enableTitle', { name: user.displayName })
          : t('members.disable.disableTitle', { name: user.displayName })
      }
      confirmLabel={enabling ? t('members.actions.enable') : t('members.actions.disable')}
      danger={!enabling}
      loading={patch.isPending}
      error={patch.error ?? undefined}
      onConfirm={() =>
        patch.mutate(
          { id: user.id, patch: { disabled: !enabling } },
          {
            onSuccess: () => {
              toast.success(
                enabling
                  ? t('members.disable.enabled', { name: user.displayName })
                  : t('members.disable.disabled', { name: user.displayName }),
              );
              onClose();
            },
          },
        )
      }
      onClose={onClose}
    >
      <p>{enabling ? t('members.disable.enableBody') : t('members.disable.disableBody')}</p>
    </ConfirmDialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const reset = useResetPassword();
  const { t } = useTranslation(['admin', 'common']);
  const newPassword = reset.data?.password;

  if (newPassword) {
    return (
      <ResponsiveDialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={t('members.reset.newTitle')}
        description={t('members.reset.newBody', { name: user.displayName })}
        footer={
          <Button size="touch" className="sm:min-h-9" onClick={onClose}>
            {t('common:actions.done')}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2 pb-1">
          <code
            data-testid="new-password"
            className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-base break-all"
          >
            {newPassword}
          </code>
          <CopyButton text={newPassword} />
        </div>
      </ResponsiveDialog>
    );
  }

  return (
    <ConfirmDialog
      open
      title={t('members.reset.title', { name: user.displayName })}
      confirmLabel={t('members.actions.resetPassword')}
      danger
      loading={reset.isPending}
      error={reset.error ?? undefined}
      onConfirm={() => reset.mutate(user.id)}
      onClose={onClose}
    >
      <p>{t('members.reset.body')}</p>
    </ConfirmDialog>
  );
}

function RevokeSessionsDialog({
  user,
  onClose,
  onDone,
}: {
  user: User;
  onClose: () => void;
  onDone: () => void;
}) {
  const revoke = useRevokeSessions();
  const { t } = useTranslation('admin');
  return (
    <ConfirmDialog
      open
      title={t('members.revoke.title', { name: user.displayName })}
      confirmLabel={t('members.revoke.confirm')}
      danger
      loading={revoke.isPending}
      error={revoke.error ?? undefined}
      onConfirm={() => revoke.mutate(user.id, { onSuccess: onDone })}
      onClose={onClose}
    >
      <p>{t('members.revoke.body')}</p>
    </ConfirmDialog>
  );
}

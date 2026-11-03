import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { AiGroupRow } from '@ezychat/shared';
import { useAgentGroups, useSetAgentGroupChats, useSetAnswerInGroups } from '../api/ai-groups';
import { ApiError, errorMessage } from '../api/client';
import { Banner, ResponsiveDialog } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { encodeJid } from '../lib/jid';
import { ChatAvatar } from '../inbox/ChatAvatar';
import { GroupIcon } from '../inbox/ChatListItem';
import { ErrorState, ListSkeleton, Pending } from './adminUi';

/** Lite's only inbox keeps the name migration 014 gave inbox 1 (a product name, never translated). */
export const LITE_INBOX_NAME = 'WhatsApp';

/**
 * Agent page → Groups (designs docs/features/ai-groups/ and docs/features/group-agents/): the
 * agent's "Answer in groups" switch and, when on, the groups given to this agent, each with its
 * "Reads every message" switch and Remove. Add groups gives more groups of the inbox to it (a group
 * another agent holds is shown but cannot be chosen). Group info shows the same for one group.
 */
export function AgentGroupsCard({
  agentId,
  name,
  agentEnabled,
  inboxName,
}: Readonly<{
  agentId: number;
  name: string;
  /** The agent's saved on/off. */
  agentEnabled: boolean;
  /** The name of the agent's inbox; null = the agent answers no inbox. */
  inboxName: string | null;
}>) {
  const { t } = useTranslation('admin');
  const switchId = useId();
  const q = useAgentGroups(agentId);
  const setAgent = useSetAnswerInGroups(agentId);
  const setGroups = useSetAgentGroupChats(agentId);
  const [adding, setAdding] = useState(false);
  const fail = (e: unknown) =>
    toast.error(
      e instanceof ApiError && e.code === 'group_has_agent'
        ? t('aiGroups.add.taken')
        : t('aiGroups.saveFailed'),
    );
  const all = q.data?.groups ?? [];
  const mine = all.filter((g) => g.agentId === agentId);
  const others = all.filter((g) => g.agentId !== agentId);
  const on = Boolean(q.data?.enabled);
  // The server names the agent's inbox; the page's name stands in for an older server.
  const inbox = q.data?.inboxName ?? inboxName ?? '';

  return (
    <Card className="gap-4" data-testid="agent-groups">
      <CardHeader>
        <CardTitle>{t('aiGroups.title')}</CardTitle>
        {inboxName !== null && (
          <CardDescription>{t('aiGroups.description', { name, inbox })}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {inboxName === null ? (
          <p className="text-sm text-muted-foreground">{t('aiGroups.noInbox', { name })}</p>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <ListSkeleton rows={2} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-3">
              <div className="min-w-0">
                <Label htmlFor={switchId}>{t('aiGroups.switch')}</Label>
                <p className="mt-1 text-sm text-muted-foreground">{t('aiGroups.switchHint')}</p>
              </div>
              <Label
                htmlFor={switchId}
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
              >
                <Switch
                  id={switchId}
                  data-testid="answer-in-groups"
                  checked={on}
                  disabled={setAgent.isPending}
                  onCheckedChange={(enabled) =>
                    setAgent.mutate(enabled, {
                      onError: () => toast.error(t('aiGroups.saveFailed')),
                    })
                  }
                />
              </Label>
            </div>

            {on && !agentEnabled && (
              <Banner tone="warning">{t('aiGroups.agentOff', { name })}</Banner>
            )}

            {all.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="groups-none">
                {t('aiGroups.noGroups', { inbox })}
              </p>
            ) : !on ? (
              <p className="text-sm text-muted-foreground" data-testid="groups-off">
                {t('aiGroups.offSummary', { count: all.length, inbox, name })}
              </p>
            ) : (
              <>
                {mine.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="groups-none-on">
                    {t('aiGroups.noneOn', { name })}
                  </p>
                ) : (
                  <ul
                    className="flex flex-col divide-y rounded-lg border"
                    aria-label={t('aiGroups.listLabel', { name })}
                    data-testid="agent-group-list"
                  >
                    {mine.map((g) => (
                      <GroupRow
                        key={g.jid}
                        group={g}
                        busy={setGroups.isPending}
                        onListen={(listen) =>
                          setGroups.mutate(
                            { jids: [g.jid], enabled: true, listen },
                            { onError: fail },
                          )
                        }
                        onRemove={() =>
                          setGroups.mutate({ jids: [g.jid], enabled: false }, { onError: fail })
                        }
                      />
                    ))}
                  </ul>
                )}
                <Button
                  variant="outline"
                  size="touch"
                  className="self-start"
                  onClick={() => setAdding(true)}
                  data-testid="add-groups"
                >
                  <Plus aria-hidden />
                  {t('aiGroups.add.button')}
                </Button>
                <Banner tone="info">
                  <span className="font-medium text-foreground">{t('aiGroups.listenTitle')}</span>
                  {': '}
                  {t('aiGroups.listenInfo')}
                </Banner>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                  <li>{t('aiGroups.loopGuard', { count: q.data.loopGuard, name })}</li>
                  <li>{t('aiGroups.lookupsOnly', { name })}</li>
                </ul>
              </>
            )}
            {adding && (
              <AddGroupsDialog
                agentId={agentId}
                name={name}
                inbox={inbox}
                groups={others}
                onClose={() => setAdding(false)}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One group given to this agent: its name (opens the chat), Reads every message and Remove. */
function GroupRow({
  group: g,
  busy,
  onListen,
  onRemove,
}: Readonly<{
  group: AiGroupRow;
  busy: boolean;
  onListen: (listen: boolean) => void;
  onRemove: () => void;
}>) {
  const { t } = useTranslation('admin');
  const listenId = useId();
  return (
    <li className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ChatAvatar name={g.name} seed={g.jid} size="sm" />
        <Link
          to={`/chats/${encodeJid(g.jid)}`}
          aria-label={t('aiGroups.openGroup', { group: g.name })}
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-start gap-1 text-sm font-medium">
            <GroupIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="[overflow-wrap:anywhere]">{g.name}</span>
          </span>
          <span className={cn('text-xs text-muted-foreground', g.paused && 'text-warning')}>
            {g.memberCount != null && `${t('aiGroups.members', { count: g.memberCount })} · `}
            {g.paused
              ? t('aiGroups.paused')
              : g.listen
                ? t('aiGroups.listens')
                : t('aiGroups.answers')}
          </span>
        </Link>
      </div>
      <div className="flex items-center justify-end gap-1 pl-11 sm:pl-0">
        <Label htmlFor={listenId} className="text-sm font-normal text-muted-foreground">
          {t('aiGroups.listenTitle')}
        </Label>
        <Label
          htmlFor={listenId}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
        >
          <Switch
            id={listenId}
            aria-label={t('aiGroups.listenIn', { group: g.name })}
            checked={g.listen}
            disabled={busy}
            onCheckedChange={onListen}
          />
        </Label>
        <Button
          variant="ghost"
          size="touch"
          aria-label={t('aiGroups.removeFrom', { group: g.name })}
          disabled={busy}
          onClick={onRemove}
        >
          {t('aiGroups.remove')}
        </Button>
      </div>
    </li>
  );
}

/**
 * Add groups: the inbox's other groups with a search, one checkbox each (a group another agent
 * holds is shown disabled with that agent's name), and "Read every message in these groups" (on).
 */
function AddGroupsDialog({
  agentId,
  name,
  inbox,
  groups,
  onClose,
}: Readonly<{
  agentId: number;
  name: string;
  inbox: string;
  groups: readonly AiGroupRow[];
  onClose: () => void;
}>) {
  const { t, i18n } = useTranslation('admin');
  const save = useSetAgentGroupChats(agentId);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [listen, setListen] = useState(true);
  const listenId = useId();
  const needle = search.trim().toLocaleLowerCase(i18n.language);
  const shown = needle
    ? groups.filter((g) => g.name.toLocaleLowerCase(i18n.language).includes(needle))
    : groups;
  const toggle = (jid: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(jid);
    else next.delete(jid);
    setChosen(next);
  };
  const submit = () =>
    save.mutate({ jids: [...chosen], enabled: true, listen }, { onSuccess: onClose });
  const taken = save.error instanceof ApiError && save.error.code === 'group_has_agent';

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('aiGroups.add.title', { name })}
      description={t('aiGroups.add.description', { inbox })}
      footer={
        <>
          <Button variant="ghost" size="touch" onClick={onClose} disabled={save.isPending}>
            {t('aiGroups.add.cancel')}
          </Button>
          <Button
            size="touch"
            onClick={submit}
            disabled={chosen.size === 0 || save.isPending}
            data-testid="add-groups-save"
          >
            <Pending show={save.isPending} />
            {t('aiGroups.add.save', { count: chosen.size })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-1">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('aiGroups.add.none', { inbox })}</p>
        ) : (
          <>
            <SearchField
              value={search}
              onChange={setSearch}
              label={t('aiGroups.add.search')}
              placeholder={t('aiGroups.add.search')}
            />
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('aiGroups.add.noMatch')}</p>
            ) : (
              <ul className="flex flex-col divide-y" data-testid="add-groups-list">
                {shown.map((g) => (
                  <AddGroupRow
                    key={g.jid}
                    group={g}
                    checked={chosen.has(g.jid)}
                    onChange={(on) => toggle(g.jid, on)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
        <div className="flex min-h-11 items-center gap-3 border-t pt-3">
          <Checkbox id={listenId} checked={listen} onCheckedChange={(v) => setListen(v === true)} />
          <Label htmlFor={listenId} className="font-normal">
            {t('aiGroups.add.listen')}
          </Label>
        </div>
        {save.error && (
          <Banner tone="danger">
            {taken ? t('aiGroups.add.taken') : errorMessage(save.error)}
          </Banner>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function AddGroupRow({
  group: g,
  checked,
  onChange,
}: Readonly<{ group: AiGroupRow; checked: boolean; onChange: (on: boolean) => void }>) {
  const { t } = useTranslation('admin');
  const id = useId();
  const held = g.agentId !== null;
  const detail = [
    g.memberCount != null ? t('aiGroups.members', { count: g.memberCount }) : null,
    held ? t('aiGroups.add.held', { agent: g.agentName ?? t('aiGroups.add.otherAgent') }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex min-h-11 items-center gap-3 py-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={held}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <Label
        htmlFor={id}
        className={cn(
          'flex min-w-0 flex-col items-start gap-0.5 font-normal',
          held && 'opacity-60',
        )}
      >
        <span className="[overflow-wrap:anywhere]">{g.name}</span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </Label>
    </li>
  );
}

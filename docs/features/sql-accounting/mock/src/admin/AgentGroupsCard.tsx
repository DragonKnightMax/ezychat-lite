import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { encodeJid } from '../lib/jid';
import { ChatAvatar } from '../inbox/ChatAvatar';
import { GroupIcon } from '../inbox/ChatListItem';
import type { MockAgent } from '../mock/agents';
import { inboxOfChat, useMockInboxes } from '../mock/inboxes';
import { useMockGroups, useSetAnswerInGroups, useSetGroupAnswers } from '../mock/groups';
import { GroupsMockControls } from '../mock/GroupsMockControls';

/**
 * Proposed (ai-groups): agent page → Groups. The agent's "Answer in groups (when mentioned)"
 * switch and, when on, the groups of the agent's inbox, each with its own switch (new groups start
 * off) and a link to the group chat. The same per-group switch is in the group's info panel.
 */
export function AgentGroupsCard({
  agent,
  name,
}: Readonly<{ agent: Pick<MockAgent, 'id' | 'inboxId' | 'enabled'>; name: string }>) {
  const { t } = useTranslation('admin');
  const switchId = useId();
  const inboxes = useMockInboxes();
  const q = useMockGroups();
  const setAgent = useSetAnswerInGroups();
  const setGroup = useSetGroupAnswers();
  const inbox = inboxes.inboxes.find((i) => i.id === agent.inboxId);
  const groups = (q.data?.groups ?? []).filter(
    (g) => inbox && inboxOfChat(inboxes, g.jid)?.id === inbox.id,
  );
  const on = Boolean(q.data?.agents[agent.id]);
  const fail = () => toast.error(t('mockGroups.saveFailed'));
  const inboxName = inbox?.name ?? '';

  return (
    <Card className="gap-4" data-testid="agent-groups">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockGroups.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        {inbox && (
          <CardDescription>
            {t('mockGroups.description', { name, inbox: inboxName })}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!inbox ? (
          <p className="text-sm text-muted-foreground">{t('mockGroups.noInbox', { name })}</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-3">
              <div className="min-w-0">
                <Label htmlFor={switchId}>{t('mockGroups.switch')}</Label>
                <p className="mt-1 text-sm text-muted-foreground">{t('mockGroups.switchHint')}</p>
              </div>
              <Label
                htmlFor={switchId}
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
              >
                <Switch
                  id={switchId}
                  data-testid="answer-in-groups"
                  checked={on}
                  disabled={!q.data || setAgent.isPending}
                  onCheckedChange={(enabled) =>
                    setAgent.mutate({ agentId: agent.id, enabled }, { onError: fail })
                  }
                />
              </Label>
            </div>

            {on && !agent.enabled && (
              <Banner tone="warning">{t('mockGroups.agentOff', { name })}</Banner>
            )}

            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="groups-none">
                {t('mockGroups.noGroups', { inbox: inboxName })}
              </p>
            ) : !on ? (
              <p className="text-sm text-muted-foreground" data-testid="groups-off">
                {t('mockGroups.offSummary', { count: groups.length, inbox: inboxName, name })}
              </p>
            ) : (
              <>
                {!groups.some((g) => g.enabled) && (
                  <p className="text-sm text-muted-foreground" data-testid="groups-none-on">
                    {t('mockGroups.noneOn', { name })}
                  </p>
                )}
                <ul
                  className="flex flex-col divide-y rounded-lg border"
                  aria-label={t('mockGroups.listLabel', { inbox: inboxName })}
                  data-testid="agent-group-list"
                >
                  {groups.map((g) => {
                    const status = !g.enabled
                      ? t('mockGroups.off')
                      : g.paused
                        ? t('mockGroups.paused')
                        : t('mockGroups.answers');
                    return (
                      <li key={g.jid} className="flex items-center gap-3 px-3 py-2">
                        <ChatAvatar name={g.name} seed={g.jid} size="sm" />
                        <Link
                          to={`/chats/${encodeJid(g.jid)}`}
                          aria-label={t('mockGroups.openGroup', { group: g.name })}
                          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                          <span className="flex min-w-0 items-start gap-1 text-sm font-medium">
                            <GroupIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <span className="[overflow-wrap:anywhere]">{g.name}</span>
                          </span>
                          <span
                            className={cn(
                              'text-xs text-muted-foreground',
                              g.enabled && g.paused && 'text-warning',
                            )}
                          >
                            {g.size != null && `${t('mockGroups.members', { count: g.size })} · `}
                            {status}
                          </span>
                        </Link>
                        <Label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                          <Switch
                            checked={g.enabled}
                            aria-label={t('mockGroups.answerIn', { group: g.name })}
                            disabled={setGroup.isPending}
                            onCheckedChange={(enabled) =>
                              setGroup.mutate({ jid: g.jid, enabled }, { onError: fail })
                            }
                          />
                        </Label>
                      </li>
                    );
                  })}
                </ul>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                  <li>
                    {t('mockGroups.loopGuard', {
                      count: q.data?.loopGuardAnswers ?? 10,
                      name,
                    })}
                  </li>
                  <li>{t('mockGroups.lookupsOnly', { name })}</li>
                </ul>
              </>
            )}
          </>
        )}
        <GroupsMockControls agentId={agent.id} agentName={name} />
      </CardContent>
    </Card>
  );
}

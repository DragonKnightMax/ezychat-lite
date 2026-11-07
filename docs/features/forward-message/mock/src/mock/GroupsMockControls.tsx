import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { toast } from 'sonner';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '../api/client';
import { formatTime } from '../lib/format';
import {
  useGroupAi,
  useGroupsScenario,
  useMockGroups,
  useSetAnswerInGroups,
  useSimulateGroup,
  type MockGroupNotification,
  type SimulateKind,
} from './groups';

const ACTIONS: readonly SimulateKind[] = [
  'question',
  'followUp',
  'unrelated',
  'handover',
  'teammate',
];

/** The hand-over notification as the desktop app and the phone show it (title, text, recipient). */
export function GroupNotificationPreview({ n }: { n: MockGroupNotification }) {
  const { t } = useTranslation('inbox');
  return (
    <div
      className="flex items-start gap-3 rounded-lg border bg-surface p-3 shadow-sm"
      data-testid="group-notification"
    >
      <Bell className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold [overflow-wrap:anywhere]">
          {t('mockGroups.notification.title', { agent: n.agent, group: n.group })}
        </p>
        <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
          {t('mockGroups.notification.body', { member: n.member, question: n.question })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {n.to
            ? t('mockGroups.notification.to', { name: n.to })
            : t('mockGroups.notification.toAll')}{' '}
          · {formatTime(n.at)}
        </p>
      </div>
    </div>
  );
}

/**
 * Proposed (ai-groups), mock only: a dashed panel to switch the states of the feature (the agent's
 * Answer in groups switch, the loop guard, admin or agent view) and, in a group chat, make
 * something happen there (a mention, a follow-up, an unrelated message, a request the AI hands over,
 * a teammate's reply). It also shows the last group hand-over notification. The app has no such panel.
 */
export function GroupsMockControls({
  agentId,
  agentName,
  jid,
  collapsible = false,
}: {
  agentId: string | undefined;
  agentName: string;
  /** A group chat: the simulation buttons act in it. */
  jid?: string;
  collapsible?: boolean;
}) {
  const { t } = useTranslation('inbox');
  const ids = { agent: useId(), guard: useId(), view: useId(), simulate: useId() };
  const q = useMockGroups();
  const setAgent = useSetAnswerInGroups();
  const scenario = useGroupsScenario();
  const simulate = useSimulateGroup();
  const view = q.data;
  if (!view) return null;
  const fail = (err: unknown) => toast.error(errorMessage(err));
  const demo = jid ? view.groups.find((g) => g.jid === jid)?.demo : false;
  const busy = setAgent.isPending || scenario.isPending || simulate.isPending;

  const body = (
    <div className="flex flex-col gap-3 pt-2">
      {agentId && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span id={ids.agent} className="text-sm font-medium">
            {t('mockGroups.control.agentSwitch', { name: agentName })}
          </span>
          <SegmentedControl<'on' | 'off'>
            size="sm"
            aria-labelledby={ids.agent}
            value={view.agents[agentId] ? 'on' : 'off'}
            onValueChange={(v) =>
              setAgent.mutate({ agentId, enabled: v === 'on' }, { onError: fail })
            }
            options={[
              { value: 'on', label: t('mockGroups.control.on') },
              { value: 'off', label: t('mockGroups.control.off') },
            ]}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={ids.guard} className="text-sm font-medium">
          {t('mockGroups.control.loopGuard')}
        </span>
        <SegmentedControl<'no' | 'yes'>
          size="sm"
          aria-labelledby={ids.guard}
          value={view.loopGuard ? 'yes' : 'no'}
          onValueChange={(v) => scenario.mutate({ loopGuard: v === 'yes' }, { onError: fail })}
          options={[
            { value: 'no', label: t('mockGroups.control.no') },
            { value: 'yes', label: t('mockGroups.control.yes') },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={ids.view} className="text-sm font-medium">
          {t('mockGroups.control.viewAs')}
        </span>
        <SegmentedControl<'admin' | 'agent'>
          size="sm"
          aria-labelledby={ids.view}
          value={view.viewAs}
          onValueChange={(viewAs) => scenario.mutate({ viewAs }, { onError: fail })}
          options={[
            { value: 'admin', label: t('mockGroups.control.admin') },
            { value: 'agent', label: t('mockGroups.control.agent') },
          ]}
        />
      </div>
      {jid && (
        <div className="flex flex-col gap-2 border-t pt-2">
          <p id={ids.simulate} className="text-sm font-medium">
            {t('mockGroups.control.simulate')}
          </p>
          {demo ? (
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={ids.simulate}>
              {ACTIONS.map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="min-h-11 whitespace-normal md:pointer-fine:min-h-8"
                  data-testid={`simulate-${kind}`}
                  onClick={() =>
                    simulate.mutate(
                      { jid, kind },
                      {
                        onSuccess: ({ outcome }) =>
                          toast(t(`mockGroups.control.outcome.${outcome}`)),
                        onError: fail,
                      },
                    )
                  }
                >
                  {t(`mockGroups.control.actions.${kind}`)}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('mockGroups.control.notADemoGroup')}</p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 border-t pt-2">
        <p className="text-sm font-medium">{t('mockGroups.control.notificationTitle')}</p>
        {view.notification ? (
          <GroupNotificationPreview n={view.notification} />
        ) : (
          <p className="text-xs text-muted-foreground">{t('mockGroups.control.noNotification')}</p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        className="min-h-11 self-start md:pointer-fine:min-h-8"
        onClick={() => scenario.mutate({ reset: true }, { onError: fail })}
      >
        {t('mockGroups.control.reset')}
      </Button>
    </div>
  );

  const header = (
    <>
      <Badge variant="outline">{t('mockGroups.control.proposed')}</Badge>
      <span className="font-medium">{t('mockGroups.control.title')}</span>
    </>
  );

  return collapsible ? (
    <details
      className="mx-3 mt-3 rounded-lg border border-dashed px-3 py-2 text-sm md:mx-4"
      data-testid="mock-groups"
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 md:pointer-fine:min-h-8">
        {header}
      </summary>
      {body}
    </details>
  ) : (
    <div
      className="flex flex-col rounded-lg border border-dashed px-3 py-3 text-sm"
      data-testid="mock-groups"
    >
      <div className="flex flex-wrap items-center gap-2">{header}</div>
      {body}
    </div>
  );
}

/** The panel in a group chat: the agent is the one of the group's inbox. */
export function GroupChatMockControls({ jid }: { jid: string }) {
  const ai = useGroupAi(jid);
  return (
    <GroupsMockControls
      agentId={ai.agent?.id}
      agentName={ai.agent?.name ?? ''}
      jid={jid}
      collapsible
    />
  );
}

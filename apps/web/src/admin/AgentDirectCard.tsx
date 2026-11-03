import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAgentGroups, useSetAnswerDirect } from '../api/ai-groups';
import { useAiAgents } from '../api/ai';
import { ApiError } from '../api/client';
import { Banner } from '@/components/app';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from './adminUi';

/**
 * Agent page → Direct chats (design docs/features/ai-direct-chats/design.md): the agent's "Answer
 * direct chats" switch, on by default. Off with "Answer in groups" on makes a group-only agent: it
 * never answers or takes a direct chat, teammates cannot assign one to it, and the direct chats it
 * holds go back to the team (after a confirm naming how many). Hidden while the agent's inbox has no
 * WhatsApp groups (the WhatsApp Business API), where the switch does not apply.
 */
export function AgentDirectCard({
  agentId,
  name,
  inboxName,
}: Readonly<{
  agentId: number;
  name: string;
  /** The name of the agent's inbox; null = the agent answers no inbox (card hidden). */
  inboxName: string | null;
}>) {
  const { t } = useTranslation('admin');
  const switchId = useId();
  const q = useAgentGroups(agentId);
  const set = useSetAnswerDirect(agentId);
  const agents = useAiAgents();
  const [confirm, setConfirm] = useState(false);
  /** 409 `inbox_has_direct_agent`: another agent of this inbox answers direct chats. */
  const [taken, setTaken] = useState(false);
  if (inboxName === null || !q.data?.directAvailable) return null;

  const { answerDirect: on, enabled: groupsOn, heldDirect: held } = q.data;
  const inbox = q.data.inboxName ?? inboxName;
  // The other agent is named when it is the only other agent of this inbox.
  const list = agents.data?.agents ?? [];
  const inboxId = list.find((a) => a.id === agentId)?.inboxId ?? null;
  const rivals = list.filter((a) => a.id !== agentId && inboxId !== null && a.inboxId === inboxId);
  const other = rivals.length === 1 ? rivals[0]!.displayName : null;
  const save = (enabled: boolean) => {
    setTaken(false);
    set.mutate(enabled, {
      onSuccess: () => setConfirm(false),
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'inbox_has_direct_agent') setTaken(true);
        else toast.error(t('aiDirect.saveFailed'));
      },
    });
  };

  return (
    <Card className="gap-4" data-testid="agent-direct">
      <CardHeader>
        <CardTitle>{t('aiDirect.title')}</CardTitle>
        <CardDescription>{t('aiDirect.description', { inbox })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-3">
          <div className="min-w-0">
            <Label htmlFor={switchId}>{t('aiDirect.switch')}</Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('aiDirect.switchHint', { name })}
            </p>
          </div>
          <Label
            htmlFor={switchId}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id={switchId}
              data-testid="answer-direct"
              checked={on}
              disabled={set.isPending}
              onCheckedChange={(enabled) => {
                if (!enabled && held > 0) setConfirm(true);
                else save(enabled);
              }}
            />
          </Label>
        </div>

        {taken && (
          <p className="text-sm text-danger" role="alert" data-testid="direct-taken">
            {other ? t('aiDirect.taken', { other, inbox }) : t('aiDirect.takenUnknown', { inbox })}
          </p>
        )}

        {!on && (
          <div data-testid={groupsOn ? 'direct-group-only' : 'direct-none'}>
            {groupsOn ? (
              <Banner tone="info">{t('aiDirect.groupOnly', { name })}</Banner>
            ) : (
              <Banner tone="warning">{t('aiDirect.answersNothing', { name })}</Banner>
            )}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirm}
        title={t('aiDirect.confirmTitle', { name })}
        confirmLabel={t('aiDirect.confirmAction')}
        loading={set.isPending}
        onConfirm={() => save(false)}
        onClose={() => setConfirm(false)}
      >
        {t('aiDirect.confirmBody', { count: held, name })}
      </ConfirmDialog>
    </Card>
  );
}

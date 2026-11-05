import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { errorMessage } from '../api/client';
import { useGroupAi, useSetGroupAnswers } from '../mock/groups';

/**
 * Proposed (ai-groups): Group info → "AI agent answers when mentioned". Admins switch it; agents
 * see the state. Disabled with a hint while the agent's "Answer in groups" is off.
 */
export function GroupAiRow({ jid }: { jid: string }) {
  const { t } = useTranslation('inbox');
  const id = useId();
  const hintId = useId();
  const ai = useGroupAi(jid);
  const setGroup = useSetGroupAnswers();
  if (!ai.view || !ai.row) return null;
  const { agent, row } = ai;
  const hint = !agent
    ? t('mockGroups.info.noAgent')
    : !ai.agentOn
      ? t('mockGroups.info.agentOff', { name: agent.name })
      : ai.active && row.paused
        ? t('mockGroups.info.paused')
        : t('mockGroups.info.hint', { name: agent.name });

  return (
    <section
      className="mx-4 mt-2 rounded-lg border bg-muted/40 px-3 py-2"
      aria-labelledby={id}
      data-testid="group-ai-row"
    >
      <div className="flex items-center gap-3">
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Label
          htmlFor={ai.canEdit ? id : undefined}
          id={ai.canEdit ? undefined : id}
          className="min-w-0 flex-1 text-sm leading-snug"
        >
          {t('mockGroups.info.title')}
        </Label>
        {ai.canEdit ? (
          <Label
            htmlFor={id}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id={id}
              aria-describedby={hintId}
              checked={row.enabled && ai.agentOn}
              disabled={!agent || !ai.agentOn || setGroup.isPending}
              onCheckedChange={(enabled) =>
                setGroup.mutate({ jid, enabled }, { onError: (e) => toast.error(errorMessage(e)) })
              }
            />
          </Label>
        ) : (
          <Badge
            variant={ai.active ? 'secondary' : 'outline'}
            className="shrink-0"
            data-testid="group-ai-state"
          >
            {ai.active ? t('mockGroups.info.on') : t('mockGroups.info.off')}
          </Badge>
        )}
      </div>
      <p id={hintId} className="mt-1 pl-7 text-xs text-muted-foreground">
        {hint}
        {agent && !ai.agentOn && ai.canEdit && (
          <>
            {' '}
            <Link
              to={`/admin/members/ai/${encodeURIComponent(agent.id)}`}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('mockGroups.info.openAgent', { name: agent.name })}
            </Link>
          </>
        )}
      </p>
      {!ai.canEdit && (
        <p className="mt-0.5 pl-7 text-xs text-muted-foreground">{t('mockGroups.info.readOnly')}</p>
      )}
    </section>
  );
}

/** Proposed (ai-groups): chat header badge on a group where the AI answers when mentioned. */
export function GroupAiBadge({ jid }: { jid: string }) {
  const { t } = useTranslation('inbox');
  const ai = useGroupAi(jid);
  if (!ai.active || !ai.row) return null;
  const paused = ai.row.paused;
  return (
    <Badge
      variant="outline"
      className={cn(
        'min-w-0 shrink gap-1 font-normal',
        paused ? 'border-warning/40 text-warning' : 'border-primary/30 text-primary',
      )}
      data-testid="group-ai-badge"
    >
      <Bot className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {paused ? t('mockGroups.badgePaused') : t('mockGroups.badge')}
      </span>
    </Badge>
  );
}

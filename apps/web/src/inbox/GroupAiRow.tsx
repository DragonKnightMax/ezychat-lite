import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import type { AiGroupChat, AiGroupChatBody } from '@ezychat/shared';
import { useGroupChatAi, useSetGroupChatAi } from '../api/ai-groups';
import { InfoTip } from '@/components/app/InfoTip';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { errorMessage } from '../api/client';

/** The AI answers tags and quotes in this group now (its switch and the agent's are both on). */
export const groupAiActive = (ai: AiGroupChat | null | undefined): boolean =>
  Boolean(ai?.enabled && ai.agentAnswersGroups);

/**
 * Group info → "AI agent in this group" (designs docs/features/ai-groups/ and
 * docs/features/group-agents/). Admins switch it, choose the agent when the inbox has 2+ agents
 * that answer in groups, and switch "Reads every message"; agents see the state. Disabled with a
 * hint while no agent can answer here. Hidden when the server does not answer (an older server, or
 * no access).
 */
export function GroupAiRow({ jid, isAdmin }: Readonly<{ jid: string; isAdmin: boolean }>) {
  const { t } = useTranslation('inbox');
  const id = useId();
  const hintId = useId();
  const agentLabelId = useId();
  const listenId = useId();
  const q = useGroupChatAi(jid);
  const setGroup = useSetGroupChatAi();
  /** The agent an admin chose while the group is off (saved when the switch turns on). */
  const [picked, setPicked] = useState<number | null>(null);
  const ai = q.data;
  if (!ai) return null;
  const active = groupAiActive(ai);
  const choices = ai.agents;
  const candidate = picked ?? ai.agentId;
  const agentFor = choices.some((c) => c.id === candidate)
    ? candidate
    : choices.length === 1
      ? choices[0]!.id
      : null;
  const canTurnOn =
    choices.length === 0 ? ai.agentId !== null && ai.agentAnswersGroups : agentFor !== null;
  const agentName =
    (ai.agentId === null ? choices.find((c) => c.id === agentFor)?.name : ai.agentName) ?? '';
  const onError = (e: unknown) => toast.error(errorMessage(e));
  const save = (body: AiGroupChatBody) => setGroup.mutate({ jid, ...body }, { onError });
  const hint =
    ai.agentId === null && choices.length === 0
      ? t('aiGroups.info.noAgent')
      : ai.agentId === null && agentFor === null
        ? t('aiGroups.info.chooseAgent')
        : ai.agentId === null
          ? t('aiGroups.info.hint', { name: agentName })
          : !ai.agentEnabled
            ? t('aiGroups.info.agentDisabled', { name: agentName })
            : !ai.agentAnswersGroups
              ? t('aiGroups.info.agentOff', { name: agentName })
              : active && ai.paused
                ? t('aiGroups.info.paused')
                : active && ai.listen
                  ? t('aiGroups.info.listenHint', { name: agentName })
                  : t('aiGroups.info.hint', { name: agentName });

  return (
    <section
      className="mx-4 mt-2 rounded-lg border bg-muted/40 px-3 py-2"
      aria-labelledby={id}
      data-testid="group-ai-row"
    >
      <div className="flex items-center gap-3">
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Label
          htmlFor={isAdmin ? id : undefined}
          id={isAdmin ? undefined : id}
          className="min-w-0 flex-1 text-sm leading-snug"
        >
          {t('aiGroups.info.title')}
        </Label>
        {isAdmin ? (
          <Label
            htmlFor={id}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id={id}
              aria-describedby={hintId}
              checked={active}
              disabled={setGroup.isPending || (!active && !canTurnOn)}
              onCheckedChange={(enabled) =>
                save(
                  enabled && choices.length > 0 && agentFor !== null
                    ? { enabled, agentId: agentFor }
                    : { enabled },
                )
              }
            />
          </Label>
        ) : (
          <Badge
            variant={active ? 'secondary' : 'outline'}
            className="shrink-0"
            data-testid="group-ai-state"
          >
            {active ? t('aiGroups.info.on') : t('aiGroups.info.off')}
          </Badge>
        )}
      </div>
      <p id={hintId} className="mt-1 pl-7 text-xs text-muted-foreground">
        {hint}
        {ai.agentId !== null && !ai.agentAnswersGroups && isAdmin && (
          <>
            {' '}
            <Link
              to={`/admin/members/ai/${ai.agentId}`}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('aiGroups.info.openAgent', { name: agentName })}
            </Link>
          </>
        )}
      </p>
      {isAdmin && choices.length >= 2 && (
        <div className="mt-2 flex flex-col gap-1 pl-7">
          <Label id={agentLabelId} className="text-xs text-muted-foreground">
            {t('aiGroups.info.agent')}
          </Label>
          <Select
            value={agentFor !== null ? String(agentFor) : ''}
            disabled={setGroup.isPending}
            onValueChange={(value) => {
              const next = Number(value);
              setPicked(next);
              if (ai.enabled) save({ enabled: true, agentId: next });
            }}
          >
            <SelectTrigger
              aria-labelledby={agentLabelId}
              className="min-h-11 w-full bg-surface *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate"
              data-testid="group-ai-agent"
            >
              <SelectValue placeholder={t('aiGroups.info.chooseAgentPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {isAdmin && active && (
        <div className="mt-1 flex items-center gap-2 pl-7">
          <Label htmlFor={listenId} className="min-w-0 flex-1 text-sm leading-snug font-normal">
            {t('aiGroups.info.listen')}
          </Label>
          <InfoTip title={t('aiGroups.info.listenTipTitle')} body={t('aiGroups.info.listenTip')} />
          <Label
            htmlFor={listenId}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id={listenId}
              data-testid="group-ai-listen"
              checked={ai.listen}
              disabled={setGroup.isPending}
              onCheckedChange={(listen) =>
                save({
                  enabled: true,
                  ...(ai.agentId !== null && { agentId: ai.agentId }),
                  listen,
                })
              }
            />
          </Label>
        </div>
      )}
      {!isAdmin && (
        <p className="mt-0.5 pl-7 text-xs text-muted-foreground">{t('aiGroups.info.readOnly')}</p>
      )}
    </section>
  );
}

/** Chat header badge on a group where the AI answers when tagged or quoted (or is paused there). */
export function GroupAiBadge({ ai }: Readonly<{ ai: AiGroupChat | null | undefined }>) {
  const { t } = useTranslation('inbox');
  if (!ai || !groupAiActive(ai)) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        'min-w-0 shrink gap-1 font-normal',
        ai.paused ? 'border-warning/40 text-warning' : 'border-primary/30 text-primary',
      )}
      data-testid="group-ai-badge"
    >
      <Bot className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {ai.paused
          ? t('aiGroups.badgePaused')
          : ai.listen
            ? t('aiGroups.badgeListen')
            : t('aiGroups.badge')}
      </span>
    </Badge>
  );
}

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { MockAgent } from '../mock/agents';
import { setResolutionCheck, useResolutionCheck } from '../mock/resolution';

/**
 * Proposed (ai-handoff-rules): agent page → Closing chats. The "Ask if the question is answered"
 * switch (off by default: no check-in line, the team closes chats) and, in a dashed Mock only box,
 * how the same two customer turns are answered with the switch off or on.
 */
export function AgentResolutionCard({
  agent,
  name,
}: Readonly<{ agent: Pick<MockAgent, 'id' | 'preset'>; name: string }>) {
  const { t } = useTranslation('admin');
  const switchId = useId();
  const on = useResolutionCheck(agent.id, agent.preset);
  return (
    <Card className="gap-4" data-testid="agent-resolution">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockResolution.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockResolution.description', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-3">
          <div className="min-w-0">
            <Label htmlFor={switchId}>{t('mockResolution.switch')}</Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {on ? t('mockResolution.onHint', { name }) : t('mockResolution.offHint', { name })}
            </p>
          </div>
          <Label
            htmlFor={switchId}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id={switchId}
              data-testid="resolution-check"
              checked={on}
              onCheckedChange={(enabled) => setResolutionCheck(agent.id, enabled)}
            />
          </Label>
        </div>
        <div
          className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3 text-sm"
          data-testid="resolution-preview"
        >
          <p className="font-medium text-muted-foreground">{t('mockResolution.previewTitle')}</p>
          {(
            [
              [t('mockResolution.customer'), t('mockResolution.q1')],
              [name, on ? t('mockResolution.on.a1') : t('mockResolution.off.a1')],
              [t('mockResolution.customer'), t('mockResolution.q2')],
              [name, on ? t('mockResolution.on.a2') : t('mockResolution.off.a2')],
            ] as const
          ).map(([speaker, text], i) => (
            <p
              key={i}
              className={
                i % 2 === 0
                  ? '[overflow-wrap:anywhere]'
                  : '[overflow-wrap:anywhere] text-muted-foreground'
              }
            >
              <span className="font-medium text-foreground">{speaker}:</span> {text}
            </p>
          ))}
          <p className="text-muted-foreground">
            {on ? t('mockResolution.on.result') : t('mockResolution.off.result')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

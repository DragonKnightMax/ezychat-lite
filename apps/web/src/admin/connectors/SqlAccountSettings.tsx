import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  SQL_OBJECTS,
  sqlAccessOf,
  type SqlAccess,
  type SqlAccountStatus,
  type SqlAgentSettings,
  type SqlObjectDef,
  type SqlStockDetail,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import { useSaveSqlAgentSettings, useSqlAgentSettings, useSqlMatch } from '../../api/sql-account';
import { Banner, SegmentedControl } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ErrorState, ListSkeleton } from '../adminUi';
import { AgentPicker } from './AgentPicker';

const GUARDS = ['confirm', 'items', 'price', 'limit', 'never'] as const;

/** Settings tab: one AI agent at a time (`&agent=<id>`), like Google Calendar and Sheets. */
export function SqlAgentsSettings() {
  return (
    <AgentPicker
      render={(agent) => (
        <SqlAgentAccessLoader key={agent.id} agentId={agent.id} name={agent.displayName} />
      )}
    />
  );
}

function SqlAgentAccessLoader({ agentId, name }: Readonly<{ agentId: number; name: string }>) {
  const query = useSqlAgentSettings(agentId);
  if (query.isPending) return <ListSkeleton rows={4} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <SqlAgentAccess agentId={agentId} name={name} saved={query.data} />;
}

/** Whether two settings give the agent the same access (a missing choice = the default). */
function sameSettings(a: SqlAgentSettings, b: SqlAgentSettings): boolean {
  return (
    a.showPrice === b.showPrice &&
    a.stockDetail === b.stockDetail &&
    SQL_OBJECTS.every((o) => sqlAccessOf(a, o.id) === sqlAccessOf(b, o.id))
  );
}

/** Off / Read / Read + create per SQL Account object, and how stock is shown. */
function SqlAgentAccess({
  agentId,
  name,
  saved,
}: Readonly<{ agentId: number; name: string; saved: SqlAgentSettings }>) {
  const { t } = useTranslation('admin');
  const save = useSaveSqlAgentSettings(agentId);
  const [draft, setDraft] = useState<SqlAgentSettings>(saved);
  const dirty = !sameSettings(draft, saved);
  const set = (o: SqlObjectDef, access: SqlAccess) =>
    setDraft((d) => ({ ...d, access: { ...d.access, [o.id]: access } }));
  const quotation = sqlAccessOf(draft, 'salesquotation') === 'create';
  const stockOn = sqlAccessOf(draft, 'stockitem') !== 'off';
  const priceId = `sql-price-${agentId}`;
  const stockId = `sql-stock-${agentId}`;
  return (
    <Card data-testid="sql-agent-access">
      <CardHeader>
        <CardTitle className="break-words">
          {t('connectors.sql.access.title', { agent: name })}
        </CardTitle>
        <CardDescription>{t('connectors.sql.access.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y rounded-lg border">
          {SQL_OBJECTS.map((o) => {
            const labelId = `sql-obj-${agentId}-${o.id}`;
            return (
              <li
                key={o.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid={`sql-object-${o.id}`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span id={labelId} className="text-sm font-medium">
                      {t(`connectors.sql.obj.${o.id}.name`)}
                    </span>
                    <Badge variant="secondary">
                      {o.scope === 'own'
                        ? t('connectors.sql.access.own')
                        : t('connectors.sql.access.everyone')}
                    </Badge>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`connectors.sql.obj.${o.id}.sees`)}
                  </span>
                </span>
                <SegmentedControl<SqlAccess>
                  size="sm"
                  className="shrink-0"
                  aria-labelledby={labelId}
                  value={sqlAccessOf(draft, o.id)}
                  onValueChange={(v) => set(o, v)}
                  options={[
                    { value: 'off', label: t('connectors.sql.access.off') },
                    { value: 'read', label: t('connectors.sql.access.read') },
                    ...(o.create
                      ? [{ value: 'create' as const, label: t('connectors.sql.access.create') }]
                      : []),
                  ]}
                />
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-muted-foreground">{t('connectors.sql.access.never')}</p>
        {quotation && (
          <Banner tone="warning" title={t('connectors.sql.guard.title')}>
            <ul className="flex list-disc flex-col gap-1 pl-5" data-testid="sql-quotation-guard">
              {GUARDS.map((k) => (
                <li key={k}>{t(`connectors.sql.guard.${k}`)}</li>
              ))}
            </ul>
          </Banner>
        )}
        {stockOn && (
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={priceId}>{t('connectors.sql.access.showPrice')}</Label>
              <Label
                htmlFor={priceId}
                className="flex min-h-11 min-w-11 items-center justify-center"
              >
                <Switch
                  id={priceId}
                  checked={draft.showPrice}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, showPrice: v }))}
                />
              </Label>
            </div>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span id={stockId} className="text-sm font-medium">
                {t('connectors.sql.access.stockShown')}
              </span>
              <SegmentedControl<SqlStockDetail>
                size="sm"
                aria-labelledby={stockId}
                value={draft.stockDetail}
                onValueChange={(v) => setDraft((d) => ({ ...d, stockDetail: v }))}
                options={[
                  { value: 'inStock', label: t('connectors.sql.access.inStock') },
                  { value: 'quantity', label: t('connectors.sql.access.quantity') },
                ]}
              />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="touch"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(draft, {
                onSuccess: (next) => {
                  setDraft(next);
                  toast.success(t('connectors.sql.access.saved'));
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            {t('connectors.sql.access.save')}
          </Button>
          {dirty && (
            <Button size="touch" variant="ghost" onClick={() => setDraft(saved)}>
              {t('connectors.sql.access.discard')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** "Who is this customer in SQL Account?": the match rules and Match by phone number. */
export function SqlMatchCard({ status }: Readonly<{ status: SqlAccountStatus }>) {
  const { t } = useTranslation('admin');
  const match = useSqlMatch();
  const id = 'sql-match-phone';
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('connectors.sql.match.title')}</CardTitle>
        <CardDescription>{t('connectors.sql.match.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li>{t('connectors.sql.match.rule1')}</li>
          <li>{t('connectors.sql.match.rule2')}</li>
          <li>{t('connectors.sql.match.rule3')}</li>
        </ol>
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={id}>{t('connectors.sql.match.byPhone')}</Label>
            <Label htmlFor={id} className="flex min-h-11 min-w-11 items-center justify-center">
              <Switch
                id={id}
                checked={status.matchByPhone}
                disabled={match.isPending}
                onCheckedChange={(v) =>
                  match.mutate(v, { onError: (error) => toast.error(errorMessage(error)) })
                }
              />
            </Label>
          </div>
          {status.phoneMatch === 'building' && (
            <p className="text-sm text-muted-foreground" data-testid="sql-phone-building">
              {t('connectors.sql.match.building')}
            </p>
          )}
          {status.phoneMatch === 'unavailable' && (
            <p className="text-sm text-muted-foreground" data-testid="sql-phone-unavailable">
              {t('connectors.sql.match.unavailable')}
            </p>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{t('connectors.sql.match.never')}</p>
      </CardContent>
    </Card>
  );
}

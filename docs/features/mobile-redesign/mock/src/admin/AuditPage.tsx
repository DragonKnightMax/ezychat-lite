import { useId, useState } from 'react';
import { Download, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AuditEntry, User } from '@ezychat/shared';
import { useAudit, useUsers } from '../api/queries';
import { formatDateTime } from '../lib/format';
import {
  EmptyState,
  PageHeader,
  ResponsiveTable,
  SegmentedControl,
  type Column,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { ErrorState, ListSkeleton, Pending } from './adminUi';
import { auditActionLabel, auditDetails, isSignInAction } from './audit-actions';
import { EnrichmentAuditScore } from './EnrichmentAuditScore';

type AuditFilter = 'all' | 'changes';

export function AuditPage() {
  const audit = useAudit();
  const users = useUsers();
  const { t } = useTranslation(['admin', 'common']);
  const filterLabelId = useId();
  const [filter, setFilter] = useState<AuditFilter>('all');
  const byId = new Map<number, User>((users.data ?? []).map((u) => [u.id, u]));
  const userName = (id: number) => byId.get(id)?.displayName;
  const person = (e: AuditEntry) =>
    e.userId == null
      ? t('audit.system')
      : (userName(e.userId) ?? t('audit.userNumber', { id: e.userId }));
  // An AI assistant's change is shown under its access token's name, with the token's owner below.
  const who = (e: AuditEntry) =>
    e.meta.via === 'mcp' ? (
      <span className="flex flex-col">
        <span className="flex items-start gap-1.5 font-medium">
          <KeyRound aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
          <span className="break-words">{e.apiToken?.name ?? t('audit.aiAssistantToken')}</span>
        </span>
        {/* The prefix tells apart tokens given the same name, as the token list does. */}
        <span className="text-xs text-muted-foreground">
          {t('audit.tokenOwner', { name: person(e) })}
          {e.apiToken && <span className="block font-mono">{e.apiToken.prefix}…</span>}
        </span>
      </span>
    ) : (
      person(e)
    );
  const details = (e: AuditEntry) =>
    auditDetails(
      e.action === 'customer.enrichment_update'
        ? Object.fromEntries(Object.entries(e.meta).filter(([key]) => key !== 'enrichment'))
        : e.meta,
      t,
      userName,
    );

  const loaded = audit.data?.pages.flatMap((p) => p.entries) ?? [];
  const entries = filter === 'all' ? loaded : loaded.filter((e) => !isSignInAction(e.action));
  const hidden = loaded.length - entries.length;

  const columns: Column<AuditEntry>[] = [
    {
      key: 'time',
      header: t('audit.columns.time'),
      className: 'md:w-44 whitespace-nowrap text-muted-foreground',
      cell: (e) => formatDateTime(e.at),
    },
    { key: 'who', header: t('audit.columns.who'), className: 'md:w-36', cell: (e) => who(e) },
    {
      key: 'action',
      header: t('audit.columns.action'),
      // Wrap between words, never inside one (the table cell otherwise breaks anywhere).
      className: 'md:w-48 [overflow-wrap:break-word]',
      cell: (e) => (
        <span title={e.action} className="break-words font-medium">
          {e.action === 'customer.enrichment_update'
            ? t('mockEnrichment.action')
            : auditActionLabel(e.action, t)}
        </span>
      ),
    },
    {
      key: 'details',
      header: t('audit.columns.details'),
      hideOnMobileFor: (e) => details(e) === '',
      cell: (e) =>
        e.action === 'customer.enrichment_update' ? (
          <div className="flex flex-col items-start">
            <span className="break-words text-muted-foreground">{details(e)}</span>
            <EnrichmentAuditScore entry={e} />
          </div>
        ) : (
          <span className="break-words text-muted-foreground">{details(e)}</span>
        ),
    },
    {
      key: 'ip',
      header: t('audit.columns.ip'),
      className: 'md:w-32',
      hideOnMobileFor: (e) => e.action === 'customer.enrichment_update' && e.ip == null,
      cell: (e) => <span className="font-mono text-xs text-muted-foreground">{e.ip ?? ''}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('audit.title')}
        description={t('audit.description')}
        actions={
          <Button asChild variant="outline" size="touch" className="md:min-h-9">
            <a href="/api/logs/download">
              <Download aria-hidden />
              {t('audit.download')}
            </a>
          </Button>
        }
      />

      {audit.isPending ? (
        <ListSkeleton rows={6} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span id={filterLabelId} className="text-sm text-muted-foreground">
              {t('audit.filterLabel')}
            </span>
            <SegmentedControl
              aria-labelledby={filterLabelId}
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: 'all', label: t('audit.filterAll') },
                { value: 'changes', label: t('audit.filterChanges') },
              ]}
            />
            {hidden > 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('audit.hiddenSignIns', { count: hidden })}
              </p>
            )}
          </div>
          <ResponsiveTable
            rows={entries}
            columns={columns}
            rowKey={(e) => e.id}
            empty={<EmptyState title={t('audit.empty')} />}
          />
          {audit.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="touch"
                className="md:min-h-9"
                onClick={() => void audit.fetchNextPage()}
                disabled={audit.isFetchingNextPage}
              >
                <Pending show={audit.isFetchingNextPage} />
                {t('audit.loadOlder')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

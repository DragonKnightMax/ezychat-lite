import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CircleAlert, Link2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { SqlActivity, SqlCustomerRow } from '@ezychat/shared';
import { ApiError, errorMessage } from '../../api/client';
import { useSqlActivity, useSqlCustomers, useSqlDebtors, useSqlLink } from '../../api/sql-account';
import { encodeJid } from '../../lib/jid';
import { EmptyState, ResponsiveDialog } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatRelative } from '@/lib/format';
import { ErrorState, ListSkeleton } from '../adminUi';

/* ---------------- Customers ---------------- */

/** Under a chat: its SQL Account customer, or why it has none. */
function matchLine(
  r: SqlCustomerRow,
  t: (key: 'connectors.sql.cust.severalHint' | 'connectors.sql.cust.noneHint') => string,
) {
  if (r.code) return [r.code, r.sqlName].filter(Boolean).join(' · ');
  return t(
    r.kind === 'several' ? 'connectors.sql.cust.severalHint' : 'connectors.sql.cust.noneHint',
  );
}

function MatchBadge({ row }: Readonly<{ row: SqlCustomerRow }>) {
  const { t } = useTranslation('admin');
  let variant: 'default' | 'outline' | 'secondary' = 'secondary';
  if (row.kind === 'linked' || row.kind === 'phone') variant = 'default';
  else if (row.kind === 'several') variant = 'outline';
  return (
    <Badge
      variant={variant}
      className={row.kind === 'several' ? 'border-warning text-warning' : undefined}
    >
      {t(`connectors.sql.cust.${row.kind}`)}
    </Badge>
  );
}

/** Customers tab: each direct chat and the SQL Account customer it is matched to. */
export function SqlCustomers() {
  const { t } = useTranslation('admin');
  const query = useSqlCustomers();
  const link = useSqlLink();
  const [linking, setLinking] = useState<SqlCustomerRow | null>(null);
  if (query.isPending) return <ListSkeleton rows={5} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const rows = query.data;
  if (rows.length === 0) return <EmptyState title={t('connectors.sql.cust.empty')} />;
  const unlink = (row: SqlCustomerRow) =>
    link.mutate(
      { jid: row.jid, code: null },
      {
        onSuccess: () => toast.success(t('connectors.sql.cust.unlinked')),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <Card className="gap-3" data-testid="sql-customers">
      <CardHeader>
        <CardTitle>
          <span className="inline-flex flex-wrap items-center gap-1">
            {t('connectors.sql.cust.title')} <InfoTip topic="sqlCustomerCode" />
          </span>
        </CardTitle>
        <CardDescription>{t('connectors.sql.cust.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {rows.map((r) => (
            <li
              key={r.jid}
              className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`sql-customer-${r.jid}`}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/chats/${encodeJid(r.jid)}`}
                    className="text-sm font-medium break-words underline-offset-4 hover:underline"
                  >
                    {r.name}
                  </Link>
                  <MatchBadge row={r} />
                </span>
                <span className="text-sm break-words text-muted-foreground">{matchLine(r, t)}</span>
              </span>
              <span className="flex shrink-0 flex-wrap gap-2">
                <Button size="touch" variant="outline" onClick={() => setLinking(r)}>
                  <Link2 aria-hidden />
                  {r.kind === 'linked'
                    ? t('connectors.sql.cust.change')
                    : t('connectors.sql.cust.link')}
                </Button>
                {r.kind === 'linked' && (
                  <Button
                    size="touch"
                    variant="ghost"
                    disabled={link.isPending}
                    onClick={() => unlink(r)}
                  >
                    {t('connectors.sql.cust.unlink')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
      {linking && <LinkDialog row={linking} onClose={() => setLinking(null)} />}
    </Card>
  );
}

/** Waits until the admin stops typing: every search is a request to SQL Account. */
function useDebounced(value: string, ms = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Search SQL Account's customers by code or company name and link one to the chat. */
function LinkDialog({ row, onClose }: Readonly<{ row: SqlCustomerRow; onClose: () => void }>) {
  const { t } = useTranslation('admin');
  const [q, setQ] = useState('');
  const search = useDebounced(q.trim());
  const debtors = useSqlDebtors(search);
  const link = useSqlLink();
  const [error, setError] = useState<string | null>(null);
  const pick = (code: string) => {
    setError(null);
    link.mutate(
      { jid: row.jid, code },
      {
        onSuccess: () => {
          toast.success(t('connectors.sql.cust.linkedToast', { code }));
          onClose();
        },
        onError: (e) =>
          setError(
            e instanceof ApiError && e.code === 'unknown_code'
              ? t('connectors.sql.cust.unknownCode')
              : errorMessage(e),
          ),
      },
    );
  };
  const unavailable = debtors.error instanceof ApiError && debtors.error.status === 503;
  const results = () => {
    if (debtors.isPending)
      return <p className="text-sm text-muted-foreground">{t('connectors.sql.cust.searching')}</p>;
    if (debtors.error)
      return (
        <p className="text-sm text-muted-foreground">
          {unavailable ? t('connectors.sql.cust.notConnected') : errorMessage(debtors.error)}
        </p>
      );
    return (
      <ul className="flex flex-col divide-y rounded-lg border">
        {debtors.data.map((d) => (
          <li key={d.code} className="flex items-center justify-between gap-3 p-3">
            <span className="flex min-w-0 flex-col">
              <span className="font-mono text-sm break-all">{d.code}</span>
              <span className="text-sm break-words text-muted-foreground">{d.name}</span>
            </span>
            <Button
              size="touch"
              className="shrink-0"
              disabled={link.isPending}
              aria-label={`${t('connectors.sql.cust.pick')} ${d.code}`}
              onClick={() => pick(d.code)}
            >
              {t('connectors.sql.cust.pick')}
            </Button>
          </li>
        ))}
        {debtors.data.length === 0 && (
          <li className="p-3 text-sm text-muted-foreground">{t('connectors.sql.cust.noDebtor')}</li>
        )}
      </ul>
    );
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('connectors.sql.cust.linkTitle', { name: row.name })}
      description={t('connectors.sql.cust.linkHint')}
    >
      <div className="flex flex-col gap-3 pb-4 sm:pb-0" data-testid="sql-link-dialog">
        <Input
          type="search"
          value={q}
          aria-label={t('connectors.sql.cust.search')}
          placeholder={t('connectors.sql.cust.search')}
          onChange={(e) => setQ(e.target.value)}
          className="min-h-11"
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {results()}
      </div>
    </ResponsiveDialog>
  );
}

/* ---------------- Activity ---------------- */

/** The reasons the server records (tools.ts refusals and SqlError kinds); others show as sent. */
const KNOWN_REASONS = [
  'no_customer',
  'several',
  'not_own',
  'object_off',
  'item_not_looked_up',
  'qty_not_from_customer',
  'no_price',
  'no_draft',
  'draft_expired',
  'limit_chat',
  'limit_agent',
  'not_confirmed',
  'no_dns',
  'unreachable',
  'private_ip',
  'bad_keys',
  'old_version',
  'unexpected',
  'other',
] as const;
type KnownReason = (typeof KNOWN_REASONS)[number];
const isKnownReason = (reason: string): reason is KnownReason =>
  (KNOWN_REASONS as readonly string[]).includes(reason);

/** Activity tab: what the AI did with SQL Account (who and when, never amounts or documents). */
export function SqlActivityList() {
  const { t } = useTranslation('admin');
  const query = useSqlActivity();
  if (query.isPending) return <ListSkeleton rows={4} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const rows = query.data;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('connectors.activityEmpty')}
        description={t('connectors.sql.act.hint')}
      />
    );
  const reason = (r: SqlActivity) => {
    if (!r.reason) return null;
    return isKnownReason(r.reason) ? t(`connectors.sql.act.reason.${r.reason}`) : r.reason;
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('connectors.activityTitle')}</CardTitle>
        <CardDescription>{t('connectors.sql.act.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y" data-testid="sql-activity">
          {rows.map((r) => {
            const chat = r.chatName ?? t('connectors.sql.act.noChat');
            const why = reason(r);
            return (
              <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0">
                {r.result === 'done' ? (
                  <ShieldCheck
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                ) : (
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm break-words">
                    {t(`connectors.sql.act.${r.tool}`, {
                      agent: r.agentName ?? t('connectors.sql.act.someone'),
                    })}{' '}
                    {r.chatJid ? (
                      <Link
                        to={`/chats/${encodeJid(r.chatJid)}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {chat}
                      </Link>
                    ) : (
                      chat
                    )}
                    {r.dockey !== null &&
                      ` · ${t('connectors.sql.act.dockey', { dockey: r.dockey })}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[t(`connectors.sql.act.result.${r.result}`), why, formatRelative(r.at)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

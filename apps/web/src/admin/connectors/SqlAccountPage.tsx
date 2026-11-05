import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { FileText, PackageSearch, Receipt, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import {
  sqlHostFromKey,
  type ConnectorEntry,
  type SqlAccountProblem,
  type SqlAccountState,
  type SqlAccountStatus,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import { useSqlAccount, useSqlConnect, useSqlDisconnect, useSqlTest } from '../../api/sql-account';
import { Banner } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';
import { ConfirmDialog, ErrorState, ListSkeleton } from '../adminUi';
import { ConnectorNotice } from './connector-ui';
import { SqlActivityList, SqlCustomers } from './SqlAccountCustomers';
import { SqlAgentsSettings, SqlMatchCard } from './SqlAccountSettings';

/** The form of an access key (not a real key; the same in every language). */
const KEY_EXAMPLE = '13fcdacdc0429dc2f8fa47dddf97c393.sql.my/APIUSER';

const SQL_TABS = ['overview', 'connection', 'settings', 'customers', 'activity'] as const;
type SqlTab = (typeof SQL_TABS)[number];

const PROBLEMS: readonly SqlAccountProblem[] = [
  'no_dns',
  'unreachable',
  'private_ip',
  'bad_keys',
  'old_version',
  'unexpected',
];

/** A state that is neither connected nor disconnected: what went wrong. */
export function sqlProblem(state: SqlAccountState | null | undefined): SqlAccountProblem | null {
  return PROBLEMS.find((p) => p === state) ?? null;
}

/**
 * `/admin/connectors/sql-account` (design docs/features/sql-accounting/design.md): built into the
 * app. Works only with SQL Account's API service (API Link); each AI agent's access is chosen per
 * SQL Account object (Off / Read / Read + create). Tabs: Overview, Connection, Settings, Customers,
 * Activity (`?tab=`, `&agent=`).
 */
export function SqlAccountTabs({ entry }: Readonly<{ entry: ConnectorEntry | null }>) {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();
  const query = useSqlAccount();
  const tabParam = params.get('tab');
  const tab: SqlTab = (SQL_TABS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as SqlTab)
    : 'overview';
  const setTab = (next: string) =>
    setParams(
      (p) => {
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  if (query.isPending) return <ListSkeleton rows={4} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const status = query.data;
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
        <TabsList variant="line" className="w-max justify-start">
          {SQL_TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="min-h-11 flex-none px-3 md:min-h-9">
              {t(`connectors.sql.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="overview" className="flex flex-col gap-4">
        <Overview status={status} onConnect={() => setTab('connection')} />
        <ConnectorNotice entry={entry} />
      </TabsContent>
      <TabsContent value="connection" className="flex flex-col gap-4">
        <Connection status={status} />
      </TabsContent>
      <TabsContent value="settings" className="flex flex-col gap-4">
        {status.state === 'disconnected' && (
          <Banner tone="info" title={t('connectors.sql.settings.notConnected')} />
        )}
        <SqlAgentsSettings />
        <SqlMatchCard status={status} />
      </TabsContent>
      <TabsContent value="customers" className="flex flex-col gap-4">
        <SqlCustomers />
      </TabsContent>
      <TabsContent value="activity" className="flex flex-col gap-4">
        <SqlActivityList />
      </TabsContent>
    </Tabs>
  );
}

/* ---------------- Overview ---------------- */

/** "Works only with SQL Account's API service": what the company needs before connecting. */
function Requirements() {
  const { t } = useTranslation('admin');
  return (
    <Banner tone="info" title={t('connectors.sql.req.title')}>
      <span className="flex flex-col gap-2" data-testid="sql-requirements">
        <span>{t('connectors.sql.req.body')}</span>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>{t('connectors.sql.req.version')}</li>
          <li>
            <span className="inline-flex flex-wrap items-center gap-1">
              {t('connectors.sql.req.service')} <InfoTip topic="sqlApiService" />
            </span>
          </li>
          <li>{t('connectors.sql.req.port')}</li>
          <li>{t('connectors.sql.req.user')}</li>
        </ul>
        <span>{t('connectors.sql.req.cloud')}</span>
        <span className="text-muted-foreground">{t('connectors.sql.req.dealer')}</span>
      </span>
    </Banner>
  );
}

const CAN = [
  [PackageSearch, 'stock'],
  [Wallet, 'account'],
  [FileText, 'documents'],
  [Receipt, 'quotation'],
] as const;

function Overview({
  status,
  onConnect,
}: Readonly<{ status: SqlAccountStatus; onConnect: () => void }>) {
  const { t } = useTranslation('admin');
  return (
    <>
      <Card className="gap-3">
        <CardHeader>
          <CardTitle>{t('connectors.aboutTitle')}</CardTitle>
          <CardDescription>{t('connectors.sql.about')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2 text-sm">
            {CAN.map(([Icon, key]) => (
              <li key={key} className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>{t(`connectors.sql.can.${key}`)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{t('connectors.sql.ownOnly')}</p>
          {status.state === 'disconnected' && (
            <Button size="touch" className="self-start" onClick={onConnect}>
              {t('connectors.sql.conn.connect')}
            </Button>
          )}
        </CardContent>
      </Card>
      <Requirements />
      <Card className="gap-3">
        <CardHeader>
          <CardTitle>{t('connectors.privacyTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>{t('connectors.sql.privacy1')}</p>
          <p>{t('connectors.sql.privacy2')}</p>
        </CardContent>
      </Card>
    </>
  );
}

/* ---------------- Connection ---------------- */

function ProblemBanner({ state }: Readonly<{ state: SqlAccountProblem }>) {
  const { t } = useTranslation('admin');
  return (
    <Banner
      tone={state === 'bad_keys' ? 'danger' : 'warning'}
      title={t(`connectors.sql.state.${state}.title`)}
    >
      <span data-testid={`sql-problem-${state}`}>{t(`connectors.sql.state.${state}.body`)}</span>
    </Banner>
  );
}

function Connection({ status }: Readonly<{ status: SqlAccountStatus }>) {
  return status.state === 'disconnected' ? (
    <>
      <Requirements />
      <ConnectForm />
    </>
  ) : (
    <ConnectedCard status={status} />
  );
}

/** Access key + secret key; the address is derived from the access key. */
function ConnectForm() {
  const { t } = useTranslation('admin');
  const connect = useSqlConnect();
  const ids = { access: useId(), secret: useId() };
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [failed, setFailed] = useState<SqlAccountProblem | 'key_format' | null>(null);
  const host = sqlHostFromKey(accessKey);
  const submit = () =>
    connect.mutate(
      { accessKey: accessKey.trim(), secretKey },
      {
        onSuccess: (result) => {
          if (result.ok) {
            setFailed(null);
            setSecretKey('');
            toast.success(t('connectors.sql.conn.connected'));
          } else
            setFailed(
              result.error === 'key_format'
                ? 'key_format'
                : (sqlProblem(result.error) ?? 'unexpected'),
            );
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <Card data-testid="sql-connect-form">
      <CardHeader>
        <CardTitle>{t('connectors.sql.conn.title')}</CardTitle>
        <CardDescription>
          <span className="inline-flex flex-wrap items-center gap-1">
            {t('connectors.sql.conn.hint')} <InfoTip topic="sqlKeys" />
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {failed && failed !== 'key_format' && <ProblemBanner state={failed} />}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.access}>{t('connectors.sql.conn.accessKey')}</Label>
            <Input
              id={ids.access}
              value={accessKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={KEY_EXAMPLE}
              onChange={(e) => setAccessKey(e.target.value)}
              aria-invalid={failed === 'key_format'}
              aria-describedby={`${ids.access}-hint`}
              className="min-h-11 font-mono text-sm"
            />
            <p
              id={`${ids.access}-hint`}
              className={
                failed === 'key_format' ? 'text-sm text-danger' : 'text-sm text-muted-foreground'
              }
            >
              {failed === 'key_format'
                ? t('connectors.sql.conn.keyFormat')
                : t('connectors.sql.conn.accessHint')}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.secret}>{t('connectors.sql.conn.secretKey')}</Label>
            <Input
              id={ids.secret}
              type="password"
              value={secretKey}
              autoComplete="off"
              onChange={(e) => setSecretKey(e.target.value)}
              className="min-h-11"
            />
          </div>
          <p className="text-sm break-all text-muted-foreground" data-testid="sql-host">
            {t('connectors.sql.conn.host')}{' '}
            <span className="font-mono">
              {host ? `https://${host}` : t('connectors.sql.conn.hostFromKey')}
            </span>
          </p>
          <Button
            type="submit"
            size="touch"
            className="self-start"
            disabled={!accessKey.trim() || !secretKey || connect.isPending}
          >
            {connect.isPending
              ? t('connectors.sql.conn.testing')
              : t('connectors.sql.conn.connectTest')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Saved keys: the state (working or the problem), the details, Test connection and Disconnect. */
function ConnectedCard({ status }: Readonly<{ status: SqlAccountStatus }>) {
  const { t } = useTranslation('admin');
  const test = useSqlTest();
  const disconnect = useSqlDisconnect();
  const [confirm, setConfirm] = useState(false);
  const problem = sqlProblem(status.state);
  return (
    <Card data-testid="sql-connection">
      <CardHeader>
        <CardTitle>{t('connectors.sql.conn.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {problem ? (
          <ProblemBanner state={problem} />
        ) : (
          <Banner tone="info" title={t('connectors.sql.conn.okTitle')}>
            {t('connectors.sql.conn.okBody')}
          </Banner>
        )}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr] sm:gap-y-2">
          <dt className="text-muted-foreground">{t('connectors.sql.conn.host')}</dt>
          <dd className="font-mono break-all">{status.host ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('connectors.sql.conn.accessKey')}</dt>
          <dd className="font-mono break-all">{status.keyEnd ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('connectors.sql.conn.checked')}</dt>
          <dd>{status.checkedAt ? formatRelative(status.checkedAt) : '—'}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            size="touch"
            variant="outline"
            disabled={test.isPending}
            onClick={() =>
              test.mutate(undefined, {
                onSuccess: (next) => {
                  if (next.state === 'connected') toast.success(t('connectors.sql.conn.testOk'));
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            {test.isPending ? t('connectors.sql.conn.testing') : t('connectors.sql.conn.test')}
          </Button>
          <Button size="touch" variant="ghost" onClick={() => setConfirm(true)}>
            {t('connectors.sql.conn.disconnect')}
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirm}
        danger
        loading={disconnect.isPending}
        error={disconnect.error}
        title={t('connectors.sql.conn.disconnectTitle')}
        confirmLabel={t('connectors.sql.conn.disconnect')}
        onClose={() => setConfirm(false)}
        onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setConfirm(false) })}
      >
        {t('connectors.sql.conn.disconnectBody')}
      </ConfirmDialog>
    </Card>
  );
}

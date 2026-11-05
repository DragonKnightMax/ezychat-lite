import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Bot,
  CircleAlert,
  FileText,
  Link2,
  PackageSearch,
  Receipt,
  ShieldCheck,
  UserRound,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Banner, EmptyState, ResponsiveDialog, SegmentedControl } from '@/components/app';
import { InfoTip } from '@/components/app/InfoTip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';
import { encodeJid } from '@/lib/jid';
import {
  useSqlAccount,
  useSqlAction,
  useSqlActivity,
  useSqlCustomers,
  useSqlDebtors,
  useSqlTry,
  type SqlAccess,
  type SqlAccountView,
  type SqlAgentSettings,
  type SqlCustomerRow,
  type SqlObject,
  type SqlQuestion,
  type SqlScenario,
  type SqlTryResult,
} from '@/mock/sqlAccount';
import { useShownAgents } from '@/mock/useAgents';
import { ConfirmDialog, ListSkeleton } from './adminUi';
import { ConnectorIcon, ConnectorStatusBadge } from './ConnectorsGalleryPage';
import { AgentSettings, ConnectorBreadcrumb } from './ConnectorDetailPage';

/** Mock: catalog keys are built from ids here (the app types them per key). */
function useT() {
  const { t } = useTranslation('admin');
  return t as unknown as (key: string, options?: Record<string, unknown>) => string;
}

const TABS = ['overview', 'connection', 'settings', 'customers', 'activity'] as const;
type Tab = (typeof TABS)[number];
const PROBLEMS: readonly SqlScenario[] = [
  'no_dns',
  'unreachable',
  'private_ip',
  'bad_keys',
  'old_version',
];

/**
 * Proposed (sql-accounting): `/admin/connectors/sql-account`. Built into EzyChat (Lite and
 * Enterprise). Works only with SQL Account's API service (API Link); the AI's access is chosen per
 * object (Off / Read / Read + create) for each AI agent. Design: docs/features/sql-accounting/design.md.
 */
export function SqlAccountPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const query = useSqlAccount();
  const data = query.data;
  const tabParam = params.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'overview';
  const setTab = (next: string) =>
    setParams(
      (p) => {
        p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  const status =
    data?.state === 'connected'
      ? 'connected'
      : data && data.state !== 'disconnected'
        ? 'attention'
        : 'notConnected';
  return (
    <div className="flex flex-col gap-4" data-testid="connector-page-sql-account">
      <ConnectorBreadcrumb name="SQL Account" />
      <div className="flex items-start gap-4">
        <ConnectorIcon c={{ icon: Receipt }} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words">SQL Account</h1>
            <ConnectorStatusBadge status={status} />
            <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('mockConnectors.byCore')} · {t('mockConnectors.category.accounting')}
          </p>
        </div>
      </div>
      {query.isPending && <ListSkeleton rows={4} />}
      {data && (
        <Tabs value={tab} onValueChange={setTab}>
          <div className="-mx-4 scroll-px-4 overflow-x-auto px-4 pb-1">
            <TabsList variant="line" className="w-max justify-start">
              {TABS.map((id) => (
                <TabsTrigger key={id} value={id} className="min-h-11 flex-none px-3 md:min-h-9">
                  {t(`mockSql.tabs.${id}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="overview" className="flex flex-col gap-4">
            <Overview view={data} onConnect={() => setTab('connection')} />
          </TabsContent>
          <TabsContent value="connection" className="flex flex-col gap-4">
            <Connection view={data} />
          </TabsContent>
          <TabsContent value="settings" className="flex flex-col gap-4">
            {data.state === 'disconnected' && (
              <Banner tone="info" title={t('mockSql.settings.notConnected')} />
            )}
            <AgentSettings
              render={(agent) => <AgentAccess key={agent.id} view={data} agent={agent} />}
            />
            <MatchCard view={data} />
          </TabsContent>
          <TabsContent value="customers" className="flex flex-col gap-4">
            <Customers />
          </TabsContent>
          <TabsContent value="activity" className="flex flex-col gap-4">
            <Activity />
          </TabsContent>
        </Tabs>
      )}
      {data && <SqlMockControls view={data} />}
    </div>
  );
}

/* ---------------- Overview ---------------- */

function Requirements() {
  const t = useT();
  return (
    <Banner tone="info" title={t('mockSql.req.title')}>
      <span className="flex flex-col gap-2">
        <span>{t('mockSql.req.body')}</span>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>{t('mockSql.req.version')}</li>
          <li className="flex flex-wrap items-center gap-1">
            {t('mockSql.req.service')} <InfoTip topic="sqlApiService" />
          </li>
          <li>{t('mockSql.req.port')}</li>
          <li>{t('mockSql.req.user')}</li>
        </ul>
        <span className="text-muted-foreground">{t('mockSql.req.dealer')}</span>
      </span>
    </Banner>
  );
}

function Overview({ view, onConnect }: { view: SqlAccountView; onConnect: () => void }) {
  const t = useT();
  return (
    <>
      <Card className="gap-3">
        <CardHeader>
          <CardTitle>{t('mockConnectors.aboutTitle')}</CardTitle>
          <CardDescription>{t('mockSql.about')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2 text-sm">
            {[
              [PackageSearch, 'stock'],
              [Wallet, 'account'],
              [FileText, 'documents'],
              [Receipt, 'quotation'],
            ].map(([Icon, key]) => {
              const I = Icon as typeof Receipt;
              return (
                <li key={key as string} className="flex items-start gap-2">
                  <I className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>{t(`mockSql.can.${key as string}`)}</span>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-muted-foreground">{t('mockSql.ownOnly')}</p>
          {view.state === 'disconnected' && (
            <Button size="touch" className="self-start" onClick={onConnect}>
              {t('mockSql.conn.connect')}
            </Button>
          )}
        </CardContent>
      </Card>
      <Requirements />
      <Card className="gap-3">
        <CardHeader>
          <CardTitle>{t('mockConnectors.privacyTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>{t('mockSql.privacy1')}</p>
          <p>{t('mockSql.privacy2')}</p>
        </CardContent>
      </Card>
    </>
  );
}

/* ---------------- Connection ---------------- */

function ProblemBanner({ state }: { state: SqlScenario }) {
  const t = useT();
  return (
    <Banner
      tone={state === 'bad_keys' ? 'danger' : 'warning'}
      title={t(`mockSql.state.${state}.title`)}
    >
      {t(`mockSql.state.${state}.body`)}
    </Banner>
  );
}

function Connection({ view }: { view: SqlAccountView }) {
  const t = useT();
  const action = useSqlAction();
  const ids = { access: useId(), secret: useId() };
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [failed, setFailed] = useState<SqlScenario | 'key_format' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const derived = /^([0-9a-f]{32})\.sql\.my\//.exec(accessKey.trim());
  const connect = () =>
    action.mutate(
      { kind: 'connect', accessKey, secretKey },
      {
        onSuccess: (r) => {
          const res = r as { ok: boolean; error?: SqlScenario | 'key_format' };
          if (res.ok) {
            setFailed(null);
            setSecretKey('');
            toast.success(t('mockSql.conn.connected'));
          } else setFailed(res.error ?? null);
        },
      },
    );
  if (view.state === 'disconnected')
    return (
      <>
        <Requirements />
        <Card data-testid="sql-connect-form">
          <CardHeader>
            <CardTitle>{t('mockSql.conn.title')}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-1">
              {t('mockSql.conn.hint')} <InfoTip topic="sqlKeys" />
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {failed && failed !== 'key_format' && <ProblemBanner state={failed} />}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.access}>{t('mockSql.conn.accessKey')}</Label>
              <Input
                id={ids.access}
                value={accessKey}
                autoComplete="off"
                spellCheck={false}
                placeholder="13fcdacdc0429dc2f8fa47dddf97c393.sql.my/APIUSER"
                onChange={(e) => setAccessKey(e.target.value)}
                aria-invalid={failed === 'key_format'}
                className="min-h-11 font-mono text-sm"
              />
              {failed === 'key_format' ? (
                <p className="text-sm text-danger">{t('mockSql.conn.keyFormat')}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('mockSql.conn.accessHint')}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.secret}>{t('mockSql.conn.secretKey')}</Label>
              <Input
                id={ids.secret}
                type="password"
                value={secretKey}
                autoComplete="off"
                onChange={(e) => setSecretKey(e.target.value)}
                className="min-h-11"
              />
            </div>
            <p className="text-sm text-muted-foreground break-all">
              {t('mockSql.conn.host')}{' '}
              <span className="font-mono">
                {derived ? `https://${derived[1]}.sql.my` : t('mockSql.conn.hostFromKey')}
              </span>
            </p>
            <Button
              size="touch"
              className="self-start"
              disabled={!accessKey.trim() || !secretKey || action.isPending}
              onClick={connect}
            >
              {action.isPending ? t('mockSql.conn.testing') : t('mockSql.conn.connectTest')}
            </Button>
          </CardContent>
        </Card>
      </>
    );
  const problem = view.state !== 'connected' ? (view.state as SqlScenario) : null;
  return (
    <Card data-testid="sql-connection">
      <CardHeader>
        <CardTitle>{t('mockSql.conn.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {problem ? (
          <ProblemBanner state={problem} />
        ) : (
          <Banner tone="info" title={t('mockSql.conn.okTitle')}>
            {t('mockSql.conn.okBody')}
          </Banner>
        )}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">{t('mockSql.conn.host')}</dt>
          <dd className="font-mono break-all">{view.host}</dd>
          <dt className="text-muted-foreground">{t('mockSql.conn.accessKey')}</dt>
          <dd className="font-mono">{view.keyEnd}</dd>
          {view.version && (
            <>
              <dt className="text-muted-foreground">{t('mockSql.conn.version')}</dt>
              <dd>{view.version}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('mockSql.conn.checked')}</dt>
          <dd>{view.checkedAt ? formatRelative(view.checkedAt) : '—'}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            size="touch"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate({ kind: 'test' })}
          >
            {t('mockSql.conn.test')}
          </Button>
          <Button size="touch" variant="ghost" onClick={() => setConfirm(true)}>
            {t('mockSql.conn.disconnect')}
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirm}
        danger
        title={t('mockSql.conn.disconnectTitle')}
        confirmLabel={t('mockSql.conn.disconnect')}
        onClose={() => setConfirm(false)}
        onConfirm={() =>
          action.mutate({ kind: 'disconnect' }, { onSuccess: () => setConfirm(false) })
        }
      >
        {t('mockSql.conn.disconnectBody')}
      </ConfirmDialog>
    </Card>
  );
}

/* ---------------- Settings: access per object ---------------- */

function AgentAccess({
  view,
  agent,
}: {
  view: SqlAccountView;
  agent: { id: string; name: string };
}) {
  const t = useT();
  const action = useSqlAction();
  const saved = view.agents[agent.id] ?? view.defaults;
  const [draft, setDraft] = useState<SqlAgentSettings>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const accessOf = (o: SqlObject): SqlAccess => draft.access[o.id] ?? o.def;
  const set = (o: SqlObject, v: SqlAccess) =>
    setDraft((d) => ({ ...d, access: { ...d.access, [o.id]: v } }));
  const quotation = draft.access.salesquotation === 'create';
  const stockOn = (draft.access.stockitem ?? 'read') !== 'off';
  return (
    <Card data-testid="sql-agent-access">
      <CardHeader>
        <CardTitle>{t('mockSql.access.title', { agent: agent.name })}</CardTitle>
        <CardDescription>{t('mockSql.access.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y rounded-lg border">
          {view.objects.map((o) => {
            const labelId = `sql-obj-${o.id}`;
            return (
              <li
                key={o.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid={`sql-object-${o.id}`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span id={labelId} className="text-sm font-medium">
                      {t(`mockSql.obj.${o.id}.name`)}
                    </span>
                    <Badge variant="secondary">
                      {t(o.scope === 'own' ? 'mockSql.access.own' : 'mockSql.access.everyone')}
                    </Badge>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`mockSql.obj.${o.id}.sees`)}
                  </span>
                </span>
                <SegmentedControl<SqlAccess>
                  size="sm"
                  aria-labelledby={labelId}
                  value={accessOf(o)}
                  onValueChange={(v) => set(o, v)}
                  options={[
                    { value: 'off', label: t('mockSql.access.off') },
                    { value: 'read', label: t('mockSql.access.read') },
                    ...(o.create
                      ? [{ value: 'create' as const, label: t('mockSql.access.create') }]
                      : []),
                  ]}
                />
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-muted-foreground">{t('mockSql.access.never')}</p>
        {quotation && (
          <Banner tone="warning" title={t('mockSql.guard.title')}>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {['confirm', 'items', 'price', 'limit', 'never'].map((k) => (
                <li key={k}>{t(`mockSql.guard.${k}`)}</li>
              ))}
            </ul>
          </Banner>
        )}
        {stockOn && (
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`sql-price-${agent.id}`}>{t('mockSql.access.showPrice')}</Label>
              <Switch
                id={`sql-price-${agent.id}`}
                checked={draft.showPrice}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, showPrice: v }))}
              />
            </div>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span id={`sql-stock-${agent.id}`} className="text-sm font-medium">
                {t('mockSql.access.stockShown')}
              </span>
              <SegmentedControl<'inStock' | 'quantity'>
                size="sm"
                aria-labelledby={`sql-stock-${agent.id}`}
                value={draft.stockDetail}
                onValueChange={(v) => setDraft((d) => ({ ...d, stockDetail: v }))}
                options={[
                  { value: 'inStock', label: t('mockSql.access.inStock') },
                  { value: 'quantity', label: t('mockSql.access.quantity') },
                ]}
              />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="touch"
            disabled={!dirty || action.isPending}
            onClick={() =>
              action.mutate(
                { kind: 'agent', agentId: agent.id, settings: draft },
                { onSuccess: () => toast.success(t('mockSql.access.saved')) },
              )
            }
          >
            {t('mockSql.access.save')}
          </Button>
          {dirty && (
            <Button size="touch" variant="ghost" onClick={() => setDraft(saved)}>
              {t('mockSql.access.discard')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MatchCard({ view }: { view: SqlAccountView }) {
  const t = useT();
  const action = useSqlAction();
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockSql.match.title')}</CardTitle>
        <CardDescription>{t('mockSql.match.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li>{t('mockSql.match.rule1')}</li>
          <li>{t('mockSql.match.rule2')}</li>
          <li>{t('mockSql.match.rule3')}</li>
        </ol>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <Label htmlFor="sql-match-phone">{t('mockSql.match.byPhone')}</Label>
          <Switch
            id="sql-match-phone"
            checked={view.matchByPhone}
            onCheckedChange={(v) => action.mutate({ kind: 'match', matchByPhone: v })}
          />
        </div>
        <p className="text-sm text-muted-foreground">{t('mockSql.match.never')}</p>
      </CardContent>
    </Card>
  );
}

/* ---------------- Customers ---------------- */

function MatchBadge({ row }: { row: SqlCustomerRow }) {
  const t = useT();
  const tone =
    row.kind === 'linked' || row.kind === 'phone'
      ? 'default'
      : row.kind === 'several'
        ? 'outline'
        : 'secondary';
  return (
    <Badge
      variant={tone}
      className={row.kind === 'several' ? 'border-warning text-warning' : undefined}
    >
      {t(`mockSql.cust.${row.kind}`)}
    </Badge>
  );
}

function Customers() {
  const t = useT();
  const query = useSqlCustomers();
  const action = useSqlAction();
  const [linking, setLinking] = useState<SqlCustomerRow | null>(null);
  if (query.isPending) return <ListSkeleton rows={5} />;
  const rows = query.data ?? [];
  if (!rows.length) return <EmptyState title={t('mockSql.cust.empty')} />;
  return (
    <Card className="gap-3" data-testid="sql-customers">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-1">
          {t('mockSql.cust.title')} <InfoTip topic="sqlCustomerCode" />
        </CardTitle>
        <CardDescription>{t('mockSql.cust.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {rows.map((r) => (
            <li
              key={r.jid}
              className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
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
                <span className="text-sm text-muted-foreground break-words">
                  {r.code
                    ? `${r.code} · ${r.sqlName}`
                    : t(
                        r.kind === 'several' ? 'mockSql.cust.severalHint' : 'mockSql.cust.noneHint',
                      )}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <Button size="touch" variant="outline" onClick={() => setLinking(r)}>
                  <Link2 aria-hidden />
                  {r.kind === 'linked' ? t('mockSql.cust.change') : t('mockSql.cust.link')}
                </Button>
                {r.kind === 'linked' && (
                  <Button
                    size="touch"
                    variant="ghost"
                    onClick={() => action.mutate({ kind: 'link', jid: r.jid, code: null })}
                  >
                    {t('mockSql.cust.unlink')}
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

function LinkDialog({ row, onClose }: { row: SqlCustomerRow; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const debtors = useSqlDebtors(q);
  const action = useSqlAction();
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('mockSql.cust.linkTitle', { name: row.name })}
      description={t('mockSql.cust.linkHint')}
    >
      <div className="flex flex-col gap-3">
        <Input
          value={q}
          autoFocus
          aria-label={t('mockSql.cust.search')}
          placeholder={t('mockSql.cust.search')}
          onChange={(e) => setQ(e.target.value)}
          className="min-h-11"
        />
        <ul className="flex flex-col divide-y rounded-lg border">
          {(debtors.data ?? []).map((d) => (
            <li key={d.code} className="flex items-center justify-between gap-3 p-3">
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-sm">{d.code}</span>
                <span className="text-sm text-muted-foreground break-words">{d.name}</span>
              </span>
              <Button
                size="touch"
                onClick={() =>
                  action.mutate(
                    { kind: 'link', jid: row.jid, code: d.code },
                    {
                      onSuccess: () => {
                        toast.success(t('mockSql.cust.linkedToast', { code: d.code }));
                        onClose();
                      },
                    },
                  )
                }
              >
                {t('mockSql.cust.pick')}
              </Button>
            </li>
          ))}
          {debtors.data?.length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">{t('mockSql.cust.noDebtor')}</li>
          )}
        </ul>
      </div>
    </ResponsiveDialog>
  );
}

/* ---------------- Activity ---------------- */

function Activity() {
  const t = useT();
  const query = useSqlActivity();
  const rows = query.data ?? [];
  if (query.isPending) return <ListSkeleton rows={4} />;
  if (!rows.length) return <EmptyState title={t('mockConnectors.activityEmpty')} />;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t('mockConnectors.activityTitle')}</CardTitle>
        <CardDescription>{t('mockSql.act.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {rows.map((r) => (
            <li key={`${r.at}-${r.tool}`} className="flex items-start gap-3 py-3 first:pt-0">
              {r.result === 'done' ? (
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              )}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm break-words">
                  {t(`mockSql.act.${r.tool}`, { agent: r.agent })}{' '}
                  <Link
                    to={`/chats/${encodeJid(r.chatJid)}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {r.customer}
                  </Link>
                  {r.dockey ? ` · ${t('mockSql.act.dockey', { dockey: r.dockey })}` : ''}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`mockSql.act.result.${r.result}`)}
                  {r.reason ? ` · ${t(`mockSql.act.reason.${r.reason}`)}` : ''} ·{' '}
                  {formatRelative(r.at)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------- Mock only ---------------- */

const QUESTIONS: readonly SqlQuestion[] = [
  'stock',
  'balance',
  'document',
  'otherDocument',
  'quotation',
  'confirm',
];

function SqlMockControls({ view }: { view: SqlAccountView }) {
  const t = useT();
  const action = useSqlAction();
  const run = useSqlTry();
  const customers = useSqlCustomers();
  const { shown } = useShownAgents();
  const ids = { scenario: useId(), chat: useId(), q: useId() };
  const [jid, setJid] = useState('60123110021@s.whatsapp.net');
  const [question, setQuestion] = useState<SqlQuestion>('balance');
  const [result, setResult] = useState<SqlTryResult | null>(null);
  const agent = shown[0];
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
      data-testid="sql-mock-controls"
    >
      <Badge variant="outline" className="self-start">
        {t('mockSuggest.mockControls')}
      </Badge>
      <div className="flex flex-col gap-2">
        <span id={ids.scenario} className="text-sm font-medium">
          {t('mockSql.mock.scenario')}
        </span>
        <Select
          value={view.scenario}
          onValueChange={(v) => action.mutate({ kind: 'scenario', scenario: v as SqlScenario })}
        >
          <SelectTrigger aria-labelledby={ids.scenario} className="min-h-11 w-full sm:w-96">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['ok', ...PROBLEMS] as SqlScenario[]).map((s) => (
              <SelectItem key={s} value={s}>
                {t(`mockSql.mock.s.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{t('mockSql.mock.scenarioHint')}</span>
      </div>
      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Bot className="size-4" aria-hidden />
          {t('mockSql.mock.tryTitle', { agent: agent?.name ?? 'AI' })}
        </span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex flex-col gap-1">
            <Label id={ids.chat}>{t('mockSql.mock.chat')}</Label>
            <Select value={jid} onValueChange={setJid}>
              <SelectTrigger aria-labelledby={ids.chat} className="min-h-11 w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(customers.data ?? []).map((c) => (
                  <SelectItem key={c.jid} value={c.jid}>
                    {c.name} · {t(`mockSql.cust.${c.kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label id={ids.q}>{t('mockSql.mock.question')}</Label>
            <Select value={question} onValueChange={(v) => setQuestion(v as SqlQuestion)}>
              <SelectTrigger aria-labelledby={ids.q} className="min-h-11 w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUESTIONS.map((q) => (
                  <SelectItem key={q} value={q}>
                    {t(`mockSql.mock.q.${q}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          size="touch"
          variant="outline"
          className="self-start"
          disabled={!agent || run.isPending}
          onClick={() =>
            agent &&
            run.mutate(
              { agentId: agent.id, agentName: agent.name, jid, question },
              { onSuccess: setResult },
            )
          }
        >
          {t('mockSql.mock.run')}
        </Button>
        {result && (
          <div
            className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 text-sm"
            data-testid="sql-try-result"
          >
            <span className="text-muted-foreground">“{t(`mockSql.mock.q.${question}`)}”</span>
            {result.outcome === 'answer' ? (
              <>
                <span className="flex flex-wrap gap-1">
                  {result.tools.map((tool) => (
                    <Badge key={tool} variant="secondary" className="font-mono">
                      {tool}
                    </Badge>
                  ))}
                  {result.match && (
                    <Badge variant="outline">
                      {t(`mockSql.cust.${result.match.kind}`)} · {result.match.code}
                    </Badge>
                  )}
                </span>
                <span className="break-words">{result.reply}</span>
                {result.note && (
                  <span className="text-muted-foreground">
                    {t(`mockSql.mock.note.${result.note}`)}
                  </span>
                )}
              </>
            ) : (
              <span className="flex items-start gap-2">
                <UserRound className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="break-words">
                  {t('mockSql.mock.handover')} ·{' '}
                  {t(`mockSql.mock.why.${result.reason ?? 'no_customer'}`, {
                    object: result.object ? t(`mockSql.obj.${result.object}.name`) : '',
                  })}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

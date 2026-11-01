import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiToken } from '@ezychat/shared';
import {
  useApiTokens,
  useMcpSettings,
  useMe,
  usePatchMcpSettings,
  useRevokeApiToken,
} from '../api/queries';
import { errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { formatDate, formatRelative } from '@/lib/format';
import { ConfirmDialog, CopyButton, ErrorState, ListSkeleton } from './adminUi';
import { CreateTokenDialog } from './CreateTokenDialog';
import { TokenPermissionsDialog } from './TokenPermissionsDialog';
import { InfoTip } from '@/components/app/InfoTip';
import { LiteMcpNoticeCard } from '../lite-import/notice';

/** "Used 5 minutes ago" for recent use, a plain date after that. */
const RELATIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Base URL an assistant uses: the tunnel when one runs, else the server's loopback address on the
 * port it actually listens on (reported by the server, not the saved port setting).
 */
export function assistantBaseUrl(publicUrl: string | null, localUrl: string): string {
  return (publicUrl ?? localUrl).replace(/\/+$/, '');
}

/** Settings → Integrations: read-only AI assistant (MCP) access and its access tokens. */
export function IntegrationsSection() {
  const { t } = useTranslation('admin');
  const mcp = useMcpSettings();
  const patch = usePatchMcpSettings();
  const switchId = useId();
  const [createOpen, setCreateOpen] = useState(false);

  if (!mcp.data)
    return mcp.isError ? (
      <ErrorState error={mcp.error} onRetry={() => void mcp.refetch()} />
    ) : (
      <ListSkeleton rows={3} />
    );

  const { enabled, publicUrl, localUrl, endpointPath } = mcp.data;
  const endpoint = `${assistantBaseUrl(publicUrl, localUrl)}${endpointPath}`;

  return (
    <div className="flex flex-col gap-4">
      <LiteMcpNoticeCard />
      <Card className="gap-4">
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Label htmlFor={switchId} className="leading-normal">
                  {t('integrations.access.label')}
                </Label>
                <InfoTip topic="mcp" />
              </div>
              <p id={`${switchId}-desc`} className="mt-0.5 text-sm text-muted-foreground">
                {t('integrations.access.description')}
              </p>
            </div>
            {/* The padded label makes the whole 44px target toggle the switch. */}
            <Label
              htmlFor={switchId}
              className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
            >
              <Switch
                id={switchId}
                aria-describedby={`${switchId}-desc`}
                checked={enabled}
                disabled={patch.isPending}
                onCheckedChange={(next) =>
                  patch.mutate(
                    { enabled: next },
                    {
                      onSuccess: (r) =>
                        toast.success(
                          r.enabled
                            ? t('integrations.access.turnedOn')
                            : t('integrations.access.turnedOff'),
                        ),
                    },
                  )
                }
              />
            </Label>
          </div>
          {enabled && (
            <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
              <div className="min-w-0">
                {/* A margin, not a literal space, separates the label: Chinese takes no space. */}
                <span className="me-1 font-medium text-foreground">
                  {t('integrations.access.worksFromLabel')}
                </span>
                {publicUrl
                  ? t('integrations.access.worksFromTunnel')
                  : t('integrations.access.worksFromLocal')}
                {publicUrl && (
                  <code className="mt-1 block font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                    {publicUrl}
                  </code>
                )}
              </div>
              <p>
                <span className="me-1 font-medium text-foreground">
                  {t('integrations.access.privacyLabel')}
                </span>
                {t('integrations.access.privacy')}
              </p>
            </div>
          )}
          {patch.error != null && <Banner tone="danger">{errorMessage(patch.error)}</Banner>}
        </CardContent>
      </Card>

      {/* One place to connect: sign-in first (most people), a token only for developer tools. */}
      {enabled && (
        <ConnectAppCard
          endpoint={endpoint}
          localOnly={!publicUrl}
          onCreateToken={() => setCreateOpen(true)}
        />
      )}

      {!publicUrl && (
        <Banner tone="warning" title={t('integrations.noTunnel.title')}>
          <p>{t('integrations.noTunnel.body')}</p>
          <Link
            to="/admin/tunnel"
            className="mt-1 inline-block font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('integrations.noTunnel.link')}
          </Link>
        </Banner>
      )}

      <Card className="gap-4">
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>{t('integrations.tokens.title')}</CardTitle>
            <InfoTip topic="accessToken" />
          </div>
          <CardDescription className="mt-1.5">
            {t('integrations.tokens.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TokenList />
        </CardContent>
      </Card>

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        endpoint={endpoint}
        localOnly={!publicUrl}
      />
    </div>
  );
}

/**
 * "Connect an AI app": the sign-in way (claude.ai, ChatGPT, Claude Desktop) as numbered steps, marked
 * Recommended; the access token way only behind "For developer tools", closed by default.
 */
function ConnectAppCard({
  endpoint,
  localOnly,
  onCreateToken,
}: {
  endpoint: string;
  localOnly: boolean;
  onCreateToken: () => void;
}) {
  const { t } = useTranslation('admin');
  const [devOpen, setDevOpen] = useState(false);
  const devId = useId();
  return (
    <Card className="gap-4" data-testid="connect-app-card">
      <CardHeader>
        <CardTitle>{t('integrations.connectApp.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <section className="flex min-w-0 flex-col gap-3" data-testid="connect-app-signin">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{t('integrations.connectApp.recommended')}</Badge>
            <h3 className="text-sm font-medium">{t('integrations.connectApp.apps')}</h3>
          </div>
          <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm">
            <li>{t('integrations.connectApp.step1')}</li>
            <li>
              {/* A flex box inside the item: a flex <li> loses its number. */}
              <div className="flex flex-col gap-2">
                <span>{t('integrations.connectApp.step2')}</span>
                <code
                  data-testid="connect-app-url"
                  className="rounded-md border bg-muted px-3 py-2.5 font-mono text-xs [overflow-wrap:anywhere]"
                >
                  {endpoint}
                </code>
                <CopyButton
                  text={endpoint}
                  label={t('integrations.connectApp.copy')}
                  className="self-start"
                />
              </div>
            </li>
            <li>{t('integrations.connectApp.step3')}</li>
          </ol>
          <p className="text-sm text-muted-foreground">{t('integrations.connectApp.noToken')}</p>
          {localOnly && (
            <p className="text-sm text-muted-foreground">
              {t('integrations.connectApp.needsTunnel')}
            </p>
          )}
        </section>
        <Separator />
        <section className="flex min-w-0 flex-col gap-3">
          <Button
            type="button"
            variant="ghost"
            size="touch"
            className="-mx-2 h-auto justify-start px-2 text-start whitespace-normal md:min-h-9"
            aria-expanded={devOpen}
            aria-controls={devId}
            onClick={() => setDevOpen((v) => !v)}
          >
            {devOpen ? (
              <ChevronDown aria-hidden className="shrink-0" />
            ) : (
              <ChevronRight aria-hidden className="shrink-0" />
            )}
            {t('integrations.connectApp.developerToggle')}
          </Button>
          {devOpen && (
            <div id={devId} className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>{t('integrations.connectApp.developerBody')}</p>
              <Button size="touch" className="self-start md:min-h-9" onClick={onCreateToken}>
                <Plus aria-hidden />
                {t('integrations.tokens.create')}
              </Button>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function TokenList() {
  const { t } = useTranslation('admin');
  const tokens = useApiTokens();
  const revoke = useRevokeApiToken();
  const me = useMe();
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [editing, setEditing] = useState<ApiToken | null>(null);

  if (!tokens.data)
    return tokens.isError ? (
      <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
    ) : (
      <ListSkeleton rows={2} />
    );
  if (tokens.data.length === 0)
    return <p className="text-sm text-muted-foreground">{t('integrations.tokens.empty')}</p>;

  const now = Date.now();
  const closeConfirm = () => {
    setRevoking(null);
    revoke.reset();
  };

  return (
    <>
      <ul className="flex flex-col divide-y" aria-label={t('integrations.tokens.title')}>
        {tokens.data.map((token) => (
          <TokenRow
            key={token.id}
            token={token}
            now={now}
            onEdit={token.userId === me.data?.id ? () => setEditing(token) : undefined}
            onRevoke={() => {
              revoke.reset();
              setRevoking(token);
            }}
          />
        ))}
      </ul>
      <ConfirmDialog
        open={revoking !== null}
        title={t('integrations.tokens.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('integrations.tokens.revokeConfirm')}
        danger
        loading={revoke.isPending}
        error={revoke.error ?? undefined}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast.success(t('integrations.tokens.revoked'));
              closeConfirm();
            },
          });
        }}
        onClose={closeConfirm}
      >
        {t('integrations.tokens.revokeBody')}
      </ConfirmDialog>
      <TokenPermissionsDialog token={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function TokenRow({
  token,
  now,
  onEdit,
  onRevoke,
}: {
  token: ApiToken;
  now: number;
  /** Only on the signed-in admin's own tokens (a token acts as its owner). */
  onEdit?: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation('admin');
  const expired = token.expiresAt !== null && token.expiresAt <= now;
  const lastUsed =
    token.lastUsedAt === null
      ? t('integrations.tokens.neverUsed')
      : t('integrations.tokens.lastUsed', {
          when:
            now - token.lastUsedAt < RELATIVE_WINDOW_MS
              ? formatRelative(token.lastUsedAt)
              : formatDate(token.lastUsedAt),
        });
  return (
    <li
      data-testid="api-token-row"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0"
    >
      <p className="col-span-2 pt-2.5 leading-snug font-medium [overflow-wrap:anywhere] sm:col-span-1 md:pt-1.5">
        {token.name}
      </p>
      {/* Phones: the actions get their own row under the details, so the name keeps the full width. */}
      <div className="order-last col-span-2 -mx-2 flex items-center justify-end gap-1 sm:order-none sm:col-span-1 sm:mx-0">
        {/* Change what the token may do, without a new token. */}
        {onEdit && !expired && (
          <Button
            type="button"
            variant="ghost"
            size="touch"
            className="px-2 md:min-h-8"
            aria-label={t('integrations.permissions.editLabel', { name: token.name })}
            onClick={onEdit}
          >
            {t('integrations.permissions.edit')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="px-2 text-danger hover:bg-danger/10 hover:text-danger md:min-h-8"
          aria-label={t('integrations.tokens.revokeLabel', { name: token.name })}
          onClick={onRevoke}
        >
          {t('integrations.tokens.revoke')}
        </Button>
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
        {/* How it connected: an app's sign-in, or a token pasted into a developer tool. */}
        <Badge variant="outline" data-testid="token-kind">
          {token.connectedApp
            ? t('integrations.tokens.signedInBadge')
            : t('integrations.tokens.tokenBadge')}
        </Badge>
        <code className="rounded bg-muted px-1.5 font-mono text-xs text-foreground">
          {token.prefix}…
        </code>
        <span className="[overflow-wrap:anywhere]">{token.userName}</span>
        {/* Tokens that may send messages, or message new numbers, say so. */}
        {token.canSend && (
          <Badge variant="outline" data-testid="token-can-send">
            {t('integrations.tokens.canSendBadge')}
          </Badge>
        )}
        {token.canMessageNewNumbers && (
          <Badge
            variant="outline"
            className="border-danger/50 text-danger"
            data-testid="token-can-message-new"
          >
            {t('integrations.tokens.canNewBadge')}
          </Badge>
        )}
        <span>{t('integrations.tokens.created', { date: formatDate(token.createdAt) })}</span>
        <span>{lastUsed}</span>
        {token.expiresAt === null ? (
          <span>{t('integrations.tokens.neverExpires')}</span>
        ) : expired ? (
          <Badge variant="outline" className="border-danger/50 text-danger">
            {t('integrations.tokens.expired', { date: formatDate(token.expiresAt) })}
          </Badge>
        ) : (
          <span>{t('integrations.tokens.expires', { date: formatDate(token.expiresAt) })}</span>
        )}
      </div>
    </li>
  );
}

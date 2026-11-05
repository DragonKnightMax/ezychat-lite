import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight, ExternalLink, Loader2, ThumbsUp, type LucideIcon } from 'lucide-react';
import { connectorText, type ConnectorEntry } from '@ezychat/shared';
import { useConnectorGallery } from '../../api/connector-list';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAppLinks } from '@/lib/app-links';
import { cn } from '@/lib/utils';
import { useWebExtensions } from '../../extensions';
import type { ConnectorStatus } from './catalog';

/** Connector pages that web extensions provide, by catalog id (the first extension wins). */
export function useConnectorLinks(): Partial<Record<string, string>> {
  const extensions = useWebExtensions();
  const links: Partial<Record<string, string>> = {};
  for (const ext of extensions)
    for (const [id, href] of Object.entries(ext.connectorLinks ?? {}))
      if (href && links[id] === undefined) links[id] = href;
  return links;
}

/** Status badge on gallery cards and the connector page header (none for `linked`). */
export function ConnectorStatusBadge({ status }: { status: ConnectorStatus }) {
  const { t } = useTranslation('admin');
  if (status === 'linked') return null;
  const variant =
    status === 'connected'
      ? 'default'
      : status === 'comingSoon' || status === 'enterprise' || status === 'needsUpdate'
        ? 'secondary'
        : 'outline';
  return (
    <Badge
      variant={variant}
      className={
        status === 'attention' || status === 'delisted' ? 'border-warning text-warning' : undefined
      }
      data-testid={`connector-status-${status}`}
    >
      {t(`connectors.status.${status}`)}
    </Badge>
  );
}

/** "Beta" next to the status on cards and page headers, when the connector list marks the entry. */
export function BetaBadge({ show }: Readonly<{ show: boolean }>) {
  const { t } = useTranslation('admin');
  if (!show) return null;
  return (
    <Badge variant="outline" data-testid="connector-beta">
      {t('connectors.status.beta')}
    </Badge>
  );
}

/** The entry's notice from the connector list, above Connect; titled Beta for a beta entry. */
export function ConnectorNotice({ entry }: Readonly<{ entry: ConnectorEntry | null }>) {
  const { t, i18n } = useTranslation('admin');
  if (!entry?.notice) return null;
  return (
    <Banner tone="info" title={entry.stage === 'beta' ? t('connectors.status.beta') : undefined}>
      <span data-testid="connector-notice">{connectorText(entry.notice, i18n.language)}</span>
    </Banner>
  );
}

/** The connector list's entry for one of the app's own connectors (e.g. its Beta mark and notice). */
export function useBuiltinEntry(builtinId: string): ConnectorEntry | null {
  const list = useConnectorGallery();
  return (
    list.data?.connectors.find((g) => g.entry.kind === 'builtin' && g.entry.builtinId === builtinId)
      ?.entry ?? null
  );
}

/**
 * The connector's icon in a calm tile: the icon file from the connector list (served by the
 * server, checked against the list's hash) or a Lucide icon (no brand logos in the app).
 */
export function ConnectorIcon({
  c,
  size = 'md',
  muted = false,
}: {
  c: { icon: LucideIcon; image?: string };
  size?: 'md' | 'lg';
  muted?: boolean;
}) {
  const Icon = c.icon;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted',
        muted ? 'text-muted-foreground opacity-60' : 'text-foreground',
        size === 'lg' ? 'size-14' : 'size-11',
      )}
      aria-hidden
    >
      {c.image ? (
        <img
          src={c.image}
          alt=""
          className={size === 'lg' ? 'size-9' : 'size-7'}
          data-testid="connector-icon-image"
        />
      ) : (
        <Icon className={size === 'lg' ? 'size-7' : 'size-5'} />
      )}
    </span>
  );
}

/** "Connectors › <name>" above a connector page. */
export function ConnectorBreadcrumb({ name }: { name: string }) {
  const { t } = useTranslation('admin');
  return (
    <nav aria-label={t('connectors.breadcrumb')} className="flex items-center gap-1 text-sm">
      <Link
        to="/admin/connectors"
        className="text-muted-foreground underline-offset-4 hover:underline"
      >
        {t('connectors.title')}
      </Link>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </nav>
  );
}

/**
 * "Vote for this connector": opens a ready message to the EzyChat team (WhatsApp in Lite). Nothing
 * is counted in the app (no tracking in Lite); hidden when the product sets the link to null.
 */
export function VoteButton({ name, size = 'touch' }: { name: string; size?: 'sm' | 'touch' }) {
  const { t } = useTranslation('admin');
  const request = useAppLinks().connectorRequest;
  if (!request) return null;
  return (
    <Button
      asChild
      variant="outline"
      size={size}
      className={cn('self-start', size === 'sm' && 'min-h-9 pointer-coarse:min-h-11')}
    >
      <a
        href={request(t('connectors.voteMessage', { name }))}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="vote-connector"
      >
        <ThumbsUp aria-hidden />
        {t('connectors.vote')}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

/** "Open Google Calendar" / "Open in Google Calendar": opens Google in the browser (outside the app). */
export function GoogleCalendarLink({
  href,
  label,
  variant = 'outline',
}: {
  href: string;
  label: string;
  variant?: 'outline' | 'ghost';
}) {
  return (
    <Button
      asChild
      variant={variant}
      size="sm"
      className="min-h-9 self-start pointer-coarse:min-h-11"
    >
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

/**
 * One switch of a connector's per-agent settings ("Check free times", "Answer questions from the sheet"): label, an
 * optional badge (e.g. "Changes your calendar"), a hint and a 44 px switch target; `children` shows
 * under it (e.g. the tab to read).
 */
export function ToolSwitchRow({
  id,
  label,
  hint,
  badge,
  tip,
  checked,
  disabled,
  onCheckedChange,
  children,
}: Readonly<{
  id: string;
  label: string;
  hint: string;
  badge?: string;
  /** An InfoTip after the label (what a risky switch does). */
  tip?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}>) {
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <Label htmlFor={id}>{label}</Label>
            {badge && <Badge variant="secondary">{badge}</Badge>}
            {tip}
          </span>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
        </div>
        <Label htmlFor={id} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
          <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        </Label>
      </div>
      {children}
    </div>
  );
}

/**
 * While Google's file picker is open in another window (Google Sheets, Google Drive): what is
 * happening, a link to open it again (the browser may have blocked the window) and Cancel.
 */
export function PickerWaiting({
  testId,
  title,
  hint,
  url,
  blocked,
  openLabel,
  sameComputer,
  onCancel,
}: Readonly<{
  testId: string;
  title: string;
  hint: string;
  url: string;
  blocked: boolean;
  openLabel: string;
  sameComputer: string;
  onCancel: () => void;
}>) {
  const { t } = useTranslation('admin');
  return (
    <output
      className="flex flex-col items-start gap-3 rounded-lg border px-3 py-3"
      data-testid={testId}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {title}
      </p>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <Button asChild size="touch" variant={blocked ? 'default' : 'outline'}>
        <a href={url} target="_blank" rel="noopener noreferrer">
          {openLabel}
          <ExternalLink aria-hidden />
        </a>
      </Button>
      <p className="text-sm text-muted-foreground">{sameComputer}</p>
      <Button size="touch" variant="ghost" onClick={onCancel}>
        {t('connectors.gc.cancelSignIn')}
      </Button>
    </output>
  );
}

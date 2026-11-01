// After an import: the "Finish for Lite's team" checklist (Admin → Inboxes) and the "address changed"
// card for AI assistants (Settings → Integrations). Both read `/api/lite-import/notice` (admins).
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Bell, HardDriveDownload, KeyRound, LogIn, PlugZap, Send } from 'lucide-react';
import type { LiteImportChecklistItem } from '@ezychat/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { CopyButton } from '../admin/adminUi';
import { useLiteImportNotice, useUpdateLiteImportNotice } from './api';
import { liteImportBridge } from './bridge';
import { IconBubble, type Icon } from './ui';

/** Admin → Inboxes: "Add a number from EzyChat Lite", only in the desktop window on the host PC. */
export function LiteImportEntry({ maxInboxes }: { maxInboxes: number }) {
  const { t } = useTranslation('admin');
  if (!liteImportBridge() || maxInboxes <= 1) return null;
  return (
    <Button asChild variant="outline" size="touch" className="md:min-h-9">
      <Link to="/admin/inboxes/lite" data-testid="lite-import-entry">
        <HardDriveDownload aria-hidden />
        {t('liteImport.entry')}
      </Link>
    </Button>
  );
}

const ITEMS: Array<{ id: LiteImportChecklistItem; icon: Icon }> = [
  { id: 'share', icon: Send },
  { id: 'signin', icon: LogIn },
  { id: 'notifications', icon: Bell },
  { id: 'mcp', icon: PlugZap },
];

/** The address people open: the MCP URL without its `/mcp` path. */
function siteAddress(mcpUrl: string | null | undefined): string | null {
  if (!mcpUrl) return null;
  try {
    return new URL(mcpUrl).origin;
  } catch {
    return null;
  }
}

/** "Finish for Lite's team": share the address, sign in again, alerts, AI assistants. */
export function LiteChecklistCard() {
  const { t } = useTranslation('admin');
  const notice = useLiteImportNotice();
  const update = useUpdateLiteImportNotice();
  const list = notice.data?.checklist;
  if (!list) return null;
  const done = ITEMS.filter(({ id }) => list.items[id]).length;
  const address = siteAddress(notice.data?.mcp?.mcpUrl);
  return (
    <Card data-testid="lite-checklist">
      <CardHeader>
        <CardTitle className="text-lg">{t('liteImport.list.title')}</CardTitle>
        <CardDescription>
          {t('liteImport.list.intro', { inbox: list.inboxName, done, total: ITEMS.length })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Progress value={(done / ITEMS.length) * 100} aria-label={t('liteImport.list.title')} />
        <ul className="grid gap-3 sm:grid-cols-2">
          {ITEMS.map(({ id: item, icon }) => {
            const id = `lite-check-${item}`;
            const on = list.items[item] === true;
            return (
              <li key={item} className="flex min-w-0 items-center gap-3 rounded-lg border p-3">
                <IconBubble icon={icon} tone={on ? 'success' : 'primary'} />
                <Label
                  htmlFor={id}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col items-start gap-1 font-normal break-words',
                    on && 'text-muted-foreground line-through',
                  )}
                >
                  <span>{t(`liteImport.list.${item}`, { n: list.liteUsers })}</span>
                  {item === 'mcp' && list.tokens.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {list.tokens.map((x) => (
                        <Badge key={`${x.kind}:${x.name}`} variant="outline">
                          <KeyRound aria-hidden />
                          {x.name}
                        </Badge>
                      ))}
                    </span>
                  )}
                </Label>
                <Checkbox
                  id={id}
                  checked={on}
                  disabled={update.isPending}
                  className="size-5"
                  onCheckedChange={(v) => update.mutate({ item, done: v === true })}
                />
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-2">
          {address && <CopyButton text={address} label={t('liteImport.list.copyAddress')} />}
          <Button
            variant="ghost"
            size="touch"
            className="md:min-h-9"
            disabled={update.isPending}
            onClick={() => update.mutate({ dismiss: 'checklist' })}
          >
            {t('liteImport.list.dismiss')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Settings → Integrations: AI assistants connected to Lite must be connected again. */
export function LiteMcpNoticeCard() {
  const { t } = useTranslation('admin');
  const notice = useLiteImportNotice();
  const update = useUpdateLiteImportNotice();
  const mcp = notice.data?.mcp;
  if (!mcp) return null;
  const tokens = notice.data?.checklist?.tokens ?? [];
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4"
      data-testid="lite-mcp-flag"
    >
      <div className="flex min-w-0 items-center gap-3">
        <IconBubble icon={PlugZap} tone="warning" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="font-medium">{t('liteImport.mcp.title')}</p>
          <p className="text-sm text-muted-foreground">{t('liteImport.mcp.body')}</p>
        </div>
        <Button
          variant="ghost"
          size="touch"
          className="shrink-0 md:min-h-9"
          disabled={update.isPending}
          onClick={() => update.mutate({ dismiss: 'mcp' })}
        >
          {t('liteImport.mcp.dismiss')}
        </Button>
      </div>
      {mcp.mcpUrl ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('liteImport.mcp.newAddress')}</span>
          <code className="min-w-0 rounded-md bg-card px-2 py-1 break-all">{mcp.mcpUrl}</code>
          <CopyButton text={mcp.mcpUrl} />
        </div>
      ) : (
        <p className="text-sm">
          <Link to="/admin/tunnel" className="underline underline-offset-4">
            {t('liteImport.mcp.noAddress')}
          </Link>
        </p>
      )}
      {tokens.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('liteImport.mcp.tokens')}>
          {tokens.map((x) => (
            <li key={`${x.kind}:${x.name}`}>
              <Badge variant="outline">
                <KeyRound aria-hidden />
                {x.name}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {mcp.reason === 'quick' && (
        <p className="text-xs text-muted-foreground">{t('liteImport.mcp.quickHint')}</p>
      )}
    </div>
  );
}

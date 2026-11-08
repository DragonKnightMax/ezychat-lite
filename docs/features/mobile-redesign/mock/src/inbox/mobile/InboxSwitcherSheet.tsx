// Proposed (mobile-redesign): switch WhatsApp number from a bottom sheet, like an account switcher.
// Each row: the number's colour, name, number, connection state and unread chats. Shown only when the
// user may open 2+ numbers (Lite and one-number agents keep the plain "Inbox" title).
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Layers, Settings } from 'lucide-react';
import type { Chat } from '@ezychat/shared';
import { ResponsiveDialog, StatusDot } from '@/components/app';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { inboxOfChat, setInboxFilter, useMockInboxes, type MockInbox } from '../../mock/inboxes';
import { useVisibleInboxes } from '../useVisibleInboxes';

const SWATCH: Record<MockInbox['tone'], string> = {
  primary: 'bg-primary/15 text-primary',
  warning: 'bg-warning/20 text-foreground',
  info: 'bg-info/15 text-foreground',
  success: 'bg-success/15 text-foreground',
};
/** Solid fills for the small badge on a photo (a tint would show the photo through). */
const SOLID: Record<MockInbox['tone'], string> = {
  primary: 'bg-primary text-primary-foreground',
  warning: 'bg-warning text-background',
  info: 'bg-info text-background',
  success: 'bg-success text-background',
};

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export function InboxSwatch({
  inbox,
  className,
  solid = false,
}: Readonly<{ inbox: Pick<MockInbox, 'name' | 'tone'>; className?: string; solid?: boolean }>) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-xl font-semibold',
        (solid ? SOLID : SWATCH)[inbox.tone],
        className,
      )}
    >
      {initialsOf(inbox.name)}
    </span>
  );
}

function Row({
  selected,
  onSelect,
  icon,
  title,
  subtitle,
  status,
  unread,
  testId,
}: Readonly<{
  selected: boolean;
  onSelect(): void;
  icon: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  status?: React.ReactNode;
  unread: number;
  testId?: string;
}>) {
  const { t } = useTranslation('inbox');
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={testId}
      className={cn(
        'flex min-h-16 w-full items-center gap-3 rounded-xl px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'bg-accent' : 'active:bg-muted',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-medium text-foreground">{title}</span>
          {status}
        </span>
        <span className="block truncate text-xs text-muted-foreground tabular-nums">
          {subtitle}
        </span>
      </span>
      {unread > 0 && (
        <span
          className="min-w-6 rounded-full bg-unread px-1.5 text-center text-xs font-bold text-primary-foreground tabular-nums"
          aria-label={t('mobile.switcher.unread', { count: unread })}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      <Check
        aria-hidden
        className={cn('size-5 shrink-0 text-primary', selected ? 'visible' : 'invisible')}
      />
    </button>
  );
}

export function InboxSwitcherSheet({
  open,
  onOpenChange,
  chats,
}: Readonly<{ open: boolean; onOpenChange(open: boolean): void; chats: Chat[] }>) {
  const { t } = useTranslation('inbox');
  const state = useMockInboxes();
  const visible = useVisibleInboxes();
  const { isAdmin } = useAuth();
  const unreadOf = (id?: string) =>
    chats.filter((c) => c.unreadCount > 0 && (!id || inboxOfChat(state, c.jid)?.id === id)).length;
  const selectedId = visible.some((i) => i.id === state.inboxFilter) ? state.inboxFilter : 'all';
  const choose = (id: string) => {
    setInboxFilter(id);
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('mobile.switcher.title')}
      description={t('mobile.switcher.description')}
      footer={
        isAdmin ? (
          <Button asChild variant="ghost" size="touch" className="justify-start">
            <Link to="/admin/inboxes">
              <Settings aria-hidden />
              {t('mobile.switcher.manage')}
            </Link>
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-1 pb-2" data-testid="inbox-switcher-sheet">
        <Row
          selected={selectedId === 'all'}
          onSelect={() => choose('all')}
          icon={
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Layers className="size-5" aria-hidden />
            </span>
          }
          title={t('mobile.switcher.allNumbers')}
          subtitle={t('mobile.switcher.numbersCount', { count: visible.length })}
          unread={unreadOf()}
          testId="switch-all"
        />
        {visible.map((inbox) => {
          const tone =
            inbox.status === 'connected'
              ? 'success'
              : inbox.status === 'phone_offline'
                ? 'danger'
                : 'warning';
          return (
            <Row
              key={inbox.id}
              selected={selectedId === inbox.id}
              onSelect={() => choose(inbox.id)}
              icon={<InboxSwatch inbox={inbox} className="size-11 text-sm" />}
              title={inbox.name}
              subtitle={
                inbox.type === 'business_api'
                  ? `${inbox.number} · ${t('mobile.switcher.businessApi')}`
                  : inbox.number
              }
              status={
                // Connected numbers show only the green dot; a problem is spelled out.
                <StatusDot
                  tone={tone}
                  className="shrink-0 gap-1 text-xs text-muted-foreground"
                  label={
                    inbox.status === 'connected' ? (
                      <span className="sr-only">{t('mobile.switcher.status.connected')}</span>
                    ) : (
                      t(`mobile.switcher.status.${inbox.status}`)
                    )
                  }
                />
              }
              unread={unreadOf(inbox.id)}
              testId={`switch-${inbox.id}`}
            />
          );
        })}
      </div>
    </ResponsiveDialog>
  );
}

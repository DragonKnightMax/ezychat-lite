import type React from 'react';
import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Loader2, MessageSquare, Search, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { GroupInfoResponse, GroupMember } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { useGroupMembers, useMemberAbout, useStartMemberChat } from '../api/queries';
import { Banner } from '@/components/app';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { formatDate } from '../lib/format';
import { encodeJid } from '../lib/jid';
import { ChatAvatar } from './ChatAvatar';
import { GroupAiRow } from './GroupAiRow';
import { PanelHeader } from './PanelHeader';

/** Rows rendered at a time; large groups show more on request instead of rendering all at once. */
export const MEMBER_PAGE = 100;

export interface GroupPanelProps {
  jid: string;
  open: boolean;
  onClose(): void;
}

type T = ReturnType<typeof useTranslation<'inbox'>>['t'];

/** What the team can call a member: our name for them, else their number, else their WhatsApp ID. */
export function memberLabel(m: GroupMember, t: T): string {
  if (m.isMe) return t('groupInfo.you');
  return m.name ?? (m.phone ? `+${m.phone}` : (m.lid ?? m.jid));
}

function memberSubline(m: GroupMember, t: T): { text: string; hidden?: boolean } {
  if (m.username) return { text: `@${m.username}` };
  if (m.phone) return { text: m.name || m.isMe ? `+${m.phone}` : t('groupInfo.noName') };
  return { text: t('groupInfo.hiddenNumber'), hidden: true };
}

const searchable = (m: GroupMember) =>
  [m.name, m.phone, m.phone && `+${m.phone}`, m.username, m.lid]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

function MemberRow({
  groupJid,
  member,
  onOpen,
}: {
  groupJid: string;
  member: GroupMember;
  onOpen(): void;
}) {
  const { t } = useTranslation('inbox');
  const label = memberLabel(member, t);
  const sub = memberSubline(member, t);
  const bareId = !member.name && !member.phone && !member.isMe;
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        onClick={onOpen}
        className="h-auto min-h-13 w-full justify-start gap-2.5 rounded-none px-4 py-2 text-left font-normal"
      >
        <ChatAvatar
          name={member.isMe ? label : (member.name ?? '')}
          src={`/api/chats/${encodeJid(groupJid)}/members/${encodeJid(member.lid ?? member.jid)}/avatar`}
          seed={member.jid}
          size="sm"
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-sm font-medium',
              member.isMe && 'text-primary',
              bareId && 'font-mono text-xs',
            )}
          >
            {label}
          </span>
          <span
            className={cn('block truncate text-xs text-muted-foreground', sub.hidden && 'italic')}
          >
            {sub.text}
          </span>
        </span>
        {member.role !== 'member' && (
          <Badge variant="secondary" className="shrink-0">
            {t('groupInfo.admin')}
          </Badge>
        )}
      </Button>
    </li>
  );
}

function MemberList({
  data,
  onOpen,
}: {
  data: GroupInfoResponse;
  onOpen(member: GroupMember): void;
}) {
  const { t } = useTranslation('inbox');
  const [query, setQuery] = useState('');
  const [adminsOnly, setAdminsOnly] = useState(false);
  const [limit, setLimit] = useState(MEMBER_PAGE);
  const q = useDeferredValue(query.trim().toLowerCase());
  const index = useMemo(() => data.members.map((m) => [m, searchable(m)] as const), [data.members]);
  const matches = useMemo(
    () => index.filter(([, text]) => !q || text.includes(q)).map(([m]) => m),
    [index, q],
  );
  const shown = useMemo(
    () => (adminsOnly ? matches.filter((m) => m.role !== 'member') : matches),
    [matches, adminsOnly],
  );
  const { group } = data;
  const creator = group.createdBy
    ? (group.createdBy.name ?? (group.createdBy.phone ? `+${group.createdBy.phone}` : null))
    : null;

  return (
    <>
      <div className="space-y-0.5 px-4 pt-3 pb-1">
        {group.name && (
          <p className="text-[15px] font-semibold [overflow-wrap:anywhere]">{group.name}</p>
        )}
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('groupInfo.memberCount', { count: group.size })} ·{' '}
          {t('groupInfo.adminCount', { count: group.adminCount })}
        </p>
        {group.createdAt && (
          <p className="text-xs text-muted-foreground">
            {creator
              ? t('groupInfo.created', { date: formatDate(group.createdAt), name: creator })
              : t('groupInfo.createdOn', { date: formatDate(group.createdAt) })}
          </p>
        )}
      </div>
      {/* Proposed (ai-groups): whether the AI agent answers in this group when mentioned. */}
      <GroupAiRow jid={group.jid} />
      <div className="relative mx-4 mt-2 mb-1.5">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(MEMBER_PAGE);
          }}
          placeholder={t('groupInfo.search')}
          aria-label={t('groupInfo.search')}
          className="h-10 bg-surface pl-8 text-base md:text-sm"
        />
      </div>
      <div className="flex gap-1.5 px-4 pb-2" role="group" aria-label={t('groupInfo.title')}>
        {[
          {
            admins: false,
            on: !adminsOnly,
            label: t('groupInfo.all'),
            n: q ? matches.length : group.size,
          },
          {
            admins: true,
            on: adminsOnly,
            label: t('groupInfo.admins'),
            n: q ? matches.filter((m) => m.role !== 'member').length : group.adminCount,
          },
        ].map((c) => (
          <Button
            key={String(c.admins)}
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={c.on}
            onClick={() => {
              setAdminsOnly(c.admins);
              setLimit(MEMBER_PAGE);
            }}
            className={cn(
              'h-8 rounded-full px-3 text-xs tabular-nums',
              c.on
                ? 'border-transparent bg-accent text-accent-foreground'
                : 'text-muted-foreground',
            )}
          >
            {c.label} · {c.n}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t('groupInfo.none')}
          </p>
        ) : (
          <ul aria-label={t('groupInfo.listLabel')}>
            {shown.slice(0, limit).map((m) => (
              <MemberRow key={m.jid} groupJid={group.jid} member={m} onOpen={() => onOpen(m)} />
            ))}
          </ul>
        )}
        {shown.length > limit && (
          <div className="px-4 py-3">
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="w-full"
              onClick={() => setLimit((l) => l + MEMBER_PAGE)}
            >
              {t('groupInfo.showMore', { shown: limit, total: shown.length })}
            </Button>
          </div>
        )}
        {!q && !adminsOnly && group.size > data.members.length && (
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            {t('groupInfo.partial', { listed: data.members.length, total: group.size })}
          </p>
        )}
      </div>
      <p className="safe-bottom border-t px-4 py-2.5 text-xs text-muted-foreground">
        {t('groupInfo.foot')}
      </p>
    </>
  );
}

function MemberDetail({
  groupJid,
  member,
  onBack,
  onOpenChat,
}: {
  groupJid: string;
  member: GroupMember;
  onBack(): void;
  onOpenChat(chatJid: string): void;
}) {
  const { t } = useTranslation('inbox');
  const about = useMemberAbout(groupJid, member.isMe ? null : (member.lid ?? member.jid));
  const start = useStartMemberChat(groupJid);
  const [confirming, setConfirming] = useState(false);
  const label = memberLabel(member, t);
  const bareId = !member.name && !member.phone && !member.isMe;
  const rows: Array<[string, React.ReactNode]> = [
    [
      t('groupInfo.phone'),
      member.phone ? `+${member.phone}` : <i key="h">{t('groupInfo.hiddenNumber')}</i>,
    ],
  ];
  if (member.lid)
    rows.push([t('groupInfo.lid'), <span className="font-mono text-xs">{member.lid}</span>]);
  if (member.username) rows.push([t('groupInfo.username'), `@${member.username}`]);
  rows.push([
    t('groupInfo.role'),
    member.role === 'member' ? t('groupInfo.member') : t('groupInfo.admin'),
  ]);
  // Empty (private or unset) hides the row; a failed read says so and offers a retry.
  if (!member.isMe && (about.isPending || about.isError || about.data?.about))
    rows.push([
      t('groupInfo.about'),
      about.isPending ? (
        <span className="text-muted-foreground">{t('groupInfo.aboutLoading')}</span>
      ) : about.isError ? (
        <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2 text-muted-foreground">
          {t('groupInfo.aboutFailed')}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => void about.refetch()}
            disabled={about.isFetching}
          >
            {t('groupInfo.retry')}
          </Button>
        </span>
      ) : (
        <span className="whitespace-pre-wrap">{about.data?.about}</span>
      ),
    ]);

  function startChat() {
    // The WhatsApp ID: a stale list must never start a chat with a recycled number's new owner.
    start.mutate(member.lid ?? member.jid, {
      onSuccess: ({ chatJid }) => onOpenChat(chatJid),
      onError: (err) =>
        toast.error(err instanceof Error ? errorMessage(err) : t('groupInfo.startFailed')),
    });
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pt-2 pb-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="-ml-2 text-muted-foreground"
      >
        <ChevronLeft aria-hidden="true" />
        {t('groupInfo.back')}
      </Button>
      <div className="flex items-center gap-3">
        <ChatAvatar
          name={member.isMe ? label : (member.name ?? '')}
          src={`/api/chats/${encodeJid(groupJid)}/members/${encodeJid(member.lid ?? member.jid)}/avatar`}
          seed={member.jid}
          size="lg"
        />
        <div className="min-w-0">
          <p
            className={cn('font-semibold [overflow-wrap:anywhere]', bareId && 'font-mono text-xs')}
          >
            {label}
          </p>
        </div>
      </div>
      <section
        className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        aria-label={t('groupInfo.details')}
      >
        <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
          {t('groupInfo.details')}
        </h4>
        <dl className="space-y-1">
          {rows.map(([k, v]) => (
            <div key={k} className="flex min-w-0 items-baseline justify-between gap-3">
              <dt className="shrink-0 text-xs text-muted-foreground">{k}</dt>
              <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      {member.isMe ? null : member.chatJid ? (
        <>
          <Button
            type="button"
            size="touch"
            className="w-full"
            onClick={() => onOpenChat(member.chatJid!)}
          >
            <MessageSquare aria-hidden="true" />
            {t('groupInfo.openChat')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('groupInfo.hasChat')}</p>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="w-full"
            onClick={() => setConfirming(true)}
          >
            <MessageSquare aria-hidden="true" />
            {t('groupInfo.message')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('groupInfo.noChat')}</p>
          <AlertDialog
            open={confirming}
            onOpenChange={(o) => !o && !start.isPending && setConfirming(false)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="[overflow-wrap:anywhere]">
                  {t('groupInfo.confirmTitle', { name: label })}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-warning">
                  {t('groupInfo.confirmWarn')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={start.isPending}>
                  {t('groupInfo.cancel')}
                </AlertDialogCancel>
                <Button
                  type="button"
                  className="min-h-11 sm:min-h-9"
                  onClick={startChat}
                  disabled={start.isPending}
                >
                  {start.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {t('groupInfo.start')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

function GroupBody({
  jid,
  open,
  onClose,
  title,
  description,
}: GroupPanelProps & { title: React.ReactNode; description: React.ReactNode }) {
  const { t } = useTranslation('inbox');
  const navigate = useNavigate();
  const q = useGroupMembers(jid, open);
  const [selected, setSelected] = useState<string | null>(null);
  const member = selected ? q.data?.members.find((m) => m.jid === selected) : undefined;

  return (
    <>
      <PanelHeader
        icon={<Users className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        title={title}
        description={description}
        closeLabel={t('groupInfo.close')}
        onClose={onClose}
      />
      {q.isPending ? (
        <div className="space-y-2 px-4 py-3" role="status" aria-label={t('groupInfo.loading')}>
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-10 w-full" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="space-y-3 px-4 py-3">
          <Banner tone="warning">{t('groupInfo.unavailable')}</Banner>
          <Button type="button" variant="outline" size="touch" onClick={() => void q.refetch()}>
            {t('groupInfo.retry')}
          </Button>
        </div>
      ) : member ? (
        <MemberDetail
          key={member.jid}
          groupJid={jid}
          member={member}
          onBack={() => setSelected(null)}
          onOpenChat={(chatJid) => {
            onClose();
            navigate(`/chats/${encodeJid(chatJid)}`);
          }}
        />
      ) : (
        <MemberList data={q.data} onOpen={(m) => setSelected(m.jid)} />
      )}
    </>
  );
}

/**
 * Group info: the members of a WhatsApp group (read from WhatsApp, view-only), with search, an
 * admins filter and per-member details. Side panel on >= lg, full-height Sheet below.
 */
export function GroupPanel({ jid, open, onClose }: GroupPanelProps) {
  const { t } = useTranslation('inbox');
  const desktop = useMediaQuery('(min-width: 1024px)');
  const titleRef = useRef<HTMLHeadingElement>(null);

  if (desktop) {
    if (!open) return null;
    return (
      <aside
        aria-label={t('groupInfo.title')}
        className="flex w-80 shrink-0 flex-col border-l bg-surface"
      >
        <GroupBody
          jid={jid}
          open={open}
          onClose={onClose}
          title={<h3>{t('groupInfo.title')}</h3>}
          description={<p>{t('groupInfo.description')}</p>}
        />
      </aside>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-label={t('groupInfo.title')}
        className="safe-top safe-x w-full gap-0 bg-surface max-sm:border-l-0 sm:max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <GroupBody
          jid={jid}
          open={open}
          onClose={onClose}
          title={
            <SheetTitle ref={titleRef} tabIndex={-1} className="text-sm outline-none">
              {t('groupInfo.title')}
            </SheetTitle>
          }
          description={
            <SheetDescription className="text-xs">{t('groupInfo.description')}</SheetDescription>
          }
        />
      </SheetContent>
    </Sheet>
  );
}

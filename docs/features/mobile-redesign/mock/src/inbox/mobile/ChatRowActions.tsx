// Proposed (mobile-redesign): chat-list row gestures on a phone.
//  - swipe right: Assign to me; swipe left: Resolve (Reopen in the Resolved list). Each shows a toast
//    with Undo, because a swipe is easy to do by accident.
//  - press and hold (or the context menu): a sheet with every row action, so nothing depends on the
//    swipe alone (the swipe is a shortcut; screen-reader users get the same actions from the sheet).
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  Info,
  MailOpen,
  RotateCcw,
  Tag,
  UserRound,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Chat } from '@ezychat/shared';
import { ResponsiveDialog } from '@/components/app';
import { cn } from '@/lib/utils';
import { useMarkRead, usePatchChat } from '../../api/queries';
import { encodeJid } from '../../lib/jid';
import { chatTitle } from '../chat-title';
import type { Directory } from '../useDirectory';
import { AssignSheet } from './AssignSheet';
import { ChatTagsSheet } from './TagSheet';

const THRESHOLD = 72;
const MAX = 112;
const HOLD_MS = 450;

export function ChatRowActions({
  chat,
  directory,
  children,
}: Readonly<{ chat: Chat; directory: Directory; children: React.ReactNode }>) {
  const { t } = useTranslation(['inbox', 'common']);
  const navigate = useNavigate();
  const patch = usePatchChat(chat.jid);
  const markRead = useMarkRead(chat.jid);
  const [dx, setDxState] = useState(0);
  // The latest offset, read on pointer up (events can arrive before React renders the last move).
  const dxRef = useRef(0);
  const setDx = (v: number) => {
    dxRef.current = v;
    setDxState(v);
  };
  const [sheet, setSheet] = useState<'actions' | 'assign' | 'tags' | null>(null);
  const drag = useRef<{ x: number; y: number; horizontal: boolean | null; moved: boolean } | null>(
    null,
  );
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const me = directory.me?.id ?? null;
  const mine = chat.assignedTo != null && chat.assignedTo === me;
  const resolved = chat.status === 'resolved';
  const name = chatTitle(chat, t);

  const undoable = (body: { assignedTo?: number | null; status?: 'open' | 'resolved' }) => {
    const before = { assignedTo: chat.assignedTo ?? null, status: chat.status };
    patch.mutate(body, {
      onSuccess: () =>
        toast(
          body.status === 'resolved'
            ? t('mobile.row.resolvedToast', { name })
            : body.status === 'open'
              ? t('mobile.row.reopenedToast', { name })
              : t('mobile.row.assignedToast', { name }),
          {
            action: {
              label: t('mobile.row.undo'),
              onClick: () =>
                patch.mutate(
                  'status' in body ? { status: before.status } : { assignedTo: before.assignedTo },
                ),
            },
          },
        ),
      onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    });
  };

  const assignToMe = () => {
    if (me != null && !mine) undoable({ assignedTo: me });
  };
  const toggleResolve = () => undoable({ status: resolved ? 'open' : 'resolved' });

  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    setDx(0);
    drag.current = { x: e.clientX, y: e.clientY, horizontal: null, moved: false };
    clearHold();
    hold.current = setTimeout(() => {
      suppressClick.current = true;
      drag.current = null;
      setDx(0);
      navigator.vibrate?.(10);
      setSheet('actions');
    }, HOLD_MS);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearHold();
    if (d.horizontal == null && (Math.abs(mx) > 10 || Math.abs(my) > 10))
      d.horizontal = Math.abs(mx) > Math.abs(my);
    if (!d.horizontal) return;
    d.moved = true;
    // Right = Assign to me (nothing to do when it is already mine); left = Resolve / Reopen.
    const next = Math.max(-MAX, Math.min(mine || me == null ? 0 : MAX, mx));
    setDx(next);
  };
  const onPointerEnd = () => {
    clearHold();
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) {
      setDx(0);
      return;
    }
    suppressClick.current = true;
    const offset = dxRef.current;
    if (offset >= THRESHOLD) assignToMe();
    else if (offset <= -THRESHOLD) toggleResolve();
    setDx(0);
  };

  const action = (
    key: string,
    icon: React.ReactNode,
    label: string,
    run: () => void,
    hidden = false,
  ) =>
    hidden ? null : (
      <button
        key={key}
        type="button"
        onClick={run}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  const icon = (I: typeof Info) => (
    <I className="size-5 shrink-0 text-muted-foreground" aria-hidden />
  );

  return (
    <div className="relative overflow-hidden" data-testid="swipe-row">
      {/* What the swipe will do, revealed under the row. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 flex items-center px-5 text-sm font-semibold',
          dx > 0
            ? 'justify-start bg-primary text-primary-foreground'
            : 'justify-end bg-success text-background',
          dx === 0 && 'invisible',
        )}
      >
        {dx > 0 ? (
          <span className="flex items-center gap-2">
            <UserRoundCheck className="size-5" />
            {t('mobile.row.assignToMe')}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            {resolved ? t('header.reopen') : t('header.resolve')}
            {resolved ? <RotateCcw className="size-5" /> : <CheckCircle2 className="size-5" />}
          </span>
        )}
      </div>
      <div
        className={cn(
          'relative touch-pan-y select-none bg-surface [-webkit-touch-callout:none]',
          dx === 0 && 'transition-transform duration-200',
        )}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          clearHold();
          setSheet('actions');
        }}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClick.current = false;
          }
        }}
      >
        {children}
      </div>

      <ResponsiveDialog
        open={sheet === 'actions'}
        onOpenChange={(o) => setSheet(o ? 'actions' : null)}
        title={name}
        description={
          chat.assignedTo != null
            ? t('chatListItem.assignedTo', {
                name: directory.nameOf(chat.assignedTo, { youLabel: true }),
              })
            : t('header.unassigned')
        }
      >
        <div className="space-y-0.5 pb-3" data-testid="row-actions-sheet">
          {action(
            'me',
            icon(UserRoundCheck),
            t('mobile.row.assignToMe'),
            () => {
              setSheet(null);
              assignToMe();
            },
            mine || me == null,
          )}
          {action('assign', icon(UserRound), t('mobile.row.chooseAssignee'), () =>
            setSheet('assign'),
          )}
          {action('tags', icon(Tag), t('mobile.row.tags'), () => setSheet('tags'))}
          {action(
            'read',
            icon(MailOpen),
            t('mobile.row.markRead'),
            () => {
              setSheet(null);
              markRead.mutate();
            },
            chat.unreadCount === 0,
          )}
          {action(
            'resolve',
            icon(resolved ? RotateCcw : CheckCircle2),
            resolved ? t('header.reopen') : t('header.resolve'),
            () => {
              setSheet(null);
              toggleResolve();
            },
          )}
          {action(
            'info',
            icon(chat.type === 'group' ? Users : Info),
            chat.type === 'group' ? t('mobile.row.groupInfo') : t('mobile.row.customer'),
            () => {
              setSheet(null);
              navigate(
                `/chats/${encodeJid(chat.jid)}?${chat.type === 'group' ? 'info' : 'customer'}=1`,
                { state: { fromList: true } },
              );
            },
          )}
        </div>
      </ResponsiveDialog>
      <AssignSheet
        open={sheet === 'assign'}
        onOpenChange={(o) => setSheet(o ? 'assign' : null)}
        directory={directory}
        value={chat.assignedTo ?? null}
        onAssign={(id) =>
          patch.mutate(
            { assignedTo: id },
            { onError: (e) => toast.error(e instanceof Error ? e.message : String(e)) },
          )
        }
      />
      {
        <ChatTagsSheet
          jid={chat.jid}
          group={chat.type === 'group'}
          open={sheet === 'tags'}
          onOpenChange={(o) => setSheet(o ? 'tags' : null)}
        />
      }
    </div>
  );
}

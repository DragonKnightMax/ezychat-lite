// Proposed (mobile-redesign): New chat as a floating action button at the bottom right of the chat
// list (thumb reach), labelled "New chat" and shrinking to its icon while the list scrolls down.
// Same rules as the header button: admins always, team members when Settings allows it.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNewChatState } from '../../mock/newChat';
import { NewChatDialog } from '../NewChatDialog';

export function NewChatFab({ scroller }: Readonly<{ scroller: HTMLElement | null }>) {
  const { t } = useTranslation('inbox');
  const state = useNewChatState();
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (!scroller) return;
    let last = scroller.scrollTop;
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (Math.abs(top - last) > 8) setCompact(top > last && top > 24);
      last = top;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller]);

  if (!state.data?.allowed) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('mockNewChat.button')}
        data-testid="new-chat-fab"
        className={cn(
          // 56 px FAB (Material 3), above the safe area; tokens only.
          'absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-10 inline-flex h-14 items-center justify-center gap-2 rounded-2xl bg-primary text-primary-foreground shadow-lg outline-none transition-[width,padding] duration-200 focus-visible:ring-4 focus-visible:ring-ring/50 active:bg-primary/90',
          compact ? 'w-14' : 'px-5',
        )}
      >
        <MessageSquarePlus className="size-6 shrink-0" aria-hidden />
        {!compact && <span className="text-[15px] font-semibold">{t('mockNewChat.button')}</span>}
      </button>
      <NewChatDialog open={open} onClose={() => setOpen(false)} state={state.data} />
    </>
  );
}

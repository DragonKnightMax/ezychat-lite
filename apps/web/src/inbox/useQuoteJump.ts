import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, MessageListResponse } from '@ezychat/shared';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { locateMessage } from '../api/queries';

/** Older pages loaded at most to reach a quoted message (50 each: 2,000 messages back). */
export const QUOTE_JUMP_MAX_PAGES = 40;
/** Messages per page of `useMessages`. */
const PAGE_SIZE = 50;

/** A request to scroll to a message; `seq` makes a second tap on the same quote scroll again. */
export interface JumpTarget {
  id: string;
  seq: number;
}

interface OlderPages {
  hasNextPage: boolean;
  fetchNextPage(): Promise<{
    data?: { pages: MessageListResponse[] };
    hasNextPage: boolean;
    isError: boolean;
  }>;
}

/**
 * "Tap a quote to see the original", like WhatsApp: a loaded original is scrolled to at once;
 * otherwise the server says whether it is stored in this chat and how far back, and older pages
 * load (bounded) until it is there. Never matched by text, only by the stored message key.
 */
export function useQuoteJump(
  jid: string,
  messagesById: Map<string, Message>,
  older: OlderPages,
): { target: JumpTarget | null; open(id: string): Promise<void> } {
  const { t } = useTranslation('inbox');
  const [target, setTarget] = useState<JumpTarget | null>(null);
  useEffect(() => setTarget(null), [jid]);
  const busy = useRef(false);
  // The latest values, read after each await (the callback keeps a stable identity).
  const latest = useRef({ messagesById, older });
  latest.current = { messagesById, older };

  const open = useCallback(
    async (id: string) => {
      if (busy.current) return;
      const show = () => setTarget((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
      if (latest.current.messagesById.has(id)) return show();
      busy.current = true;
      try {
        const where = await locateMessage(jid, id);
        if (!where.found) {
          toast(t('message.quoteJump.unavailable'));
          return;
        }
        // Pages needed from the newest message, plus one in case new messages arrived meanwhile.
        const pages = Math.min(QUOTE_JUMP_MAX_PAGES, Math.ceil((where.newer + 1) / PAGE_SIZE) + 1);
        let more = latest.current.older.hasNextPage;
        for (let i = 0; i < pages && more; i++) {
          const r = await latest.current.older.fetchNextPage();
          if (r.data?.pages.some((p) => p.messages.some((m) => m.id === id))) return show();
          if (r.isError) throw new Error('older page failed');
          more = r.hasNextPage;
        }
        toast(t(more ? 'message.quoteJump.tooFar' : 'message.quoteJump.unavailable'));
      } catch {
        toast.error(t('message.quoteJump.failed'));
      } finally {
        busy.current = false;
      }
    },
    [jid, t],
  );

  return { target, open };
}

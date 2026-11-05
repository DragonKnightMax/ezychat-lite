import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Message } from '@ezychat/shared';
import { HIGHLIGHT_MS, MessageList, type MessageListProps } from './MessageList';
import type { TimelineItem } from './timeline';
import type { Directory } from './useDirectory';

const base: Message = {
  id: 'M-0',
  chatJid: '60123456789@s.whatsapp.net',
  senderJid: '60123456789@s.whatsapp.net',
  senderName: 'Gus',
  fromMe: false,
  sentByUserId: null,
  type: 'text',
  body: 'hello',
  mediaUrl: null,
  mediaMime: null,
  mediaName: null,
  mediaStatus: 'none',
  quotedId: null,
  status: 'delivered',
  error: null,
  timestamp: 1_700_000_000_000,
  clientId: null,
  reactions: [],
};
const item = (id: string, i: number): TimelineItem => ({
  kind: 'message',
  key: id,
  at: base.timestamp + i,
  message: { ...base, id, body: `body ${id}`, timestamp: base.timestamp + i },
});
const directory = { me: null, nameOf: () => '' } as unknown as Directory;

function props(over: Partial<MessageListProps>): MessageListProps {
  const items = over.items ?? [item('M-1', 1), item('M-2', 2)];
  return {
    items,
    messagesById: new Map(),
    isGroup: false,
    directory,
    loading: false,
    hasOlder: false,
    loadingOlder: false,
    onLoadOlder: vi.fn(),
    onRetry: vi.fn(),
    retryingId: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MessageList jump to a quoted message', () => {
  it('centres, focuses and briefly highlights the original once it is rendered', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container, rerender } = render(
      <MessageList {...props({ jumpTo: { id: 'M-9', seq: 1 } })} />,
    );
    // not rendered yet (an older page is still loading): nothing happens
    expect(scrollIntoView).not.toHaveBeenCalled();
    const items = [item('M-9', 0), item('M-1', 1), item('M-2', 2)];
    rerender(<MessageList {...props({ items, jumpTo: { id: 'M-9', seq: 1 } })} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    const target = container.querySelector('[data-message-id="M-9"]');
    expect(target?.getAttribute('data-highlighted')).toBe('true');
    expect(document.activeElement).toBe(target);
    // the same request is handled once, even when items change again
    rerender(<MessageList {...props({ items: [...items], jumpTo: { id: 'M-9', seq: 1 } })} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(HIGHLIGHT_MS));
    expect(container.querySelector('[data-highlighted]')).toBeNull();
  });

  it('jumps without smooth scrolling for people who prefer reduced motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<MessageList {...props({ jumpTo: { id: 'M-2', seq: 3 } })} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
  });

  it('passes the quote handler to each bubble', () => {
    const onOpenQuote = vi.fn();
    const quoting = { ...item('M-3', 3) } as Extract<TimelineItem, { kind: 'message' }>;
    quoting.message = { ...quoting.message, quotedId: 'M-1' };
    const { getByTestId } = render(
      <MessageList {...props({ items: [item('M-1', 1), quoting], onOpenQuote })} />,
    );
    act(() => getByTestId('quote-jump').click());
    expect(onOpenQuote).toHaveBeenCalledWith('M-1');
  });
});

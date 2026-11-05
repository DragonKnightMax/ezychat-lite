import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Message, MessageListResponse } from '@ezychat/shared';
import { QUOTE_JUMP_MAX_PAGES, useQuoteJump } from './useQuoteJump';

const locate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('../api/queries', () => ({ locateMessage: locate }));
vi.mock('sonner', () => ({ toast }));

const JID = '60123456789@s.whatsapp.net';
const msg = (id: string) => ({ id }) as Message;
const page = (...ids: string[]): MessageListResponse => ({
  messages: ids.map(msg),
  nextBefore: null,
});

/** Older pages served one by one; the last one has no more after it. */
function olderPages(pages: MessageListResponse[], loaded: MessageListResponse[] = []) {
  const served = [...loaded];
  const fetchNextPage = vi.fn(async () => {
    const next = pages.shift();
    if (next) served.push(next);
    return { data: { pages: [...served] }, hasNextPage: pages.length > 0, isError: false };
  });
  return { hasNextPage: pages.length > 0, fetchNextPage };
}

afterEach(() => vi.clearAllMocks());

describe('useQuoteJump', () => {
  it('a loaded original is shown at once, without asking the server; a second tap scrolls again', async () => {
    const older = olderPages([]);
    const { result } = renderHook(() => useQuoteJump(JID, new Map([['Q1', msg('Q1')]]), older));
    await act(() => result.current.open('Q1'));
    expect(result.current.target).toEqual({ id: 'Q1', seq: 1 });
    await act(() => result.current.open('Q1'));
    expect(result.current.target).toEqual({ id: 'Q1', seq: 2 });
    expect(locate).not.toHaveBeenCalled();
  });

  it('an older original loads page by page until it is there', async () => {
    locate.mockResolvedValue({ found: true, newer: 120 });
    const older = olderPages([page('A', 'B'), page('Q1', 'C'), page('D')]);
    const { result } = renderHook(() => useQuoteJump(JID, new Map(), older));
    await act(() => result.current.open('Q1'));
    expect(locate).toHaveBeenCalledWith(JID, 'Q1');
    expect(older.fetchNextPage).toHaveBeenCalledTimes(2);
    expect(result.current.target).toEqual({ id: 'Q1', seq: 1 });
    expect(toast).not.toHaveBeenCalled();
  });

  it('an original not in our records loads nothing and says so', async () => {
    locate.mockResolvedValue({ found: false, newer: 0 });
    const older = olderPages([page('A')]);
    const { result } = renderHook(() => useQuoteJump(JID, new Map(), older));
    await act(() => result.current.open('GONE'));
    expect(older.fetchNextPage).not.toHaveBeenCalled();
    expect(result.current.target).toBeNull();
    expect(toast).toHaveBeenCalledWith("The original message isn't available");
  });

  it('stops after the pages the server counted (it says unavailable when history ends)', async () => {
    locate.mockResolvedValue({ found: true, newer: 10 });
    const older = olderPages([page('A'), page('B')]);
    const { result } = renderHook(() => useQuoteJump(JID, new Map(), older));
    await act(() => result.current.open('Q1'));
    // ceil(11 / 50) + 1 = 2 pages at most
    expect(older.fetchNextPage).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith("The original message isn't available");
  });

  it('never loads more than the cap, and says the original is too far back', async () => {
    locate.mockResolvedValue({ found: true, newer: 100_000 });
    const pages = Array.from({ length: QUOTE_JUMP_MAX_PAGES + 5 }, (_, i) => page(`P${i}`));
    const older = olderPages(pages);
    const { result } = renderHook(() => useQuoteJump(JID, new Map(), older));
    await act(() => result.current.open('Q1'));
    expect(older.fetchNextPage).toHaveBeenCalledTimes(QUOTE_JUMP_MAX_PAGES);
    expect(toast).toHaveBeenCalledWith('The original message is too far back to show here');
  });

  it('a failed lookup or page shows an error; taps while busy are ignored', async () => {
    let fail!: (e: Error) => void;
    locate.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    const older = olderPages([]);
    const { result } = renderHook(() => useQuoteJump(JID, new Map(), older));
    let first!: Promise<void>;
    act(() => {
      first = result.current.open('Q1');
    });
    await act(() => result.current.open('Q1'));
    expect(locate).toHaveBeenCalledTimes(1);
    await act(async () => {
      fail(new Error('offline'));
      await first;
    });
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the original message. Try again.");

    locate.mockResolvedValueOnce({ found: true, newer: 0 });
    const broken = {
      hasNextPage: true,
      fetchNextPage: vi.fn(async () => ({ data: { pages: [] }, hasNextPage: true, isError: true })),
    };
    const second = renderHook(() => useQuoteJump(JID, new Map(), broken));
    await act(() => second.result.current.open('Q1'));
    expect(broken.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  it('opening another chat clears the target', async () => {
    const { result, rerender } = renderHook(
      ({ jid }) => useQuoteJump(jid, new Map([['Q1', msg('Q1')]]), olderPages([])),
      { initialProps: { jid: JID } },
    );
    await act(() => result.current.open('Q1'));
    expect(result.current.target).not.toBeNull();
    rerender({ jid: '60999999999@s.whatsapp.net' });
    expect(result.current.target).toBeNull();
  });
});

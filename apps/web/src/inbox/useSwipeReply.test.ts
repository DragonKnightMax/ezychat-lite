import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSwipeReply } from './useSwipeReply';

type Handlers = ReturnType<typeof useSwipeReply>['handlers'];
const ev = (pointerType: string, clientX: number, clientY = 0) =>
  ({ pointerType, clientX, clientY, pointerId: 1 }) as unknown as React.PointerEvent<HTMLElement>;
const call = (h: Handlers, name: keyof Handlers, e = ev('touch', 0)) =>
  act(() => (h[name] as (e: unknown) => void)(e));

afterEach(() => vi.useRealTimers());

describe('useSwipeReply', () => {
  it('a right swipe past the threshold starts a reply; a short one does not', () => {
    const onReply = vi.fn();
    const { result } = renderHook(() => useSwipeReply(onReply));
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    call(result.current.handlers, 'onPointerMove', ev('touch', 40));
    call(result.current.handlers, 'onPointerUp');
    expect(onReply).not.toHaveBeenCalled();
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    call(result.current.handlers, 'onPointerMove', ev('touch', 30));
    call(result.current.handlers, 'onPointerMove', ev('touch', 90));
    expect(result.current.offset).toBe(72);
    call(result.current.handlers, 'onPointerUp');
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(result.current.offset).toBe(0);
  });

  it('a vertical move is a scroll, never a swipe', () => {
    const onReply = vi.fn();
    const { result } = renderHook(() => useSwipeReply(onReply));
    call(result.current.handlers, 'onPointerDown', ev('touch', 10, 10));
    call(result.current.handlers, 'onPointerMove', ev('touch', 20, 60));
    call(result.current.handlers, 'onPointerMove', ev('touch', 100, 60));
    call(result.current.handlers, 'onPointerUp');
    expect(onReply).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
  });

  it('press and hold starts a reply; the mouse never does', () => {
    vi.useFakeTimers();
    const onReply = vi.fn();
    const { result } = renderHook(() => useSwipeReply(onReply));
    call(result.current.handlers, 'onPointerDown', ev('mouse', 10));
    act(() => vi.advanceTimersByTime(600));
    expect(onReply).not.toHaveBeenCalled();
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    act(() => vi.advanceTimersByTime(600));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('with onLongPress, press and hold opens it instead; a swipe still replies', () => {
    vi.useFakeTimers();
    const onReply = vi.fn();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useSwipeReply(onReply, onLongPress));
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    act(() => vi.advanceTimersByTime(600));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    call(result.current.handlers, 'onPointerMove', ev('touch', 30));
    call(result.current.handlers, 'onPointerMove', ev('touch', 90));
    call(result.current.handlers, 'onPointerUp');
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('remembers that the last touch was a long press or a swipe, not a tap', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSwipeReply(vi.fn(), vi.fn()));
    expect(result.current.wasGesture()).toBe(false);
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.wasGesture()).toBe(true);
    // a plain tap clears it
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    call(result.current.handlers, 'onPointerUp');
    expect(result.current.wasGesture()).toBe(false);
    // a sideways swipe counts too, even a short one
    call(result.current.handlers, 'onPointerDown', ev('touch', 10));
    call(result.current.handlers, 'onPointerMove', ev('touch', 30));
    call(result.current.handlers, 'onPointerUp');
    expect(result.current.wasGesture()).toBe(true);
  });
});

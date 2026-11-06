import type React from 'react';
import { useEffect, useRef, useState } from 'react';

/** Swipe distance (px) that starts a reply, and the furthest the bubble follows the finger. */
export const SWIPE_TRIGGER_PX = 56;
const SWIPE_MAX_PX = 72;
const LONG_PRESS_MS = 500;
/** Movement that cancels a long press (the finger is scrolling or swiping instead). */
const MOVE_TOLERANCE_PX = 8;

/**
 * Touch gestures that start a reply, like WhatsApp: swipe the message right, or press and hold.
 * Mouse and pen are ignored (desktop uses the Reply button). Vertical movement keeps scrolling.
 * Proposed (send-reactions): with `onLongPress`, press-and-hold calls it instead (the reaction bar,
 * which offers Reply too).
 */
export function useSwipeReply(onReply: (() => void) | undefined, onLongPress?: () => void) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; id: number; horizontal: boolean } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  useEffect(() => clearHold, []);

  const reset = () => {
    clearHold();
    start.current = null;
    setOffset(0);
  };

  const handlers: React.HTMLAttributes<HTMLElement> = onReply
    ? {
        onPointerDown(e) {
          if (e.pointerType !== 'touch') return;
          start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: false };
          clearHold();
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null;
            start.current = null;
            setOffset(0);
            (onLongPress ?? onReply)();
          }, LONG_PRESS_MS);
        },
        onPointerMove(e) {
          const s = start.current;
          if (!s || e.pointerId !== s.id) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (Math.abs(dx) > MOVE_TOLERANCE_PX || Math.abs(dy) > MOVE_TOLERANCE_PX) clearHold();
          if (!s.horizontal) {
            // Decide once: a mostly vertical move is a scroll and never becomes a swipe.
            if (Math.abs(dy) > MOVE_TOLERANCE_PX && Math.abs(dy) >= Math.abs(dx)) {
              start.current = null;
              return;
            }
            if (dx > MOVE_TOLERANCE_PX) s.horizontal = true;
          }
          if (s.horizontal) setOffset(Math.max(0, Math.min(dx, SWIPE_MAX_PX)));
        },
        onPointerUp() {
          const fire = start.current?.horizontal && offset >= SWIPE_TRIGGER_PX;
          reset();
          if (fire) onReply();
        },
        onPointerCancel: reset,
      }
    : {};

  return { offset, handlers };
}

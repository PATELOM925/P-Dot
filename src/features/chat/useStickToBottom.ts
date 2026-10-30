"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Within this many pixels of the end, the list counts as "at the bottom" and follows new text. */
export const STICK_PX = 80;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearBottom(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < STICK_PX;
}

/**
 * The scroll rule without React, so it is testable: `onScroll` records whether
 * the user is at the bottom, `onContent` follows new content only there, and
 * `jump` goes to the end.
 */
export function createStickController(options: {
  metrics: () => ScrollMetrics | null;
  scrollToEnd: () => void;
  onAwayChange: (away: boolean) => void;
  schedule: (task: () => void) => void;
}) {
  // `atBottom` is read on every scroll event, so new content never fights a user who just
  // scrolled up. The visible "away" state changes at most once for each animation frame.
  let atBottom = true;
  let away = false;
  let pending = false;
  const setAway = (next: boolean) => {
    if (next === away) return;
    away = next;
    options.onAwayChange(next);
  };
  return {
    onScroll() {
      const metrics = options.metrics();
      if (metrics) atBottom = isNearBottom(metrics);
      if (pending) return;
      pending = true;
      options.schedule(() => {
        pending = false;
        setAway(!atBottom);
      });
    },
    onContent() {
      if (atBottom) options.scrollToEnd();
    },
    jump() {
      atBottom = true;
      options.scrollToEnd();
      setAway(false);
    },
  };
}

/**
 * Follows new content only while the user is at the bottom. When they scroll up
 * (during a reply or after it), the list stays still and `showJump` turns on.
 * `jump()` goes to the end, for the "Jump to latest" button and after a send.
 */
export function useStickToBottom(listRef: RefObject<HTMLElement | null>, content: unknown) {
  const [showJump, setShowJump] = useState(false);
  const controller = useRef<ReturnType<typeof createStickController> | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const stick = createStickController({
      metrics: () => list,
      scrollToEnd: () => {
        list.scrollTop = list.scrollHeight;
      },
      onAwayChange: setShowJump,
      schedule: (task) => window.requestAnimationFrame(task),
    });
    controller.current = stick;
    const onScroll = () => stick.onScroll();
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      list.removeEventListener("scroll", onScroll);
      controller.current = null;
    };
  }, [listRef]);

  useEffect(() => {
    controller.current?.onContent();
  }, [content]);

  const jump = useCallback(() => controller.current?.jump(), []);
  return { showJump, jump };
}

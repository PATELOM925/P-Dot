"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Within this many pixels of the end, the list counts as "at the bottom" and follows new text. */
export const STICK_PX = 80;

export function isNearBottom(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < STICK_PX;
}

/**
 * Follows new content only while the user is at the bottom. When they scroll up
 * to read, the list stays still and `showJump` turns on. `jump()` goes to the end,
 * for the "Jump to latest" button and after a send.
 */
export function useStickToBottom(listRef: RefObject<HTMLElement | null>, content: unknown) {
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      atBottom.current = isNearBottom(list);
      if (atBottom.current) setShowJump(false);
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [listRef]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (atBottom.current) list.scrollTop = list.scrollHeight;
    else if (!isNearBottom(list)) setShowJump(true);
  }, [listRef, content]);

  const jump = useCallback(() => {
    const list = listRef.current;
    atBottom.current = true;
    setShowJump(false);
    if (list) list.scrollTop = list.scrollHeight;
  }, [listRef]);

  return { showJump, jump };
}

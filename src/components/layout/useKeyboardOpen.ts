"use client";

import { useEffect, useState } from "react";

/** A phone keyboard takes at least this much of the screen. Browser bars that hide on scroll take less. */
const KEYBOARD_MIN_PX = 150;
/** The tabs come back only after the keyboard has closed, so a tap that closes it cannot miss its target. */
const SHOW_DELAY_MS = 250;

/**
 * True when the visual viewport is much shorter than the layout viewport: an
 * on-screen keyboard covers the page. Pinch zoom also makes the visual
 * viewport shorter, so the height is read at a scale of 1.
 */
export function isKeyboardOpen(layoutHeight: number, viewportHeight: number, scale: number): boolean {
  return layoutHeight - viewportHeight * scale > KEYBOARD_MIN_PX;
}

/**
 * Reads the keyboard from VisualViewport resizes, never from focus. A focus
 * rule hid the tabs on blur, the layout moved, and a tap on Send missed.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (isKeyboardOpen(window.innerHeight, viewport.height, viewport.scale)) setOpen(true);
      else timer = setTimeout(() => setOpen(false), SHOW_DELAY_MS);
    };
    update();
    viewport.addEventListener("resize", update);
    return () => {
      clearTimeout(timer);
      viewport.removeEventListener("resize", update);
    };
  }, []);
  return open;
}

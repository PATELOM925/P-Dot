import { useEffect, useRef, useState } from "react";

/**
 * Calls `reset` when the browser shows this page again from the back/forward
 * cache. That cache keeps the page as it was when the user left, so a button
 * that was disabled while it navigated stays disabled after Back.
 */
export function onRestoreFromBackForwardCache(target: EventTarget, reset: () => void): () => void {
  function listener(event: Event) {
    if ((event as PageTransitionEvent).persisted) reset();
  }
  target.addEventListener("pageshow", listener);
  return () => target.removeEventListener("pageshow", listener);
}

/** Runs `reset` each time the page comes back from the back/forward cache. */
export function useResetOnPageShow(reset: () => void): void {
  const latest = useRef(reset);
  useEffect(() => {
    latest.current = reset;
  });
  useEffect(() => onRestoreFromBackForwardCache(window, () => latest.current()), []);
}

/**
 * A number that changes each time the page comes back from the back/forward
 * cache. Use it as a `key` to remount a form whose pending state React owns
 * (`useActionState`, `useFormStatus`).
 */
export function usePageShowKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => onRestoreFromBackForwardCache(window, () => setKey((value) => value + 1)), []);
  return key;
}

"use client";

import { useEffect, useRef } from "react";

/**
 * A status message that takes focus once when it appears, so keyboard and
 * screen reader users hear the result of a Connect or Disconnect redirect.
 */
export function FocusedMessage({ text, error }: { text: string; error: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p ref={ref} tabIndex={-1} className={error ? "alert alert-error" : "alert alert-notice"} role={error ? "alert" : "status"}>
      {text}
    </p>
  );
}

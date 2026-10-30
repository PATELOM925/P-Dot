"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { usePopover } from "./usePopover";

/**
 * A small (i) button that opens a short note. A native <details>, so it works
 * with the keyboard and without script; with script, Escape and a tap outside
 * close it.
 */
export function InfoNote({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const close = useCallback(() => {
    if (detailsRef.current) detailsRef.current.open = false;
    setOpen(false);
  }, []);
  usePopover({ open, menuRef: detailsRef, triggerRef: summaryRef, onClose: close });
  return (
    <details ref={detailsRef} className="info-note" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} aria-label={label} title={label}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.01" />
        </svg>
      </summary>
      <div className="info-note-body">{children}</div>
    </details>
  );
}

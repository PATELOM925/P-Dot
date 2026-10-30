"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useModal } from "@/components/ui/useModal";
import { usePopover } from "@/components/ui/usePopover";
import { signOutAction } from "@/features/auth/actions";
import { WaitingApprovalsBadge } from "@/features/actions/WaitingApprovalsBadge";

const TABS = [
  { href: "/today", label: "Today" },
  { href: "/chat", label: "Chat" },
  { href: "/memory", label: "Memory" },
];

const MORE = [
  { href: "/workflows", label: "Workflows" },
  { href: "/connectors", label: "Connectors" },
  { href: "/action-log", label: "Action log" },
  { href: "/devices", label: "Devices" },
  { href: "/settings", label: "Settings" },
];

/** Phones only (CSS): 4 tabs at the bottom, and a "More" sheet with the other pages and sign-out. */
export function BottomNav({ trial }: { trial: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopover({ open, menuRef: sheetRef, triggerRef: moreRef, onClose: close });
  useModal(open, sheetRef, backdropRef);

  // Focus moves into the sheet, and back to "More" after the render that takes `inert` off the nav.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      doneRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      moreRef.current?.focus();
    }
  }, [open]);

  const moreActive = MORE.some((link) => pathname === link.href);

  return (
    <>
      <nav aria-label="Workspace" className="bottom-nav">
        {TABS.map((tab) => (
          <Link key={tab.href} href={tab.href} className="bottom-tab" aria-current={pathname === tab.href ? "page" : undefined}>
            {tab.label}
            {tab.href === "/today" && <WaitingApprovalsBadge />}
          </Link>
        ))}
        <button
          ref={moreRef}
          type="button"
          className="bottom-tab"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? "more-sheet" : undefined}
          aria-current={moreActive ? "page" : undefined}
          onClick={() => setOpen(!open)}
        >
          More
        </button>
      </nav>
      {open && (
        <>
          <div ref={backdropRef} className="sheet-backdrop" aria-hidden="true" />
          <div id="more-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label="More pages" className="sheet">
            <div className="sheet-head">
              <p className="sheet-title">More</p>
              <button
                ref={doneRef}
                type="button"
                className="button button-small"
                onClick={() => setOpen(false)}
              >
                Done
              </button>
            </div>
            <ul className="sheet-list">
              {MORE.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="sheet-row"
                    aria-current={pathname === link.href ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <form action={signOutAction}>
                  <button type="submit" className="sheet-row sheet-row-button">
                    {trial ? "End trial" : "Sign out"}
                  </button>
                </form>
              </li>
            </ul>
          </div>
        </>
      )}
    </>
  );
}

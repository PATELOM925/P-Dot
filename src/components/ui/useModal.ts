"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes an open dialog modal: everything outside it is inert, the page behind
 * does not scroll, and Tab and Shift+Tab cycle inside it. All of it is undone on
 * close and on unmount. The caller handles Escape and where focus goes.
 */
export function useModal(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  /** Elements that stay active, such as the backdrop that closes the dialog on a tap. */
  backdropRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const backdrop = backdropRef?.current ?? null;

    // Every sibling of the dialog and of each of its ancestors, up to <body>.
    const madeInert: HTMLElement[] = [];
    for (let node: HTMLElement | null = dialog; node && node !== document.body; node = node.parentElement) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node || sibling === backdrop || !(sibling instanceof HTMLElement) || sibling.inert) continue;
        sibling.inert = true;
        madeInert.push(sibling);
      }
    }

    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      for (const element of madeInert) element.inert = false;
      document.body.style.overflow = overflow;
    };
  }, [open, dialogRef, backdropRef]);
}

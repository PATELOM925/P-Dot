"use client";

import { useEffect, type RefObject } from "react";

/**
 * Close rules shared by the composer menus: a pointer down outside the menu
 * and its trigger closes it without moving focus; Escape closes it and returns
 * focus to the trigger; a window resize closes it.
 */
export function usePopover({
  open,
  menuRef,
  triggerRef,
  onClose,
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };
    const onResize = () => onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, menuRef, triggerRef, onClose]);
}

/** Arrow, Home and End keys move focus between the menu's items. */
export function moveMenuFocus(event: React.KeyboardEvent<HTMLElement>, selector: string): void {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: number | null = null;
  if (event.key === "ArrowDown") next = (index + 1) % items.length;
  else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

"use client";

import { useCallback, useRef, type RefObject } from "react";
import { moveMenuFocus, usePopover } from "@/components/ui/usePopover";

/**
 * One row in the "+" menu and, while it is on, one chip above the text. The
 * composer builds the list, so a new tool (an app, Google) is one more item.
 */
export interface ToolItem {
  key: string;
  title: string;
  description: string;
  /** Short name on the chip. */
  chip: string;
  chipClass: "chip-web" | "chip-deep" | "chip-app";
  icon: "web" | "deep" | "app";
  on: boolean;
}

function ToolIcon({ icon }: { icon: ToolItem["icon"] }) {
  if (icon === "web") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
      </svg>
    );
  }
  if (icon === "app") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M9 12h6M12 9v6" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/**
 * The "+" button and its menu. The menu opens above the message box (it is
 * placed against `.composer-box`), so it never covers the text. A click or
 * Enter on a row toggles it and closes the menu; Space toggles and keeps it open.
 */
export function ToolsMenu({
  open,
  onOpenChange,
  items,
  onToggle,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ToolItem[];
  onToggle: (key: string) => void;
  disabled: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dismiss = useCallback(() => onOpenChange(false), [onOpenChange]);
  usePopover({ open, menuRef, triggerRef, onClose: dismiss });

  const closeToTrigger = () => {
    onOpenChange(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="tools-anchor">
      {open && (
        <div
          id="composer-tools"
          ref={menuRef}
          role="menu"
          aria-label="Tools for this message"
          className="tools-menu"
          onKeyDown={(event) => moveMenuFocus(event, '[role="menuitemcheckbox"]')}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.on}
              className="tool-row"
              data-tool={item.icon}
              autoFocus={index === 0}
              onKeyDown={(event) => {
                if (event.key === " ") {
                  event.preventDefault();
                  onToggle(item.key);
                }
              }}
              onClick={() => {
                onToggle(item.key);
                closeToTrigger();
              }}
            >
              <ToolIcon icon={item.icon} />
              <span className="tool-row-text">
                <span className="tool-row-title">{item.title}</span>
                <span className="tool-row-description">{item.description}</span>
              </span>
              <span className="tool-switch" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="round-button"
        aria-label="Tools for this message"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "composer-tools" : undefined}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}

/** One chip for each tool that is on, above the text. A chip press turns its tool off. */
export function ToolChips({
  items,
  onToggle,
  disabled,
  inputRef,
}: {
  items: ToolItem[];
  onToggle: (key: string) => void;
  disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const active = items.filter((item) => item.on);
  if (active.length === 0) return null;
  return (
    <div className="composer-chips" role="group" aria-label="On for this message">
      {active.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`composer-chip ${item.chipClass}`}
          aria-label={`${item.chip} is on. Turn off`}
          disabled={disabled}
          onClick={() => {
            onToggle(item.key);
            inputRef.current?.focus();
          }}
        >
          <ToolIcon icon={item.icon} />
          {item.chip}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      ))}
    </div>
  );
}

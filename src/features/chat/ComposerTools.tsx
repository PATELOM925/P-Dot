"use client";

import { useCallback, useRef, type RefObject } from "react";
import { BrandMark } from "@/components/ui/BrandMark";
import type { BrandId } from "@/components/ui/brand-marks";
import { moveMenuFocus, usePopover } from "@/components/ui/usePopover";
import { MODE_LABELS } from "@/lib/mode";
import type { Mode } from "@/types/api";

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
  icon: "web" | "deep" | "app" | "google";
  /** The service's brand mark, shown in place of the icon. */
  brand?: BrandId;
  on: boolean;
  /** The tool cannot turn on here. With `href`, the row is a link to the page that sets it up. */
  unavailable?: { href?: string };
  /** A source that can be on with others (decision 0021): a checkbox, and the menu stays open after a click. */
  checkbox?: true;
}

/** One part of the "+" menu. The label is for screen readers; a line separates the parts. */
export interface ToolGroup {
  label: string;
  items: ToolItem[];
}

/** Personal or Work in the "+" menu: the same switch as the header. */
export interface ModeRows {
  current: Mode;
  /** True when a conversation is open: it keeps its mode, so the other mode starts a new chat. */
  inConversation: boolean;
  pending: boolean;
  onSelect: (mode: Mode) => void;
}

const MODES: Mode[] = ["personal", "work"];

function modeDescription(rows: ModeRows, value: Mode): string {
  const current = MODE_LABELS[rows.current];
  if (value === rows.current) return rows.inConversation ? `This chat is in ${current}.` : "For this new chat.";
  return rows.inConversation ? `Starts a new chat. This chat stays ${current}.` : `Use ${MODE_LABELS[value]} for this new chat.`;
}

function ToolIcon({ icon, brand }: { icon: ToolItem["icon"]; brand?: BrandId }) {
  if (brand) return <BrandMark brand={brand} />;
  if (icon === "web") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
      </svg>
    );
  }
  if (icon === "google") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
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
 * placed against `.composer-box`), so it never covers the text. A source row
 * is a checkbox: a click toggles it and keeps the menu open, so the user can
 * tick several. Another row toggles and closes the menu on a click or Enter.
 * Space toggles any row and keeps the menu open.
 */
export function ToolsMenu({
  open,
  onOpenChange,
  groups,
  onToggle,
  disabled,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: ToolGroup[];
  onToggle: (key: string) => void;
  disabled: boolean;
  /** Personal and Work rows at the end of the menu. Missing: no mode rows. */
  mode?: ModeRows;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dismiss = useCallback(() => onOpenChange(false), [onOpenChange]);
  usePopover({ open, menuRef, triggerRef, onClose: dismiss });

  const closeToTrigger = () => {
    onOpenChange(false);
    triggerRef.current?.focus();
  };
  const firstKey = groups.find((group) => group.items.length > 0)?.items[0]?.key;

  return (
    <div className="tools-anchor">
      {open && (
        <div
          id="composer-tools"
          ref={menuRef}
          role="menu"
          aria-label="Tools for this message"
          className="tools-menu"
          onKeyDown={(event) => moveMenuFocus(event, '[role^="menuitem"]')}
        >
          {groups
            .filter((group) => group.items.length > 0)
            .map((group, groupIndex) => (
              <div key={group.label} role="group" aria-label={group.label} className={groupIndex > 0 ? "tools-group tools-group-next" : "tools-group"}>
                {group.items.map((item) =>
                  item.unavailable?.href ? (
                    <a
                      key={item.key}
                      role="menuitem"
                      className="tool-row"
                      data-tool={item.icon}
                      href={item.unavailable.href}
                      autoFocus={item.key === firstKey}
                    >
                      <ToolIcon icon={item.icon} brand={item.brand} />
                      <span className="tool-row-text">
                        <span className="tool-row-title">{item.title}</span>
                        <span className="tool-row-description">{item.description}</span>
                      </span>
                      <span className="tool-row-go" aria-hidden="true">
                        ›
                      </span>
                    </a>
                  ) : (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={item.on}
                      aria-disabled={item.unavailable ? true : undefined}
                      className="tool-row"
                      data-tool={item.icon}
                      autoFocus={item.key === firstKey}
                      onKeyDown={(event) => {
                        if (event.key === " ") {
                          event.preventDefault();
                          if (!item.unavailable) onToggle(item.key);
                        }
                      }}
                      onClick={() => {
                        if (item.unavailable) return;
                        onToggle(item.key);
                        if (!item.checkbox) closeToTrigger();
                      }}
                    >
                      <ToolIcon icon={item.icon} brand={item.brand} />
                      <span className="tool-row-text">
                        <span className="tool-row-title">{item.title}</span>
                        <span className="tool-row-description">{item.description}</span>
                      </span>
                      <span className={item.checkbox ? "tool-check" : "tool-switch"} aria-hidden="true" />
                    </button>
                  ),
                )}
              </div>
            ))}
          {mode && (
            <div role="group" aria-label="Mode" className="tools-group tools-group-next">
              {MODES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode.current === value}
                  aria-disabled={mode.pending ? true : undefined}
                  className="tool-row"
                  data-mode={value}
                  onClick={() => {
                    if (mode.pending) return;
                    if (value !== mode.current) mode.onSelect(value);
                    closeToTrigger();
                  }}
                >
                  <span className="tool-mode-dot" data-mode={value} aria-hidden="true" />
                  <span className="tool-row-text">
                    <span className="tool-row-title">{MODE_LABELS[value]} mode</span>
                    <span className="tool-row-description">{modeDescription(mode, value)}</span>
                  </span>
                  <span className="tool-radio" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
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
          <ToolIcon icon={item.icon} brand={item.brand} />
          {item.chip}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      ))}
    </div>
  );
}

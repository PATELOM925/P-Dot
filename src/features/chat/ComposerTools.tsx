"use client";

import { useCallback, useRef, type RefObject } from "react";
import { moveMenuFocus, usePopover } from "@/components/ui/usePopover";

export interface ComposerToolState {
  webSearch: boolean;
  deep: boolean;
}

type ToolKey = keyof ComposerToolState;

const TOOLS: { key: ToolKey; title: string; description: string; chip: string; chipClass: string }[] = [
  {
    key: "webSearch",
    title: "Search the web",
    description: "Current pages, with sources.",
    chip: "Web search",
    chipClass: "chip-web",
  },
  {
    key: "deep",
    title: "Think harder",
    description: "Stronger model. Slower. This message only.",
    chip: "Think harder",
    chipClass: "chip-deep",
  },
];

function ToolIcon({ tool }: { tool: ToolKey }) {
  return tool === "webSearch" ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </svg>
  ) : (
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
  tools,
  onToggle,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tools: ComposerToolState;
  onToggle: (tool: ToolKey) => void;
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
          {TOOLS.map((tool, index) => (
            <button
              key={tool.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={tools[tool.key]}
              className="tool-row"
              data-tool={tool.key}
              autoFocus={index === 0}
              onKeyDown={(event) => {
                if (event.key === " ") {
                  event.preventDefault();
                  onToggle(tool.key);
                }
              }}
              onClick={() => {
                onToggle(tool.key);
                closeToTrigger();
              }}
            >
              <ToolIcon tool={tool.key} />
              <span className="tool-row-text">
                <span className="tool-row-title">{tool.title}</span>
                <span className="tool-row-description">{tool.description}</span>
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
  tools,
  onToggle,
  disabled,
  inputRef,
}: {
  tools: ComposerToolState;
  onToggle: (tool: ToolKey) => void;
  disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const active = TOOLS.filter((tool) => tools[tool.key]);
  if (active.length === 0) return null;
  return (
    <div className="composer-chips" role="group" aria-label="On for this message">
      {active.map((tool) => (
        <button
          key={tool.key}
          type="button"
          className={`composer-chip ${tool.chipClass}`}
          aria-label={`${tool.chip} is on. Turn off`}
          disabled={disabled}
          onClick={() => {
            onToggle(tool.key);
            inputRef.current?.focus();
          }}
        >
          <ToolIcon tool={tool.key} />
          {tool.chip}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      ))}
    </div>
  );
}

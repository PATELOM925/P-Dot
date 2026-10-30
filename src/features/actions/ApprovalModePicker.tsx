"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePopover } from "@/components/ui/usePopover";
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, MAX_AUTO_ACTIONS_PER_REPLY, type ApprovalMode } from "@/lib/approval-policy";
import { setApprovalMode, useApprovalMode, useApprovalModeChosen } from "./approval-mode";

const DESCRIPTIONS: Record<ApprovalMode, string> = {
  manual: "Every action waits for your OK. Recommended.",
  auto: `Tasks and reminders are added on their own (up to ${MAX_AUTO_ACTIONS_PER_REPLY} per reply), with Undo. Deleting, memories, outside accounts and private data still ask.`,
};

function ModeIcon({ mode }: { mode: ApprovalMode }) {
  return mode === "auto" ? (
    // A bolt: acts on its own.
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  ) : (
    // A shield with a check: waits for your OK.
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/**
 * The two modes as radio cards with what each does. Used in Settings, in the
 * first-run setup and in the composer menu. `onPicked` runs after a choice.
 */
export function ApprovalModeOptions({ onPicked }: { onPicked?: () => void }) {
  const mode = useApprovalMode();
  const name = useId();
  return (
    <div role="radiogroup" aria-label="When P-Dot acts" className="approval-options">
      {APPROVAL_MODES.map((value) => (
        <label key={value} className="approval-option" data-approval={value}>
          <input
            type="radio"
            name={name}
            value={value}
            checked={mode === value}
            onChange={() => {
              setApprovalMode(value);
              onPicked?.();
            }}
          />
          <span className="approval-option-body">
            <span className="approval-option-title">
              <ModeIcon mode={value} /> {APPROVAL_MODE_LABELS[value]}
            </span>
            <span className="hint">{DESCRIPTIONS[value]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Next to the message box: one button that always shows the current mode and
 * opens a small menu to change it. Works the same with touch, mouse and keyboard.
 */
export function ApprovalModeMenu({
  open: openProp,
  onOpenChange,
  disabled = false,
}: {
  /** Controlled by the composer, so only one of its menus is open at a time. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const mode = useApprovalMode();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (next: boolean) => {
      if (onOpenChange) onOpenChange(next);
      else setOpenState(next);
    },
    [onOpenChange],
  );
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dismiss = useCallback(() => setOpen(false), [setOpen]);
  usePopover({ open, menuRef, triggerRef: buttonRef, onClose: dismiss });

  // Focus goes into the menu when it opens: to the chosen mode.
  useEffect(() => {
    if (!open) return;
    const radios = menuRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const checked = Array.from(radios ?? []).find((radio) => radio.checked) ?? radios?.[0];
    checked?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="tools-anchor approval-anchor">
      {open && (
        <div id={menuId} ref={menuRef} role="dialog" aria-label="When P-Dot acts" className="tools-menu approval-menu">
          <p className="approval-menu-title">When P-Dot acts</p>
          <ApprovalModeOptions onPicked={close} />
          <Link href="/settings#approvals" className="small" onClick={() => setOpen(false)}>
            What always asks
          </Link>
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        className="chip-button approval-mode-button"
        data-approval={mode}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Approvals: ${APPROVAL_MODE_LABELS[mode]}. Change`}
        title="Choose whether P-Dot asks before every action"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <ModeIcon mode={mode} />
        <span>{APPROVAL_MODE_LABELS[mode]}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <path d="m6 15 6-6 6 6" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Shown once in chat on a device where no mode was chosen yet. Choosing either
 * mode, or keeping the default, hides it for good on this device.
 */
export function ApprovalModeSetup({ onChoose }: { onChoose: () => void }) {
  const chosen = useApprovalModeChosen();
  if (chosen) return null;
  return (
    <p className="approval-setup-line">
      <span>P-Dot asks before it acts. You can let it add tasks and reminders on its own.</span>
      <button type="button" className="link-button small" onClick={onChoose}>
        Choose
      </button>
      <button type="button" className="link-button small" onClick={() => setApprovalMode("manual")}>
        Keep Ask first
      </button>
    </p>
  );
}

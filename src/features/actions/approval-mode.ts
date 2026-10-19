"use client";

// The user's choice between "Ask first" and "Auto", kept on this device. The
// server does not store it yet (decision 0011); until it does, a new device
// starts in "Ask first", the safe default.
import { useSyncExternalStore } from "react";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE, parseApprovalMode, type ApprovalMode } from "@/lib/approval-policy";

const STORAGE_KEY = "pdot.approvalMode";
const listeners = new Set<() => void>();
/** Used when storage refuses the write, so this page still follows the choice until it reloads. */
let memoryFallback: ApprovalMode | null = null;

function stored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked (private windows, strict settings).
    return null;
  }
}

function read(): ApprovalMode {
  return memoryFallback ?? parseApprovalMode(stored());
}

/** True once the user picked a mode on this device. With storage blocked, true after a pick on this page. */
function chosen(): boolean {
  if (memoryFallback) return true;
  const value = stored();
  return (APPROVAL_MODES as readonly string[]).includes(value ?? "");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setApprovalMode(mode: ApprovalMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    memoryFallback = mode;
  }
  for (const listener of listeners) listener();
}

export function useApprovalMode(): ApprovalMode {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_APPROVAL_MODE);
}

/**
 * Whether the user already chose a mode here. The server render says yes, so
 * the one-time setup card appears only after the browser has checked.
 */
export function useApprovalModeChosen(): boolean {
  return useSyncExternalStore(subscribe, chosen, () => true);
}

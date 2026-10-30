"use client";

import { useSyncExternalStore } from "react";
import { ACTION_LIST_LIMIT } from "@/lib/limits";
import { fetchActions } from "./api";
import { onActionsChanged } from "./events";

// One shared count for every badge on the page (the top nav and the phone tabs),
// so the page loads it once, not once for each badge.
let count = 0;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function startLoading(): () => void {
  let controller: AbortController | null = null;
  const load = () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    // A failed load keeps the last count; the Today page shows the full list and its errors.
    fetchActions("proposed", current.signal).then(
      (waiting) => {
        count = waiting.length;
        for (const listener of listeners) listener();
      },
      () => {},
    );
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") load();
  };
  load();
  const stopListening = onActionsChanged(load);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopListening();
    document.removeEventListener("visibilitychange", onVisible);
    controller?.abort();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) stop = startLoading();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stop) {
      stop();
      stop = null;
    }
  };
}

/**
 * How many proposals wait for approval, in both modes, shown on the Today
 * link. It reloads after a decision or a chat reply, and when the user comes
 * back to the tab. Nothing is shown while the count is unknown or zero.
 */
export function WaitingApprovalsBadge() {
  const waiting = useSyncExternalStore(
    subscribe,
    () => count,
    () => 0,
  );

  if (waiting === 0) return null;
  const shown = waiting >= ACTION_LIST_LIMIT ? `${ACTION_LIST_LIMIT - 1}+` : String(waiting);
  return (
    <>
      <span className="nav-badge" aria-hidden="true">
        {shown}
      </span>
      <span className="visually-hidden">
        , {shown} {waiting === 1 ? "action" : "actions"} waiting for your approval
      </span>
    </>
  );
}

"use client";

// The Today layout in this browser's storage, read with useSyncExternalStore.
// The server and the first client render use the default layout, so hydration
// matches; the stored layout follows right after.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { layoutKey, layoutReducer, parseLayout, serializeLayout, type LayoutAction, type TodayLayout } from "./layout";

const listeners = new Set<() => void>();
/** Used when storage refuses a write, so this page still follows the choice until it reloads. */
const memoryFallback = new Map<string, string | null>();

function read(key: string): string | null {
  if (memoryFallback.has(key)) return memoryFallback.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    memoryFallback.delete(key);
  } catch {
    memoryFallback.set(key, value);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useTodayLayout(userId: string): [TodayLayout, (action: LayoutAction) => void] {
  const key = layoutKey(userId);
  const raw = useSyncExternalStore(subscribe, () => read(key), () => null);
  const layout = useMemo(() => parseLayout(raw), [raw]);
  const dispatch = useCallback(
    (action: LayoutAction) => {
      if (action.type === "reset") return write(key, null);
      const current = parseLayout(read(key));
      const next = layoutReducer(current, action);
      if (next !== current) write(key, serializeLayout(next));
    },
    [key],
  );
  return [layout, dispatch];
}

let arranging = false;

/** Arrange mode is for this page view only; it is not stored. */
export function useArranging(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => arranging, () => false);
  const set = useCallback((on: boolean) => {
    arranging = on;
    for (const listener of listeners) listener();
  }, []);
  return [value, set];
}

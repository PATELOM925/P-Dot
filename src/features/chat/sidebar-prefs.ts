"use client";

// Chat sidebar choices kept on this device: whether the desktop list is
// hidden, and which conversations are pinned. The server does not store them
// yet, so a new device starts with the list shown and nothing pinned.
import { useMemo, useSyncExternalStore } from "react";

export const MAX_PINS = 50;
const COLLAPSED_KEY = "pdot.chatSidebar";
const pinsKey = (userId: string) => `pdot.pins.${userId}`;

const listeners = new Set<() => void>();
/** Used when storage refuses a write, so this page still follows the choice until it reloads. */
const memoryFallback = new Map<string, string>();

function stored(key: string): string | null {
  if (memoryFallback.has(key)) return memoryFallback.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage can be blocked (private windows, strict settings).
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
    memoryFallback.delete(key);
  } catch {
    memoryFallback.set(key, value);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed it.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Reads a stored list of pinned IDs. Anything that is not a list of strings counts as no pins. */
export function parsePins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, MAX_PINS) : [];
  } catch {
    return [];
  }
}

/** Pinned conversations first, newest pin at the top; the rest keep the server's order. */
export function orderByPins<T extends { id: string }>(list: readonly T[], pins: readonly string[]): T[] {
  if (pins.length === 0) return [...list];
  const byId = new Map(list.map((item) => [item.id, item]));
  const pinned = pins.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
  const pinnedIds = new Set(pinned.map((item) => item.id));
  return [...pinned, ...list.filter((item) => !pinnedIds.has(item.id))];
}

/** Adds the ID at the top, or removes it. Keeps at most MAX_PINS. */
export function togglePin(pins: readonly string[], id: string): string[] {
  return pins.includes(id) ? pins.filter((pin) => pin !== id) : [id, ...pins].slice(0, MAX_PINS);
}

export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, () => stored(COLLAPSED_KEY) === "collapsed", () => false);
  return [collapsed, (next) => store(COLLAPSED_KEY, next ? "collapsed" : "open")];
}

export function usePins(userId: string): { pins: string[]; toggle: (id: string) => void; unpin: (id: string) => void } {
  const key = pinsKey(userId);
  const raw = useSyncExternalStore(subscribe, () => stored(key), () => null);
  const pins = useMemo(() => parsePins(raw), [raw]);
  return {
    pins,
    toggle: (id) => store(key, JSON.stringify(togglePin(parsePins(stored(key)), id))),
    unpin: (id) => {
      const current = parsePins(stored(key));
      if (current.includes(id)) store(key, JSON.stringify(current.filter((pin) => pin !== id)));
    },
  };
}

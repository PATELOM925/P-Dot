"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** False during server rendering and hydration, true afterwards. */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

let clock = 0;

function subscribeClock(onChange: () => void) {
  const timer = setInterval(() => {
    clock = Date.now();
    onChange();
  }, 60_000);
  return () => clearInterval(timer);
}

function readClock(): number {
  if (clock === 0) clock = Date.now();
  return clock;
}

/** The current time, updated every minute. Null during server rendering and hydration. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribeClock, readClock, () => null);
}

const FORMATS = {
  dateTime: { dateStyle: "medium", timeStyle: "short" },
  date: { dateStyle: "medium" },
  time: { timeStyle: "short" },
  /** "Wed, Nov 4, 2026, 10:00 AM EST": the weekday and the time zone, for an event on an approval card. */
  dateTimeZone: { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export function formatLocal(iso: string, style: keyof typeof FORMATS = "dateTime"): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat(undefined, FORMATS[style]).format(date);
}

/**
 * A date in the viewer's own time zone and locale. The server does not know
 * either, so it renders the UTC time and the browser replaces it after hydration.
 */
export function LocalTime({ iso, style = "dateTime" }: { iso: string; style?: keyof typeof FORMATS }) {
  const isClient = useIsClient();
  const text = isClient ? formatLocal(iso, style) : `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return <time dateTime={iso}>{text}</time>;
}

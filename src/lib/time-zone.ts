/** Longest IANA time zone name accepted, for example "America/Argentina/ComodRivadavia". */
export const MAX_TIME_ZONE_CHARS = 64;

/** True for a time zone name that this runtime knows, such as "Asia/Kolkata". */
export function isValidTimeZone(name: string): boolean {
  if (name.length === 0 || name.length > MAX_TIME_ZONE_CHARS || !/^[A-Za-z0-9_+\-/]+$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The browser's time zone, or undefined when it is missing or not valid. */
export function browserTimeZone(): string | undefined {
  try {
    const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return name && isValidTimeZone(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The local date, time and UTC offset at `now` in `timeZone`, for the prompt.
 * Example: { date: "Friday, 2026-10-30", time: "18:05", offset: "+05:30" }.
 */
export function localTime(now: Date, timeZone: string): { date: string; time: string; offset: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const offset = (parts.timeZoneName ?? "GMT").replace(/^GMT/, "") || "+00:00";
  return {
    date: `${parts.weekday}, ${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    offset,
  };
}

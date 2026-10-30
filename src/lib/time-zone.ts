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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Wed 2026-11-04" for a calendar date. Month and day may overflow, as in Date.UTC. */
function dayLabel(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${WEEKDAYS[date.getUTCDay()]} ${date.toISOString().slice(0, 10)}`;
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
}

/**
 * Today and the next days in `timeZone`, each as "Wed 2026-11-04" with the UTC
 * offset of that day, for the prompt. The model copies a weekday from this
 * list and does not work it out (live test, 2026-10-30: it wrote "Thu Nov 4").
 */
export function upcomingDays(now: Date, timeZone: string, count = 15): { day: string; offset: string }[] {
  const parts = zonedParts(now, timeZone);
  const [year, month, day] = [Number(parts.year), Number(parts.month), Number(parts.day)];
  return Array.from({ length: count }, (_, index) => ({
    day: dayLabel(year, month, day + index),
    offset: localTime(new Date(Date.UTC(year, month - 1, day + index, 12)), timeZone).offset,
  }));
}

/** An ISO date-time as { day: "Wed 2026-11-04", time: "10:00" } in `timeZone`. Null when it is not a date-time. */
export function zonedDayTime(iso: string, timeZone: string): { day: string; time: string } | null {
  if (!/\d{2}:\d{2}/.test(iso)) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedParts(date, timeZone);
  return {
    day: dayLabel(Number(parts.year), Number(parts.month), Number(parts.day)),
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** A date (YYYY-MM-DD) as "Wed 2026-11-04", moved by `shiftDays`. Null when it is not a valid date. */
export function dateDay(date: string, shiftDays = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return dayLabel(year, month, day + shiftDays);
}

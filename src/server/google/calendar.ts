import "server-only";
import { z } from "zod";
import { authorizedRequest, clip, requireScope } from "./api";
import { GoogleApiError, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "./http";
import { CALENDAR_ALL_SCOPE, CALENDAR_SCOPE } from "./oauth";
import type { GoogleAccess } from "./token-store";

// Google Calendar through plain fetch, on the primary calendar only
// (decision 0014). Every answer is checked with zod.

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const CALENDAR_LIST_MAX_RESULTS = 25;
export const CALENDAR_LIST_MAX_DAYS = 31;
const DAY_MS = 86_400_000;
/** base32hex, as events.insert requires for a client-chosen ID. */
const EVENT_ID = /^[a-v0-9]{5,1024}$/;

export interface CalendarEvent {
  id: string;
  title: string;
  /** An ISO date-time, or a date (YYYY-MM-DD) for an all-day event. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  attendeeCount: number;
}

const when = z.object({ dateTime: z.string().max(64).optional(), date: z.string().max(16).optional() });
const eventSchema = z.object({
  id: z.string().max(1024),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  start: when.optional(),
  end: when.optional(),
  attendees: z.array(z.unknown()).max(1000).optional(),
});
const listSchema = z.object({ items: z.array(eventSchema).max(250).optional() });
const createdSchema = z.object({ id: z.string().regex(EVENT_ID) });

/** Events on the primary calendar that overlap [from, to). At most 31 days and 25 events. */
export async function calendarListEvents(
  access: GoogleAccess,
  range: { from: Date; to: Date; maxResults?: number },
): Promise<CalendarEvent[]> {
  requireScope(access, CALENDAR_SCOPE, CALENDAR_ALL_SCOPE);
  const span = range.to.getTime() - range.from.getTime();
  if (!Number.isFinite(span) || span <= 0 || span > CALENDAR_LIST_MAX_DAYS * DAY_MS) throw new RangeError("range");
  const max = Math.max(1, Math.min(CALENDAR_LIST_MAX_RESULTS, Math.trunc(range.maxResults ?? CALENDAR_LIST_MAX_RESULTS)));
  const query = new URLSearchParams({
    timeMin: range.from.toISOString(),
    timeMax: range.to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
  });
  const list = await authorizedRequest(access, `${EVENTS}?${query}`, { method: "GET" }, READ_TIMEOUT_MS, listSchema);
  return (list.items ?? [])
    .filter((event) => event.status !== "cancelled")
    .slice(0, max)
    .map((event) => ({
      id: clip(event.id, 128),
      title: clip(event.summary, 300),
      start: clip(event.start?.dateTime ?? event.start?.date, 64),
      end: clip(event.end?.dateTime ?? event.end?.date, 64),
      allDay: !event.start?.dateTime,
      location: clip(event.location, 300),
      attendeeCount: event.attendees?.length ?? 0,
    }));
}

export interface EventToCreate {
  title: string;
  start: string;
  end: string;
  attendees: string[];
}

/** The event ID for a proposal: its UUID without dashes, inside the base32hex set. */
export function eventIdForProposal(proposalId: string): string {
  const id = proposalId.toLowerCase().replace(/-/g, "");
  if (!EVENT_ID.test(id)) throw new RangeError("proposal id");
  return id;
}

/**
 * Inserts the event with a client-chosen ID. Google refuses a second event with
 * the same ID in the same calendar (409), so a retry in the same account
 * cannot make a second event: `alreadyExisted` is then true.
 */
export async function calendarCreateEvent(
  access: GoogleAccess,
  event: EventToCreate,
  eventId: string,
): Promise<{ eventId: string; alreadyExisted: boolean }> {
  requireScope(access, CALENDAR_SCOPE, CALENDAR_ALL_SCOPE);
  if (!EVENT_ID.test(eventId)) throw new RangeError("event id");
  const sendUpdates = event.attendees.length > 0 ? "all" : "none";
  try {
    const created = await authorizedRequest(
      access,
      `${EVENTS}?${new URLSearchParams({ sendUpdates })}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: eventId,
          summary: event.title,
          start: { dateTime: event.start },
          end: { dateTime: event.end },
          attendees: event.attendees.map((email) => ({ email })),
        }),
      },
      WRITE_TIMEOUT_MS,
      createdSchema,
    );
    return { eventId: created.id, alreadyExisted: false };
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 409) return { eventId, alreadyExisted: true };
    throw error;
  }
}

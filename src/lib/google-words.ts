// Words that point a message at the user's Gmail or Google Calendar. Shared by
// the composer (it turns Google on for a message that names email or the
// calendar) and the server (it makes the first hop read before it answers).
// Pure rules, no model call.

const MAIL = /\b(?:e-?mail(?:s|ed)?|gmail|inbox|unread)\b|\bmails?\s+(?:from|for\s+me)\b/i;

/**
 * Words with a common meaning outside the user's own data ("mail merge", "the
 * Fed meeting", "Translate 'appointment'"). They count only with an anchor.
 */
const WEAK_MAIL = /\bmails?\b/i;
const WEAK_CALENDAR = /\b(?:meetings?|agenda|appointments?)\b/i;

/** Words that make the message about the user's own mail or calendar. A bare "I" is not enough: "How do I prepare for a meeting?" */
const OWN = new RegExp(
  [
    String.raw`\b(?:my|our|inbox|gmail|calendar)\b`,
    String.raw`\b(?:with|for)\s+me\b`,
    String.raw`\bi(?:'|’)m\b|\bam\s+i\b`,
    String.raw`\b(?:do|did)\s+i\s+(?:have|get|miss|receive)\b|\bhave\s+i\s+(?:got|received|missed)\b`,
  ].join("|"),
  "i",
);

const CALENDAR = new RegExp(
  [
    String.raw`\bcalendar\b`,
    String.raw`\bmy\s+(?:events?|schedule)\b`,
    String.raw`\bam\s+i\s+(?:free|busy)\b`,
    String.raw`\bfree\s+(?:time|slots?)\b`,
    String.raw`\bwhat(?:'|’)?s\s+on\s+(?:my|today|tomorrow|this|next)\b`,
  ].join("|"),
  "i",
);

/** A request to make a meeting or a call, which is a calendar action and not a task. */
const SCHEDULE_MEETING = /\b(?:schedule|book|set\s+up)\s+(?:a\s+|an\s+|the\s+)?(?:meeting|call|event)\b/i;

/** Verbs that make a message a request to write, send or change, not a question to read. */
const WRITE = /\b(?:send|write|draft|compose|reply|respond|forward|book|invite|create|add|cancel|reschedule|schedule|set\s+up)\b/i;

export interface GoogleWords {
  mail: boolean;
  calendar: boolean;
  /** The message asks to read or check: it names email or the calendar and has no write verb. */
  read: boolean;
  /** The message asks to schedule a meeting or a call. */
  scheduleMeeting: boolean;
}

export function googleWords(message: string): GoogleWords {
  const own = OWN.test(message);
  const mail = MAIL.test(message) || (own && WEAK_MAIL.test(message));
  const scheduleMeeting = SCHEDULE_MEETING.test(message);
  const calendar = scheduleMeeting || CALENDAR.test(message) || (own && WEAK_CALENDAR.test(message));
  return {
    mail,
    calendar,
    read: (mail || calendar) && !WRITE.test(message),
    scheduleMeeting,
  };
}

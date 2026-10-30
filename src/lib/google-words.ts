// Words that point a message at the user's Gmail or Google Calendar. Shared by
// the composer (it turns Google on for a message that names email or the
// calendar) and the server (it makes the first hop read before it answers).
// Pure rules, no model call.

const MAIL = /\b(?:e-?mail(?:s|ed)?|gmail|inbox|unread|mails?)\b/i;

const CALENDAR = new RegExp(
  [
    String.raw`\bcalendar\b`,
    String.raw`\bmeetings?\b`,
    String.raw`\bagenda\b`,
    String.raw`\bappointments?\b`,
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

/** Verbs that ask P-Dot to send an email. */
const SEND = /\b(?:send|reply|forward)\b/i;

export interface GoogleWords {
  mail: boolean;
  calendar: boolean;
  /** The message asks to read or check: it names email or the calendar and has no write verb. */
  read: boolean;
  /** The message asks to schedule a meeting or a call. */
  scheduleMeeting: boolean;
  /** The message asks to send, reply to or forward an email. */
  send: boolean;
}

export function googleWords(message: string): GoogleWords {
  const mail = MAIL.test(message);
  const scheduleMeeting = SCHEDULE_MEETING.test(message);
  const calendar = scheduleMeeting || CALENDAR.test(message);
  return {
    mail,
    calendar,
    read: (mail || calendar) && !WRITE.test(message),
    scheduleMeeting,
    send: mail && SEND.test(message),
  };
}

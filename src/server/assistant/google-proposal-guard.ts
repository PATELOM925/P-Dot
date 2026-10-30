import "server-only";

// The server guard before a Google proposal (decision 0014, section 3,
// decision 11). It reads only the user's own message of this turn. It is
// conservative: when it is not sure, it refuses, and the tool asks the user
// to say it plainly.

export type GuardKind = "email" | "calendar";
export type GuardResult = { ok: true } | { ok: false; reason: "intent" | "address" };

/** The same ASCII WHATWG form as the payload check, for a whole token. */
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Words a request may start with before its verb. */
const LEAD = "(?:(?:please|pls|kindly|now|also|and|then|ok|okay|hey|p-dot|pdot|go ahead and|i want you to|i need you to)[\\s,]+)*";
const EMAIL_VERBS = new RegExp(
  `^${LEAD}(?:e-?mail|mail|send|reply to|write to|forward)\\b|\\b(?:e-?mail|mail)\\s+(?:bhej|bhejo|bhej do|kar do|karo)\\b`,
);
const CALENDAR_VERBS = new RegExp(
  `^${LEAD}(?:schedule|book|set up|invite|create (?:an? )?(?:event|meeting)|(?:add|put)\\b.*\\bcalendar\\b)|\\b(?:meeting|event|call)\\s+(?:schedule|set|book|fix)\\s*(?:kar|karo|kar do)\\b`,
);
const NEGATION = /\b(?:don't|dont|do not|never|not|no need to|stop|cancel|mat|nahi|nahin)\b/;
const QUESTION_START = /^(?:should|can|could|would|do|does|is|shall|kya)\b/;

/** Removes quoted text: a cited request is not a request. */
export function withoutQuotes(text: string): string {
  return text
    .replace(/[’‘]/g, "'")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ")
    .replace(/(^|[\s(\[{:,;])'[^'\n]+'(?=$|[\s.,;:!?)\]}])/g, "$1 ");
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** A sentence that asks for this kind of action: an imperative verb, not negated, not a question. */
function counts(sentence: string, kind: GuardKind): boolean {
  if (sentence.endsWith("?") || QUESTION_START.test(sentence)) return false;
  const verb = (kind === "email" ? EMAIL_VERBS : CALENDAR_VERBS).exec(sentence);
  if (!verb) return false;
  return !NEGATION.test(sentence.slice(0, verb.index + verb[0].length));
}

function addressTokens(sentence: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of sentence.split(/[\s,;:()<>[\]]+/)) {
    const token = raw.replace(/[.!?]+$/, "");
    if (ADDRESS.test(token)) tokens.add(token);
  }
  return tokens;
}

/**
 * True only when a sentence of the user's message, outside quotes, not
 * negated and not a question, asks for this kind of action, and every
 * address is one the user wrote in such a sentence, or the user's own.
 */
export function checkGoogleProposal(
  userText: string,
  kind: GuardKind,
  addresses: readonly string[],
  ownAddress: string | null,
): GuardResult {
  const counted = sentences(withoutQuotes(userText)).filter((sentence) => counts(sentence, kind));
  if (counted.length === 0) return { ok: false, reason: "intent" };
  const allowed = new Set<string>();
  for (const sentence of counted) for (const token of addressTokens(sentence)) allowed.add(token);
  if (ownAddress) allowed.add(ownAddress.toLowerCase());
  return addresses.every((address) => allowed.has(address.toLowerCase())) ? { ok: true } : { ok: false, reason: "address" };
}

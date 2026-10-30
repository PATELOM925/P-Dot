import "server-only";

// The server guard before a Google proposal (decision 0014, section 3,
// decision 11). It reads only the user's own message of this turn, and it is
// strict: a clause grants a permission only through an explicit pattern, and
// an address counts only when it comes from a granting clause. When it is not
// sure, it refuses, and the tool asks the user to say it plainly.

export type GuardKind = "email" | "calendar";
export type GuardResult = { ok: true } | { ok: false; reason: "intent" | "address" };

/** The payload's ASCII WHATWG form, for one whole token. */
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SELF = new Set(["me", "myself"]);

const NEGATION = /\b(?:do not|don't|dont|never|not|no need|stop|cancel|without|mat|nahi|nahin)\b|n't\b/;
const QUESTION_START = /^(?:should|can|could|would|do|does|did|is|are|shall|will|kya)\b/;
const CONJUNCTIONS = /\b(?:but|and then|however|except)\b/;

/** An email grant: the verb, then directly the address list. */
const EMAIL_VERB = /(?:^|\s)(?:e-?mail|mail|write to|send (?:an? )?(?:e-?mail|mail|message) to)\s+/g;
const CALENDAR_GRANT = /(?:^|\s)(?:invite|schedule\b|add\b.*\bto (?:the |my )?(?:event|meeting|calendar)\b)/;

/**
 * Removes what the user cites rather than asks: fenced and inline code,
 * quoted text (straight and smart quotes, also across lines, and an unclosed
 * quote to the end), quoted lines, and every URL.
 */
export function stripCited(text: string): string {
  let t = text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  t = t.replace(/```[\s\S]*?(?:```|$)/g, " ");
  t = t.replace(/`[^`]*(?:`|$)/g, " ");
  t = t
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  t = t.replace(/"[^"]*(?:"|$)/g, " ");
  t = t.replace(/(^|[\s(\[{:,;])'[^']*'(?=$|[\s.,;:!?)\]}])/g, "$1 ");
  t = t.replace(/\b(?:https?|ftp|mailto):\S*/gi, " ").replace(/\bwww\.\S+/gi, " ");
  return t;
}

interface Clause {
  text: string;
  question: boolean;
}

/** Splits at `. ! ? ;` (not inside an address), newlines and the listed conjunctions. */
export function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  const parts = text.toLowerCase().split(/([.!?;])(?=\s|$)|\n/);
  let sentence = "";
  const flush = (question: boolean) => {
    const trimmed = sentence.replace(/\s+/g, " ").trim();
    sentence = "";
    if (!trimmed) return;
    const asks = question || QUESTION_START.test(trimmed);
    for (const piece of trimmed.split(CONJUNCTIONS)) {
      const clause = piece.trim();
      if (clause) out.push({ text: clause, question: asks });
    }
  };
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) {
      flush(false);
    } else if (/^[.!?;]$/.test(part)) {
      flush(part === "?");
    } else {
      sentence += part;
    }
  }
  flush(false);
  return out;
}

function token(raw: string): string {
  return raw.replace(/^[<(["']+/, "").replace(/[>)\]"'.,!?:]+$/, "");
}

/** The address list that starts at the beginning of `rest`: addresses joined by `,`, `and` or `&`. */
function leadingAddresses(rest: string, own: string | null): string[] {
  const found: string[] = [];
  let expectAddress = true;
  for (const word of rest.split(/\s+/).filter(Boolean)) {
    if (!expectAddress) {
      if (word === "and" || word === "&") {
        expectAddress = true;
        continue;
      }
      break;
    }
    const value = token(word);
    if (ADDRESS.test(value)) found.push(value);
    else if (SELF.has(value) && own) found.push(own);
    else break;
    expectAddress = word.endsWith(",");
  }
  return found;
}

function emailGrant(clause: string, own: string | null): string[] | null {
  let granted: string[] | null = null;
  for (const match of clause.matchAll(EMAIL_VERB)) {
    const list = leadingAddresses(clause.slice((match.index ?? 0) + match[0].length), own);
    if (list.length > 0) granted = [...(granted ?? []), ...list];
  }
  return granted;
}

function calendarGrant(clause: string, own: string | null): string[] | null {
  if (!CALENDAR_GRANT.test(clause)) return null;
  const addresses = clause
    .split(/[\s,;:()<>[\]]+/)
    .map(token)
    .filter((value) => ADDRESS.test(value));
  return own && /\b(?:me|myself)\b/.test(clause) ? [...addresses, own] : addresses;
}

/**
 * True only when a clause of the user's message, after cited text is removed,
 * not negated and not a question, grants this kind of action through an
 * explicit pattern, and every address of the proposal came from such a clause.
 */
export function checkGoogleProposal(
  userText: string,
  kind: GuardKind,
  addresses: readonly string[],
  ownAddress: string | null,
): GuardResult {
  const own = ownAddress ? ownAddress.toLowerCase() : null;
  let granted: Set<string> | null = null;
  for (const clause of clauses(stripCited(userText))) {
    if (clause.question || NEGATION.test(clause.text)) continue;
    const list = kind === "email" ? emailGrant(clause.text, own) : calendarGrant(clause.text, own);
    if (list) granted = new Set([...(granted ?? []), ...list]);
  }
  if (!granted) return { ok: false, reason: "intent" };
  const allowed = granted;
  return addresses.every((address) => allowed.has(address.toLowerCase())) ? { ok: true } : { ok: false, reason: "address" };
}

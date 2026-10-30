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

/**
 * A clause grants only as an imperative that starts with the intent verb. The
 * only words allowed before the verb are "please" and the names "p-dot" or
 * "pdot", each with an optional comma. "Explain how to email…", "Tell me
 * whether to email…" or "I want to email…" grant nothing.
 */
const LEAD = "^(?:(?:please|p-dot|pdot),?\\s+)*";
const EMAIL_START = new RegExp(`${LEAD}(?:e-?mail|mail|write to|send (?:an? )?(?:e-?mail|mail|message) to)\\s+`);
const CALENDAR_START = new RegExp(`${LEAD}(?:invite\\b|schedule\\b|add\\b.*\\bto (?:the |my )?(?:event|meeting|calendar)\\b)`);

/** A quote opener, and the characters that close it. */
const QUOTES: Record<string, readonly string[]> = { "'": ["'", "’"], '"': ['"', "”"], "‘": ["’", "'"], "“": ["”", '"'] };

/**
 * Removes quoted spans and fails closed. An opener is a quote character at
 * the start or after whitespace, `:` or `(`; an apostrophe inside a word
 * (don't, Sam's) is not one. A closer is a matching quote that no letter or
 * digit follows. An opener with no closer quotes everything to the end.
 */
function withoutQuotes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const closers = QUOTES[ch];
    if (closers && (i === 0 || /[\s:(]/.test(text[i - 1]!))) {
      let end = -1;
      for (let j = i + 1; j < text.length; j += 1) {
        if (closers.includes(text[j]!) && !/[\p{L}\p{N}]/u.test(text[j + 1] ?? "")) {
          end = j;
          break;
        }
      }
      if (end === -1) return `${out} `;
      out += " ";
      i = end;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Removes what the user cites rather than asks: fenced and inline code,
 * quoted text (straight and smart quotes, also across lines, and an unclosed
 * quote to the end), quoted lines, and every URL.
 */
export function stripCited(text: string): string {
  let t = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  t = t.replace(/`[^`]*(?:`|$)/g, " ");
  t = t
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  t = withoutQuotes(t);
  t = t.replace(/\b(?:https?|ftp|mailto):\S*/gi, " ").replace(/\bwww\.\S+/gi, " ");
  // A smart apostrophe inside a word (don’t) reads as a plain one for the negation check.
  return t.replace(/[’‘]/g, "'");
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
  const match = EMAIL_START.exec(clause);
  if (!match) return null;
  const list = leadingAddresses(clause.slice(match[0].length), own);
  return list.length > 0 ? list : null;
}

function calendarGrant(clause: string, own: string | null): string[] | null {
  if (!CALENDAR_START.test(clause)) return null;
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

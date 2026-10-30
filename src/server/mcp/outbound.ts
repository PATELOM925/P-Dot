import "server-only";
import type { McpServer, McpServerId } from "./catalog";

// What may leave P-Dot in a connector argument (decision 0016, "Outbound data
// rule"). A search argument is one phrase of the user's current message. An
// ID is one that this app returned in a typed field in this turn, or one in
// the user's message with the app's ID format. Nothing else goes out, so text
// from memories, documents, earlier replies or another app cannot.

export const MAX_PHRASE_CHARS = 120;

/** NFKC, lower case, and each run of white space as one space. */
export function normalizePhrase(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;

/** True when `phrase` is one contiguous part of `message` that starts and ends at a word edge. Compares code points. */
export function isUserPhrase(phrase: string, message: string): boolean {
  const wanted = normalizePhrase(phrase);
  const wantedChars = Array.from(wanted);
  if (wantedChars.length === 0 || wantedChars.length > MAX_PHRASE_CHARS) return false;
  const text = normalizePhrase(message);
  const first = WORD_CHAR.test(wantedChars[0]!);
  const last = WORD_CHAR.test(wantedChars.at(-1)!);
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    const before = Array.from(text.slice(0, at)).at(-1) ?? "";
    const after = Array.from(text.slice(at + wanted.length))[0] ?? "";
    if (!(first && WORD_CHAR.test(before)) && !(last && WORD_CHAR.test(after))) return true;
  }
  return false;
}

/** The IDs each app may receive in one turn. */
export class TurnIds {
  private readonly ids = new Map<McpServerId, Set<string>>();

  constructor(userMessage: string, servers: readonly McpServer[]) {
    for (const server of servers) this.ids.set(server.id, new Set(server.idsInUserText(userMessage)));
  }

  /** Adds the IDs that `server.resultIds` parsed from a typed field of this app's result. */
  addFromResult(server: McpServer, result: unknown): void {
    const set = this.ids.get(server.id) ?? new Set<string>();
    for (const raw of server.resultIds(result)) {
      const id = server.normalizeId(raw);
      if (id) set.add(id);
    }
    this.ids.set(server.id, set);
  }

  /** The app's form of the ID when this turn allows it, else null. */
  allowed(server: McpServer, value: string): string | null {
    const id = server.normalizeId(value);
    return id && this.ids.get(server.id)?.has(id) ? id : null;
  }
}

export const PHRASE_REFUSAL =
  "Not sent: the search text must be one phrase copied word for word from the user's message. Nothing was searched.";
export const ID_REFUSAL =
  "Not sent: use an ID that this app returned in this turn, or one that the user typed. Nothing was read.";

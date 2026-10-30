import "server-only";
import { GMAIL_SEND_SCOPE } from "@/server/google/oauth";
import type { GoogleServices } from "./tools/google";
import { hasCalendarScopeFor, hasReadScope } from "./tools/google";
import type { GoogleToolFlags } from "./tools/registry";

/** Google for one turn: what the connection allows, and a note when it is off. */
export interface TurnGoogle {
  /** Null when Google cannot be used in this turn. */
  flags: GoogleToolFlags | null;
  ownAddress: string | null;
  /** A server line for the model, set when the user asked for Google and it is off. */
  note?: string;
}

const note = (reason: string) =>
  `The user turned on Google for this message, but Google is not available now (${reason}). Tell the user, and answer without Google.`;

/**
 * Reads the connection once, after the reply claim and before the hold
 * (decision 0014, section 3). A failed read turns Google off for the turn and
 * does not stop it. Null when the user did not ask for Google.
 */
export async function googleForTurn(
  deps: { google?: GoogleServices | null; googleBlocked?: "not_set_up" | "demo_session" | null },
  userId: string,
  asked: boolean,
): Promise<TurnGoogle | null> {
  if (!asked) return null;
  if (!deps.google) {
    return { flags: null, ownAddress: null, note: note(deps.googleBlocked === "demo_session" ? "demo session" : "not set up") };
  }
  let connection;
  try {
    connection = await deps.google.accounts.getGoogleConnection(userId);
  } catch {
    return { flags: null, ownAddress: null, note: note("could not read the connection") };
  }
  if (!connection) return { flags: null, ownAddress: null, note: note("not connected") };
  if (connection.status !== "connected") return { flags: null, ownAddress: connection.email, note: note("connect again") };
  const flags: GoogleToolFlags = {
    read: hasReadScope(connection.scopes),
    send: connection.scopes.includes(GMAIL_SEND_SCOPE),
    calendar: hasCalendarScopeFor(connection.scopes),
  };
  if (!flags.read && !flags.send && !flags.calendar) return { flags: null, ownAddress: connection.email, note: note("connect again") };
  return { flags, ownAddress: connection.email };
}

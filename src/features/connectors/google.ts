// What the Google card on the Connectors page shows. Pure, so it is unit-tested.
import type { GoogleConnection } from "@/server/db/connected-accounts";
import { CALENDAR_ALL_SCOPE, CALENDAR_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "@/server/google/oauth";
import { GOOGLE_OUTCOMES, type GoogleOutcome } from "@/server/google/connect-flow";

export type GoogleCardState =
  | { kind: "not_set_up" }
  | { kind: "account_required" }
  | { kind: "load_failed" }
  | { kind: "not_connected" }
  | { kind: "needs_reconnect"; email: string }
  | { kind: "connected"; email: string; access: string[]; missing: string[] };

export function googleCardState(
  configured: boolean,
  connection: GoogleConnection | null | "load_failed",
  anonymous = false,
): GoogleCardState {
  if (!configured) return { kind: "not_set_up" };
  if (anonymous) return { kind: "account_required" };
  if (connection === "load_failed") return { kind: "load_failed" };
  if (!connection) return { kind: "not_connected" };
  if (connection.status === "needs_reconnect") return { kind: "needs_reconnect", email: connection.email };
  const scopes = new Set<string>(connection.scopes);
  const parts = [
    { allowed: scopes.has(GMAIL_READ_SCOPE), can: "Read and search your Gmail.", off: "Read Gmail: not allowed" },
    { allowed: scopes.has(GMAIL_SEND_SCOPE), can: "Send an email, only after you approve it.", off: "Send email: not allowed" },
    {
      allowed: scopes.has(CALENDAR_SCOPE) || scopes.has(CALENDAR_ALL_SCOPE),
      can: "Read your calendar, and add an event only after you approve it.",
      off: "Calendar: not allowed",
    },
  ];
  return {
    kind: "connected",
    email: connection.email,
    access: parts.filter((part) => part.allowed).map((part) => part.can),
    missing: parts.filter((part) => !part.allowed).map((part) => part.off),
  };
}

/** The message after a Connect or Disconnect redirect. Error outcomes use role="alert". */
export function googleOutcomeMessage(value: unknown): { text: string; error: boolean } | null {
  if (typeof value !== "string" || !(GOOGLE_OUTCOMES as readonly string[]).includes(value)) return null;
  const messages: Record<GoogleOutcome, { text: string; error: boolean }> = {
    connected: { text: "Google is connected.", error: false },
    denied: { text: "You did not allow access. Google is not connected.", error: true },
    no_scopes: { text: "You did not allow access to Gmail or Calendar. Google is not connected.", error: true },
    error: { text: "Google did not connect. Try again.", error: true },
    not_set_up: { text: "Google is not set up on this site yet.", error: true },
    wrong_site: {
      text: "Connect Google on the main site. It does not work on a preview link.",
      error: true,
    },
    disconnected: { text: "Google is disconnected. P-Dot removed its access.", error: false },
    disconnected_unconfirmed: {
      text: "Google is disconnected from P-Dot, but Google did not confirm. You can also remove P-Dot at myaccount.google.com/permissions.",
      error: false,
    },
    disconnect_error: { text: "Google did not disconnect. Try again.", error: true },
    disconnect_changed: {
      text: "Your Google connection changed in another tab while P-Dot disconnected the earlier one. The new connection stays. Disconnect again to remove it.",
      error: true,
    },
    disconnect_unknown: { text: "We could not confirm that Google is disconnected. Check Connectors again.", error: true },
    account_required: { text: "Create an account to connect Google.", error: true },
  };
  return messages[value as GoogleOutcome];
}

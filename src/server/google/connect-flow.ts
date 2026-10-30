import "server-only";
import { NextResponse } from "next/server";
import { getGoogleConfig, getSiteUrl, type GoogleConfig } from "@/server/config";
import { logEvent } from "@/server/log";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_PATH } from "./oauth-state";

// Shared by the Connect, callback and Disconnect routes. Each answers the
// browser with a 303 back to the Connectors page and a short outcome code,
// which the page turns into a status message. The code never carries data.

export const GOOGLE_OUTCOMES = [
  "connected",
  "denied",
  "no_scopes",
  "error",
  "not_set_up",
  "wrong_site",
  "disconnected",
  "disconnected_unconfirmed",
  "disconnect_error",
  "disconnect_changed",
  "account_required",
] as const;
export type GoogleOutcome = (typeof GOOGLE_OUTCOMES)[number];

export function backToConnectors(request: Request, outcome: GoogleOutcome, clearState = false): NextResponse {
  const response = NextResponse.redirect(new URL(`/connectors?google=${outcome}#google`, request.url), 303);
  if (clearState) response.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_STATE_PATH, maxAge: 0, httpOnly: true });
  return response;
}

/** The config, or null after logging which names are bad (never values). */
export function readyGoogleConfig(requestId: string, route: string): GoogleConfig | null {
  const state = getGoogleConfig();
  if (state.status === "ready") return state.config;
  if (state.invalid.length > 0) logEvent("error", "google_config_invalid", { requestId, route, names: state.invalid.join(",") });
  return null;
}

/**
 * The OAuth state cookie is set on the host that started Connect, and Google
 * returns to SITE_URL. So Connect runs only on the SITE_URL host.
 */
export function isSiteHost(request: Request): boolean {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return host !== null && host === new URL(getSiteUrl()).host;
}

export const secureCookies = () => new URL(getSiteUrl()).protocol === "https:";

/** Calls Google with the global fetch at call time, so tests can replace it. */
export const googleFetch = (input: string, init?: RequestInit) => fetch(input, init);

import "server-only";
import { z } from "zod";
import type { GoogleConfig } from "@/server/config";
import { fromBase64Url } from "./crypto";
import { GoogleApiError, READ_TIMEOUT_MS, googleRequest, type FetchLike } from "./http";

// Google OAuth for Connect (decision 0014). Sign-in with Google does not use
// this module: Supabase runs that flow.

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
/** The database also accepts this calendar scope, as a fallback the owner can choose (decision 0014). */
export const CALENDAR_ALL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** The data scopes the database accepts. Keep in step with connected_accounts_known_scopes. */
export const DATA_SCOPES = [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, CALENDAR_SCOPE, CALENDAR_ALL_SCOPE] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/** What Connect asks for: the address for "Connected as", then the three data scopes. */
export const REQUESTED_SCOPES = ["openid", "email", GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, CALENDAR_SCOPE];

export function hasCalendarScope(scopes: readonly string[]): boolean {
  return scopes.includes(CALENDAR_SCOPE) || scopes.includes(CALENDAR_ALL_SCOPE);
}

export function buildAuthorizationUrl(config: GoogleConfig, state: string, codeChallenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: REQUESTED_SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.toString();
}

const formInit = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

const tokenResponse = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(2048),
  scope: z.string().max(4096),
  id_token: z.string().min(1).max(8192),
});

const refreshResponse = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86_400),
});

const idTokenClaims = z.object({ sub: z.string().min(1).max(255), email: z.string().min(3).max(320) });

export interface ExchangedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  /** Only the data scopes that Google granted, in the database's order. */
  dataScopes: DataScope[];
  /** Google's stable account ID. */
  subject: string;
  email: string;
}

/**
 * The ID token came straight from Google's token endpoint over TLS with the
 * client secret, so its signature is not checked (Google's OpenID guide). The
 * subject identifies the account; the address is used for display only.
 */
function identityFromIdToken(idToken: string): { subject: string; email: string } {
  const payload = idToken.split(".")[1];
  const bytes = payload ? fromBase64Url(payload) : null;
  if (!bytes) throw new GoogleApiError("bad_response", null);
  try {
    const claims = idTokenClaims.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!claims.success) throw new GoogleApiError("bad_response", null);
    return { subject: claims.data.sub, email: claims.data.email };
  } catch (error) {
    if (error instanceof GoogleApiError) throw error;
    throw new GoogleApiError("bad_response", null);
  }
}

export async function exchangeCode(
  fetchImpl: FetchLike,
  config: GoogleConfig,
  code: string,
  codeVerifier: string,
): Promise<ExchangedTokens> {
  const body = await googleRequest(
    fetchImpl,
    TOKEN_URL,
    formInit({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
    READ_TIMEOUT_MS,
    tokenResponse,
  );
  const granted = new Set(body.scope.split(" "));
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    refreshToken: body.refresh_token,
    dataScopes: DATA_SCOPES.filter((scope) => granted.has(scope)),
    ...identityFromIdToken(body.id_token),
  };
}

/** A new access token. Google answers 400 `invalid_grant` for a refresh token that ended. */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  config: GoogleConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = await googleRequest(
    fetchImpl,
    TOKEN_URL,
    formInit({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    READ_TIMEOUT_MS,
    refreshResponse,
  );
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

export const isDeadRefreshToken = (error: unknown) =>
  error instanceof GoogleApiError && (error.label === "invalid_grant" || error.status === 401);

/**
 * "revoked" for 200, "invalid" for 400 (for example a token that already
 * ended). Throws GoogleApiError on a timeout, a network error or a 5xx.
 */
export async function revokeToken(fetchImpl: FetchLike, token: string): Promise<"revoked" | "invalid"> {
  try {
    await googleRequest(fetchImpl, REVOKE_URL, formInit({ token }), READ_TIMEOUT_MS, z.unknown());
    return "revoked";
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 400) return "invalid";
    throw error;
  }
}

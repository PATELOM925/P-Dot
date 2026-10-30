import "server-only";
import { z } from "zod";
import { OAUTH_STATE_ASSOCIATED_DATA, openText, sealText } from "./crypto";

// The Connect flow's state and PKCE verifier, sealed with AES-GCM in a
// short-lived httpOnly cookie that only the Google routes receive. Sealing
// binds it to the signed-in user, so a cookie that another site or another
// user planted does not open or does not match (decision 0014).

export const OAUTH_STATE_COOKIE = "pdot_google_oauth";
export const OAUTH_STATE_PATH = "/api/connectors/google";
export const OAUTH_STATE_MAX_AGE_SECONDS = 600;

export interface OAuthState {
  userId: string;
  state: string;
  verifier: string;
  expiresAt: number;
}

const stateSchema = z
  .object({ u: z.string().min(1).max(64), s: z.string().min(32).max(128), v: z.string().min(43).max(128), e: z.number() })
  .strict();

export function sealOAuthState(key: Uint8Array, value: OAuthState): Promise<string> {
  return sealText(
    key,
    JSON.stringify({ u: value.userId, s: value.state, v: value.verifier, e: value.expiresAt }),
    OAUTH_STATE_ASSOCIATED_DATA,
  );
}

/** The state, or null when the cookie does not open, does not parse or has expired. */
export async function openOAuthState(key: Uint8Array, cookie: string, now: number): Promise<OAuthState | null> {
  if (cookie.length > 2048) return null;
  const text = await openText(key, cookie, OAUTH_STATE_ASSOCIATED_DATA);
  if (text === null) return null;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.e <= now) return null;
    return { userId: parsed.data.u, state: parsed.data.s, verifier: parsed.data.v, expiresAt: parsed.data.e };
  } catch {
    return null;
  }
}

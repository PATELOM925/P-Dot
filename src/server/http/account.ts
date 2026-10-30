import "server-only";
import type { AuthContext } from "@/server/auth/session";
import { errorResponse } from "./responses";

/**
 * Google actions need a real account, not an anonymous demo session. The flag
 * comes from the verified JWT (`getClaims()`), never from the client. A later
 * shared `requireAccount` route option can replace this call.
 */
export function accountRequired(auth: AuthContext, requestId: string): Response | null {
  return auth.isAnonymous === true
    ? errorResponse(403, "account_required", "Create an account to use Google with P-Dot.", requestId)
    : null;
}

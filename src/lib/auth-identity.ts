// Reads the verified Supabase JWT claims. Shared by the server session and the proxy.

export interface Identity {
  userId: string;
  /** Null for a trial (anonymous) user, whose token has an empty or missing email. */
  email: string | null;
  isAnonymous: boolean;
}

interface Claims {
  sub?: unknown;
  email?: unknown;
  is_anonymous?: unknown;
}

export function readIdentity(claims: Claims | null | undefined): Identity | null {
  if (!claims || typeof claims.sub !== "string" || claims.sub.length === 0) return null;
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" && claims.email.length > 0 ? claims.email : null,
    // Tokens from before anonymous sign-ins have no claim; those are accounts.
    isAnonymous: claims.is_anonymous === true,
  };
}

/** A permanent account, not a trial. A context without `isAnonymous` (a test fake) fails closed. */
export function hasAccount(auth: { isAnonymous?: boolean }): boolean {
  return auth.isAnonymous === false;
}

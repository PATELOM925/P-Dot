import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/server/db/supabase";

export interface AuthContext {
  userId: string;
  email: string | null;
  /** Client bound to this user's session; queries run under RLS as this user. */
  supabase: SupabaseClient;
}

/**
 * Verifies the session cookie and returns the authenticated user, or null.
 * `getClaims()` validates the JWT signature (locally with asymmetric signing
 * keys, otherwise via the Auth server), unlike `getSession()`, which only
 * decodes the cookie and must not be trusted on the server.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || typeof claims.sub !== "string" || claims.sub.length === 0) {
    return null;
  }
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    supabase,
  };
}

/** For pages: redirects to the login page when there is no valid session. */
export async function requireAuth(nextPath = "/chat"): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return auth;
}

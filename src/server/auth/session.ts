import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { readIdentity } from "@/lib/auth-identity";
import { createSupabaseServerClient } from "@/server/db/supabase";

export interface AuthContext {
  userId: string;
  email: string | null;
  /** True for a trial user (Supabase anonymous sign-in). Set by `getAuthContext`. */
  isAnonymous?: boolean;
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
  const identity = error ? null : readIdentity(data?.claims);
  if (!identity) return null;
  return { ...identity, supabase };
}

/** For pages: redirects to the login page when there is no valid session. */
export async function requireAuth(nextPath = "/chat"): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return auth;
}

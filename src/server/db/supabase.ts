import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getSupabaseConfig } from "@/lib/supabase-config";

/**
 * Per-request Supabase client acting as the signed-in user (publishable key +
 * the user's session cookie). Every query is therefore subject to RLS.
 * Create a new client for each request; never share one across requests.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  // Read cookies first: it marks the route as dynamic before any config error.
  const cookieStore = await cookies();
  const { url, publishableKey } = getSupabaseConfig();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. The proxy refreshes sessions,
          // and route handlers/server actions (which can) never reach here.
        }
      },
    },
  });
}

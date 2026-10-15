import { isSupabaseConfigured } from "@/lib/supabase-config";
import { getAssistantConfig } from "@/server/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness plus which integrations are configured (booleans
 * only; never values). It does not call the providers, so "configured" does
 * not mean "reachable".
 */
export function GET(): Response {
  let inference = false;
  let webSearch = false;
  try {
    const config = getAssistantConfig();
    inference = true;
    webSearch = config.tavily !== null;
  } catch {
    // Not configured.
  }

  return Response.json(
    {
      status: "ok",
      time: new Date().toISOString(),
      configured: { auth: isSupabaseConfigured(), inference, webSearch },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

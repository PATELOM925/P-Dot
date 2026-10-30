import { createTelegramLinkRepository } from "@/server/db/telegram-links";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { backToTelegramCard } from "@/server/telegram/flow";

const ROUTE = "connectors.telegram.unlink";

/**
 * POST /api/connectors/telegram/unlink, from the Unlink form (decision 0020).
 * Deletes the user's link row. It works also when Telegram is no longer set
 * up, so a user can always remove the stored chat.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: ROUTE, sameOrigin: true, requireAccount: true }, async ({ auth, requestId }) => {
    try {
      await createTelegramLinkRepository(auth.supabase).unlink(auth.userId);
    } catch {
      logEvent("warn", "telegram_unlink_failed", { requestId, route: ROUTE });
      return backToTelegramCard(request, "unlink_error");
    }
    return backToTelegramCard(request, "unlinked");
  });
}

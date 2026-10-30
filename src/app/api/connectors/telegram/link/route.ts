import { createTelegramLinkRepository } from "@/server/db/telegram-links";
import { withAuthenticatedRoute } from "@/server/http/route";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { readyTelegramConfig } from "@/server/telegram/flow";
import { newLinkCode } from "@/server/telegram/seal";

const ROUTE = "connectors.telegram.link";

/**
 * POST /api/connectors/telegram/link. Starts a link (decision 0020): a new
 * one-time code, of which the database keeps only the hash for 10 minutes,
 * and the t.me link that sends "/start <code>" to the bot. A linked chat
 * stays linked until the new link finishes.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: ROUTE, sameOrigin: true, requireAccount: true }, async ({ auth, requestId }) => {
    const config = readyTelegramConfig(requestId, ROUTE);
    if (!config) return errorResponse(503, "not_configured", "Telegram is not set up on this site yet.", requestId);
    const { code, hash } = await newLinkCode();
    const expiresAt = await createTelegramLinkRepository(auth.supabase).startLink(hash);
    return jsonResponse({ deepLink: `https://t.me/${config.botUsername}?start=${code}`, expiresAt }, requestId);
  });
}

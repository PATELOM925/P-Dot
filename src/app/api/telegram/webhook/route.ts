import { getSiteUrl, getTelegramConfig } from "@/server/config";
import { readJsonBody } from "@/server/http/request";
import { newRequestId } from "@/server/http/responses";
import { logEvent } from "@/server/log";
import { MAX_UPDATE_BYTES, SECRET_HEADER, secretMatches, webhookReply } from "@/server/telegram/webhook";

const ROUTE = "telegram.webhook";

const empty = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/telegram/webhook. Telegram calls it for each message to the bot
 * (decision 0020). It has no user session. A request without the exact
 * secret header gets 401 and nothing else runs. A good one gets at most one
 * reply to the chat that wrote, in this answer. No database access, no
 * outbound call, and no message text or chat ID in the logs.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const state = getTelegramConfig();
  if (state.status !== "ready") return empty(404);
  if (!secretMatches(request.headers.get(SECRET_HEADER), state.config.webhookSecret)) {
    logEvent("warn", "telegram_webhook_refused", { requestId, route: ROUTE });
    return empty(401);
  }
  const body = await readJsonBody(request, MAX_UPDATE_BYTES);
  // Telegram sends a failed update again; a body P-Dot cannot read would come back forever.
  if (!body.ok) return empty(200);
  try {
    const reply = await webhookReply(body.value, { key: state.config.sealKey, siteUrl: getSiteUrl(), now: Date.now() });
    logEvent("info", "telegram_webhook", { requestId, route: ROUTE, kind: reply.kind });
    return reply.body ? Response.json(reply.body, { headers: { "Cache-Control": "no-store" } }) : empty(200);
  } catch (error) {
    logEvent("error", "telegram_webhook_failed", { requestId, route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return empty(200);
  }
}

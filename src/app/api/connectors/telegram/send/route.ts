import { z } from "zod";
import { TELEGRAM_MAX_SEND_CHARS } from "@/lib/telegram";
import { getAssistantConfig } from "@/server/config";
import { createQuotaGate } from "@/server/db/quota";
import { createTelegramLinkRepository } from "@/server/db/telegram-links";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { sendTelegramMessage } from "@/server/telegram/bot";
import { readyTelegramConfig, telegramFetch } from "@/server/telegram/flow";
import { openChat } from "@/server/telegram/seal";

const ROUTE = "connectors.telegram.send";
const MAX_BODY_BYTES = 32 * 1024;

const sendSchema = z
  .object({
    text: z.string().max(TELEGRAM_MAX_SEND_CHARS).refine((value) => value.trim().length > 0),
    /** One key for each approval card. A second send with the same key sends nothing. */
    key: z.string().uuid(),
  })
  .strict();

/**
 * POST /api/connectors/telegram/send, from the Send button of an approval
 * card (decision 0020). The press is the approval for this one message to the
 * user's own linked chat. There is no model tool for it. Order: body, config,
 * quota, the claim of the key, then one sendMessage. The text is never logged.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: ROUTE, sameOrigin: true, requireAccount: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = sendSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(400, "invalid_request", "Send 1 to 4,000 characters and a new key.", requestId);

    const config = readyTelegramConfig(requestId, ROUTE);
    if (!config) return errorResponse(503, "not_configured", "Telegram is not set up on this site yet.", requestId);

    const { quota } = getAssistantConfig();
    let allowed: boolean;
    try {
      allowed = (await createQuotaGate(auth.supabase, quota.requestsPerWindow, quota.windowSeconds).consume()).allowed;
    } catch {
      logEvent("error", "telegram_quota_failed", { requestId, route: ROUTE });
      return errorResponse(503, "provider_unavailable", "P-Dot could not check your limit. Nothing was sent. Try again.", requestId);
    }
    if (!allowed) return errorResponse(429, "rate_limited", "You reached your message limit. Nothing was sent. Try again later.", requestId);

    let sealed: string | null;
    try {
      sealed = await createTelegramLinkRepository(auth.supabase).claimSend(parsed.data.key);
    } catch {
      // The claim may be stored. The card asks for a new press, which makes a new key.
      logEvent("warn", "telegram_claim_failed", { requestId, route: ROUTE });
      return errorResponse(503, "provider_unavailable", "P-Dot could not check your Telegram link. Nothing was sent. Try again.", requestId);
    }
    if (!sealed) {
      return errorResponse(409, "conflict", "This card was already sent, or Telegram is not linked. Check your Telegram chat and Connectors.", requestId);
    }
    const chat = await openChat(config.sealKey, auth.userId, sealed);
    if (!chat) return errorResponse(409, "reconnect_required", "Link Telegram again on the Connectors page. Nothing was sent.", requestId);

    const result = await sendTelegramMessage(telegramFetch, config.botToken, chat.chatId, parsed.data.text.trim());
    logEvent(result.status === "sent" ? "info" : "warn", "telegram_send_result", {
      requestId,
      route: ROUTE,
      status: result.status,
      reason: result.status === "not_sent" ? result.reason : null,
    });
    switch (result.status) {
      case "sent":
        return jsonResponse({ status: "sent" }, requestId);
      case "unknown":
        return jsonResponse({ status: "unknown" }, requestId, { status: 202 });
      case "not_sent":
        if (result.reason === "blocked") {
          return errorResponse(409, "conflict", "Telegram did not send it. Open the P-Dot bot in Telegram, select Start, then try again.", requestId);
        }
        if (result.reason === "rate_limited") {
          return errorResponse(429, "provider_rate_limited", "Telegram asked P-Dot to wait. Nothing was sent. Try again in a minute.", requestId);
        }
        return errorResponse(502, "provider_unavailable", "Telegram refused the message. Nothing was sent.", requestId);
    }
  });
}

import { createTelegramLinkRepository } from "@/server/db/telegram-links";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import { backToTelegramCard, readyTelegramConfig } from "@/server/telegram/flow";
import { MAX_PROOF_CHARS, openLinkProof, sealChat } from "@/server/telegram/seal";

const ROUTE = "connectors.telegram.confirm";
const MAX_FORM_BYTES = 4096;

/**
 * POST /api/connectors/telegram/confirm, from the "Link this chat" form
 * (decision 0020). The proof from the webhook says which chat sent which
 * code. The database links the chat only when that code is the signed-in
 * user's own pending code, once, before it ends. The chat is stored sealed
 * for this user.
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: ROUTE, sameOrigin: true, requireAccount: true }, async ({ auth, requestId }) => {
    const config = readyTelegramConfig(requestId, ROUTE);
    if (!config) return backToTelegramCard(request, "not_set_up");

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return backToTelegramCard(request, "error");
    let proofText: FormDataEntryValue | null;
    try {
      const form = await request.formData();
      if (form.getAll("t").length !== 1) return backToTelegramCard(request, "error");
      proofText = form.get("t");
    } catch {
      return backToTelegramCard(request, "error");
    }
    if (typeof proofText !== "string" || proofText.length > MAX_PROOF_CHARS) return backToTelegramCard(request, "error");

    const proof = await openLinkProof(config.sealKey, proofText, Date.now());
    if (proof === "expired") return backToTelegramCard(request, "expired");
    if (!proof) return backToTelegramCard(request, "error");

    const sealed = await sealChat(config.sealKey, auth.userId, { chatId: proof.chatId, name: proof.name });
    let linked: boolean;
    try {
      linked = await createTelegramLinkRepository(auth.supabase).confirmLink(proof.codeHash, sealed);
    } catch {
      logEvent("warn", "telegram_link_failed", { requestId, route: ROUTE, step: "confirm" });
      return backToTelegramCard(request, "error");
    }
    return backToTelegramCard(request, linked ? "linked" : "expired");
  });
}

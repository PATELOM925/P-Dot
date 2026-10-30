import "server-only";
import { z } from "zod";
import { sameText } from "@/server/google/crypto";
import { LINK_TTL_MS, cleanName, hashLinkCode, sealLinkProof } from "./seal";

// The Telegram webhook (decision 0020). It has no user session, so it reads
// and writes nothing and calls nothing. Its only effect is one reply to the
// chat that wrote, sent in the webhook answer. It never reads or keeps the
// text of a message except to find "/start <code>".

export const MAX_UPDATE_BYTES = 64 * 1024;
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** True only for the exact secret, compared in constant time. */
export function secretMatches(header: string | null, secret: string): boolean {
  return header !== null && header.length <= 256 && sameText(header, secret);
}

const update = z
  .object({
    update_id: z.number().int(),
    message: z
      .object({
        chat: z.object({ id: z.number().int(), type: z.string().max(32) }).loose(),
        from: z.object({ is_bot: z.boolean(), first_name: z.string().max(256).optional() }).loose().optional(),
        text: z.string().max(4096).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const START = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S{1,64}))?\s*$/;
const CODE = /^[A-Za-z0-9_-]{32}$/;

export const HELP_TEXT =
  "This bot sends you messages that you approve in P-Dot. It does not read or answer your messages here. Open P-Dot to chat.";
export const START_WITHOUT_CODE_TEXT = "To link this chat, open P-Dot, go to Connectors and select Link Telegram.";
export const FINISH_TEXT = "Select the button to finish linking this chat to P-Dot. The link works for 10 minutes.";

export type WebhookKind = "start" | "start_no_code" | "other" | "ignored";

export interface WebhookReply {
  kind: WebhookKind;
  /** The Bot API call to send in the webhook answer, or null for no reply. */
  body: Record<string, unknown> | null;
}

/** The reply to one update. Ignores updates that are not a private message from a person. */
export async function webhookReply(value: unknown, deps: { key: Uint8Array; siteUrl: string; now: number }): Promise<WebhookReply> {
  const parsed = update.safeParse(value);
  const message = parsed.success ? parsed.data.message : undefined;
  if (!message || message.chat.type !== "private" || message.chat.id <= 0 || message.from?.is_bot !== false) {
    return { kind: "ignored", body: null };
  }
  const reply = (text: string, extra: Record<string, unknown> = {}) => ({
    method: "sendMessage",
    chat_id: message.chat.id,
    text,
    link_preview_options: { is_disabled: true },
    ...extra,
  });
  const start = START.exec(message.text ?? "");
  if (!start) return { kind: "other", body: reply(HELP_TEXT, { reply_markup: openButton(deps.siteUrl, "Open P-Dot", "/chat") }) };
  const code = start[1];
  if (!code || !CODE.test(code)) return { kind: "start_no_code", body: reply(START_WITHOUT_CODE_TEXT) };

  const proof = await sealLinkProof(deps.key, {
    chatId: message.chat.id,
    name: cleanName(message.from?.first_name),
    codeHash: await hashLinkCode(code),
    expiresAt: deps.now + LINK_TTL_MS,
  });
  const path = `/connectors/telegram/confirm?t=${encodeURIComponent(proof)}`;
  const button = openButton(deps.siteUrl, "Finish linking in P-Dot", path);
  // Without a button (a local http site), the link goes in the text.
  return { kind: "start", body: reply(button ? FINISH_TEXT : `${FINISH_TEXT}\n${deps.siteUrl}${path}`, { reply_markup: button }) };
}

/** An inline URL button. Telegram accepts only https URLs here, so a local http site gets no button. */
function openButton(siteUrl: string, text: string, path: string): Record<string, unknown> | undefined {
  return siteUrl.startsWith("https://") ? { inline_keyboard: [[{ text, url: `${siteUrl}${path}` }]] } : undefined;
}

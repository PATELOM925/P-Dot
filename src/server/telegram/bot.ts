import "server-only";
import { z } from "zod";
import { readBounded, type FetchLike } from "@/server/google/http";

// One Bot API call: sendMessage (decision 0020). Plain text with no parse
// mode, so the text cannot add links or formatting. The URL holds the bot
// token, so it is never logged, and an error never carries it.

export const SEND_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 16 * 1024;

export type SendResult =
  | { status: "sent" }
  /** Telegram did not send. "blocked": the user blocked the bot or never started it. */
  | { status: "not_sent"; reason: "refused" | "blocked" | "rate_limited" }
  /** A timeout, a network error, a 5xx or an answer that does not parse: Telegram may have sent it. */
  | { status: "unknown" };

const sentAnswer = z.object({ ok: z.literal(true), result: z.object({ message_id: z.number().int() }).loose() }).loose();

export async function sendTelegramMessage(fetchImpl: FetchLike, botToken: string, chatId: number, text: string): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return { status: "unknown" };
  }
  if (response.status === 403) return drop(response, { status: "not_sent", reason: "blocked" });
  if (response.status === 429) return drop(response, { status: "not_sent", reason: "rate_limited" });
  if (response.status >= 400 && response.status < 500) return drop(response, { status: "not_sent", reason: "refused" });
  if (!response.ok) return drop(response, { status: "unknown" });
  try {
    const text = await readBounded(response, MAX_ANSWER_BYTES);
    return sentAnswer.safeParse(JSON.parse(text ?? "")).success ? { status: "sent" } : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

async function drop(response: Response, result: SendResult): Promise<SendResult> {
  await response.body?.cancel().catch(() => undefined);
  return result;
}

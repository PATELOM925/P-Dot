// Telegram link and send (decision 0020). Shared by the browser and the
// server, so it holds limits and words only, never a token or a chat ID.

/** Telegram allows 4,096 characters. P-Dot sends at most this many. */
export const TELEGRAM_MAX_SEND_CHARS = 4000;

/** Outcome codes in the Connectors page URL after Confirm or Unlink. */
export const TELEGRAM_OUTCOMES = ["linked", "expired", "error", "not_set_up", "unlinked", "unlink_error"] as const;
export type TelegramOutcome = (typeof TELEGRAM_OUTCOMES)[number];

const MESSAGES: Record<TelegramOutcome, { text: string; error: boolean }> = {
  linked: { text: "Telegram is linked. P-Dot sends a message there only when you press Send on its card.", error: false },
  expired: { text: "This link ended or was already used. Select Link Telegram to start again.", error: true },
  error: { text: "Telegram did not link. Try again.", error: true },
  not_set_up: { text: "Telegram is not set up on this site yet.", error: true },
  unlinked: { text: "Telegram is unlinked. P-Dot cannot send you messages there now.", error: false },
  unlink_error: { text: "Telegram did not unlink. Try again.", error: true },
};

/** The message for a Telegram outcome code in the URL, or null for any other value. */
export function telegramOutcomeMessage(outcome: unknown): { text: string; error: boolean } | null {
  return typeof outcome === "string" && (TELEGRAM_OUTCOMES as readonly string[]).includes(outcome)
    ? MESSAGES[outcome as TelegramOutcome]
    : null;
}

/**
 * The text that a send card shows and sends: plain text, cut to the limit.
 * Telegram counts UTF-16 units, so this does too, and it never cuts a pair in half.
 */
export function telegramSendText(text: string): { text: string; cut: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= TELEGRAM_MAX_SEND_CHARS) return { text: trimmed, cut: false };
  let end = TELEGRAM_MAX_SEND_CHARS;
  const last = trimmed.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: trimmed.slice(0, end), cut: true };
}

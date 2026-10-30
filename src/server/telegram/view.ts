import "server-only";
import type { TelegramLinkRepository } from "@/server/db/telegram-links";
import { openChat } from "./seal";

// What the Telegram card and the chat page show (decision 0020). Read on the
// server; the chat ID never leaves the Worker, only the display name does.

export type TelegramLinkState =
  | { kind: "not_linked" }
  | { kind: "relink" }
  | { kind: "linked"; name: string; linkedAt: string };

export async function telegramLinkState(repo: TelegramLinkRepository, key: Uint8Array, userId: string): Promise<TelegramLinkState> {
  const row = await repo.getLink(userId);
  if (!row?.chatCiphertext || !row.linkedAt) return { kind: "not_linked" };
  const chat = await openChat(key, userId, row.chatCiphertext);
  return chat ? { kind: "linked", name: chat.name, linkedAt: row.linkedAt } : { kind: "relink" };
}

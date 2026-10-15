import "server-only";
import type { MessageRole } from "@/types/api";

export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

/**
 * Selects the most recent messages that fit within `charBudget`, newest first,
 * then returns them in chronological order. The latest message is always kept.
 * Consecutive messages with the same role (e.g. a user message whose reply
 * failed) are merged, and the window always starts with a user message, since
 * many chat templates require user/assistant alternation.
 */
export function buildContextWindow(history: HistoryMessage[], charBudget: number): HistoryMessage[] {
  const merged: HistoryMessage[] = [];
  for (const message of history) {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role) {
      merged[merged.length - 1] = { role: message.role, content: `${previous.content}\n\n${message.content}` };
    } else {
      merged.push({ ...message });
    }
  }

  const selected: HistoryMessage[] = [];
  let used = 0;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const message = merged[index]!;
    const isLatest = index === merged.length - 1;
    if (!isLatest && used + message.content.length > charBudget) break;
    if (isLatest && message.content.length > charBudget) {
      // Keep the end of an oversized latest message (the question is usually last).
      selected.push({ role: message.role, content: message.content.slice(-charBudget) });
      used = charBudget;
      continue;
    }
    selected.push(message);
    used += message.content.length;
  }
  selected.reverse();

  while (selected.length > 1 && selected[0]!.role !== "user") selected.shift();
  return selected;
}

/** Derives a conversation title from its first message. */
export function titleFromMessage(message: string, maxChars = 60): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "New conversation";
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}

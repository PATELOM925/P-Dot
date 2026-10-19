import "server-only";
import type { MessageRole } from "@/types/api";
import type { ChatMessage, CompletionChunk } from "@/server/providers/nebius/client";

export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

export interface CompactedContextOptions {
  charBudget: number;
  /** Pre-existing summary from earlier compaction runs or persistent memory */
  summary?: string;
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

/**
 * Builds a context window and injects a rolling summary block if a summary
 * is available, ensuring dropped turns or user constraints are not lost.
 */
export function buildCompactedContextWindow(
  history: HistoryMessage[],
  options: CompactedContextOptions | number,
): HistoryMessage[] {
  const charBudget = typeof options === "number" ? options : options.charBudget;
  const summary = typeof options === "number" ? undefined : options.summary;

  const window = buildContextWindow(history, charBudget);
  if (!summary || window.length === 0) return window;

  const first = window[0]!;
  const summaryBlock = `<conversation_summary>\nEarlier context summary:\n${summary.trim()}\n</conversation_summary>\n\n`;

  const updatedFirst: HistoryMessage = {
    role: first.role,
    content: `${summaryBlock}${first.content}`,
  };

  return [updatedFirst, ...window.slice(1)];
}

/** Derives a fallback conversation title from its first message. */
export function titleFromMessage(message: string, maxChars = 60): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "New conversation";
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}

/**
 * Generates a concise, descriptive title (3 to 6 words) using the model.
 * Falls back to titleFromMessage if model call times out or fails.
 */
export async function generateSmartTitle(
  complete: (messages: ChatMessage[], signal?: AbortSignal) => AsyncIterable<CompletionChunk>,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const promptText = userPrompt.trim();
  if (promptText.length === 0) return "New conversation";
  if (promptText.length < 25 && !promptText.includes("\n")) {
    return titleFromMessage(promptText);
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a conversation title generator. Output ONLY a concise, high-level topic title of 3 to 6 words describing what the user wants to discuss. Do NOT use quotation marks, punctuation, or conversational words like 'Sure' or 'Title:'.",
    },
    {
      role: "user",
      content: promptText.slice(0, 500),
    },
  ];

  let title = "";
  try {
    for await (const chunk of complete(messages, signal)) {
      if (chunk.type === "text") {
        title += chunk.text;
      }
      if (title.length > 80) break;
    }
    const clean = title.replace(/["'*_#`]/g, "").replace(/\s+/g, " ").trim();
    if (clean.length > 0 && clean.length <= 80) {
      return clean;
    }
  } catch {
    // Fallback on any failure
  }

  return titleFromMessage(promptText);
}

/**
 * Generates a concise rolling summary of older conversation messages.
 */
export async function generateRollingSummary(
  complete: (messages: ChatMessage[], signal?: AbortSignal) => AsyncIterable<CompletionChunk>,
  olderMessages: HistoryMessage[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (olderMessages.length === 0) return null;

  const conversationText = olderMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a conversation summarizer. Summarize key user preferences, decisions, constraints, and progress from these earlier messages in 2 to 4 concise bullet points. Output ONLY the bullet points.",
    },
    {
      role: "user",
      content: conversationText.slice(0, 4000),
    },
  ];

  let summary = "";
  try {
    for await (const chunk of complete(messages, signal)) {
      if (chunk.type === "text") {
        summary += chunk.text;
      }
      if (summary.length > 500) break;
    }
    const clean = summary.trim();
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
}

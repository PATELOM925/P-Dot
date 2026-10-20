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

/** Derives a clean, appropriate initial conversation title from its first message. */
export function titleFromMessage(message: string, maxChars = 60): string {
  let cleaned = message.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "New Conversation";

  // Strip leading and trailing quotes, backticks, or brackets
  cleaned = cleaned.replace(/^["'«»“”‘’`]+|["'«»“”‘’`]+$/g, "").trim();

  // Common generic single-word greetings become "New Conversation"
  if (/^(hi|hello|hey|yo|greetings|sup)\b/i.test(cleaned) && cleaned.length < 10) {
    return "New Conversation";
  }

  // Strip conversational fillers at start
  const fillerRegex = /^(can you (please )?|could you (please )?|please |help me (to )?|i want to |i need to |tell me (about )?)/i;
  cleaned = cleaned.replace(fillerRegex, "");
  cleaned = cleaned.replace(/^["'«»“”‘’`]+|["'«»“”‘’`]+$/g, "").trim();

  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1).trimEnd()}…` : cleaned;
}

/**
 * Generates a concise, descriptive title (2 to 5 words) using the model.
 * Falls back to titleFromMessage if model call times out or fails.
 */
export async function generateSmartTitle(
  complete: (messages: ChatMessage[], signal?: AbortSignal) => AsyncIterable<CompletionChunk>,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  let promptText = userPrompt.trim();
  if (promptText.length === 0) return "New Conversation";

  // Strip leading/trailing quotes
  promptText = promptText.replace(/^["'«»“”‘’`]+|["'«»“”‘’`]+$/g, "").trim();

  // Short generic greeting check
  if (/^(hi|hello|hey|yo|greetings|good (morning|afternoon|evening))\b/i.test(promptText) && promptText.length < 15) {
    return "New Conversation";
  }

  // If prompt is just a continuation command, avoid naming the chat "Continue"
  if (/^(please\s+)?(continue|continuw|keep going|go on|proceed|finish)\b/i.test(promptText)) {
    return "New Conversation";
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are an expert conversation title generator. Output ONLY a concise, professional title of 2 to 5 words summarizing the user's core inquiry topic. Do NOT use quotation marks, punctuation, or conversational words like 'Sure' or 'Title:'. Examples: 'Pediatric Blood Transfusion Ethics', 'Tokyo Trip Planning', 'React Hook Optimization', 'Quarterly Budgeting'.",
    },
    {
      role: "user",
      content: promptText.slice(0, 1000),
    },
  ];

  let title = "";
  try {
    for await (const chunk of complete(messages, signal)) {
      if (chunk.type === "text") {
        title += chunk.text;
      }
      if (title.length > 300) break;
    }

    // Strip reasoning / think tags if emitted by reasoning models
    let clean = title.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thought>[\s\S]*?<\/thought>/gi, "");
    // Strip markdown formatting, quotes, and punctuation
    clean = clean.replace(/["'*_#`]/g, "").replace(/\s+/g, " ").trim();
    // Strip conversational title prefixes like "Title:", "Topic:", "Here is a title:"
    clean = clean.replace(/^(?:title|topic|subject|chat title)\s*[:\-]\s*/i, "");
    clean = clean.replace(/^(?:here is (?:a|the) title|suggested title)\s*[:\-]?\s*/i, "");
    clean = clean.replace(/^["'«»“”‘’]+|["'«»“”‘’]+$/g, "").trim();

    const firstLine = clean.split("\n")[0]?.trim() ?? "";
    if (firstLine.length >= 2 && firstLine.length <= 60) {
      return firstLine;
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

import type { ChatStreamEvent } from "@/types/api";

const EVENT_TYPES = new Set(["start", "search", "status", "delta", "done", "error"]);

function hasType(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export class StreamFormatError extends Error {
  constructor() {
    super("The server sent an unreadable response.");
    this.name = "StreamFormatError";
  }
}

/** Parses a newline-delimited JSON response body into chat stream events. */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parse = (line: string): ChatStreamEvent | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new StreamFormatError();
    }
    if (!hasType(value)) throw new StreamFormatError();
    // A newer server can send event types this page does not know yet. Skip them.
    return EVENT_TYPES.has(value.type) ? (value as ChatStreamEvent) : null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const event = parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => {});
  }
}

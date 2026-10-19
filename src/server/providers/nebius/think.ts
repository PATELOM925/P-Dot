import "server-only";

const OPEN = "<think>";
const CLOSE = "</think>";

export interface ThinkFilter {
  /** Returns the part of `text` that is safe to show. */
  push(text: string): string;
  /** Returns held-back text at the end of the stream. */
  flush(): string;
}

/**
 * Removes a leading `<think>...</think>` block from streamed reply text.
 * Some models write their reasoning into the reply this way instead of a
 * separate field. Reasoning must never reach the user or the saved reply.
 * Text that does not start with `<think>` passes through unchanged.
 */
export function createThinkFilter(): ThinkFilter {
  let state: "start" | "inside" | "after" | "pass" = "start";
  let buffer = "";

  function afterBlock(text: string): string {
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed) state = "pass";
    return trimmed;
  }

  return {
    push(text) {
      if (state === "pass") return text;
      if (state === "after") return afterBlock(text);

      buffer += text;
      if (state === "start") {
        const trimmed = buffer.trimStart();
        // Wait until we know whether the reply starts with <think>.
        if (trimmed.length < OPEN.length && OPEN.startsWith(trimmed)) return "";
        if (!trimmed.startsWith(OPEN)) {
          state = "pass";
          const out = buffer;
          buffer = "";
          return out;
        }
        state = "inside";
        buffer = trimmed.slice(OPEN.length);
      }

      const end = buffer.indexOf(CLOSE);
      if (end === -1) {
        // Keep only enough to find a closing tag split across chunks.
        buffer = buffer.slice(-(CLOSE.length - 1));
        return "";
      }
      const rest = buffer.slice(end + CLOSE.length);
      buffer = "";
      state = "after";
      return afterBlock(rest);
    },
    flush() {
      // Reasoning that never closed is dropped.
      const out = state === "start" ? buffer : "";
      buffer = "";
      return out;
    },
  };
}

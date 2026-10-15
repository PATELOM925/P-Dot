import "server-only";

const MAX_LINE_CHARS = 1_000_000;

export class SseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseFormatError";
  }
}

/**
 * Yields the `data` payload of each server-sent event in a byte stream.
 * Handles events split across network chunks and multi-line data fields;
 * ignores comments and other SSE fields.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  // Cancelling the reader resolves a pending read, so an abort (timeout or
  // caller cancellation) always ends the loop even if the body never errors.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          if (dataLines.length > 0) {
            yield dataLines.join("\n");
            dataLines = [];
          }
        } else if (line.startsWith("data:")) {
          const payload = line.slice(5);
          dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
        }
        newline = buffer.indexOf("\n");
      }

      if (buffer.length > MAX_LINE_CHARS) throw new SseFormatError("SSE line too long");
    }

    // Flush a final event that was not followed by a blank line.
    buffer += decoder.decode();
    const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5);
      dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
  }
}

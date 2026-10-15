/** A byte stream that emits each string as a separate chunk. */
export function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
  });
}

/** A stream that emits the given chunks, then never closes (for timeout tests). */
export function hangingStream(chunks: string[] = []): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
}

export function sseEvent(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

export function deltaChunk(text: string) {
  return { object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

export function finishChunk(reason = "stop") {
  return {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
